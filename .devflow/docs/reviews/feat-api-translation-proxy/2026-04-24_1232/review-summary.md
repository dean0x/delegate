# Code Review Summary

**Branch**: feat/api-translation-proxy → main
**Date**: 2026-04-24_1232
**Reviewed by**: 8 Parallel Reviewers (Architecture, Complexity, Consistency, Performance, Regression, Security, Testing, TypeScript)

## Merge Recommendation: CHANGES_REQUESTED

The translation proxy implementation is architecturally sound and well-tested, with clear patterns for middleware, codecs, and error handling. However, **3 blocking issues** across the reviews prevent merge without fixes:

1. **HIGH: Test file constructs invalid IR type shape** (Consistency + TypeScript) — 9 errors
2. **HIGH: Translate target source-of-truth fragmentation** (Architecture + Consistency) — 3 independent lists
3. **HIGH: Backend error messages forwarded without sanitization** (Security) — information leakage risk

Additionally, **7 supporting issues** (MEDIUM severity) should be resolved to align with project patterns and prevent future maintenance burden.

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------|----------|------|--------|-----|-------|
| **Blocking (Your Changes)** | 0 | 3 | 6 | 0 | **9** |
| **Should-Fix (Code You Touched)** | 0 | 0 | 4 | 0 | **4** |
| **Pre-existing** | 0 | 0 | 4 | 1 | **5** |
| **Suggestions (Lower Confidence)** | — | — | — | — | **8** |

**Overall Health**: 7/10 average across all reviewers
- Architecture: 8/10
- Complexity: 7/10
- Consistency: 7/10
- Performance: 8/10
- Regression: 8/10
- Security: 8/10
- Testing: 7/10
- TypeScript: 7/10

---

## Blocking Issues (Must Fix Before Merge)

### 1. **Test Factory Constructs Invalid IR Type** (Consistency + TypeScript - HIGH, 95% confidence)
**Files**: `tests/unit/translation/middleware/middleware.test.ts:35` and 8 more lines
**Impact**: 9 TypeScript errors; tests validate a shape with non-existent `delta` property

```typescript
// WRONG (current):
function makeStreamEvent(text: string): CanonicalStreamEvent {
  return { type: 'content_delta', index: 0, delta: { type: 'text_delta', text } };
  // ↑ ContentDeltaEvent has no `delta` property
}

// CORRECT:
function makeStreamEvent(text: string): CanonicalStreamEvent {
  return { type: 'content_delta', index: 0, text };
}
```

The `makeStreamTagger` middleware also reads `event.delta.type` and `event.delta.text` which don't exist on `ContentDeltaEvent` (defined in `src/translation/ir.ts:183-187` as `{ type: 'content_delta'; index: number; text: string }`). Update all assertions and taggers to use the flat `text` property.

**Why blocking**: Tests pass at runtime only because JavaScript ignores type structure. The tests validate a phantom shape that no real event would have. This defeats type safety and means middleware tests don't actually exercise the real IR contract.

---

### 2. **Translate Target Source-of-Truth Fragmentation** (Architecture + Consistency - HIGH, 85-92% confidence)
**Files**: 
- `src/core/configuration.ts:232` (JSDoc says "kept in sync with proxy-manager.ts")
- `src/core/configuration.ts:235` (`TranslateTarget` type)
- `src/cli/commands/agents.ts:23` (`SUPPORTED_TRANSLATE_TARGETS` array)
- `src/adapters/mcp-adapter.ts:351` (Zod `.enum(['openai', ''])`)

**Problem**: When a new translate target is added (e.g., `'gemini'`), three files must be updated in lockstep with zero compile-time linkage. The JSDoc also references a non-existent constant in `proxy-manager.ts` (removed in this PR).

