# Performance Review Report

**Branch**: feat/v070-task-loops -> main
**Date**: 2026-03-21
**PR**: #110

## Issues in Your Changes (BLOCKING)

### HIGH

**execSync blocks the Node.js event loop during exit condition evaluation** - `src/services/handlers/loop-handler.ts:580`
**Confidence**: 95%
- Problem: `evaluateExitCondition()` uses `execSync()` to run the user-provided exit condition shell command. This blocks the entire Node.js event loop for up to `evalTimeout` milliseconds (default 60 seconds). During this time, no other event handlers, task completions, or MCP requests can be processed. For a system designed to orchestrate multiple concurrent tasks, this is a significant bottleneck.
- Impact: If multiple loops are running simultaneously, their exit condition evaluations serialize. A slow eval script (e.g., running a test suite) blocks all other loop and task processing for its entire duration.
- Fix: Replace `execSync` with `execFile` or `exec` from `child_process` (async variants) wrapped in a Promise with timeout handling:
  ```typescript
  import { exec } from 'child_process';
  import { promisify } from 'util';
  const execAsync = promisify(exec);

  private async evaluateExitCondition(loop: Loop, taskId: TaskId): Promise<EvalResult> {
    const env = { ...process.env, AUTOBEAT_LOOP_ID: loop.id, /* ... */ };
    try {
      const { stdout } = await execAsync(loop.exitCondition, {
        cwd: loop.workingDirectory,
        timeout: loop.evalTimeout,
        env,
      });
      // ... parse stdout as before
    } catch (execError) {
      // ... handle error as before
    }
  }
  ```
  Note: This requires making `handleIterationResult` and callers accommodate the now-async `evaluateExitCondition`. The method signature already fits naturally since all callers are async.

**Missing index on `loops.status` column** - `src/implementations/database.ts:612-618`
**Confidence**: 90%
- Problem: The `findByStatusStmt` query (`SELECT * FROM loops WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`) and `cleanupOldLoopsStmt` (`DELETE FROM loops WHERE status IN (...) AND completed_at < ?`) both filter on `loops.status`, but no index exists on the `loops` table. The `loop_iterations` table has 4 indexes, but the `loops` table itself has none beyond the PRIMARY KEY. The existing codebase creates `idx_tasks_status` and `idx_schedules_status` for the analogous tables.
- Impact: As loops accumulate, `findByStatus` and `cleanupOldLoops` degrade to full table scans. The `recoverStuckLoops()` method calls `findByStatus(RUNNING)` on every startup.
- Fix: Add indexes for `loops.status` and the compound `(status, completed_at)` used by cleanup, matching the pattern used for schedules:
  ```sql
  CREATE INDEX IF NOT EXISTS idx_loops_status ON loops(status);
  CREATE INDEX IF NOT EXISTS idx_loops_cleanup ON loops(status, completed_at);
  ```

### MEDIUM

**N+1 query pattern in `recoverStuckLoops()`** - `src/services/handlers/loop-handler.ts:1024-1057`
**Confidence**: 85%
- Problem: For each running loop, the method issues 1 query to get iterations (`getIterations`) and potentially 1 more to get the task (`findById`). With N running loops at startup, this is 1 + N + N queries in the worst case. While this only runs at startup (not in the hot path), it could delay recovery time if many loops were running at crash time.
- Impact: Startup recovery time scales linearly with running loop count. Practical impact is LOW in typical usage (few concurrent loops) but could matter in edge cases (e.g., system crash with 50+ running loops).
- Fix: This is acceptable for a startup-only code path. Consider batching if loop counts are expected to grow significantly. No immediate action required.

**Over-fetching iterations in `enrichPromptWithCheckpoint()`** - `src/services/handlers/loop-handler.ts:924`
**Confidence**: 82%
- Problem: The method calls `getIterations(loop.id, iterationNumber, 0)` where `iterationNumber` is the current iteration count. For iteration 100, this fetches up to 100 iteration rows from the database, then does a linear `.find()` to locate the single previous iteration. The comment says "we need at least 2" but the limit parameter is set to `iterationNumber` rather than 2.
- Impact: Memory and I/O overhead grows linearly with iteration count. At iteration 1000, this fetches 1000 rows to find 1.
- Fix: Use a limit of 2 since iterations are ordered by `iteration_number DESC`:
  ```typescript
  // Only need the most recent 2 iterations (current + previous)
  const iterationsResult = await this.loopRepo.getIterations(loop.id, 2, 0);
  ```
  Then find the one with `iterationNumber - 1` in the (at most) 2 results. Alternatively, add a dedicated `findIterationByNumber(loopId, iterationNumber)` method to the repository.

## Issues in Code You Touched (Should Fix)

_No issues identified in adjacent code._

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`SELECT *` used across all repository queries** - `src/implementations/loop-repository.ts:201,205,209,238,245`
**Confidence**: 80%
- Problem: All loop and iteration queries use `SELECT *`. This is consistent with the existing codebase (schedule-repository.ts uses the same pattern), but as tables gain columns over migrations, `SELECT *` fetches more data than needed.
- Impact: Minimal for SQLite with small row counts. This is a pre-existing pattern across the codebase, not introduced by this PR.

## Suggestions (Lower Confidence)

- **Unbounded in-memory maps** - `src/services/handlers/loop-handler.ts:56-58` (Confidence: 65%) -- The `taskToLoop`, `pipelineTasks`, and `cooldownTimers` Maps grow with active loops/tasks. In practice these are bounded by active loops (which are finite), but there is no explicit size limit or cleanup on Maps if entries leak due to missed events.

- **Sequential event emission for pipeline steps** - `src/services/handlers/loop-handler.ts:537-551` (Confidence: 70%) -- Pipeline iteration emits `TaskDelegated` events sequentially in a `for` loop with `await`. Since these events are independent (each task has its own handler), they could potentially be emitted in parallel with `Promise.all()`. However, the sequential approach may be intentional for ordered processing.

- **`process.env` spread on every eval** - `src/services/handlers/loop-handler.ts:572-577` (Confidence: 60%) -- `{ ...process.env }` creates a shallow copy of the entire environment on every exit condition evaluation. This is a minor allocation cost that is dwarfed by the subprocess spawn itself.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Performance Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The most significant performance issue is the use of `execSync` in the exit condition evaluation path, which blocks the Node.js event loop for up to 60 seconds per evaluation. This is architecturally at odds with the event-driven design of the system. The missing `loops.status` index is a straightforward omission that should be added to match the pattern used by tasks and schedules tables. The `enrichPromptWithCheckpoint` over-fetching is a clear efficiency bug (fetching N rows when 2 suffice). The overall architecture is well-designed with prepared statements, pagination defaults, proper indexing on `loop_iterations`, and bounded query results.
