# Tests Review Report

**Branch**: fix/v060-correctness-bugs -> main
**Date**: 2026-03-19
**Commits**: 4 (18d7657, 6866844, 894d3f9, 3301a2e)

## Summary of Changes Under Review

This PR fixes four correctness bugs:

1. **RecoveryManager dependency check** - Adds `DependencyRepository` to prevent re-queuing blocked tasks during recovery, plus `TaskFailed` event emission for crashed/dead-worker tasks.
2. **CancelSchedule multi-execution** - Changes schedule cancellation to cancel tasks from ALL active executions, not just the latest.
3. **Output totalSize recalculation** - Fixes `totalSize` to reflect actual returned content after tail-slicing (both in-memory `BufferedOutputCapture` and DB-backed `TaskManagerService.getLogs`).
4. **Self-review cleanup** (3301a2e) - Addresses issues found in self-review.

## Issues in Your Changes (BLOCKING)

### HIGH

**Missing test for TaskFailed emit failure path in RecoveryManager** - `tests/unit/services/recovery-manager.test.ts`
- Problem: The production code in `recovery-manager.ts` has two error-handling branches for `TaskFailed` emission failure (lines 129-132 for dead workers, lines 271-274 for crashed tasks). Neither failure path is tested. The tests verify successful emission but not what happens when `eventBus.emit('TaskFailed', ...)` returns an error. This is a gap because the code logs an error and silently continues -- the test should verify both the logging and that recovery does not abort.
- Impact: If the emit-failure log message or error-handling logic is accidentally removed or broken, no test would catch it.
- Fix: Add two tests:
```typescript
it('should log error but continue when TaskFailed emit fails for crashed task', async () => {
  const task = buildRunningTask('crashed-emit-fail');
  setupFindByStatus([], [task]);
  workerRepo.findByTaskId.mockReturnValue(ok(null));
  const emitError = new AutobeatError(ErrorCode.SYSTEM_ERROR, 'bus down');
  // First emit (TaskFailed) fails, others succeed
  eventBus.emit
    .mockResolvedValueOnce(ok(undefined)) // update succeeds
    .mockResolvedValueOnce(err(emitError)); // TaskFailed fails

  const result = await manager.recover();

  expect(result.ok).toBe(true); // Recovery continues
  expect(logger.error).toHaveBeenCalledWith(
    'Failed to emit TaskFailed event for crashed task',
    emitError,
    { taskId: task.id },
  );
});
```
And similarly for the dead-worker path.

### MEDIUM

