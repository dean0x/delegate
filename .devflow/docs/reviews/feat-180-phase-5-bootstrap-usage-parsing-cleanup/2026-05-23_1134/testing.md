# Testing Review Report

**Branch**: feat/180-phase-5-bootstrap-usage-parsing-cleanup -> main
**Date**: 2026-05-23

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

### MEDIUM

**Missing test coverage for `sendKeys` failure fallback in `reuseSession`** - `src/implementations/event-driven-worker-pool.ts:388-397`
**Confidence**: 82%
- Problem: The `reuseSession` method has a failure path when `sendKeys` fails after `/clear` and env updates succeed (lines 388-397). This path calls `cleanupPersistentSession(key)` and returns `ok(null)` to fall through to fresh spawn. The existing test (`reuseSession failure (setEnvironment error) falls through...`) only covers the `setEnvironment` failure path. The `sendKeys` failure after successful env update is a distinct code path that is not tested.
- Fix: Add a test that makes `sendKeys` fail on the second invocation (after `/clear` succeeds) and verifies the session is destroyed and a fresh spawn occurs:
```typescript
it('sendKeys failure after /clear falls through to fresh spawn', async () => {
  const task1 = buildPersistentTask('loop-sendkeys-fail', (f) => f.withPrompt('iter 1'));
  const task2 = buildPersistentTask('loop-sendkeys-fail', (f) => f.withPrompt('iter 2'));

  await pool.spawn(task1);

  // /clear sendKeys succeeds, but prompt sendKeys fails
  (tmuxConnector.sendKeys as ReturnType<typeof vi.fn>)
    .mockReturnValueOnce(ok(undefined)) // /clear succeeds
    .mockReturnValueOnce(err(new AutobeatError(ErrorCode.TMUX_SEND_KEYS_FAILED, 'prompt send failed')));

  const result = await Promise.all([pool.spawn(task2), vi.advanceTimersByTimeAsync(400)]);
  expect(result[0].ok).toBe(true);
  expect(tmuxConnector.spawn).toHaveBeenCalledTimes(2);
});
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`_simulateOutput` uses task1.id after session is reused to task2 -- semantically misleading test** - `tests/unit/implementations/event-driven-worker-pool.test.ts:1003`
**Confidence**: 80%
- Problem: In the `onOutput callback routes output to the current iteration task, not the original` test, `_simulateOutput` is called with `task1.id` to simulate output arriving on the reused session. This works because the mock connector keys callbacks by the original task ID, but it is semantically misleading -- the intent is "output arrives on the session", not "output arrives for task1." A reader unfamiliar with the mock internals might misunderstand what the test verifies. The same pattern appears in the onExit and completionHandled tests (lines 1025, 1053, 1055).
- Fix: Consider adding a brief inline comment on the `_simulateOutput` call explaining why `task1.id` is used (the mock stores callbacks keyed by the original spawn task ID), or expose a session-name-based simulation method. The existing comments (line 1024) partially cover this for the exit test but not for the output test.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**No unit tests for `buildSetupShim` defense-in-depth validation** - `src/implementations/tmux/tmux-hooks.ts:170-174`
**Confidence**: 85%
- Problem: A defense-in-depth validation was added to `buildSetupShim` (throws on unsafe `agentCommand`). The `tmux-hooks.ts` module has zero test coverage in the test suite -- there are no test files for TmuxHooks at all. The outer `generateSetupShim()` function already validates, so this is a second layer of defense, but the behavior of throwing (rather than returning a Result) is untested.

**No unit tests for `orchestrate-interactive.ts` extracted functions** - `src/cli/commands/orchestrate-interactive.ts:105-274`
**Confidence**: 83%
- Problem: The refactoring extracted `validateTmux()`, `resolveContainerDeps()`, and `spawnAndDeliverPrompt()` as standalone functions. These contain significant logic (TmuxValidator instantiation, AUTOBEAT_WORKER stripping, exitPromise setup, cleanup-on-failure paths). The interactive orchestrator test file (`tests/unit/interactive-orchestrator.test.ts`) tests parsing and service-layer behavior but does not test these extracted CLI-layer functions. Since they call `process.exit(1)` on failure, they are inherently difficult to test, but the `validateTmux` function's switch to TmuxValidator and the AUTOBEAT_WORKER stripping logic could be tested in isolation.

## Suggestions (Lower Confidence)

- **Persistent session `persistent: true` config flag not directly asserted in tests** - `tests/unit/implementations/event-driven-worker-pool.test.ts` (Confidence: 68%) -- When a task has `persistentSessionKey`, spawn passes `{ ...config, persistent: true }` to `tmuxConnector.spawn`. No test asserts that the config passed to the mock connector contains `persistent: true`. This is a low risk since the integration path is tested, but an explicit assertion would document the contract.

- **Flushing behavior after session reuse not tested** - `src/implementations/event-driven-worker-pool.ts:723-735` (Confidence: 65%) -- After `reuseSession`, the existing flush interval from the first iteration is still running with a reference to `worker.taskId`. Since `worker.taskId` is now mutable and updated during reuse, the flush interval should automatically use the new task ID. This is implicitly tested but not explicitly asserted.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 2 | 0 |

**Testing Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Assessment

The new Phase 5 persistent session reuse tests are well-structured and thorough. The test suite added 7 new tests covering the critical regression scenarios (stale closure on output/exit, completionHandled reset, concurrent reuse guard, setEnvironment fallback, and task ID remapping). These are genuine behavior-focused regression tests that follow the Arrange-Act-Assert pattern and avoid implementation coupling.

Strengths:
- Regression tests for stale-closure bugs are correctly designed: they verify output attribution and event emission target the correct task ID after session reuse
- The concurrent spawn test validates the `reuseInProgress` guard with a realistic multi-Promise setup
- Tests use fake timers correctly to advance the 300ms settle delay
- The `buildPersistentTask` helper keeps test setup clean (under 10 lines)
- MockFactory.workerPool correctly updated with `cleanupPersistentSession`
- Bootstrap proxy integration tests correctly inject mock tmux connector

The one blocking MEDIUM issue (missing sendKeys failure fallback test) represents a small gap in the Phase 5 error path coverage. The production code handles this correctly, but having an explicit test would prevent regressions if the fallback logic is modified.
