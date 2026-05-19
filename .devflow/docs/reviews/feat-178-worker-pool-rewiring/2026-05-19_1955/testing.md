# Testing Review Report

**Branch**: feat/178-worker-pool-rewiring -> main
**Date**: 2026-05-19

## Issues in Your Changes (BLOCKING)

### HIGH

**Missing adapter cleanup tests after migration to tmux** - `tests/unit/implementations/event-driven-worker-pool.test.ts`
**Confidence**: 85%
- Problem: The old test suite had 4 tests covering `adapter.cleanup()` delegation (cleanup on systemPrompt completion, no cleanup without systemPrompt, cleanup after adapter deregistration, and resilience when cleanup throws). The new tmux-based test suite has zero tests for this behavior, yet the production code at line 147 still conditionally captures a `cleanupFn` closure and `cleanupWorkerState` (lines 540-549) still invokes it with try/catch. This is a behavior regression in test coverage for an active code path.
- Fix: Add at minimum 2 tests to the new suite:
  1. A test verifying `adapter.cleanup(taskId)` is called when a task with `systemPrompt` completes (spawn task with systemPrompt, simulate exit, assert cleanup mock was called).
  2. A test verifying worker cleanup completes even when `adapter.cleanup()` throws.

```typescript
// Example test sketch:
it('calls adapter.cleanup(taskId) when task has systemPrompt', async () => {
  const cleanupFn = vi.fn();
  const registry = createMockAgentRegistry();
  const adapter = (registry.get as ReturnType<typeof vi.fn>).mock.results[0].value.value;
  adapter.cleanup = cleanupFn;

  const task = { ...buildTask(), systemPrompt: 'You are helpful' } as Task;
  const pool = buildPool({ agentRegistry: registry });
  await pool.spawn(task);

  tmuxConnector._simulateExit(task.id, 0);
  await vi.runAllTimersAsync();

  expect(cleanupFn).toHaveBeenCalledWith(task.id);
});
```

**Missing test for `handleWorkerCompletion` when worker is already removed** - `tests/unit/implementations/event-driven-worker-pool.test.ts`
**Confidence**: 82%
- Problem: The old test suite had a test case "should log warning and not crash when completion fires for already-removed worker" (lines 575-592 of old code). This validates the defensive guard at lines 621-626 and 628-633 of `handleWorkerCompletion`. The new suite does not include an equivalent test. While the double-completion guard (EC-1) covers one aspect, it does not test the path where `kill()` removes the worker and then `onExit` fires for an unknown task.
- Fix: Add a test that kills a worker, then calls `_simulateExit` and asserts no crash and a warning is logged.

```typescript
it('logs warning when onExit fires after worker was already killed', async () => {
  const task = buildTask();
  const spawnResult = await pool.spawn(task);
  if (!spawnResult.ok) return;

  (tmuxConnector.isAlive as ReturnType<typeof vi.fn>).mockReturnValue(ok(false));
  await pool.kill(spawnResult.value.id);

  // onExit fires for the now-removed worker
  tmuxConnector._simulateExit(task.id, 0);
  await vi.runAllTimersAsync();

  expect(logger.warn).toHaveBeenCalledWith(
    'Worker completion for unknown task',
    expect.objectContaining({ taskId: task.id }),
  );
});
```

### MEDIUM

**No test for workerRepository.register call shape in the new suite** - `tests/unit/implementations/event-driven-worker-pool.test.ts`
**Confidence**: 83%
- Problem: The old suite had a test "should register worker in workerRepository on spawn" that asserted the exact shape of the registration argument including `workerId`, `taskId`, `pid`, `ownerPid`, and `agent`. The new unit test suite does not verify `workerRepository.register` call arguments. The integration test at `worker-pool-management.test.ts:251-256` does assert some fields (taskId, agent, ownerPid, sessionName) but the unit test should also verify this contract to catch regressions without running integration tests.
- Fix: Add a test in the `AC-6: Spawn flow` section that asserts `workerRepository.register` was called with the expected shape including the new `sessionName` field and `pid: 0`.

