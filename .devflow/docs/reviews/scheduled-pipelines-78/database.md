# Database Review Report

**Branch**: feat/scheduled-pipelines-78 -> main
**Date**: 2026-03-11
**Commits**: 011519e, 0ec3f84

## Issues in Your Changes (BLOCKING)

### HIGH

**Pipeline task creation loop is not wrapped in a transaction** - `/Users/dean/Sandbox/claudine/src/services/handlers/schedule-handler.ts:340-399`
- Problem: The `handlePipelineTrigger` method creates up to 20 tasks in a sequential loop (`for (let i = 0; i < steps.length; i++)`) with individual `taskRepo.save()` calls. If the process crashes mid-loop (e.g., after saving 2 of 5 tasks), the database will contain orphaned partial pipeline tasks that are never cleaned up. The existing cleanup code (lines 380-387) only handles explicit `save()` failures, not process-level crashes.
- Impact: Partial pipeline state in the database with no automatic recovery. Orphaned tasks may be picked up by workers and executed without their downstream dependents ever existing.
- Fix: Wrap the entire pipeline task creation loop in a database transaction. The `TaskRepository` already exposes a `transaction()` method (see `task-repository.ts:307`). Example:
  ```typescript
  const txResult = await this.taskRepo.transaction(async (txRepo) => {
    for (let i = 0; i < steps.length; i++) {
      // ... build task ...
      const saveResult = await txRepo.save(task);
      if (!saveResult.ok) return saveResult;
      savedTasks.push(task);
    }
    return ok(undefined);
  });
  if (!txResult.ok) {
    // Transaction rolled back automatically - record failed execution
    await this.recordFailedExecution(...);
    return txResult;
  }
  ```

**Pipeline cleanup cancels tasks via status update but does not clean up dependency rows** - `/Users/dean/Sandbox/claudine/src/services/handlers/schedule-handler.ts:380-387`
- Problem: When a pipeline save fails partway through, the cleanup loop sets `status: TaskStatus.CANCELLED` on previously saved tasks via `taskRepo.update()`. However, this does not trigger any dependency resolution. Tasks created with `dependsOn` will have corresponding rows in the `task_dependencies` table that remain in `pending` resolution state. These orphaned dependency rows will never be resolved.
- Impact: If `task_dependencies` rows are left in `pending` state for cancelled tasks, any code that queries pending dependencies (e.g., `isBlocked()`) may produce stale or incorrect results. Data integrity concern in the dependency graph.
- Fix: Either (a) use a transaction so the entire pipeline creation is atomic (preferred, see above), or (b) after cancelling each task, also emit `TaskCancellationRequested` instead of a direct DB update, which would let the existing DependencyHandler resolve the dependency rows:
  ```typescript
  for (const savedTask of savedTasks) {
    await this.eventBus.emit('TaskCancellationRequested', {
      taskId: savedTask.id,
      reason: `Pipeline step ${i + 1} save failed`,
    });
  }
  ```

### MEDIUM

**No Zod validation for `pipeline_task_ids` JSON deserialization** - `/Users/dean/Sandbox/claudine/src/implementations/schedule-repository.ts:538-545`
- Problem: When parsing `pipeline_task_ids` from the database, the code does `JSON.parse(data.pipeline_task_ids) as string[]` with a type assertion instead of Zod schema validation. This is inconsistent with how `pipeline_steps` is parsed (line 501, which uses `PipelineStepsSchema.parse()`). A malformed JSON array (e.g., `[123, null]`) would produce `TaskId` values from non-string data.
- Impact: Silent type corruption if database contains unexpected data. Violates the "parse, don't validate" principle used throughout this repository.
- Fix: Add a small Zod schema for the task IDs array:
  ```typescript
  const PipelineTaskIdsSchema = z.array(z.string().min(1));

  // In rowToExecution:
  if (data.pipeline_task_ids) {
    try {
      const parsed = JSON.parse(data.pipeline_task_ids);
      const validated = PipelineTaskIdsSchema.parse(parsed);
      pipelineTaskIds = validated.map((id) => TaskId(id));
    } catch {
      pipelineTaskIds = undefined;
    }
  }
  ```

**Inconsistent error handling between `pipeline_steps` and `pipeline_task_ids` parsing** - `/Users/dean/Sandbox/claudine/src/implementations/schedule-repository.ts:499-505` vs `/Users/dean/Sandbox/claudine/src/implementations/schedule-repository.ts:538-545`
- Problem: `pipeline_steps` parsing in `rowToSchedule()` throws an Error on invalid JSON (line 504: `throw new Error(...)`), treating it as data corruption. But `pipeline_task_ids` parsing in `rowToExecution()` silently swallows the error and returns `undefined` (line 542-544: `catch { pipelineTaskIds = undefined; }`). These are both JSON-serialized arrays stored in the same database with the same migration, so they should follow the same error strategy.
- Impact: If `pipeline_task_ids` is corrupted, it will be silently ignored. For an audit trail field, silent data loss may mask corruption issues that should be surfaced.
- Fix: Either make both throw (consistent with the existing `pipeline_steps` behavior), or make both non-fatal with logging. A pragmatic choice: since `pipeline_task_ids` is an audit/informational field, non-fatal is acceptable, but add a log warning:
  ```typescript
  } catch (e) {
    // Non-fatal: warn but don't fail for audit trail field
    // Consider: if pipeline_steps throws, pipeline_task_ids should at minimum log
    pipelineTaskIds = undefined;
  }
  ```
  Note: The comment says "log but don't fail" but no actual logging occurs since the repository has no logger reference.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`cancelSchedule` task cancellation queries only the latest execution** - `/Users/dean/Sandbox/claudine/src/services/schedule-manager.ts:257-278`
