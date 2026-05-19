# Database Review Report

**Branch**: feat/dashboard-visibility-overhaul -> main
**Date**: 2026-04-28

## Issues in Your Changes (BLOCKING)

### HIGH

**Missing `IF NOT EXISTS` on all 5 index CREATE statements in migration v24** - `src/implementations/database.ts:981-987`
**Confidence**: 95%
- Problem: Migration v24 creates indexes with `CREATE INDEX` instead of `CREATE INDEX IF NOT EXISTS`. Every other migration in the file (v1, v2, v3, v4, v5, v11, v14, v18, v19, v20, v22) uses `IF NOT EXISTS` for idempotency. The migration framework's own documentation in `getMigrations()` (line 260) states: "Uses IF NOT EXISTS for idempotency (safe if migration runs twice)". Without `IF NOT EXISTS`, if migration v24 is applied to a database where the indexes somehow already exist (e.g., a partially-failed prior run that was recorded), the migration will throw an error and fail to apply.
- Fix: Add `IF NOT EXISTS` to all 5 index creation statements:
```sql
db.exec(`CREATE INDEX IF NOT EXISTS idx_pipelines_status ON pipelines(status)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_pipelines_schedule_id ON pipelines(schedule_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_pipelines_loop_id ON pipelines(loop_id)`);
db.exec(
  `CREATE INDEX IF NOT EXISTS idx_pipelines_orchestrator_id ON pipelines(orchestrator_id) WHERE orchestrator_id IS NOT NULL`,
);
db.exec(`CREATE INDEX IF NOT EXISTS idx_pipelines_updated_at ON pipelines(updated_at)`);
```

### MEDIUM

**N+1 query pattern in PipelineHandler.updatePipelineStatus** - `src/services/handlers/pipeline-handler.ts:157-172`
**Confidence**: 82%
- Problem: The handler iterates over `pipeline.stepTaskIds` and issues a separate `findById` call to `taskRepository` for each step task. For a pipeline with N steps, this executes N individual SELECT queries. While pipelines are typically small (5-10 steps), this is an unbounded N+1 pattern -- there is no enforced max step count in the domain or MCP schema. Additionally, this runs on every `TaskCompleted`/`TaskFailed`/`TaskCancelled` event, so it executes frequently.
- Fix: Consider adding a batch `findByIds(ids: TaskId[])` method to `TaskRepository` that uses a single `WHERE id IN (...)` query. Alternatively, since this is bounded by pipeline step count (which is practically small), document the assumption with a max step guard:
```typescript
// Guard: pipelines are expected to have < 50 steps; N+1 is acceptable at this scale
if (taskIds.length > 50) {
  this.logger.warn('Large pipeline detected', { pipelineId: pipeline.id, stepCount: taskIds.length });
}
```

**`findActiveByTaskId` not on the `PipelineRepository` interface** - `src/implementations/pipeline-repository.ts:301` / `src/core/interfaces.ts:933`
**Confidence**: 85%
- Problem: `findActiveByTaskId` is implemented on `SQLitePipelineRepository` but not declared on the `PipelineRepository` interface. This forces `PipelineHandler` to depend on the concrete `SQLitePipelineRepository` class (`pipeline-handler.ts:19,22,29`) instead of the `PipelineRepository` interface, breaking the dependency inversion principle that the rest of the codebase follows. The handler-setup also types the dependency as `SQLitePipelineRepository` rather than the interface.
- Fix: Add `findActiveByTaskId` to the `PipelineRepository` interface:
```typescript
export interface PipelineRepository {
  // ... existing methods ...
  findActiveByTaskId(taskId: TaskId): Promise<Result<readonly Pipeline[]>>;
}
```
Then update `PipelineHandler` and `HandlerDependencies` to depend on `PipelineRepository` instead of `SQLitePipelineRepository`.

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **TOCTOU window in pipeline status aggregation** - `src/services/handlers/pipeline-handler.ts:155-177` (Confidence: 65%) -- The handler reads each task's status individually without a transaction, meaning a task's status could change between reads. In practice this is mitigated by the event-driven architecture (the handler will be re-invoked on the next event), but a transactional batch read would be strictly safer.

- **Pipeline entity save is fire-and-forget in schedule-manager** - `src/services/schedule-manager.ts:419-428` (Confidence: 70%) -- When `pipelineRepository.save()` fails, the pipeline entity ID is still returned in `PipelineResult.pipelineEntityId`. Downstream consumers may attempt to look up a pipeline that was never persisted. The warning log is appropriate for non-fatal handling, but the returned `pipelineEntityId` is misleading if the save failed.

- **`rowToPipeline` throws plain `Error` instead of `AutobeatError`** - `src/implementations/pipeline-repository.ts:364-366,374-376` (Confidence: 68%) -- The JSON parse/validate catch blocks throw `new Error(...)` which gets caught by `tryCatchAsync` and wrapped via `operationErrorHandler`. Other repositories in the codebase use the same pattern so this is consistent, but it means the error loses structured context. Not blocking since `tryCatchAsync` handles it gracefully.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Database Score**: 8/10
**Recommendation**: CHANGES_REQUESTED

The migration v24 schema is well-designed: correct types, proper CHECK constraint on status, appropriate foreign keys with ON DELETE SET NULL, partial index on orchestrator_id, and all 5 planned indexes present. The pipeline repository follows project conventions with Zod boundary validation, prepared statements, Result types, and JSON serialization matching the loop/schedule pattern. The pipeline handler correctly avoids direct DB access, routing all persistence through the repository.

The one blocking item (missing `IF NOT EXISTS` on indexes) is a straightforward fix that maintains the idempotency contract documented in the migration system. The interface gap and N+1 pattern are worth addressing but do not pose data integrity risk.