**Fix** — Create a single source of truth:
```typescript
// configuration.ts
export const SUPPORTED_TRANSLATE_TARGETS = ['openai'] as const;
export type TranslateTarget = (typeof SUPPORTED_TRANSLATE_TARGETS)[number];

// agents.ts
import { SUPPORTED_TRANSLATE_TARGETS } from '../../core/configuration.js';
// Use directly instead of defining a separate array

// mcp-adapter.ts
import { SUPPORTED_TRANSLATE_TARGETS } from '../../core/configuration.js';
// Import and derive: z.enum(SUPPORTED_TRANSLATE_TARGETS)

// configuration.ts (update JSDoc):
/**
 * Supported API translation targets.
 * Single source of truth — runtime validation uses this type at load boundaries
 * (CLI: agents.ts SUPPORTED_TRANSLATE_TARGETS, MCP: mcp-adapter.ts z.enum).
 * Empty string is the "clear" sentinel accepted at save boundaries (CLI, MCP).
 */
```

**Why blocking**: Violates the project's single-source-of-truth principle (CLAUDE.md). Future maintenance will likely miss one of three locations when adding new targets, causing validation inconsistencies.

---

### 3. **Backend Error Messages Forwarded Without Sanitization** (Security - HIGH, 85% confidence)
**Files**: `src/translation/proxy/translation-proxy.ts:145-157`, `:457`, `:510`
**Impact**: Information leakage of backend internals; violates stated security invariant

The new `extractBackendErrorMessage()` function forwards raw backend error text (truncated to 500 chars) to the client. While the local proxy is 127.0.0.1-only (low practical risk), backend errors can contain:
- Model deployment names
- Internal hostnames
- Stack traces or debug info
- Quota identifiers

The code's own security comment (line 12) states: _"Never includes API keys in error messages or logs."_ Forwarding raw backend content violates this defensive pattern.

**Fix** — Separate detail (debug logs) from summary (client response):
```typescript
function extractBackendErrorMessage(chunks: Buffer[]): { detail: string; summary: string } {
  const MAX_LENGTH = 500;
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (!raw) return { detail: 'Backend returned error', summary: 'Backend returned error' };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const errorObj = parsed['error'] as Record<string, unknown> | undefined;
    const msg = errorObj?.['message'] ?? parsed['message'];
    const detail = typeof msg === 'string' ? msg.substring(0, MAX_LENGTH) : raw.substring(0, MAX_LENGTH);
    return { detail, summary: 'Backend returned error' };
  } catch {
    return { detail: raw.substring(0, MAX_LENGTH), summary: 'Backend returned error' };
  }
}

// Usage:
const result = extractBackendErrorMessage(errChunks);
logger.debug('Backend error response', { statusCode, backendMessage: result.detail });
sendError(res, statusCode, errorType, result.summary);
```

**Why blocking**: Security boundary issue. Even in local-only context, sanitization is a hygiene pattern. Without this, future refactors that expose the proxy to other clients would inherit an insecure default.

---

## Should-Fix Issues (Same File, Supporting Fixes)

### 4. **Unbounded Buffer Accumulation for Backend Error Responses** (Security - MEDIUM, 82% confidence)
**Files**: `src/translation/proxy/translation-proxy.ts:450-451`, `:502-503`

Error response bodies are accumulated without size limits. Inbound requests use `MAX_BODY_BYTES` (50MB), but error responses have no guard. A malicious backend could cause memory exhaustion.

**Fix**:
```typescript
private handleStreamingError(...): void {
  const errChunks: Buffer[] = [];
  let errBytes = 0;
  const MAX_ERR_BYTES = 64 * 1024; // 64KB is generous for error bodies
  backendRes.on('data', (chunk: Buffer) => {
    errBytes += chunk.length;
    if (errBytes <= MAX_ERR_BYTES) errChunks.push(chunk);
  });
  // ... rest unchanged
}
```

Apply the same pattern at line 450 in `handleNonStreamingRequest`.

---

### 5. **`handleNonStreamingRequest` Remains 76-Line Method with Deep Nesting** (Complexity - HIGH, 85% confidence)
**Files**: `src/translation/proxy/translation-proxy.ts:417-492`

Although response processing was extracted into `processNonStreamingResponse`, the main method remains 76 lines with 5-level nesting inside a Promise callback chain. The `handleStreamingRequest` received more aggressive refactoring (extracted `handleStreamingError`, `handleJsonFallback`, `handleSseStream`), but the non-streaming handler was not.

