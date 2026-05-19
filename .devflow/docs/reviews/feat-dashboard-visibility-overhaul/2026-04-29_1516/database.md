# Database Review Report

**Branch**: feat/dashboard-visibility-overhaul -> main
**Date**: 2026-04-29T15:16

## Issues in Your Changes (BLOCKING)

### HIGH

**CancelPipeline `cancelTasks` parameter accepted but never used** - `src/adapters/mcp-adapter.ts:3785`
**Confidence**: 95%
- Problem: The `CancelPipelineSchema` (line 353) adds a `cancelTasks` boolean field with `default: true`, and the MCP tool description advertises it (line 1710-1714). However, `handleCancelPipeline` at line 3785 destructures only `{ pipelineId, reason }` from `parseResult.data` -- `cancelTasks` is silently ignored. The handler directly updates the pipeline to `CANCELLED` without cancelling in-flight step tasks, regardless of the `cancelTasks` flag. This means the MCP tool promises task cancellation by default but never delivers it.
- Fix: Destructure `cancelTasks` and, when truthy, iterate over `pipeline.stepTaskIds` to emit `TaskCancellationRequested` for each non-null, non-terminal task (matching the pattern in `schedule-manager.ts:170-196`):
```typescript
const { pipelineId, reason, cancelTasks } = parseResult.data;
// ... after successful pipeline update ...
if (cancelTasks !== false) {
  for (const taskId of pipeline.stepTaskIds) {
    if (taskId === null) continue;
    const cancelResult = await this.eventBus.emit('TaskCancellationRequested', {
      taskId,
      reason: reason ?? `Pipeline ${pipelineId} cancelled`,
    });
    if (!cancelResult.ok) {
      this.logger.warn('Failed to cancel pipeline step task', { taskId, pipelineId });
    }
  }
}
```

### MEDIUM

**Read-modify-write race in `handleScheduleExecuted` (no transaction)** - `src/services/handlers/pipeline-handler.ts:97-141`
**Confidence**: 82%
- Problem: `handleScheduleExecuted` reads the pipeline (line 104), modifies `stepTaskIds` in memory (line 118-119), then writes back (line 122). If two `ScheduleExecuted` events fire concurrently for the same pipeline (e.g., two steps dispatched near-simultaneously), the second write can overwrite the first step's `taskId` because it reads stale state. This is a TOCTOU (time-of-check-time-of-use) window. The project already documents TOCTOU protection via synchronous transactions for similar patterns (CLAUDE.md: "Use synchronous `db.transaction()` for atomicity").
- Fix: This is mitigated by the fact that pipeline steps are sequential (each step's schedule has `afterScheduleId` pointing to the previous), so concurrent dispatch is unlikely in practice. However, for defense-in-depth, consider wrapping the read-modify-write in a transaction or using an atomic SQL UPDATE that sets a single JSON array element without full replacement. At minimum, add a comment documenting why no transaction is needed (sequential schedule dispatch guarantee).

## Issues in Code You Touched (Should Fix)

### MEDIUM

**N+1 query pattern in `updatePipelineStatus`** - `src/services/handlers/pipeline-handler.ts:230-246`
**Confidence**: 85%
- Problem: `updatePipelineStatus` iterates over every `stepTaskId` (up to 20 per pipeline) and calls `this.taskRepository.findById(tid)` individually in a serial loop (line 234). This is an N+1 query pattern -- 1 query to get the pipeline, then N queries (one per step) to get task statuses. While pipelines are capped at 20 steps, this fires on every `TaskCompleted`, `TaskFailed`, or `TaskCancelled` event for any pipeline step, making it a hot path.
- Fix: Add a batch method `findByIds(ids: TaskId[])` to `TaskRepository` using `SELECT * FROM tasks WHERE id IN (...)` and use it here. For SQLite with better-sqlite3, this can use a prepared statement with dynamic placeholders:
```typescript
// In task-repository.ts:
async findByIds(ids: readonly TaskId[]): Promise<Result<readonly Task[]>> {
  const placeholders = ids.map(() => '?').join(',');
  const stmt = this.db.prepare(`SELECT * FROM tasks WHERE id IN (${placeholders})`);
  const rows = stmt.all(...ids);
  return ok(rows.map(r => this.rowToTask(r)));
}
```

**N+1 query pattern in `handlePipelineStatus`** - `src/adapters/mcp-adapter.ts:3681-3699`
**Confidence**: 85%
- Problem: Same N+1 pattern as above -- `handlePipelineStatus` calls `this.taskManager.getStatus(taskId)` in a `Promise.all` loop for every step (up to 20). While `Promise.all` parallelizes the calls, each still hits the DB individually. This is an MCP tool response path (user-facing latency).
- Fix: Same batch approach as above. Alternatively, since this is a read-only status query and pipelines have at most 20 steps, the parallel `Promise.all` approach is acceptable performance-wise. Consider adding a comment documenting the bounded nature.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`findActiveByTaskId` and `findActiveByStepScheduleId` use full-table scan with in-process filter** - `src/implementations/pipeline-repository.ts:303-330`
**Confidence**: 80%
- Problem: Both methods fetch ALL active pipelines (`findActiveStmt.all()`) then filter in JavaScript. For `findActiveByTaskId`, it searches `stepTaskIds` (a JSON blob) by string inclusion. For `findActiveByStepScheduleId`, it parses the `steps` JSON and checks `scheduleId`. The ARCHITECTURE comment correctly notes this is bounded by active pipeline count. However, as usage grows, this could become expensive. SQLite's `json_each()` function could push filtering to the DB layer.
- Fix: No action needed now -- the bounded-scan justification is valid and well-documented. If active pipeline counts grow beyond ~100, consider a SQL-level JSON search:
```sql
SELECT p.* FROM pipelines p, json_each(p.step_task_ids) j
WHERE p.status IN ('pending', 'running') AND j.value = ?
```

## Suggestions (Lower Confidence)

- **Missing index for `findActiveByStepScheduleId` JSON search** - `src/implementations/pipeline-repository.ts:320-330` (Confidence: 65%) -- The `scheduleId` field embedded in the `steps` JSON column cannot be indexed directly. If this query becomes frequent, consider denormalizing `scheduleId` into a separate column or a junction table for indexed lookups.

- **Migration v24 `IF NOT EXISTS` idempotency change alters existing migration** - `src/implementations/database.ts:981-987` (Confidence: 70%) -- Adding `IF NOT EXISTS` to index creation in migration v24 changes the behavior of an already-shipped migration. For databases that already applied v24 successfully, this is a no-op. But if a database partially applied v24 (crashed mid-migration), re-running would now silently skip indexes instead of failing. This is arguably safer behavior, but worth noting as a philosophical choice.

- **`steps` JSON blob stores `scheduleId` without validation on write** - `src/implementations/pipeline-repository.ts:340-358` (Confidence: 62%) -- `pipelineToRow` serializes the full `steps` array including `scheduleId` via `JSON.stringify`. The `StepDefinitionSchema` on the read path validates `scheduleId` as optional string, but there is no explicit validation that the stored `scheduleId` references a valid schedule. This is acceptable given the bounded lifecycle (schedules are created immediately before pipeline save in `createPipeline`).

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Database Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The `cancelTasks` parameter being accepted but silently ignored is a data integrity issue -- users will expect in-flight tasks to be cancelled when `CancelPipeline` is called (it defaults to `true`), but orphaned tasks will continue running. The read-modify-write race in `handleScheduleExecuted` is mitigated by sequential scheduling but deserves at minimum a documenting comment. The N+1 patterns are bounded (max 20 steps) but represent technical debt that will compound as pipeline usage grows.
