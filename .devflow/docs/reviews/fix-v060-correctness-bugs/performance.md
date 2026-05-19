# Performance Review Report

**Branch**: fix/v060-correctness-bugs -> main
**Date**: 2026-03-19
**Commits**: 4 (18d7657, 6866844, 894d3f9, 3301a2e)

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Sequential `isBlocked()` calls in recovery loop** - `src/services/recovery-manager.ts:166`
- Problem: `recoverQueuedTasks()` calls `this.dependencyRepo.isBlocked(task.id)` inside a `for` loop, issuing one SQLite query per QUEUED task. For N queued tasks, this is N sequential DB round-trips.
- Impact: During recovery after a crash with many queued tasks (e.g., a large pipeline), this serializes N dependency checks. Each `isBlocked()` executes a `SELECT COUNT(*)` query with a prepared statement.
- Mitigating factors: (1) SQLite is local with no network latency -- each prepared-statement call is sub-millisecond. (2) Recovery runs once at startup, not in the hot path. (3) The number of QUEUED tasks at crash time is typically small (single digits to low tens).
- Fix (if scale warrants): Batch the dependency check into a single query returning all blocked task IDs among a set of candidate task IDs, then use a Set for O(1) lookup in the loop. Example:
  ```typescript
  // Single query: SELECT DISTINCT task_id FROM task_dependencies WHERE task_id IN (...) AND resolution = 'pending'
  const blockedSet = await this.dependencyRepo.getBlockedTaskIds(tasks.map(t => t.id));
  for (const task of tasks) {
    if (blockedSet.has(task.id)) { blockedCount++; continue; }
    // ... enqueue
  }
  ```
- Verdict: Acceptable for current scale. The N+1-style pattern exists but recovery is not a hot path and N is bounded by crash-time queue depth.

**Sequential `TaskCancellationRequested` emissions in cancel loop** - `src/services/schedule-manager.ts:189-200`
- Problem: When `cancelTasks` is true, the code emits `TaskCancellationRequested` one-at-a-time via `await this.eventBus.emit(...)` inside a `for` loop over `allTaskIds`. Previously this was bounded to 1 execution (the latest); now it spans ALL active executions.
- Impact: The blast radius increased -- a long-running cron schedule with many overlapping triggered executions could accumulate many task IDs. Each emission is awaited sequentially.
- Mitigating factors: (1) Event emission is in-process (no network I/O). (2) Cancellation is an infrequent admin operation, not a hot path. (3) In practice, overlapping triggered executions are uncommon.
- Fix (if scale warrants): Use `Promise.all` for parallel emission:
  ```typescript
  await Promise.all(allTaskIds.map(taskId =>
    this.eventBus.emit('TaskCancellationRequested', {
      taskId,
      reason: `Schedule ${scheduleId} cancelled`,
    }).then(r => {
      if (!r.ok) this.logger.warn('Failed to cancel pipeline task', { taskId, scheduleId, error: r.error.message });
    })
  ));
  ```
- Verdict: Acceptable given cancellation is a rare admin action. However, the change from `getExecutionHistory(scheduleId, 1)` to `getExecutionHistory(scheduleId)` (no limit) deserves attention -- see next item.

**Unbounded execution history fetch on cancel** - `src/services/schedule-manager.ts:183`
- Problem: The old code called `getExecutionHistory(scheduleId, 1)` fetching only the latest execution. The new code calls `getExecutionHistory(scheduleId)` with no limit argument, which defaults to `DEFAULT_LIMIT = 100`. This fetches up to 100 execution rows from SQLite, maps them to objects, then filters in memory.
- Impact: For a cron schedule that has run many times, this fetches and deserializes up to 100 rows when only the `status === 'triggered'` subset is needed. The query itself uses the `idx_schedule_executions_schedule_time` index so the DB scan is efficient, but the object mapping and in-memory filter are unnecessary overhead.
- Mitigating factors: (1) Capped at 100 by DEFAULT_LIMIT. (2) The `rowToExecution` mapping is lightweight. (3) This runs only during schedule cancellation with `cancelTasks=true`.
- Fix: Add a `status` filter parameter to `getExecutionHistory`, or add a dedicated `getActiveExecutions(scheduleId)` method that queries `WHERE schedule_id = ? AND status = 'triggered'` directly, avoiding the fetch-then-filter pattern:
  ```sql
  SELECT * FROM schedule_executions
  WHERE schedule_id = ? AND status = 'triggered'
  ORDER BY scheduled_for DESC
  ```
  The existing `idx_schedule_executions_status` index would support this.
- Verdict: Low practical impact since DEFAULT_LIMIT caps at 100, but the fetch-then-filter pattern is a design smell worth noting.

## Issues in Code You Touched (Should Fix)

### LOW

**Duplicated `linesSize` utility function** - `src/implementations/output-capture.ts:13` and `src/services/task-manager.ts:33`
- Problem: The exact same `linesSize` function is defined in two files. Both were introduced/modified in this PR.
- Impact: Not a runtime performance issue, but duplicate code increases maintenance burden and bundle size (marginally). If the calculation logic ever needs to change (e.g., to account for newline separators), it must be updated in both places.
- Fix: Extract to a shared utility:
  ```typescript
  // src/utils/output.ts
  export function linesSize(lines: readonly string[]): number {
    return lines.reduce((sum, line) => sum + line.length, 0);
  }
  ```

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Sequential `eventBus.emit` in `recoverRunningTasks` loop** - `src/services/recovery-manager.ts:225-283`
- Problem: Both the pre-existing crash detection loop and the newly added `TaskFailed` emission are sequential `await` calls inside a loop iterating over RUNNING tasks. This is a pre-existing pattern; the PR adds one more `await` per iteration (the `TaskFailed` emit).
- Impact: Recovery time scales linearly with number of crashed tasks. Given recovery is a one-time startup operation, this is acceptable.
- Verdict: Pre-existing pattern. Not blocking.

### LOW

**`reduce` for size calculation on frozen arrays** - `src/implementations/output-capture.ts:119`
- Problem: `linesSize()` is called on `frozenStdout` and `frozenStderr` which are freshly spread+frozen copies. The `reduce` iterates each array element summing `.length`. For very large output buffers (thousands of lines), this is O(n) per `getOutput` call.
- Impact: Negligible in practice. The buffer size is capped by `maxBufferSize` (default 10MB), and `getOutput` with tail slicing limits the arrays further.
- Verdict: No action needed. The calculation is correct and fast for realistic sizes.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 3 | 0 |
| Should Fix | 0 | 0 | 0 | 1 |
| Pre-existing | 0 | 0 | 1 | 1 |

**Performance Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Conditions

1. The three MEDIUM blocking items are all acceptable at current scale. They follow established patterns in the codebase (sequential event emission in loops) and operate on non-hot paths (recovery at startup, admin cancellation). No immediate fix is required, but the patterns should be revisited if task/execution counts grow significantly.
2. Consider extracting the duplicated `linesSize` function to a shared utility in a follow-up.

### Positive Notes

- The `linesSize` recalculation after tail-slicing is a correctness fix that does not introduce measurable overhead (the arrays are already in memory and small post-slice).
- The `isBlocked` check uses a prepared statement with `SELECT COUNT(*)` on an indexed column -- efficient per-call.
- The `getExecutionHistory` query leverages the `idx_schedule_executions_schedule_time` composite index.
- Recovery runs once at startup, so the sequential patterns have minimal user-facing impact.