**Fix** — Extract the `requestFn` callback body into `handleBackendNonStreamingResponse`:
```typescript
private handleBackendNonStreamingResponse(
  backendRes: http.IncomingMessage,
  res: http.ServerResponse,
  middlewares: readonly TranslationMiddleware[],
  responseTimeout: ReturnType<typeof setTimeout>,
  resolve: () => void,
): void {
  const statusCode = backendRes.statusCode ?? 500;
  if (statusCode >= 400) {
    const errChunks: Buffer[] = [];
    backendRes.on('data', (chunk: Buffer) => errChunks.push(chunk));
    backendRes.on('end', () => {
      clearTimeout(responseTimeout);
      const result = extractBackendErrorMessage(errChunks);
      sendError(res, statusCode, mapStatusToErrorType(statusCode), result.summary);
      resolve();
    });
    return;
  }
  const chunks: Buffer[] = [];
  backendRes.on('data', (chunk: Buffer) => chunks.push(chunk));
  backendRes.on('end', () => {
    clearTimeout(responseTimeout);
    this.processNonStreamingResponse(Buffer.concat(chunks).toString(), res, middlewares);
    resolve();
  });
}
```

This brings the method below 50 lines and flattens nesting.

---

### 6. **Stale JSDoc References Removed Constant** (Consistency + Regression + TypeScript - MEDIUM, 90-92% confidence)
**Files**: `src/core/configuration.ts:232`

The JSDoc for `TranslateTarget` says _"kept in sync with SUPPORTED_TRANSLATE_TARGETS in proxy-manager.ts"_ but this PR removed that constant from `proxy-manager.ts`. The comment now directs developers to a non-existent artifact.

**Fix**:
```typescript
/**
 * Supported API translation targets.
 * Single source of truth — runtime validation uses this type at load boundaries
 * (CLI: agents.ts SUPPORTED_TRANSLATE_TARGETS, MCP: mcp-adapter.ts z.enum).
 * Empty string is the "clear" sentinel accepted at save boundaries (CLI, MCP).
 */
export type TranslateTarget = 'openai' | '';
```

---

### 7. **`processNonStreamingResponse` Return Type Mismatch** (Consistency + TypeScript - MEDIUM, 80-85% confidence)
**Files**: `src/translation/proxy/translation-proxy.ts:381`, `:467`, `:532`

The method signature returns `boolean` ("true on success, false if error sent"), but both callers at lines 467 and 532 ignore the return value. The return type creates a false API contract.

**Fix** — Change return type to `void`:
```typescript
private processNonStreamingResponse(
  rawBody: string,
  res: http.ServerResponse,
  middlewares: readonly TranslationMiddleware[],
): void {
  // ... method body unchanged
}
```

---

### 8. **`handleSseStream` Accepts 7 Parameters** (Complexity - MEDIUM, 84% confidence)
**Files**: `src/translation/proxy/translation-proxy.ts:539-591`

The method takes 7 parameters (`backendRes`, `res`, `translator`, `lineBuffer`, `resetIdleTimer`, `clearIdleTimer`, `resolve`). While the parameter count is high, it resulted from decomposing the monolithic streaming handler (a net positive). The parameters don't naturally form a single object except for the timer/resolve callbacks.

**Fix** — Group callbacks into a context object:
```typescript
interface StreamCallbackContext {
  resetIdleTimer: () => void;
  clearIdleTimer: () => void;
  resolve: () => void;
}

private handleSseStream(
  backendRes: http.IncomingMessage,
  res: http.ServerResponse,
  translator: StreamTranslator,
  lineBuffer: LineBuffer,
  context: StreamCallbackContext,
): void {
  // ... method body using context.resetIdleTimer, etc.
}
```

Also apply the same `StreamCallbackContext` to `handleStreamingError` and `handleJsonFallback` (lines 495-536) which currently duplicate these parameters.

---

## Supporting Issues (Lower Priority)

### 9. **`StreamTranslator.applyMiddleware` Duplicates `runStreamEventMiddleware` Logic** (Consistency + Testing - MEDIUM, 80-85% confidence)
**Files**: `src/translation/proxy/stream-translator.ts:100-109`, `src/translation/middleware/middleware.ts:48-59`

