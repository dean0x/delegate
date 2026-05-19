# Regression Review Report

**Branch**: feat/scheduled-pipelines-78 -> main
**Date**: 2026-03-18
**PR**: #80

## Issues in Your Changes (BLOCKING)

### CRITICAL

No critical regression issues found.

### HIGH

**Dependency failure cascade is an intentional breaking change that may surprise existing consumers** - `src/services/handlers/dependency-handler.ts:582-598`
- Problem: On `main`, when a task's upstream dependency failed or was cancelled, the dependent task would be **unblocked** (because `isBlocked()` returns false once all deps are resolved, regardless of resolution type). The PR changes this to cascade cancellation instead. While this is a bug fix (documented in FEATURES.md as "breaking change"), any workflow that relied on the old behavior (tasks proceeding despite upstream failure) will now see tasks cancelled instead of unblocked.
- Impact: Existing DAG workflows where downstream tasks were expected to run regardless of upstream failure will now silently cancel. This is a semantics change in the dependency system, not just a new feature.
- Fix: This is correctly documented in `docs/FEATURES.md` under "Bug Fixes (v0.6.0)" as a **breaking change**. No code fix needed, but the migration story should be verified: are there existing users who depend on the old unblocking-on-failure behavior? If so, consider adding a configurable policy (e.g., `onDependencyFailure: 'cancel' | 'proceed'`). For now, the fix is correct.
- Category: Blocking (this is new code in this PR)

### MEDIUM

**`validateScheduleTiming` extracted but not applied to existing `createSchedule` path** - `src/services/schedule-manager.ts:64-147` vs `src/services/schedule-manager.ts:491-576`
- Problem: The PR extracts a `validateScheduleTiming()` private helper and uses it in `createScheduledPipeline()`, but the existing `createSchedule()` method still has identical inline validation logic (lines 64-147). This creates a drift risk: if validation rules change in one path but not the other, the two schedule creation paths will behave differently.
- Impact: Not a regression today, but introduces a maintenance hazard. Future changes to timing validation may only be applied to one path.
- Fix: Refactor `createSchedule()` to also use `validateScheduleTiming()`. This is not blocking for merge but should be addressed soon.
- Category: Should-Fix (same module, related code)

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Pipeline partial failure cleanup uses direct `taskRepo.update()` instead of event emission** - `src/services/handlers/schedule-handler.ts:375-383`
- Problem: When pipeline task save fails partway through, the cleanup loop directly calls `this.taskRepo.update(savedTask.id, { status: TaskStatus.CANCELLED })` to cancel already-saved tasks. This bypasses the event system -- no `TaskCancelled` event is emitted for these tasks, which means:
  1. DependencyHandler won't resolve dependencies for these cancelled tasks
  2. PersistenceHandler won't record the cancellation
  3. Any other event subscribers won't be notified
- Impact: If a partial pipeline failure occurs, the cancelled tasks will be in a `CANCELLED` state in the DB but their dependents (if any) won't receive cancellation cascades.
- Fix: Emit `TaskCancellationRequested` events instead of direct repo updates, or at minimum emit `TaskCancelled` events after the direct update:
  ```typescript
  for (const savedTask of savedTasks) {
    const cancelResult = await this.taskRepo.update(savedTask.id, { status: TaskStatus.CANCELLED });
    if (cancelResult.ok) {
      await this.eventBus.emit('TaskCancelled', { taskId: savedTask.id, reason: 'Pipeline creation failed' });
    }
  }
  ```
- Category: Should-Fix (new code in touched module)

**`recordFailedExecution` hardcodes "Failed to create task:" prefix** - `src/services/handlers/schedule-handler.ts:446`
- Problem: The `recordFailedExecution` helper always prepends `"Failed to create task: "` to the error message. When called from `handlePipelineTrigger`, the caller already constructs a message like `"Pipeline failed at step 3: ..."`, resulting in the recorded message being `"Failed to create task: Pipeline failed at step 3: ..."` which is misleading.
- Impact: Confusing audit trail entries for pipeline failures.
- Fix: Either remove the prefix from the helper and let callers provide the full message, or add a parameter to control the prefix:
  ```typescript
  private async recordFailedExecution(
    scheduleId: ScheduleId,
    scheduledFor: number,
    triggeredAt: number,
    errorMessage: string,
  ): Promise<void> {
    const result = await this.scheduleRepo.recordExecution({
      scheduleId,
      scheduledFor,
      executedAt: triggeredAt,
      status: 'failed',
      errorMessage,  // No hardcoded prefix
      createdAt: Date.now(),
    });
  ```
- Category: Should-Fix (new code)

### LOW

