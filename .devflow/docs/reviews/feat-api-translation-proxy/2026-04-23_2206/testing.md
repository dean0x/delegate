# Testing Review Report

**Branch**: feat/api-translation-proxy -> main
**Date**: 2026-04-23

## Issues in Your Changes (BLOCKING)

### HIGH

**Missing unit tests for middleware pipeline runner functions (3 exported functions)** - `src/translation/middleware/middleware.ts:27-59`
**Confidence**: 90%
- Problem: The `runRequestMiddleware`, `runResponseMiddleware`, and `runStreamEventMiddleware` functions are new public API with meaningful logic (ordering, reverse ordering, null-drop behavior) but have zero direct unit tests. The ordering contract ("request = first-to-last, response/stream = last-to-first") and the null-drop behavior in `runStreamEventMiddleware` are critical correctness invariants that are only tested indirectly through the integration-level `translation-proxy.test.ts` (which passes empty middleware arrays `[]`).
- Fix: Add a dedicated test file `tests/unit/translation/middleware/middleware.test.ts` with tests:
  1. Request middleware runs in forward order
  2. Response middleware runs in reverse order
  3. Stream event middleware runs in reverse order
  4. `runStreamEventMiddleware` returns `null` when a middleware drops the event
  5. Middleware without `processRequest`/`processResponse` methods are skipped safely

### MEDIUM

**No tests for proxy error paths: 405, 404, invalid JSON, connection refused, backend parse failure** - `src/translation/proxy/translation-proxy.ts:204-221,288-292,386-398,420-434`
**Confidence**: 85%
- Problem: `TranslationProxy.handleRequest` has five distinct error branches that are untested:
  - 405 (non-POST method)
  - 404 (unknown endpoint)
  - 400 (invalid JSON body)
  - 502 (backend connection refused / ECONNREFUSED)
  - 502 (backend returns invalid JSON)
  These are all reachable code paths introduced in this PR. The integration tests cover happy paths (200 round-trip), error status mapping (401/429/500), and body-too-large (413) but miss these five.
- Fix: Add tests in `translation-proxy.test.ts`:
  ```typescript
  it('returns 405 for non-POST methods', async () => { /* GET request */ });
  it('returns 404 for unknown endpoints', async () => { /* POST /v1/unknown */ });
  it('returns 400 for invalid JSON body', async () => { /* POST with 'not json' */ });
  it('returns 502 when backend is unreachable', async () => { /* backend on closed port */ });
  it('returns 502 when backend returns invalid JSON', async () => { /* backend returns 'not json' */ });
  ```

**No test for streaming JSON fallback path** - `src/translation/proxy/translation-proxy.ts:499-541`
**Confidence**: 82%
- Problem: The `handleStreamingRequest` method has a `isJsonFallback` branch that handles backends returning `application/json` when the proxy expected `text/event-stream`. This is a real scenario (some backends downgrade streaming requests to non-streaming). The streaming test only covers the happy SSE path.
- Fix: Add a test where the backend returns `Content-Type: application/json` with a full completion response to a streaming request, and verify the proxy translates it correctly.

**PromptCacheMiddleware test has weak assertion** - `tests/unit/translation/middleware/prompt-cache.test.ts:141`
**Confidence**: 80%
- Problem: The "does not add cache tokens if already present" test asserts `expect(processed.usage.cacheReadInputTokens).toBeGreaterThanOrEqual(0)` which passes for any non-negative number, including the original value of 15. This assertion does not actually verify the middleware's behavior of not double-counting -- it would pass even if the middleware doubled the value to 30.
- Fix: Assert the exact expected value:
  ```typescript
  // Backend reported 15 cache tokens; middleware should preserve, not add to it
  expect(processed.usage.cacheReadInputTokens).toBe(15);
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**ProxiedClaudeAdapter test uses subclass to test protected method -- consider testing via observable behavior instead** - `tests/unit/translation/proxy/proxied-claude-adapter.test.ts:16-20`
**Confidence**: 80%
- Problem: `TestableProxiedClaudeAdapter` exposes the `protected resolveBaseUrl` method for testing. While the architecture note explains this is intentional (avoiding child_process mocking issues with `isolate: false`), testing protected methods through a subclass is a testing anti-pattern per the project's own CLAUDE.md guidelines ("test behaviors, not implementation"). The actual observable behavior -- that Claude Code processes get `ANTHROPIC_BASE_URL` set to the proxy -- is what matters.
- Fix: This is a pragmatic trade-off documented in the test file header. Acceptable as-is given the `isolate: false` constraint, but consider adding a comment `// DECISION: Subclass exposure chosen over child_process mocking due to isolate:false` at the class definition for clarity.

**bootstrap-proxy-integration.test.ts has large config object boilerplate** - `tests/unit/translation/proxy/bootstrap-proxy-integration.test.ts:133-151`
**Confidence**: 80%
- Problem: The `ProxiedClaudeAdapter` instantiation test at line 133-154 inlines a 19-line Configuration object literal. This is repeated across multiple test files (`proxied-claude-adapter.test.ts` has a similar one). Setup boilerplate >10 lines is a test design red flag per the testing skill.
- Fix: Extract a shared `makeTestConfig()` helper in a test utility file, or use `Partial<Configuration>` with defaults:
  ```typescript
  const testConfig = makeTestConfig({ logLevel: 'info' });
  ```

## Pre-existing Issues (Not Blocking)

No pre-existing critical issues identified in the reviewed scope.

## Suggestions (Lower Confidence)

- **No test for concurrent proxy requests** - `translation-proxy.test.ts` (Confidence: 70%) -- The proxy is an HTTP server that may receive concurrent requests. No test verifies correct behavior under concurrent load (e.g., two requests in flight simultaneously).

- **OpenAI codec `serializeResponse` returns hardcoded error** - `openai-codec.test.ts` (Confidence: 65%) -- The `OpenAICodec.serializeResponse()` method returns an error (not implemented), and `AnthropicCodec.serializeRequest()` similarly. These methods exist on the `FormatCodec` interface but are dead code in the current proxy architecture. No tests verify they return errors when called. Low priority since they are unused, but completeness would catch accidental invocation.

- **No test for the `LoggingMiddleware.processResponse` latency metric** - `logging.test.ts` (Confidence: 65%) -- The logging middleware tracks `requestStartTime` in `processRequest` and presumably logs elapsed time in `processResponse`. The test verifies token counts and stop reason are logged, but does not verify latency/timing is logged.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 3 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Testing Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The test suite is strong overall -- 12 test files covering codecs, middleware, proxy, and integration with good edge case coverage (malformed JSON, error status mapping, streaming, tool call handling). The main gap is the untested middleware pipeline runner which contains ordering logic critical to correctness. The proxy error path coverage and the weak prompt cache assertion are secondary but worthwhile fixes before merge.
