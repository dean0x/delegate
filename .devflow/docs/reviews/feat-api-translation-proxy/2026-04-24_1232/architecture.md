# Architecture Review Report

**Branch**: feat/api-translation-proxy -> main
**Date**: 2026-04-24

## Issues in Your Changes (BLOCKING)

### HIGH

**`TranslateTarget` type has a dual single-source-of-truth claim that is not enforced by code** - `src/core/configuration.ts:232` and `src/cli/commands/agents.ts:23`
**Confidence**: 85%
- Problem: The JSDoc on `TranslateTarget` says "Single source of truth -- kept in sync with SUPPORTED_TRANSLATE_TARGETS in proxy-manager.ts", but `SUPPORTED_TRANSLATE_TARGETS` was removed from `proxy-manager.ts` in this PR. Meanwhile, a separate `SUPPORTED_TRANSLATE_TARGETS` constant was added to `src/cli/commands/agents.ts:23`. The MCP adapter also has its own `.enum(['openai', ''])` definition in `src/adapters/mcp-adapter.ts:351`. These three locations define the set of valid translate targets independently -- if a new target is added (e.g. `'gemini'`), three files must be updated, with no compile-time linkage between them.
- Fix: Derive the CLI constant and MCP enum from the canonical `TranslateTarget` type. For example, export a `TRANSLATE_TARGETS` tuple from `configuration.ts` (`export const TRANSLATE_TARGETS = ['openai'] as const; export type TranslateTarget = (typeof TRANSLATE_TARGETS)[number];`) and import it in `agents.ts` and `mcp-adapter.ts`. This replaces three independent lists with one.

### MEDIUM

**`StreamTranslator.applyMiddleware` duplicates `runStreamEventMiddleware` logic** - `src/translation/proxy/stream-translator.ts:100-109`
**Confidence**: 82%
- Problem: The PR inlines the middleware iteration loop in `StreamTranslator.applyMiddleware` instead of calling the canonical `runStreamEventMiddleware` from `middleware.ts`. The rationale (DECISION comment) is to avoid re-reversing the array on every call, which is valid. However, this means the middleware traversal order is now defined in two places: `runStreamEventMiddleware` (authoritative, uses `[...mw].reverse()`) and `StreamTranslator.applyMiddleware` (uses pre-computed `reversedMiddlewares`). If the onion-model order convention changes, both must be updated.
- Fix: Consider making the pre-reversal the responsibility of the runner function itself. For example, add a `createStreamEventRunner(middlewares)` factory that returns a closed-over function with the pre-reversed array. `StreamTranslator` and any future callers would both use the same runner factory. Alternatively, accept the duplication and add a code comment in `middleware.ts` referencing `StreamTranslator` as a known parallel implementation.

**`processNonStreamingResponse` return value (boolean) is silently ignored** - `src/translation/proxy/translation-proxy.ts:467`
**Confidence**: 80%
- Problem: `processNonStreamingResponse` returns `boolean` (true on success, false if error sent), but at line 467 (inside `handleNonStreamingRequest`) and line 532 (inside `handleJsonFallback`), the return value is ignored. This means if `processNonStreamingResponse` fails and sends an error response, the caller continues executing normally. Currently this is harmless because the caller does nothing after the call, but the return type creates a false API contract that suggests callers should act on the result.
- Fix: Either (a) change the return type to `void` since callers do not branch on it, or (b) check the return value in callers. Option (a) is simpler and more honest.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`extractBackendErrorMessage` forwards raw backend text to the client without sanitization** - `src/translation/proxy/translation-proxy.ts:145-157`
**Confidence**: 82%
- Problem: When the backend returns a non-JSON error body, the raw text is forwarded to the client (truncated to 500 chars). While truncation prevents oversized payloads, the content could include internal infrastructure details (stack traces, internal hostnames, debug info) that should not be surfaced to the API consumer. The function currently only applies length truncation, not content sanitization.
- Fix: This is a security/observability boundary concern more than a pure architecture issue. Consider logging the full backend error at `debug` level (already done at line 456/508) but returning a generic message to the client for non-JSON responses, e.g. `Backend returned an error (status ${statusCode})`. Reserve the detailed message extraction for JSON `error.message` fields which are more likely to be intentional user-facing messages.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`bootstrap.ts` uses temporal coupling for proxy startup ordering** - `src/bootstrap.ts:363-422`
**Confidence**: 80%
- Problem: The `proxyPort` variable is captured in the enclosing scope and read inside the `agentRegistry` factory closure. The TEMPORAL DEPENDENCY comment (lines 363-366) correctly identifies this coupling. This is a pre-existing architectural pattern (not introduced in this PR), but the PR adds more documentation around it. Temporal coupling is fragile -- reordering statements silently breaks the contract.
- Fix: (Informational only, not blocking.) A future refactor could make the dependency explicit by passing `proxyPort` as a parameter to the agent registry factory, or by making the proxy a first-class container registration that the agent registry factory resolves.

## Suggestions (Lower Confidence)

- **`TranslationProxy` class is approaching SRP threshold (11 methods)** - `src/translation/proxy/translation-proxy.ts:203` (Confidence: 70%) -- The class handles HTTP server lifecycle, request routing, non-streaming requests, streaming requests, SSE line translation, error handling, and JSON fallback. The extraction of `handleStreamingError`, `handleJsonFallback`, and `handleSseStream` in this PR is a step in the right direction. A future refactor could extract a `RequestHandler` collaborator to separate HTTP plumbing from translation logic.

- **`countApproxChars` approximation (chars / 4) is a rough heuristic** - `src/translation/proxy/translation-proxy.ts:173` (Confidence: 65%) -- The chars-to-tokens ratio varies significantly between languages and content types (code vs. prose vs. CJK). This is acceptable for the `/count_tokens` stub but worth a DECISION comment noting the approximation quality and that it is intentionally coarse.

- **`SUPPORTED_TRANSLATE_TARGETS` in `agents.ts` uses `as readonly string[]` cast for `.includes()`** - `src/cli/commands/agents.ts:127` (Confidence: 62%) -- The cast works around TypeScript's narrow literal type checking on `.includes()`. A type-safe alternative is a `Set<string>` or a custom type guard, which would avoid the cast.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Architecture Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The translation proxy architecture is well-designed. The canonical IR (intermediate representation) pattern with pluggable codecs and middleware is a textbook application of the Adapter and Chain of Responsibility patterns. Key architectural strengths:

1. **Clean layering**: `FormatCodec` interface decouples codecs from each other; they communicate only through `CanonicalRequest`/`CanonicalResponse`/`CanonicalStreamEvent` types.
2. **Per-request middleware factory**: The shift from shared middleware instances to `middlewareFactory` correctly addresses concurrency safety for stateful middleware (PromptCacheMiddleware, LoggingMiddleware).
3. **Explicit dependency direction**: Domain types in `ir.ts` have zero imports from infrastructure; codecs depend on IR; proxy depends on codecs and middleware -- all arrows point inward.
4. **Good extraction pattern**: The PR extracts `buildToolResultMessages`, `buildAssistantMessage`, `closeActiveTextBlock`, `closeActiveToolCall`, `processToolCallDeltas`, `processNonStreamingResponse`, `handleStreamingError`, `handleJsonFallback`, `handleSseStream` -- each reducing complexity in the calling methods.
5. **Mode-gated proxy startup**: Proxy only starts in `'server'` mode, correctly avoiding unnecessary resource allocation in CLI modes.

The blocking HIGH finding (translate target source-of-truth fragmentation) should be resolved before merge to prevent future desynchronization bugs.
