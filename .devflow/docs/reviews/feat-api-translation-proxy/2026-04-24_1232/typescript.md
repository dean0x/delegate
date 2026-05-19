# TypeScript Review Report

**Branch**: feat/api-translation-proxy -> main
**Date**: 2026-04-24

## Issues in Your Changes (BLOCKING)

### HIGH

**Test file uses non-existent `delta` property on `ContentDeltaEvent` (8 occurrences)** - Confidence: 95%
- `tests/unit/translation/middleware/middleware.test.ts:35`, `:63`, `:64`, `:64`, `:64`, `:133`, `:134`, `:177`, `:178`
- Problem: `makeStreamEvent()` creates `{ type: 'content_delta', index: 0, delta: { type: 'text_delta', text } }` but `ContentDeltaEvent` in `src/translation/ir.ts:183-187` is defined as `{ type: 'content_delta'; index: number; text: string }` -- there is no `delta` property. The `makeStreamTagger` middleware accesses `event.delta.type` and `event.delta.text` which also do not exist on the type. Confirmed via targeted `tsc --noEmit` which reports 8 errors (TS2353, TS2339). Tests pass at runtime only because JavaScript ignores type structure, but the tests are validating the wrong shape. If the IR types are correct, the tests are testing a phantom property. If the tests are correct, the IR types are wrong.
- Fix: Align the test with the actual `ContentDeltaEvent` type:
  ```typescript
  function makeStreamEvent(text: string): CanonicalStreamEvent {
    return { type: 'content_delta', index: 0, text };
  }
  
  // In makeStreamTagger:
  processStreamEvent(event: CanonicalStreamEvent): CanonicalStreamEvent {
    if (event.type === 'content_delta') {
      return { ...event, text: `${event.text}:${tag}` };
    }
    return event;
  }
  ```

### MEDIUM

**Stale JSDoc reference to removed constant** - `src/core/configuration.ts:232` - Confidence: 92%
- Problem: The JSDoc on `TranslateTarget` says "Single source of truth -- kept in sync with SUPPORTED_TRANSLATE_TARGETS in proxy-manager.ts" but this PR removed `SUPPORTED_TRANSLATE_TARGETS` from `proxy-manager.ts`. The constant now only exists in `src/cli/commands/agents.ts:23`. The comment misleads future developers into looking for a constant that no longer exists.
- Fix: Update the JSDoc to reference the actual location:
  ```typescript
  /**
   * Supported API translation targets.
   * Single source of truth -- kept in sync with SUPPORTED_TRANSLATE_TARGETS in agents.ts (CLI validation).
   * Empty string is the "clear" sentinel accepted at save boundaries (CLI, MCP).
   */
  ```

**`SUPPORTED_TRANSLATE_TARGETS` in agents.ts not typed against `TranslateTarget`** - `src/cli/commands/agents.ts:23` - Confidence: 85%
- Problem: `const SUPPORTED_TRANSLATE_TARGETS = ['openai'] as const` is an independent constant not typed against `TranslateTarget`. If a new translate target is added to `TranslateTarget`, this array won't cause a compile error. The widening cast on line 127 (`as readonly string[]`) further obscures the relationship.
- Fix: Type the constant against the union type to get compile-time safety:
  ```typescript
  import type { TranslateTarget } from '../../core/configuration.js';
  const SUPPORTED_TRANSLATE_TARGETS: readonly TranslateTarget[] = ['openai'] as const;
  ```
  Then on line 127 `value` can be checked with `!SUPPORTED_TRANSLATE_TARGETS.includes(value as TranslateTarget)` or keep a type guard.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`as number` / `as ActiveToolCall` assertions after `Map.has()` checks could use non-null assertion or single `get` + truthy guard** - Confidence: 82%
- `src/translation/codecs/openai-codec.ts:319`, `:328`
- Problem: Lines like `this.openaiToCanonicalIndex.get(tcIndex) as number` and `this.pendingToolCalls.get(tcIndex) as ActiveToolCall` use `as` casts after `has()` checks. While logically safe, TypeScript's `Map.get()` returns `T | undefined` and the `as` cast silently overrides this. If the `has()` guard is ever removed during refactoring, the cast hides the potential `undefined`.
- Fix: Use the get result directly with a truthiness check, which is already done on line 321 (`if (!existing) continue`). For line 319:
  ```typescript
  const canonicalIndex = this.openaiToCanonicalIndex.get(tcIndex);
  if (canonicalIndex === undefined) continue;
  // canonicalIndex is now narrowed to number
  ```

## Pre-existing Issues (Not Blocking)

_No CRITICAL pre-existing TypeScript issues found in reviewed files._

## Suggestions (Lower Confidence)

- **Unused `middlewares` constructor parameter in `StreamTranslator`** - `src/translation/proxy/stream-translator.ts:31` (Confidence: 65%) -- The `middlewares` parameter is stored but only used to compute `reversedMiddlewares` in the constructor. The `this.middlewares` field is never read elsewhere. Consider removing the stored field and only keeping `reversedMiddlewares`.

- **`processNonStreamingResponse` return value ignored** - `src/translation/proxy/translation-proxy.ts:467`, `:532` (Confidence: 60%) -- The method returns `boolean` but both callers discard it. The return type suggests callers should branch, but since the method already sends error responses internally, the boolean is redundant. Consider changing the return type to `void` to match actual usage.

- **`extractBackendErrorMessage` could leak sensitive info from backend** - `src/translation/proxy/translation-proxy.ts:145-157` (Confidence: 70%) -- The function forwards raw backend error messages (up to 500 chars) to the client. If a backend accidentally includes credentials or internal paths in error messages, these would be proxied through. The existing truncation mitigates length-based attacks but not content-based leakage. Consider a more restrictive allowlist of known error shapes.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**TypeScript Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The main blocking issue is the newly added `middleware.test.ts` which constructs `CanonicalStreamEvent` objects with a `delta` property that does not exist on the `ContentDeltaEvent` type. This produces 8 TypeScript errors when type-checked directly and means the tests are validating a shape that does not match the canonical IR. The type narrowing in the test helpers (`event.delta.type === 'text_delta'`) operates on properties that TypeScript cannot verify, defeating the purpose of typed tests.

The remaining issues are medium-severity: a stale JSDoc reference, a constant not typed against its canonical union type, and `as` casts that could be replaced with proper narrowing.