The `applyMiddleware` method reimplements the middleware iteration loop (with pre-reversed array) instead of calling the exported `runStreamEventMiddleware` helper. The DECISION comment justifies this as a performance optimization to avoid re-reversing on every call. However, `runStreamEventMiddleware` is now only called in tests, never in production — creating dead code.

**Suggested fix** (not blocking): Either (a) update `runStreamEventMiddleware` to accept a pre-reversed array option, or (b) add a comment in `middleware.ts` documenting that it's a test-only reference with production using the inlined version in `StreamTranslator`.

**Missing test**: The `StreamTranslator` was refactored to inline this logic but is tested with an empty middleware array (`[]`). Add a test exercising the middleware path with actual middlewares.

---

### 10. **`runResponseMiddleware` Still Creates Reversed Copy Per Call** (Performance - MEDIUM, 85% confidence)
**Files**: `src/translation/middleware/middleware.ts:41`

The streaming path optimizes by pre-computing reversed middlewares, but the non-streaming `runResponseMiddleware` still calls `[...middlewares].reverse()` on every call. For a 3-element array this is negligible, but it's an inconsistency with the stated pattern.

**Suggested fix**: Apply the same pre-computation pattern to non-streaming calls, or acknowledge the negligible cost and move on.

---

### 11. **`SUPPORTED_TRANSLATE_TARGETS` in agents.ts Not Typed Against `TranslateTarget`** (TypeScript - MEDIUM, 85% confidence)
**Files**: `src/cli/commands/agents.ts:23`, `:127`

The constant is defined as `['openai'] as const` without linking to the `TranslateTarget` union type. If a new target is added to `TranslateTarget`, this array won't cause a compile error. The widening cast on line 127 (`as readonly string[]`) further obscures the relationship.

**Fix**:
```typescript
import type { TranslateTarget } from '../../core/configuration.js';

const SUPPORTED_TRANSLATE_TARGETS: readonly TranslateTarget[] = ['openai'] as const;
```

Then on line 127, the type guard can use this constant directly without casting to `string[]`.

---

### 12. **`processToolCallDeltas` State Machine Branching** (Complexity - MEDIUM, 82% confidence)
**Files**: `src/translation/codecs/openai-codec.ts:307-368`

The method has a 3-way branching structure with nested conditionals reaching 4-5 indent levels. This is inherent to the OpenAI streaming protocol state machine, but the branches could be extracted for clarity.

**Suggested fix**: Extract each of the 3 branches (`accumulateStartedToolCall`, `promoteOrAccumulatePending`, `registerNewToolCall`) as separate private methods to make state transitions self-documenting.

---

### 13. **`extractBackendNonStreamingResponse` at Line 145 Has 9 Type Errors** (TypeScript - MEDIUM, 85% confidence)
**Files**: `tests/unit/translation/middleware/middleware.test.ts:35,63,64,133,134,177,178`

Related to issue #1 above — the test file constructs events with the wrong shape. Reported separately by TypeScript reviewer.

---

### 14. **`Map.get()` Assertions Could Use Proper Narrowing** (TypeScript - MEDIUM, 82% confidence)
**Files**: `src/translation/codecs/openai-codec.ts:319`, `:328`

Lines like `this.openaiToCanonicalIndex.get(tcIndex) as number` use `as` casts after `has()` checks. While logically safe, TypeScript's narrowing is bypassed. A safer approach:
```typescript
const canonicalIndex = this.openaiToCanonicalIndex.get(tcIndex);
if (canonicalIndex === undefined) continue;
// canonicalIndex is now narrowed to number
```

---

## Pre-existing Issues (Not Blocking)

These are documented for awareness but don't block this PR:

| Issue | File | Score |
|-------|------|-------|
| `translation-proxy.ts` exceeds 500-line threshold (674 lines) | `src/translation/proxy/translation-proxy.ts` | Can extract utilities to `proxy-utils.ts` |
| `openai-codec.ts` at 578 lines, near threshold | `src/translation/codecs/openai-codec.ts` | Monitor growth; stream parser is cohesive |
| `LineBuffer.feed()` uses string concatenation | `src/translation/proxy/line-buffer.ts:18` | Adequate for typical SSE throughput |
| Temporal coupling in `bootstrap.ts` | `src/bootstrap.ts:363-422` | Pre-existing pattern; improve in future refactor |
| `OpenAIStreamParser` maintains 9 mutable state fields | `src/translation/codecs/openai-codec.ts:196-206` | Inherent to state machine; add diagram comment |