**No test for `workerRepository.unregister` on process exit in unit tests** - `tests/unit/implementations/event-driven-worker-pool.test.ts`
**Confidence**: 80%
- Problem: The old suite tested that `workerRepository.unregister` was called after process exit (lines 691-702). The new suite tests `outputCapture.clear` on exit (AC-8) but does not assert that `workerRepository.unregister` is called during the onExit path. This is covered in integration tests but not in unit tests.
- Fix: Add an assertion to the `AC-8: onExit fires` describe block that checks `workerRepository.unregister` was called after exit.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`_simulateExit` throws on missing callbacks but tests may not guard against racing spawn** - `tests/fixtures/mocks.ts:173`
**Confidence**: 80%
- Problem: `_simulateExit` throws `Error('No callbacks registered for taskId: ...')` if no callbacks exist. This is a good guard for test authors, but if a test calls `_simulateExit` for a task that failed to spawn (e.g., due to resource limits), the thrown error would produce a confusing test failure instead of a clear assertion failure. The pattern is inconsistent with the integration test style where `_simulateExit` is called without checking the spawn result first.
- Fix: This is minor — current tests all check `spawnResult.ok` before calling `_simulateExit` in the unit tests, and in integration tests the spawn is expected to succeed. No action needed now, but consider adding a `_hasCallbacks(taskId)` predicate to the mock for defensive callers.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`process-connector.test.ts` deleted without equivalent coverage in new architecture** - `tests/unit/services/process-connector.test.ts`
**Confidence**: 85%
- Problem: The `ProcessConnector` class was deleted along with its 12 tests. Most behaviors (stdout/stderr capture, exit handling, double-exit guard, periodic flush, backpressure) have equivalent tests in the new `event-driven-worker-pool.test.ts`, but two behaviors lack direct unit test coverage: (1) the backpressure guard that skips flushes when a previous flush is in-flight (old test at line 269), and (2) `prepareForKill` which stops the interval and performs a final flush before kill (old test at line 311). These behaviors are now inlined in `EventDrivenWorkerPool` at `startFlushing` (line 415) and `cleanupWorkerState` (line 528), but are not directly tested.
- The `EC-5: Periodic flush backpressure guard` test only verifies that flushing starts, not that concurrent flushes are actually skipped. The `flushingInProgress` Set in the implementation prevents concurrent flushes but has no test.

## Suggestions (Lower Confidence)

- **Missing test for `timeout=0` edge case** - `tests/unit/implementations/event-driven-worker-pool.test.ts` (Confidence: 75%) — The old suite tested that `timeout=0` is treated as "no timeout." The new suite only tests `timeout: undefined` in AC-10 but the production code at line 559 checks `!timeoutMs || timeoutMs <= 0`. Consider adding a test for `timeout: 0`.

- **`getWorkers()` frozen array test dropped** - `tests/unit/implementations/event-driven-worker-pool.test.ts` (Confidence: 70%) — The old suite verified `Object.isFrozen(result.value)` for `getWorkers()`. The new API-1 tests verify length but not immutability. If frozen arrays are part of the contract, this should be tested.

- **Heartbeat updateHeartbeat call assertion dropped** - `tests/unit/implementations/event-driven-worker-pool.test.ts` (Confidence: 65%) — The old heartbeat tests verified that `workerRepository.updateHeartbeat` was called at each 30s interval and stopped after kill. The new AC-5 test only checks that `cleanupWorkerState` runs when `isAlive` returns false. The heartbeat-writes-to-DB behavior is no longer directly unit tested.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Testing Score**: 6/10
**Recommendation**: CHANGES_REQUESTED

The test migration from ProcessSpawner to TmuxConnector is well-structured with clear AC/EC naming, good mock consolidation (shared `createMockTmuxConnector`), and correct wiring of integration tests. However, the migration dropped coverage for several existing behaviors: adapter cleanup delegation (4 tests removed, 0 added), workerRepository integration assertions in unit tests, completion-after-kill warning path, and flush backpressure guard. These are active code paths in the production implementation and should have equivalent tests before merge. (avoids PF-001 -- surfacing all issues rather than deferring)
