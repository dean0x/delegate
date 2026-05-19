# Performance Review Report

**Branch**: feat/dashboard-visibility-overhaul -> main
**Date**: 2026-04-29T15:16

## Issues in Your Changes (BLOCKING)

### HIGH

**Sequential N+1 task lookups in PipelineHandler.updatePipelineStatus** - `src/services/handlers/pipeline-handler.ts:231-246`
**Confidence**: 90%
- Problem: `updatePipelineStatus` iterates over `pipeline.stepTaskIds` and calls `this.taskRepository.findById(tid)` sequentially in a `for` loop. For a pipeline with N steps (up to 20), this issues N sequential database queries. This method is invoked on every task lifecycle event (completed, failed, cancelled) for pipelines containing that task.
- Impact: Each task state change triggers O(N) serial DB round-trips where N is the pipeline step count. With 20-step pipelines, this adds measurable latency to the event handler path. While SQLite is local (no network round-trip), each call goes through async wrappers, `tryCatchAsync`, and Zod validation in `rowToPipeline`. On a busy system with many concurrent pipelines, this serializes event processing.
- Fix: Use `Promise.all` for independent step task lookups. All lookups are independent read operations with no ordering dependency:
  ```typescript
  const stepStatusResults = await Promise.all(
    pipeline.stepTaskIds.map(async (tid, stepIdx) => {
      if (tid === null) return null;
      const taskResult = await this.taskRepository.findById(tid);
      if (!taskResult.ok) {
        this.logger.warn('PipelineHandler: failed to fetch step task', {
          taskId: tid, pipelineId: pipeline.id, error: taskResult.error.message,
        });
        return null;
      }
      if (!taskResult.value) return null;
      return { taskId: tid, status: taskResult.value.status, stepIndex: stepIdx };
    }),
  );
  const stepStatuses = stepStatusResults.filter((s): s is NonNullable<typeof s> => s !== null);
  ```
  Note: For SQLite specifically, the benefit is moderate since queries run in-process. The bigger gain is avoiding N async context switches. If pipeline step counts remain small (2-5 typical), this is a "should fix while here" rather than critical.

### MEDIUM

**Sequential N+1 task lookups in handlePipelineStatus MCP handler** - `src/adapters/mcp-adapter.ts:3681-3699`
**Confidence**: 85%
- Problem: The `handlePipelineStatus` MCP handler uses `Promise.all` correctly to parallelize step lookups, so this is NOT the classic sequential N+1. However, each step calls `this.taskManager.getStatus(taskId)` which makes a full repository lookup per step. For a 20-step pipeline, this is 20 individual task lookups via the task manager.
- Impact: Since `Promise.all` is used, the wall-clock time is bounded by the slowest query rather than the sum. For SQLite (in-process), this is acceptable. The concern is that each `getStatus` call may do its own validation/parsing overhead. For an MCP tool call (user-facing, not event-driven), the latency is tolerable but could be improved with a batch query.
- Fix: Consider adding a `findByIds(ids: TaskId[])` batch method to `TaskRepository` to fetch all step tasks in a single `WHERE id IN (...)` query. Not blocking, but worthwhile for pipelines with many steps.

**Full-table scan of active pipelines on every task lifecycle event** - `src/implementations/pipeline-repository.ts:303-312`
**Confidence**: 82%
- Problem: Both `findActiveByTaskId` and `findActiveByStepScheduleId` call `this.findActiveStmt.all()` which fetches ALL active (pending/running) pipelines, deserializes each row (including JSON parse + Zod validation), then filters in-process. The comment says "bounded in practice" but does not enforce a limit.
- Impact: If the system accumulates many active pipelines (e.g., a burst of 50+ concurrent pipelines), every single `TaskCompleted`/`TaskFailed`/`TaskCancelled` event triggers a full scan of all active pipeline rows with JSON parse + Zod validation for each. The `findActiveByTaskId` is called on EVERY task lifecycle event, not just pipeline-related tasks. Most of the time it will scan many rows and find zero matches for non-pipeline tasks.
- Fix: Two options, either is effective:
  1. Add `LIMIT` to `findActiveStmt` (e.g., 200) as a safety bound
  2. Use a `WHERE step_task_ids LIKE '%' || ? || '%'` filter in SQL (crude but moves filtering to SQLite, avoiding JSON parse for non-matching rows). Better: maintain an in-memory Set of active pipeline task IDs that gets invalidated on updates.
  The architectural comment acknowledges this is bounded, so this is medium severity unless pipeline counts grow.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Redundant pipeline lookup in handleScheduleExecuted + onTaskTerminated** - `src/services/handlers/pipeline-handler.ts:97-141` and `168-211`
**Confidence**: 80%
- Problem: When `ScheduleExecuted` fires, `handleScheduleExecuted` calls `findActiveByStepScheduleId` (full active pipeline scan). Then, when the task created by that schedule later completes, `onTaskTerminated` calls `findActiveByTaskId` (another full active pipeline scan). Both scans load and deserialize all active pipelines. This is a double-scan pattern for each pipeline step execution.
- Impact: For a 20-step pipeline, every step trigger causes two full scans of active pipelines across the lifecycle (one at schedule-execute time, one at task-complete time). The overhead is O(active_pipelines * step_count * 2) JSON parses.
- Fix: Consider caching the pipeline lookup result from `handleScheduleExecuted` (e.g., in a short-lived Map keyed by taskId) so `onTaskTerminated` can skip the full scan. Alternatively, store the pipelineId on the task metadata so `onTaskTerminated` can do a targeted `findById` instead of scanning.

## Pre-existing Issues (Not Blocking)

No critical pre-existing performance issues found in the reviewed files.

## Suggestions (Lower Confidence)

- **Dashboard `getEntityDisplayFields` linear search** - `src/cli/dashboard/components/entity-browser-panel.tsx:46-98` (Confidence: 65%) -- Each `EntityRow` render calls `data.tasks.find()` / `data.loops.find()` etc. with O(n) array search per row. For the current FETCH_LIMIT (likely 50-100 items), this is a quadratic pattern (n rows * n items to search). Converting data arrays to Maps (keyed by ID) before rendering would make each lookup O(1). Low impact at current scale.

- **`cancelSchedule` iterates all execution history for task cancellation** - `src/services/schedule-manager.ts:170-196` (Confidence: 70%) -- `getExecutionHistory(scheduleId)` fetches ALL executions for the schedule, then filters for 'triggered' status in-process. For long-running cron schedules with many historical executions, this loads unnecessary data. A `findActiveExecutions(scheduleId)` query would be more targeted.

- **`ActivityTile` slice + reverse on every render** - `src/cli/dashboard/components/activity-tile.tsx:28` (Confidence: 60%) -- `activityFeed.slice(-maxEntries).reverse()` creates two new arrays on every render. With `React.memo` the component only re-renders when props change, so the impact is minimal. A `useMemo` inside the component would prevent re-computation if the parent re-renders with the same feed reference.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Performance Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The sequential task lookup in `updatePipelineStatus` should be parallelized (HIGH). The full active-pipeline scan pattern is architecturally acknowledged but would benefit from a LIMIT safety bound (MEDIUM). The dashboard simplification (removing ActivityPanel interactivity, consolidating tiles) is a net positive for rendering performance -- fewer components, fewer re-renders, simpler state. The `React.memo` usage on new components (ActivityTile, StatsTile) is correct and prevents unnecessary re-renders.
