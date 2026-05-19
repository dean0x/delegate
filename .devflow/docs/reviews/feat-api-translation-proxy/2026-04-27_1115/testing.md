# Testing Review Report

**Branch**: feat/api-translation-proxy -> main
**Date**: 2026-04-27

## Issues in Your Changes (BLOCKING)

### HIGH

**Missing test for `deriveModeFlags` skipProxy regression** - `tests/unit/translation/proxy/bootstrap-proxy-integration.test.ts:164-176`
**Confidence**: 90%
- Problem: The diff removes the `deriveModeFlags skipProxy` describe block (lines 164-176 in the old file) which explicitly tested all three modes (server=false, run=false, cli=true). This block is gone in the new version. While a similar test exists in `tests/integration/service-initialization.test.ts:396`, the unit-level test for the proxy-specific bootstrap file has been deleted without replacement. This is a regression in test coverage for a function that determines whether the proxy starts.
- Fix: The `deriveModeFlags` skipProxy tests were likely removed because they were simple pass-through tests of a pure function already covered in integration tests. If this was intentional, no fix needed. However, if the removal was accidental (e.g., during a diff rebase), restore the block:
  ```typescript
  describe('deriveModeFlags skipProxy', () => {
    it('enables proxy in server mode', () => {
      expect(deriveModeFlags('server').skipProxy).toBe(false);
    });
    it('enables proxy in run mode', () => {
      expect(deriveModeFlags('run').skipProxy).toBe(false);
    });
    it('skips proxy in cli mode', () => {
      expect(deriveModeFlags('cli').skipProxy).toBe(true);
    });
  });
  ```

### MEDIUM

**No test for bootstrap `NODE_MODULE_VERSION` error path** - `src/bootstrap.ts:256-275`
**Confidence**: 82%
- Problem: The bootstrap function now has a new try/catch around database creation that returns a specific `AutobeatError` when `better-sqlite3` is compiled for a different Node.js version (checking `msg.includes('NODE_MODULE_VERSION')`). This error path has no test coverage. The change is significant because it replaces `registerSingleton` (lazy) with `registerValue` (eager) for the database, which changes when the native module is loaded.
- Fix: Add a test that verifies the error message format when the database factory throws a `NODE_MODULE_VERSION` error. This can be done with a unit test that mocks the `Database` constructor:
  ```typescript
  it('returns structured error when better-sqlite3 has version mismatch', async () => {
    // Mock Database constructor to throw NODE_MODULE_VERSION error
    // Verify result.ok === false and error message contains 'npm rebuild'
  });
  ```

**No test for CLI `agents config set` probe integration** - `src/cli/commands/agents.ts:159-180`
**Confidence**: 80%
- Problem: The CLI `agentsConfigSet` function now calls `probeUrl` after setting `baseUrl`, `apiKey`, or `translate` fields. This code path -- which includes dynamic import, conditional probe execution, and user-facing output via `ui.success`/`ui.note` -- has no dedicated test coverage. The MCP adapter equivalent IS tested (in `mcp-adapter.test.ts`), but the CLI path is a separate code path with its own logic (dynamic import, different output format).
- Fix: Consider adding a test for `agentsConfigSet` that mocks `probeUrl` and verifies: (1) probe is called when `baseUrl` is set, (2) probe is NOT called when `model` is set, (3) appropriate output is shown for ok/warning/error severity. Since this is a CLI entry point with `process.exit` calls, it may be more practical to test the probe logic at the MCP level (which is already done) and accept the CLI gap.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Global `vi.mock` + `beforeEach` in mcp-adapter test introduces coupling risk** - `tests/unit/adapters/mcp-adapter.test.ts:60-79`
**Confidence**: 82%
- Problem: Adding a top-level `vi.mock('../../../src/utils/url-probe.js')` and a global `beforeEach` that sets the mock return value affects ALL tests in this file (3300+ lines). The global beforeEach sets `probeUrl` to return a successful result, which means every existing test now runs with this mock active. While the default return value (reachable: true) is correct for "no impact" on non-probe tests, it introduces a subtle dependency: if any existing test imports `url-probe.js` transitively, the mock will interfere. This is a known Vitest footgun with `vi.mock` at module level.
- Fix: The current approach is pragmatic given the file size. The `beforeEach` default is well-chosen (ok/reachable). Document the coupling explicitly in a comment and consider extracting the ConfigureAgent probe tests to a separate file to reduce blast radius:
  ```
  // NOTE: vi.mock('url-probe.js') is global to this file. All tests run with probeUrl mocked.
  // If adding tests that need the real probeUrl, extract to a separate test file.
  ```

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Integration test for bootstrap proxy uses real database** - `tests/unit/translation/proxy/bootstrap-proxy-integration.test.ts:182`
**Confidence**: 85%
- Problem: The test now sets `process.env.AUTOBEAT_DATABASE_PATH` in beforeEach/afterEach to isolate the database to a temp directory. While this fix is correct (prevents polluting the real database), the test is technically an integration test (it calls `bootstrap()`) living in the `tests/unit/` directory. This is a naming/organization issue, not a correctness issue.

## Suggestions (Lower Confidence)

- **Missing edge case: probe timeout in MCP adapter `check` action** - `tests/unit/adapters/mcp-adapter.test.ts:3441` (Confidence: 70%) -- The `check` action tests verify `connectivity` is present/absent, but do not test behavior when `probeUrl` takes longer than 5000ms (the configured timeout). Since this is an async operation in a tool handler, a hung probe could block the MCP response.

- **No test for streaming with `reasoning_content` through the full proxy stack** - `tests/unit/translation/proxy/translation-proxy.test.ts` (Confidence: 65%) -- The OpenAI codec stream parser tests thoroughly cover `reasoning_content` (thinking block lifecycle), but the full proxy round-trip test only covers text streaming. A streaming round-trip with `reasoning_content` would validate that thinking events survive the full codec-to-SSE-to-Anthropic pipeline.

- **`flush()` on OpenAI stream parser with open text block untested** - `tests/unit/translation/codecs/openai-codec.test.ts` (Confidence: 65%) -- The `flush()` test verifies it closes open thinking blocks, but does not test `flush()` when a text `content_start` was emitted without a `content_stop`. If the stream is interrupted mid-text, `flush()` behavior for text blocks is not covered.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Testing Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The test coverage for the new code is strong. New features have dedicated test suites:
- `url-probe.test.ts` (417 lines) covers real loopback servers, DI mocks for network errors, deep probe lifecycle, timeout, malformed URLs, and all severity levels.
- `openai-codec.test.ts` adds comprehensive thinking block lifecycle tests (12 new tests covering start/stop ordering, sequential indices, flush behavior, mixed content types).
- `anthropic-codec.test.ts` adds thinking_start/thinking_stop/thinking_delta serializer tests.
- `mcp-adapter.test.ts` adds 5 ConfigureAgent probe integration tests covering reachable, unreachable, stored URL, model-only change, and error propagation.
- `translation-proxy.test.ts` adds HEAD health check, query string stripping, and path prefix preservation tests.
- `proxied-claude-adapter.test.ts` adds resolveModel/resolveAuth override tests.

The one HIGH finding (removed `deriveModeFlags` unit tests) should be confirmed as intentional before merge. The two MEDIUM findings (untested bootstrap error path and CLI probe path) are acceptable gaps given the MCP-level coverage exists for the probe logic.
