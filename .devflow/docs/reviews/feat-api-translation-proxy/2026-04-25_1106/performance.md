# Performance Review Report

**Branch**: feat/api-translation-proxy -> main
**Date**: 2026-04-25
**Diff**: `git diff b762591...HEAD` (incremental)

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Unbounded buffer accumulation in JSON fallback handler** - `src/translation/proxy/translation-proxy.ts:465-466`
**Confidence**: 85%
- Problem: The `handleJsonFallback` method accumulates response chunks without any size cap (`const chunks: Buffer[] = []; backendRes.on('data', (chunk: Buffer) => chunks.push(chunk));`). While the non-streaming success path (`handleBackendNonStreamingResponse` at line 465) has the same pattern, the error path correctly caps accumulation at `MAX_ERR_BYTES` (64KB). A malformed backend that returns `application/json` content-type with an enormous body (not an error status) would accumulate unbounded memory. The `readBody` function for inbound requests already enforces `MAX_BODY_BYTES` (50MB), but outbound response bodies have no equivalent guard.
- Impact: Under adversarial or buggy backend conditions, a single streaming request that falls back to the JSON path could accumulate arbitrarily large response data in memory. Practically low risk since the backend is a configured API endpoint, but the pattern is inconsistent with the defensive error-path approach introduced in this diff.
- Fix: Apply a size cap consistent with `MAX_BODY_BYTES` to the success-path chunk accumulator, or reuse `readBody`-style logic. Example:
  ```typescript
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  backendRes.on('data', (chunk: Buffer) => {
    totalBytes += chunk.length;
    if (totalBytes <= MAX_BODY_BYTES) {
      chunks.push(chunk);
    }
  });
  ```

## Issues in Code You Touched (Should Fix)

No issues found at this confidence level.

## Pre-existing Issues (Not Blocking)

No critical pre-existing performance issues in changed files.

## Suggestions (Lower Confidence)

- **SHA-256 per request for prefix hashing** - `src/translation/middleware/prompt-cache.ts:55` (Confidence: 65%) -- `hashPrefix` computes a full SHA-256 digest on every request. For metrics-only cache detection, a faster non-cryptographic hash (e.g., FNV-1a or xxHash) would reduce CPU overhead per request. Low practical impact since system prompt strings are typically small.

- **`runResponseMiddleware` array reversal on every call** - `src/translation/middleware/middleware.ts:41` (Confidence: 70%) -- The comment at line 49-51 already acknowledges this: production streaming pre-computes the reversed array. However, the non-streaming response path (`processNonStreamingResponse` at translation-proxy.ts:419) still calls `runResponseMiddleware` which allocates a reversed copy per response. Since non-streaming is the less common path, impact is minimal.

- **Per-request middleware factory allocation** - `src/translation/proxy/proxy-manager.ts:136-140` (Confidence: 60%) -- Each request instantiates three middleware objects. This is documented as a conscious decision for concurrency safety. Object allocation cost is negligible for the expected request rate.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Performance Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The changes are well-considered for performance: batched SSE writes reduce syscalls, error body accumulation is now capped at 64KB (`MAX_ERR_BYTES`), the `StreamCallbackContext` refactor eliminates parameter-passing overhead, and the shared `PromptCacheState` pattern correctly separates per-request mutable state from cross-request cache tracking without introducing concurrency issues. The proxy startup in `run` mode (DD1) and the shutdown ordering (DD3 -- stop proxy before killing workers) are sound.

The single blocking finding is the inconsistency between the defensive 64KB cap on error bodies and the uncapped success-path buffer in `handleJsonFallback` / `handleBackendNonStreamingResponse`. Addressing this would make the defensive buffering pattern complete across all response paths.
