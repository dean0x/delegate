# Regression Review Report

**Branch**: feat/v0.8.0-loop-enhancements -> main
**Date**: 2026-03-23
**Commits**: 5 (7bfdefd..eb1389d)
**Files Changed**: 16 source files, 8 test files (+2,597 / -64 lines)

## Issues in Your Changes (BLOCKING)

### HIGH

**`createLoop` signature change is a breaking API change** - `src/core/domain.ts:597`
**Confidence**: 95%
- Problem: The `createLoop` factory function signature was changed from `(request, workingDirectory)` to `(request, workingDirectory, scheduleId?)`. While the third parameter is optional, this is an exported public function. The `-export` line in the diff confirms the old signature was removed. Any external consumer importing `createLoop` with explicit type annotations (e.g., `const fn: (req: LoopCreateRequest, wd: string) => Loop = createLoop`) would break at compile time.
- Impact: Low risk in practice since the parameter is optional and TypeScript allows extra optional params, but this is a public API change that should be documented.
- Fix: Document this as a minor breaking change in release notes. The optional parameter is backward-compatible at the call site level, so no code migration is needed -- but consumers with strict type aliases will break.

**`ScheduleHandler.create()` constructor signature change (new required dependency)** - `src/services/handlers/schedule-handler.ts:77`
**Confidence**: 95%
- Problem: `ScheduleHandler.create()` now requires a `loopRepo: LoopRepository` parameter inserted between `database` and `logger`. This is a breaking change for any code that constructs a `ScheduleHandler` directly. The handler-setup and test files have been updated, but any external consumer or plugin that instantiates `ScheduleHandler.create()` will fail.
- Impact: Internal API (not exported via MCP), but still a breaking positional parameter change that shifts `logger` and `options` positions.
- Fix: All known call sites (`handler-setup.ts`, `schedule-handler.test.ts`) are updated. Verify no other call sites exist. Consider documenting in migration notes.

**Unsafe type cast: `LoopId as unknown as TaskId`** - `src/services/handlers/schedule-handler.ts:560`
**Confidence**: 85%
- Problem: The code casts `loop.id as unknown as TaskId` to emit a `ScheduleExecuted` event. This violates type safety -- `LoopId` and `TaskId` are distinct branded types. The `ScheduleExecutor.clearRunningScheduleByTask` method accepts `string` at runtime so it works, but this creates a maintenance trap: if `clearRunningScheduleByTask` is ever tightened to accept `TaskId`, this will silently fail or break. Additionally, the `ScheduleExecutedEvent` type declares `taskId: TaskId` which is semantically incorrect when it holds a `LoopId`.
- Impact: Works at runtime today, but introduces a semantic lie in the type system. Future refactors of the schedule executor could cause subtle bugs.
- Fix: Either (a) add a `loopId?: LoopId` field to `ScheduleExecutedEvent` and handle it in `ScheduleExecutor`, or (b) create a separate `ScheduleLoopExecuted` event type, or (c) extend `clearRunningScheduleByTask` to accept `string` explicitly with documentation.

### MEDIUM

**`handleTaskTerminal` skips processing for PAUSED loops** - `src/services/handlers/loop-handler.ts:202`
**Confidence**: 82%
- Problem: The guard `if (loop.status !== LoopStatus.RUNNING)` on line 202 will cause `handleTaskTerminal` to skip processing and clean up tracking when a task completes while the loop is PAUSED (graceful pause case). This means: (1) the iteration result is silently discarded, (2) the `taskToLoop` entry is deleted so recovery via `recoverSingleLoop` on resume will not find it, (3) the iteration is left in `running` status permanently. When the loop is later resumed, `recoverSingleLoop` finds a `running` iteration with no task (since `taskToLoop` was cleared), which triggers a `cancelled` status + restart -- losing the actual task result.
- Impact: In the graceful pause scenario, if the task completes while the loop is paused, the iteration result (pass/fail/score) is lost. The recovery logic will treat it as a cancelled iteration and start a new one, wasting work.
- Fix: Change the guard to allow `PAUSED` status through for result recording but skip scheduling the next iteration:
  ```typescript
  if (loop.status !== LoopStatus.RUNNING && loop.status !== LoopStatus.PAUSED) {
    // ... skip
  }
  // ... process result ...
  if (loop.status === LoopStatus.RUNNING) {
    await this.scheduleNextIteration(...);
  }
  ```

