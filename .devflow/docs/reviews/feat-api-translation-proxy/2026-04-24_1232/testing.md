# Testing Review Report

**Branch**: feat/api-translation-proxy -> main
**Date**: 2026-04-24

## Issues in Your Changes (BLOCKING)

### MEDIUM

**StreamTranslator.applyMiddleware duplicates runStreamEventMiddleware logic without dedicated test coverage** - `src/translation/proxy/stream-translator.ts:100-109`
**Confidence**: 85%
- Problem: The `applyMiddleware` method was refactored from delegating to `runStreamEventMiddleware(this.middlewares, event)` to an inlined loop over `this.reversedMiddlewares`. This is a performance optimization (pre-computing the reversed array in the constructor), but the existing `stream-translator.test.ts` constructs all translators with an empty middleware array (`[]`). No test exercises the `StreamTranslator` with a non-empty middleware pipeline, meaning this inlined logic (null-short-circuit, processStreamEvent dispatch) is untested at the `StreamTranslator` level.
- Fix: Add a test in `stream-translator.test.ts` that constructs a `StreamTranslator` with at least one middleware that modifies or drops stream events, and verifies the middleware is applied during `processLine` and `flush`. Example:
  ```typescript
  it('applies middleware to stream events', () => {
    const dropper: TranslationMiddleware = {
      name: 'dropper',
      processStreamEvent: () => null,
    };
    const translator = new StreamTranslator(
      anthropicCodec.createStreamSerializer(),
      openaiCodec.createStreamParser(),
      [dropper],
    );
    // Process a text delta chunk -- middleware should drop it
    const lines = translator.processLine(`data: ${JSON.stringify(textChunk)}`);
    expect(lines).toEqual([]);
  });
  ```

**Existing "unsupported translate target" test now passes for wrong reason** - `tests/unit/translation/proxy/bootstrap-proxy-integration.test.ts:106-122`
**Confidence**: 82%
- Problem: The test "returns null for unsupported translate target" with `translate: 'gemini-native'` still passes, but the *reason* it passes changed. Before this PR, `loadProxyConfig` had an explicit `SUPPORTED_TRANSLATE_TARGETS.includes()` check that rejected unknown targets. Now, it passes because `loadAgentConfig` in `configuration.ts:258` only recognizes `'openai'` as a valid translate value (returning `undefined` for anything else), and then `!agentConfig.translate` is truthy, so `loadProxyConfig` returns null at line 67. The test name and comment still imply a proxy-manager-level validation that no longer exists. While the behavior is correct, the test documents a contract that now lives in a different module.
- Fix: Update the test name and/or add a comment clarifying the validation now happens in `loadAgentConfig` (not proxy-manager). Optionally add a unit test for `loadAgentConfig` verifying it returns `translate: undefined` for non-`'openai'` values.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**No unit tests for `extractBackendErrorMessage` helper** - `src/translation/proxy/translation-proxy.ts:145-157`
**Confidence**: 85%
- Problem: The new `extractBackendErrorMessage` function handles four cases: empty body, valid JSON with `error.message`, valid JSON with `message`, and non-JSON text. It also applies a 500-character truncation. This function is exercised indirectly through integration tests (`forwards non-JSON backend error as raw text`, `falls back to generic message on empty error body`, `truncates long backend error messages`), but those tests are heavyweight (spin up HTTP servers). A direct unit test would verify all branches cheaply and be more resilient to integration test regressions.
- Fix: Either export `extractBackendErrorMessage` for direct testing, or verify the integration tests cover all branches (they currently do cover 4 of 4 paths: JSON with `error.message`, raw text, empty body, truncation). This is low urgency given the integration coverage is adequate.

**No unit tests for `countApproxChars` helper** - `src/translation/proxy/translation-proxy.ts:173-201`
**Confidence**: 80%
- Problem: The `countApproxChars` function was extracted from inline code in `handleCountTokens`. It handles non-object input, string content, array content with text blocks, and system strings. The only test exercising this is the integration test `returns token count estimate for /v1/messages/count_tokens` which sends a single simple message. Edge cases like array content blocks, system strings, and non-object input are not tested.
- Fix: Export `countApproxChars` and add targeted unit tests, or add more count_tokens integration tests with varied inputs (system prompt, array content blocks, non-text blocks).

## Pre-existing Issues (Not Blocking)

### LOW

**StreamTranslator tests all use empty middleware array** - `tests/unit/translation/proxy/stream-translator.test.ts:12`
**Confidence**: 90%
- Problem: Every test in `stream-translator.test.ts` creates translators via `makeTranslator()` which passes `[]` for middlewares. The middleware integration path through `StreamTranslator` is never tested at the unit level, only through the full proxy integration tests.
- Fix: Add at least one test with a non-trivial middleware to the stream-translator test suite.

## Suggestions (Lower Confidence)

- **Bootstrap mode guard test gap** - `src/bootstrap.ts:382` (Confidence: 70%) -- The new condition `(options.mode ?? 'server') === 'server'` that skips proxy startup in CLI/run modes is not covered by any test. The `bootstrap-proxy-integration.test.ts` only tests `loadProxyConfig`, not the bootstrap function itself. This could be tested by calling bootstrap with `mode: 'cli'` and verifying no proxy is started.

- **Translation proxy test helper boilerplate** - `tests/unit/translation/proxy/translation-proxy.test.ts` (Confidence: 65%) -- The HTTP request helper pattern (create `http.request`, collect chunks, resolve promise) is repeated ~15 times across the proxy tests. A shared `makeProxyRequest(port, options)` helper would reduce boilerplate and improve readability.

- **`middlewareFactory` not tested for per-request isolation** - `src/translation/proxy/translation-proxy.ts:347` (Confidence: 65%) -- The DECISION comment explains that `middlewareFactory` produces fresh instances per request to avoid shared mutable state across concurrent requests. No test validates this concurrency guarantee (e.g., sending two concurrent requests and verifying middleware state is isolated). This would be a valuable integration test to prevent future regressions.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 1 |

**Testing Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The test suite is well-structured and comprehensive for the new features. The new middleware runner tests (`middleware.test.ts`) are exemplary -- clean factory helpers, clear AAA structure, and strong behavioral coverage of ordering, short-circuiting, and no-op skip behavior. The new OpenAI codec stream parser tests for tool-call-after-text scenarios are precisely targeted at the bug fix. The proxy integration tests cover error paths, non-JSON fallback, and streaming fallback thoroughly.

The main gaps are: (1) the `StreamTranslator` middleware path is never tested with actual middleware at the unit level, and (2) the extracted helpers (`extractBackendErrorMessage`, `countApproxChars`) rely on integration tests for coverage. These are non-blocking because the integration tests provide adequate coverage, but unit-level tests would improve resilience and test isolation.
