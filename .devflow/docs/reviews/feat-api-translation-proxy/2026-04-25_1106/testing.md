# Testing Review Report

**Branch**: feat/api-translation-proxy -> main
**Date**: 2026-04-25
**Diff**: `git diff b762591...HEAD` (incremental)

## Issues in Your Changes (BLOCKING)

### HIGH

**Bootstrap proxy integration tests lack database isolation** - `tests/unit/translation/proxy/bootstrap-proxy-integration.test.ts:203-239`
**Confidence**: 95%
- Problem: The three `proxy startup by bootstrap mode` tests call `bootstrap({ mode: 'run' })` and `bootstrap({ mode: 'cli' })` without setting `AUTOBEAT_DATABASE_PATH` to a temp directory. This causes bootstrap to create/use the production database at `~/.autobeat/autobeat.db`. All existing integration tests that call `bootstrap()` set `process.env.AUTOBEAT_DATABASE_PATH = join(tempDir, 'test.db')` (see `service-initialization.test.ts:29`, `:155`, `:224`, `:296`) to avoid polluting the user's real database. Additionally, these tests do not inject `processSpawner` or `resourceMonitor`, which means bootstrap creates a real `SystemResourceMonitor` that starts a polling interval after 2 seconds -- a potential source of leaked timers if `dispose()` doesn't clean them fast enough.
- Fix: Follow the established pattern from `service-initialization.test.ts`:
```typescript
beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'autobeat-proxy-bootstrap-'));
  restoreConfig = _testSetConfigDir(tempDir);
  process.env.AUTOBEAT_DATABASE_PATH = join(tempDir, 'test.db');
});

afterEach(async () => {
  restoreConfig();
  delete process.env.AUTOBEAT_DATABASE_PATH;
  await rm(tempDir, { recursive: true, force: true });
});
```
  Also consider injecting `resourceMonitor: new TestResourceMonitor()` to avoid spawning the real SystemResourceMonitor.

### MEDIUM

**Duplicate test coverage for deriveModeFlags skipProxy** - `tests/unit/translation/proxy/bootstrap-proxy-integration.test.ts:164-176` and `tests/integration/service-initialization.test.ts:388-398`
**Confidence**: 82%
- Problem: The `deriveModeFlags skipProxy` describe block in `bootstrap-proxy-integration.test.ts` tests the exact same three assertions (server=false, run=false, cli=true) that are already covered by the `it.each` in `service-initialization.test.ts:389-397` (which was updated in this diff to include `skipProxy`). This is redundant test coverage for a pure function.
- Fix: Remove the `deriveModeFlags skipProxy` describe block from `bootstrap-proxy-integration.test.ts`. The `service-initialization.test.ts` parametric test already covers all three modes with all flags including `skipProxy`.

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

_No issues found._

## Suggestions (Lower Confidence)

- **Bootstrap proxy tests could assert proxy port is valid** - `tests/unit/translation/proxy/bootstrap-proxy-integration.test.ts:210` (Confidence: 65%) -- The "starts proxy in run mode" test only checks `container.get('proxyManager').ok === true` but does not verify the proxy is actually listening (e.g., by checking `proxyManager.proxyUrl` or the port). Verifying port availability would make the test more behavior-focused.

- **Middleware test stream event shape update lacks explicit assertion on new shape** - `tests/unit/translation/middleware/middleware.test.ts:35,63-64` (Confidence: 62%) -- The `makeStreamEvent` helper and `makeStreamTagger` were updated to use the new flat `{ text }` shape instead of the old `{ delta: { type: 'text_delta', text } }` shape, which correctly aligns with the IR type change. However, no test explicitly validates that the old nested shape is rejected, which would prevent regressions if someone accidentally reintroduces the nested format.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Testing Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The new tests demonstrate good behavior-focused testing patterns -- the prompt-cache shared state tests (`shared state enables cache hit detection across middleware instances`, `without shared state, separate instances cannot detect cache hits`, `shared state reflects changed prefix`) verify the exact cross-request behavior that the production `middlewareFactory` + `PromptCacheState` design enables. The bootstrap proxy integration tests cover the key mode-gating behavior (DD1).

The blocking HIGH issue is the missing database isolation in the bootstrap proxy tests. Running these tests writes to the user's production database rather than a temp directory, violating the test isolation pattern established by all other bootstrap integration tests. This should be fixed before merge.