- Problem: When `cancelTasks: true` is passed, the code fetches `getExecutionHistory(scheduleId, 1)` -- only the most recent execution. For a CRON schedule that has triggered multiple times, there could be in-flight tasks from earlier executions that are not cancelled. This is a design choice, but the parameter name `cancelTasks` (plural) and the description "cancel in-flight pipeline tasks" suggest broader behavior than what is implemented.
- Impact: Users may expect all in-flight tasks to be cancelled but only the latest execution's tasks are affected. For CRON pipelines with overlapping executions, earlier pipeline runs continue executing.
- Fix: Either (a) document clearly that only the latest execution's tasks are cancelled, or (b) increase the history limit to cover recent executions and filter for non-terminal tasks:
  ```typescript
  const historyResult = await this.scheduleRepository.getExecutionHistory(scheduleId, 10);
  // ... iterate and cancel tasks from all recent non-terminal executions
  ```

### LOW

**Migration 8 adds TEXT columns without CHECK constraint for JSON validity** - `/Users/dean/Sandbox/claudine/src/implementations/database.ts:524-531`
- Problem: The new `pipeline_steps` and `pipeline_task_ids` columns are plain `TEXT` with no database-level constraints. While SQLite cannot validate JSON structure natively, a `CHECK(pipeline_steps IS NULL OR json_valid(pipeline_steps))` constraint could be added (SQLite supports `json_valid()` since 3.38.0, 2022).
- Impact: Without a DB-level constraint, any code path that bypasses the repository layer could insert malformed JSON. Low risk since all writes go through the repository, but defense-in-depth is reduced.
- Fix: Add `json_valid()` CHECK constraints in the migration:
  ```sql
  ALTER TABLE schedules ADD COLUMN pipeline_steps TEXT CHECK(pipeline_steps IS NULL OR json_valid(pipeline_steps));
  ALTER TABLE schedule_executions ADD COLUMN pipeline_task_ids TEXT CHECK(pipeline_task_ids IS NULL OR json_valid(pipeline_task_ids));
  ```

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`INSERT OR REPLACE` in `saveStmt` can trigger cascading deletes** - `/Users/dean/Sandbox/claudine/src/implementations/schedule-repository.ts:160-170`
- Problem: The `saveStmt` uses `INSERT OR REPLACE` which deletes and re-inserts the row if the primary key exists. This triggers `ON DELETE CASCADE` on `schedule_executions`, wiping the entire execution history for that schedule. The codebase already has a separate `updateStmt` (line 174) specifically to avoid this, but any code path that calls `save()` on an existing schedule will lose its execution history.
- Impact: Potential data loss of schedule execution audit trail if `save()` is accidentally called for an update.
- Fix: Change `INSERT OR REPLACE` to `INSERT OR IGNORE` or `INSERT ... ON CONFLICT DO NOTHING` to prevent accidental overwrites, or add a guard in the `save()` method to check if the ID already exists.

### LOW

**`findDue` query returns all columns including `pipeline_steps` JSON** - `/Users/dean/Sandbox/claudine/src/implementations/schedule-repository.ts:208-212`
- Problem: The `SELECT *` in `findDueStmt` now includes the potentially large `pipeline_steps` JSON blob for every due schedule query. For schedules without pipelines this is just a NULL, but for pipeline schedules with 20 steps and long prompts, this adds unnecessary data to the critical scheduler tick path.
- Impact: Minor performance concern on the hot path. Negligible for typical workloads.
- Fix: No immediate action needed. If performance becomes a concern, consider a projection query that omits `pipeline_steps` for the `findDue` path, loading it lazily when a trigger actually fires.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 1 |
| Pre-existing | 0 | 0 | 1 | 1 |

**Database Score**: 6/10
**Recommendation**: CHANGES_REQUESTED

### Rationale

The schema migration is clean and follows existing patterns well. JSON serialization/deserialization for the new columns is implemented correctly in the repository layer, with proper Zod validation on the `pipeline_steps` read path. The test coverage for round-trip persistence is solid (4 new repository tests).

The two HIGH issues center on the same root concern: the pipeline task creation loop in `handlePipelineTrigger` lacks transactional atomicity. Creating up to 20 tasks with sequential `save()` calls and relying on application-level cleanup is fragile. A process crash between saves leaves the database in an inconsistent state with orphaned tasks and unresolved dependency rows. The `TaskRepository` already supports transactions, so wrapping the loop is straightforward. The cleanup path also bypasses the event system, meaning dependency rows for cancelled tasks remain in `pending` state.

The MEDIUM validation inconsistency (`pipeline_task_ids` parsed with a bare type assertion instead of Zod) is a minor integrity concern that should be addressed for consistency with the rest of the repository's boundary validation approach.
