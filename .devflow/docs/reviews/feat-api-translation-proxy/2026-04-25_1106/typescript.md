# TypeScript Review Report

**Branch**: feat/api-translation-proxy -> main
**Date**: 2026-04-25
**Diff**: `git diff b762591...HEAD` (incremental review)

## Issues in Your Changes (BLOCKING)

### HIGH

**`as [string, ...string[]]` assertion bypasses Zod enum type safety** - `src/adapters/mcp-adapter.ts:359`
**Confidence**: 85%
- Problem: The expression `[...TRANSLATE_TARGETS, ''] as [string, ...string[]]` widens the tuple to `[string, ...string[]]`, erasing the concrete literal types (`'openai' | ''`). Zod's `.enum()` with a widened tuple accepts any string at the type level, defeating compile-time validation. If a caller passes `translate: 'invalid'`, TypeScript will not flag it.
- Fix: Use a derived tuple type that preserves literals:
  ```typescript
  .enum([...TRANSLATE_TARGETS, ''] as const satisfies readonly [string, ...string[]])
  ```
  Alternatively, construct a typed constant outside the schema and reference it:
  ```typescript
  const TRANSLATE_WITH_CLEAR = [...TRANSLATE_TARGETS, ''] as const;
  // Then in the schema:
  .enum(TRANSLATE_WITH_CLEAR)
  ```

### MEDIUM

**`DisposableService` duck-typing with `as` casts in `dispose()`** - `src/core/container.ts:214-218`
**Confidence**: 82%
- Problem: The new proxy shutdown block uses `this.get('proxyManager')` and casts the result to `DisposableService`, then checks `if (proxyManager.stop)`. This is consistent with the existing pattern for `resourceMonitor`, `scheduleExecutor`, etc. in the same method, so it is not a regression. However, the `DisposableService` interface is a loose duck-type with all optional methods -- it provides no compile-time guarantee that the resolved value actually has a `stop()` method. This is a pre-existing design concern amplified by one more usage.
- Fix: No blocking action needed for this PR since it follows the established pattern. A future improvement would be to register services with typed interfaces (e.g., `container.get<Stoppable>('proxyManager')`) or introduce a `Disposable` contract that the `ProxyManager` class explicitly implements.

## Issues in Code You Touched (Should Fix)

No issues found.

## Pre-existing Issues (Not Blocking)

No critical pre-existing issues in changed files.

## Suggestions (Lower Confidence)

- **`handleBackendNonStreamingResponse` success path has no body size cap** - `src/translation/proxy/translation-proxy.ts:465-466` (Confidence: 65%) -- The error path correctly caps accumulated bytes at `MAX_ERR_BYTES`, but the success path (`const chunks: Buffer[]`) accumulates without limit. The inbound `readBody` has a 50MB cap, but there is no corresponding cap on the backend response body. A malicious or misconfigured backend could return an unbounded response. Low practical risk since the proxy only connects to a configured backend.

- **`PromptCacheState` shared mutable state has no concurrency guard** - `src/translation/middleware/prompt-cache.ts:24-26` (Confidence: 65%) -- `PromptCacheState.lastPrefixHash` is mutated by concurrent request middleware instances without synchronization. In Node.js single-threaded runtime this is safe for simple property assignments, but if the middleware ever becomes async or the proxy is used in a worker_threads context, this could produce stale reads. The current design is correct for the single-threaded model.

- **`as const satisfies` on `TRANSLATE_TARGETS` could replace all `as` casts downstream** - `src/core/configuration.ts:268` (Confidence: 70%) -- The `(TRANSLATE_TARGETS as readonly string[]).includes(record.translate as string)` double-cast could be avoided with a type guard function like `isTranslateTarget(v: unknown): v is TranslateTarget` that internalizes the cast. This would centralize the boundary validation and remove the two `as` casts.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**TypeScript Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The changes demonstrate good TypeScript practices overall: const tuple with `satisfies` for `TRANSLATE_TARGETS`, proper narrowing in the openai-codec (replacing `as number` with `Map.get()` + `undefined` check), exported `PromptCacheState` interface for shared state, and `StreamCallbackContext` interface to replace loose parameter lists. The one actionable finding is the `as [string, ...string[]]` widening cast in the Zod schema that defeats literal type safety.