**`handleLoopPaused` does not validate loop status before pausing** - `src/services/handlers/loop-handler.ts:379`
**Confidence**: 80%
- Problem: The handler blindly updates the loop status to PAUSED without verifying the loop is currently RUNNING. While the `LoopManagerService.pauseLoop()` validates this, the handler is also reachable directly via `EventBus.emit('LoopPaused', ...)`. If an event is emitted directly (e.g., by another handler or during recovery), a completed/cancelled loop could be set back to PAUSED, corrupting state.
- Impact: Defense-in-depth violation. The service layer prevents this today, but the handler should be self-protecting.
- Fix: Add a status check after fetching the loop:
  ```typescript
  if (loop.status !== LoopStatus.RUNNING) {
    this.logger.warn('Cannot pause loop that is not running', { loopId, status: loop.status });
    return ok(undefined);
  }
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Migration v11: `INSERT INTO loops_new SELECT *, NULL, NULL, NULL FROM loops` is fragile** - `src/implementations/database.ts:660`
**Confidence**: 85%
- Problem: Using `SELECT *` in a migration is fragile because it depends on column order matching between the old table and the new table definition. If a future migration adds a column to the old `loops` table schema (before this migration runs), the `*` expansion and the `NULL, NULL, NULL` appending would be misaligned. This follows the existing pattern from v2/v3 migrations, so it is consistent -- but it is a known anti-pattern.
- Impact: Safe for now since migration ordering is deterministic, but makes future migrations more error-prone.
- Fix: Explicitly list all source columns:
  ```sql
  INSERT INTO loops_new (id, strategy, task_template, ..., completed_at, git_branch, git_base_branch, schedule_id)
  SELECT id, strategy, task_template, ..., completed_at, NULL, NULL, NULL FROM loops
  ```

**`recoverStuckLoops` does not recover PAUSED loops on startup** - `src/services/handlers/loop-handler.ts:1306`
**Confidence**: 80%
- Problem: `recoverStuckLoops()` only fetches `LoopStatus.RUNNING` loops. After a server crash, PAUSED loops with stale in-memory state (e.g., cooldown timers, taskToLoop maps) would not be rebuilt. This is acceptable for paused loops that are truly idle, but if a graceful-pause loop had a running task at crash time, the task-to-loop mapping would be lost and the task completion event would be ignored on restart.
- Impact: After a crash, graceful-paused loops with in-flight tasks lose tracking. When resumed, `recoverSingleLoop` partially handles this, but the taskToLoop map would not be pre-populated.
- Fix: Include `LoopStatus.PAUSED` in recovery:
  ```typescript
  const pausedLoopsResult = await this.loopRepo.findByStatus(LoopStatus.PAUSED);
  // For each, rebuild taskToLoop if latest iteration is still 'running'
  ```

## Pre-existing Issues (Not Blocking)

No critical pre-existing issues identified.

## Suggestions (Lower Confidence)

- **`ScheduleExecutor` does not subscribe to `LoopPaused`** - `src/services/schedule-executor.ts` (Confidence: 65%) -- The executor subscribes to `LoopCompleted` and `LoopCancelled` to clear running schedule state, but not `LoopPaused`. If a scheduled loop is paused indefinitely, the schedule remains in `runningSchedules` forever, blocking the next cron trigger. This may be intentional (paused loop is still "active"), but should be documented.

- **Cleanup query excludes paused loops without explicit comment in SQL** - `src/implementations/loop-repository.ts:277` (Confidence: 60%) -- The cleanup SQL `WHERE status IN ('completed', 'failed', 'cancelled')` implicitly excludes paused loops (correct behavior), but the only documentation is a code comment. The SQL itself could benefit from a `-- excludes 'paused'` inline comment for future readers.

- **`ListLoops` status enum in MCP adapter includes 'paused' but recovery does not list paused loops separately** - `src/adapters/mcp-adapter.ts:240` (Confidence: 62%) -- Users can now filter by 'paused' status via MCP/CLI, but there is no dedicated recovery or monitoring for paused loops. This is a UX gap rather than a regression.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 3 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Regression Score**: 6/10
**Recommendation**: CHANGES_REQUESTED

### Rationale

The v0.8.0 changes are additive and well-structured, with no deleted files or removed exports. The new `LoopStatus.PAUSED` state, git branch integration, and scheduled loops are clean additions. However, there are two regression concerns that warrant changes before merge:

1. **The `handleTaskTerminal` guard** (MEDIUM BLOCKING) silently discards task results for graceful-paused loops. This is the most impactful regression risk -- it means graceful pause does not actually preserve in-flight iteration results, contradicting the documented behavior.

2. **The `LoopId as unknown as TaskId` cast** (HIGH BLOCKING) introduces a type-safety hole in the schedule executor tracking system. While it works at runtime, it creates a semantic lie that will be a maintenance trap.

3. **The `createLoop` and `ScheduleHandler.create()` signature changes** (HIGH BLOCKING) are backward-compatible in practice but should be documented as minor breaking changes in v0.8.0 release notes.

The migration (v11) is safe and follows established patterns. The new MCP tools, CLI commands, and event subscriptions are properly wired. Test coverage appears comprehensive across all new features.