**Duplicate `linesSize` utility function** - `src/implementations/output-capture.ts:13` and `src/services/task-manager.ts:33`
- Problem: The `linesSize` helper function is defined identically in two files. While this is a production code issue rather than a test issue, the tests only validate each copy indirectly through behavior. Neither copy has a dedicated unit test ensuring correctness for edge cases (empty arrays, empty strings, unicode).
- Impact: If one copy is changed but not the other, the two code paths would diverge silently. The function is simple enough that indirect testing is adequate, but the duplication is a maintenance risk.
- Fix: Extract to a shared utility (e.g., `src/utils/output.ts`) and add a focused unit test:
```typescript
describe('linesSize()', () => {
  it('should return 0 for empty array', () => {
    expect(linesSize([])).toBe(0);
  });
  it('should sum character lengths', () => {
    expect(linesSize(['abc', 'de'])).toBe(5);
  });
});
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Integration test `task-persistence.test.ts` does not verify dependency-aware recovery** - `tests/integration/task-persistence.test.ts:82-90`
- Problem: The integration tests were updated to pass `dependencyRepo` to `RecoveryManager` (required by the new constructor signature), but no integration test actually exercises the dependency-blocking behavior. All tasks in the integration tests have no dependencies, so `isBlocked` always returns `false`. This means the new dependency-check codepath is only tested at the unit level with mocks, not with real SQLite.
- Impact: A bug in `SQLiteDependencyRepository.isBlocked()` interacting with the recovery flow would not be caught by integration tests.
- Fix: Add an integration test case that creates a QUEUED task with an unresolved dependency, runs recovery, and verifies the task is NOT re-queued:
```typescript
it('should not re-queue QUEUED tasks with unresolved dependencies', async () => {
  // Create parent task (running), child task (queued, depends on parent)
  // Run recovery
  // Assert child is NOT re-queued (blocked), parent is marked FAILED
});
```

**Schedule manager test uses real DB but does not verify execution status update after cancel** - `tests/unit/services/schedule-manager.test.ts:470-508`
- Problem: The new test "should cancel tasks from ALL active executions" verifies that `TaskCancellationRequested` events are emitted for all 4 tasks across 2 active executions. However, it does not verify that the execution records themselves are updated to reflect cancellation. The test uses real SQLite via `scheduleRepo.recordExecution`, so it could also verify post-cancellation state.
- Impact: If the schedule handler that processes `ScheduleCancelled` events fails to update execution status, this test would not catch it. (Note: this may be intentional if execution status updates happen in a separate handler.)
- Fix: This is a minor gap. If execution status updates happen in the same flow, add an assertion checking execution statuses post-cancel. If handled by a separate handler (likely given the event-driven architecture), this is acceptable as-is.

### LOW

**Test name inconsistency in output-capture test** - `tests/unit/implementations/output-capture.test.ts:258`
- Problem: The new test is named "should recalculate totalSize after tail-slicing" which duplicates the semantic intent of the pre-existing test "should return last N entries with tail" (line 224). The new test is focused specifically on totalSize recalculation, which is good, but the describe block "Tail functionality" now has two tests that partially overlap in what they verify.
- Impact: Minor readability issue only. No functional concern.
- Fix: No action needed. The tests are distinct enough in their assertions.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Several tail tests lack explicit `expect(output.ok).toBe(true)` guard** - `tests/unit/implementations/output-capture.test.ts:224-285`
- Problem: Multiple pre-existing tail tests use `if (output.ok) { ... }` without a preceding `expect(output.ok).toBe(true)`. If `getOutput` returned an error, the test would silently pass with zero assertions. The new test at line 258 correctly adds the `expect(output.ok).toBe(true)` check, but the older tests (lines 229, 237, 249, 277, 282) do not.
- Impact: Silent test pass on unexpected errors. A broken `getOutput` could hide failures.
- Fix: Add `expect(output.ok).toBe(true)` before each `if (output.ok)` block in the pre-existing tail tests.

### LOW

**`createMockDependencyRepo` mock has untyped methods** - `tests/unit/services/recovery-manager.test.ts:61-71`
- Problem: The mock factory returns methods like `addDependency`, `getDependencies`, etc. as bare `vi.fn()` without return values. Only `isBlocked` has a proper default. While only `isBlocked` is called by `RecoveryManager`, having the other methods untyped means the mock could silently satisfy interface requirements without proper defaults.
- Impact: Very low risk since `RecoveryManager` only calls `isBlocked`. This is informational.
- Fix: Add `mockResolvedValue(ok(...))` defaults to other methods for consistency, or use a type assertion to ensure interface compliance.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 2 | 1 |
| Pre-existing | 0 | 0 | 1 | 1 |

**Tests Score**: 8/10

The test additions are well-structured, behavior-focused, and follow the project's established patterns (mock factories, Result type validation, AAA structure). Coverage for the four bug fixes is strong. The new tests correctly validate the fixed behavior (dependency-blocked recovery, multi-execution cancellation, totalSize recalculation). The main gap is the missing error-path test for `TaskFailed` emission failure in the recovery manager -- the happy paths are tested but the error branches are not.

**Recommendation**: APPROVED_WITH_CONDITIONS

Conditions:
1. Add tests for `TaskFailed` emission failure paths in both dead-worker and crashed-task recovery (HIGH). These are new error-handling branches introduced in this PR and should have test coverage.
2. Consider extracting the duplicated `linesSize` helper to reduce maintenance risk (MEDIUM, non-blocking).
