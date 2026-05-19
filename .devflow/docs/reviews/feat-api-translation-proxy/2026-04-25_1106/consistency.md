# Consistency Review Report

**Branch**: feat/api-translation-proxy -> main
**Date**: 2026-04-25
**Diff**: `git diff b762591...HEAD` (incremental)

## Issues in Your Changes (BLOCKING)

### HIGH

**Inconsistent error type in bootstrap proxy failure path** - `src/bootstrap.ts:399-404`
**Confidence**: 90%
- Problem: Every other `return err(...)` in `bootstrap()` wraps an `AutobeatError` with a structured error code (e.g., `ErrorCode.DEPENDENCY_INJECTION_FAILED`, `ErrorCode.SYSTEM_ERROR`). The new proxy failure path returns `err(new Error(...))` -- a plain `Error` with no error code. This breaks the pattern that callers of `bootstrap()` can rely on `AutobeatError` instances with typed error codes for all failure modes.
- Fix:
  ```typescript
  return err(
    new AutobeatError(
      ErrorCode.CONFIGURATION_ERROR,
      `Translation proxy failed to start: ${proxyResult.error.message}. ` +
        'To work without the proxy, run: beat agents config set claude translate ""',
      { error: proxyResult.error.message },
    ),
  );
  ```

### MEDIUM

**handleBackendNonStreamingResponse uses raw params instead of StreamCallbackContext** - `src/translation/proxy/translation-proxy.ts:436-442`
**Confidence**: 85%
- Problem: The newly extracted `handleBackendNonStreamingResponse` takes `responseTimeout` and `resolve` as separate parameters, while the streaming counterparts (`handleStreamingError`, `handleJsonFallback`, `handleSseStream`) all accept a `StreamCallbackContext` object. This creates an inconsistency in the method signatures within the same class. The `StreamCallbackContext` pattern was introduced in this same diff to consolidate callbacks -- the non-streaming handler was left out.
- Fix: Either extend `StreamCallbackContext` to include `responseTimeout` (if applicable to non-streaming too), or accept that non-streaming has a different lifecycle (no idle timer). If the latter, add a brief comment explaining why non-streaming does not use `StreamCallbackContext`.

**Decision comment tag style inconsistency (DD1/DD2/DD3 identifiers)** - `src/bootstrap.ts:67`, `src/bootstrap.ts:378`, `src/bootstrap.ts:382`, `src/core/container.ts:210`
**Confidence**: 82%
- Problem: Across the codebase, DECISION comments use a plain `DECISION:` prefix (e.g., `// DECISION: Resource monitoring in all modes.`). This diff introduces a new convention with sequential identifiers: `DECISION (DD1)`, `DECISION (DD2)`, `DECISION (DD3)`. No other file in `src/` uses this identifier pattern. The DDn identifiers serve a cross-referencing purpose (DD1 in bootstrap.ts references the same DD1 in the comment block and the test file), but this is a novel convention that deviates from all existing decision comments.
- Fix: Either adopt the DDn convention project-wide (unlikely scope for this PR), or drop the identifiers and use plain `DECISION:` to match existing style. If cross-referencing is important, use the existing pattern of naming the decision descriptively (e.g., `DECISION: Proxy mode gating`).

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

_No issues found._

## Suggestions (Lower Confidence)

- **Duplicate MAX_ERR_BYTES line in diff** - `src/translation/proxy/translation-proxy.ts:50` (Confidence: 70%) -- The diff shows `const MAX_ERR_BYTES = 64 * 1024;` appearing twice at lines 50. This may be a diff rendering artifact, but verify the file does not contain a duplicate declaration.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Consistency Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The changes are well-structured overall: the `TRANSLATE_TARGETS` const tuple extraction is a good single-source-of-truth pattern, the `PromptCacheState` shared state design correctly separates per-request and cross-request concerns, the `StreamCallbackContext` consolidation reduces parameter sprawl, and the `skipProxy` ModeFlags addition follows the existing flag derivation pattern exactly. The primary consistency gap is the plain `Error` return in bootstrap (vs. `AutobeatError` everywhere else in that function), which is a straightforward fix.
