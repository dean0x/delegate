# Performance Review Report

**Branch**: feat/api-translation-proxy -> main
**Date**: 2026-04-24

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

### MEDIUM

**Per-request middleware factory allocates 3 objects on every request** - `src/translation/proxy/translation-proxy.ts:347`
**Confidence**: 82%
- Problem: `this.config.middlewareFactory()` is called on every inbound request (line 347), creating 3 fresh middleware instances (`ToolNameMappingMiddleware`, `PromptCacheMiddleware`, `LoggingMiddleware`) per request. Under high concurrency this creates GC pressure from short-lived allocations. The DECISION comment justifies this as necessary to avoid shared mutable state across concurrent requests, which is correct -- but two of the three middlewares (`ToolNameMappingMiddleware` and `PromptCacheMiddleware`) may hold per-request state that could instead be reset via a `reset()` method on a pooled instance.
- Fix: This is a design trade-off already documented in the codebase. For the current load profile (local proxy serving a single Claude Code process), the allocation cost is negligible. If concurrency grows, consider object pooling or adding a `reset()` method to stateful middlewares. No change needed now -- flagged as MEDIUM for awareness.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`runResponseMiddleware` still creates a reversed copy per call** - `src/translation/middleware/middleware.ts:41`
**Confidence**: 85%
- Problem: The stream path was correctly optimized in `StreamTranslator` to pre-compute the reversed middleware array once at construction (line 22-26 of `stream-translator.ts`). However, `runResponseMiddleware` at `middleware.ts:41` still calls `[...middlewares].reverse()` on every non-streaming response. The same optimization pattern (pre-compute reversed array) should be applied for consistency. For non-streaming requests this is called once per request so the impact is minimal, but it is an inconsistency with the stated DECISION pattern.
- Fix: Pre-compute the reversed middleware array in `TranslationProxy.handleMessages` alongside the fresh middleware factory call and pass it to `processNonStreamingResponse`, or create a small helper that caches the reversed array. Alternatively, since non-streaming responses call this exactly once per request, the cost of one `[...arr].reverse()` on a 3-element array is truly negligible -- acknowledge and move on.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`LineBuffer.feed()` uses string concatenation for buffering** - `src/translation/proxy/line-buffer.ts:18`
**Confidence**: 80%
- Problem: `this.buffer += chunk` at line 18 uses string concatenation for the SSE line buffer. For very long streaming responses where chunks arrive frequently, this pattern creates increasingly large intermediate strings that must be copied each time. The line scanning loop (lines 21-34) also operates on the growing string with `.slice()`.
- Fix: For the typical proxy use case (SSE lines are short and the buffer is drained frequently), string concatenation is adequate. If profiling reveals this as a bottleneck under sustained high-throughput streaming, consider switching to an array-of-chunks approach with a join on demand.

## Suggestions (Lower Confidence)

- **SSE output batching could use a single `Buffer.concat` instead of `join('')`** - `src/translation/proxy/translation-proxy.ts:569` (Confidence: 65%) -- The batched write optimization (`output.join('')`) is a good improvement over per-line `res.write()` calls. For very high throughput, pre-allocating a Buffer and writing bytes directly could save one intermediate string allocation, but this is a micro-optimization unlikely to matter in practice.

- **`extractBackendErrorMessage` parses full error body into JSON on every error** - `src/translation/proxy/translation-proxy.ts:147` (Confidence: 62%) -- `Buffer.concat(chunks).toString('utf-8')` followed by `JSON.parse` on error paths is fine since errors are infrequent. No action needed.

- **`countApproxChars` iterates all messages twice for system prompt** - `src/translation/proxy/translation-proxy.ts:173-200` (Confidence: 60%) -- The function iterates `messages` and then checks `system`. This is a single pass with O(n) complexity which is fine. The separate system check is not a second iteration of messages.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Performance Score**: 8/10
**Recommendation**: APPROVED

Key positive performance observations:

1. **Batched SSE writes** (`translation-proxy.ts:560-570`): The refactored `handleSseStream` collects all translated SSE lines from a backend chunk into a single array and writes once with `res.write(output.join(''))`. This is a meaningful improvement over the prior per-line `res.write()` pattern, reducing syscalls during streaming.

2. **Pre-computed reversed middleware array** (`stream-translator.ts:22-33`): The `StreamTranslator` now pre-computes `this.reversedMiddlewares` at construction instead of calling `[...middlewares].reverse()` on every SSE chunk. Given that `applyMiddleware` is called hundreds/thousands of times per streaming response, this eliminates a repeated allocation in the hot path.

3. **Per-request middleware factory** (`translation-proxy.ts:345-347`): Correctly avoids shared mutable state across concurrent requests. The allocation cost of 3 lightweight middleware objects per request is negligible for the expected load profile.

4. **Proxy-only-in-server-mode guard** (`bootstrap.ts:382`): Prevents proxy startup overhead in CLI/run modes where it is unnecessary.

5. **Extracted helper methods** in `OpenAIStreamParser` (`openai-codec.ts:284-368`): `closeActiveTextBlock`, `closeActiveToolCall`, `processToolCallDeltas` are clean refactors that do not add overhead -- they return empty arrays early when no work is needed.

Overall, this PR improves streaming performance through batched writes and pre-computed middleware ordering, and the middleware factory pattern is a correct trade-off for concurrency safety. No blocking performance issues found.