**`ScheduleExecuted` event uses `lastTaskId` for pipelines but `task.id` for single tasks** - `src/services/handlers/schedule-handler.ts:296` vs `src/services/handlers/schedule-handler.ts:357`
- Problem: The `ScheduleExecuted` event semantics differ between single-task and pipeline paths. For single tasks, `taskId` is the created task. For pipelines, `taskId` is the **last** step's task (tail task for concurrency tracking). This implicit contract is not documented in the event definition.
- Impact: Any future subscriber of `ScheduleExecuted` that assumes `taskId` is "the task that was created" will behave incorrectly for pipelines. The comment on line 356 explains the intent, but the event interface in `events.ts` should document this.
- Fix: Add a JSDoc comment to the `ScheduleExecuted` event type explaining that `taskId` represents the tail task for concurrency tracking purposes.
- Category: Should-Fix (new code)

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`createSchedule` method in schedule-manager has duplicated validation** - `src/services/schedule-manager.ts:64-147`
- Problem: The existing `createSchedule` method has ~80 lines of inline timing validation that is now duplicated by `validateScheduleTiming`. This predates this PR.
- Category: Pre-existing

### LOW

**`ScheduleExecution.pipelineTaskIds` parsed with silent catch in `rowToExecution`** - `src/implementations/schedule-repository.ts:540-548`
- Problem: When `pipeline_task_ids` JSON parsing fails, the error is silently swallowed (`catch { pipelineTaskIds = undefined; }`). Meanwhile, `pipeline_steps` parsing (line 498-504) throws an error on parse failure. The inconsistent error handling is a minor concern.
- Fix: Either throw for both or silently degrade for both. The non-fatal approach is reasonable for task IDs (read path), but the inconsistency should be noted.
- Category: Pre-existing (the pattern of silent catch exists in the codebase)

## Regression Checklist

- [x] No exports removed without deprecation -- all existing exports preserved
- [x] Return types backward compatible -- `cancelSchedule` added optional parameter (backward compatible)
- [x] Default values unchanged -- `cancelTasks` defaults to `undefined`/`false`
- [x] Side effects preserved -- all existing events still emitted; new events added
- [x] All consumers of changed `cancelSchedule` signature updated (MCP, CLI, tests)
- [x] Migration complete across codebase -- new `createScheduledPipeline` added to all ScheduleService implementations
- [x] CLI options preserved -- existing schedule commands unchanged, new `--pipeline`, `--step`, `--cancel-tasks` flags added
- [x] API endpoints preserved -- existing MCP tools unchanged, new `SchedulePipeline` tool added
- [x] Commit message matches implementation -- scheduled pipelines + dependency cascade fix matches diff
- [x] Breaking changes documented -- dependency cascade fix documented in FEATURES.md as breaking change
- [x] No files removed
- [x] No TODOs indicating incomplete work
- [x] Database migration additive only (new nullable columns)
- [x] Schedule handler refactoring preserves all original behavior (afterScheduleId, maxRuns, expiration, nextRunAt clearing)
- [x] Queue handler fast-path is safe (only skips when `dependencyState === 'blocked'`, which is deterministic from `createTask`)

## Intent vs Reality Verification

| Commit Message Claim | Verified |
|----------------------|----------|
| Scheduled pipelines (SchedulePipeline MCP tool) | Yes -- `src/adapters/mcp-adapter.ts`, `src/services/schedule-manager.ts` |
| Linear task dependencies on each trigger | Yes -- `src/services/handlers/schedule-handler.ts:handlePipelineTrigger` |
| CLI `--pipeline --step` support | Yes -- `src/cli/commands/schedule.ts` |
| Dependency failure cascade fix | Yes -- `src/services/handlers/dependency-handler.ts:582-598` |
| Queue handler race condition fix | Yes -- `src/services/handlers/queue-handler.ts:65-73` |
| `cancelTasks` on CancelSchedule | Yes -- all layers updated |
| Migration 8: pipeline_steps + pipeline_task_ids columns | Yes -- `src/implementations/database.ts` |
| Tests for all new features | Yes -- 92 new dependency tests, 39 queue tests, 223 schedule handler tests, 467 MCP adapter tests, 169 CLI tests, 103 repo tests, 99 manager tests |

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | 0 |
| Should Fix | 0 | 0 | 2 | 1 |
| Pre-existing | 0 | 0 | 1 | 1 |

**Regression Score**: 8/10
- Excellent preservation of existing behavior in the schedule-handler refactoring
- The dependency cascade change is correctly identified and documented as a breaking change
- The queue handler fast-path is a clean, safe race condition fix
- Minor issues around pipeline partial failure cleanup and validation duplication
- Comprehensive test coverage for all new and changed behaviors

**Recommendation**: APPROVED_WITH_CONDITIONS
- The HIGH issue (dependency cascade breaking change) is correctly documented in FEATURES.md, so it is intentional. However, confirm there are no existing workflows relying on the old unblock-on-failure behavior before merging.
- The MEDIUM should-fix items (pipeline partial failure cleanup bypassing events, error message prefix, event semantics documentation) should be addressed in a follow-up or this PR if convenient.
- No regressions detected in existing functionality.