---

## Positive Observations

1. **Architectural patterns are textbook clean**: The canonical IR (intermediate representation) with pluggable codecs is a clean Adapter pattern. Middleware chain-of-responsibility is well-designed.

2. **Per-request middleware factory is correct**: Avoids shared mutable state across concurrent requests, preventing data races and cross-request information leakage.

3. **Extracted helpers improve clarity**: `buildToolResultMessages`, `buildAssistantMessage`, `closeActiveTextBlock`, `closeActiveToolCall`, `processToolCallDeltas`, `handleStreamingError`, `handleJsonFallback`, `handleSseStream` all reduce complexity in their callers.

4. **Performance improvements are meaningful**: Batched SSE writes and pre-computed reversed middleware array eliminate repeated allocations in the hot path. Mode-gated proxy startup prevents unnecessary resource allocation.

5. **Test suite is comprehensive**: Middleware runner tests are exemplary (clean factories, clear AAA structure, exhaustive behavioral coverage). OpenAI codec stream parser tests precisely target the tool-call-after-text bug fix. Integration tests cover error paths, non-JSON fallback, and streaming fallback thoroughly.

6. **URL sanitization for log injection** (lines 280-282): Good defense-in-depth practice.

7. **MCP schema tightening**: The `translate` field Zod schema was correctly narrowed from `.string()` to `.enum(['openai', ''])`, rejecting arbitrary values at the API boundary.

---

## Action Plan

### Before Merge (Blocking)
1. **Fix test factory** (consistency.md, typescript.md) — Update `makeStreamEvent()` and middleware taggers to use flat `text` property instead of `delta.text`
2. **Consolidate translate targets** (architecture.md, consistency.md) — Export `SUPPORTED_TRANSLATE_TARGETS` from `configuration.ts` and import in `agents.ts` and `mcp-adapter.ts`
3. **Sanitize backend errors** (security.md) — Return generic summary to client; keep detail for debug logs only
4. **Add error buffer bounds** (security.md) — Apply `MAX_ERR_BYTES` guard to both non-streaming and streaming error paths
5. **Update JSDoc references** (consistency.md, regression.md, typescript.md) — Remove reference to non-existent `proxy-manager.ts` constant

### Strongly Recommended (Same-File Fixes)
6. **Extract `handleBackendNonStreamingResponse`** (complexity.md) — Bring nesting below 5 levels
7. **Change `processNonStreamingResponse` return type to `void`** (consistency.md, typescript.md)
8. **Add `StreamCallbackContext` object** (complexity.md) — Reduce parameter count in `handleSseStream`, `handleStreamingError`, `handleJsonFallback`
9. **Type `SUPPORTED_TRANSLATE_TARGETS` array** (typescript.md) — Link to `TranslateTarget` union type for compile-time safety
10. **Add middleware path test for `StreamTranslator`** (testing.md) — Verify non-empty middleware pipeline works at unit level

### Nice-to-Have (Separate PR)
11. Extract utility functions to `proxy-utils.ts` (complexity.md)
12. Extract state machine branches in `processToolCallDeltas` (complexity.md)
13. Add unit tests for `extractBackendErrorMessage` and `countApproxChars` (testing.md)
14. Document `OpenAIStreamParser` state diagram (complexity.md)
15. Consider object pooling for middleware if concurrency grows (performance.md)

---

## Summary

The translation proxy is a well-designed component with clean patterns and solid test coverage. The blocking issues are fixable and straightforward:
- **Type safety**: Fix the test factory to match the actual IR types
- **Design consistency**: Consolidate the translate target constant
- **Security**: Sanitize backend errors and bound error buffer sizes
- **Documentation**: Update stale JSDoc references

The supporting MEDIUM issues should be resolved together with the blocking fixes to maintain consistency and prevent maintenance burden. Estimated effort: 2-3 hours for all fixes and validation.

**Recommendation**: Request changes for the 3 blocking issues + recommended supporting fixes. Approve once these are addressed.
