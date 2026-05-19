# Database Review Report

**Branch**: feat/v070-task-loops -> main
**Date**: 2026-03-21

## Issues in Your Changes (BLOCKING)

### HIGH

**Missing index on `loops.status` column** - `src/implementations/database.ts:568-618`
**Confidence**: 95%
- Problem: The `loops` table has no index on the `status` column, yet `findByStatus()` queries filter by `status` and `cleanupOldLoops()` filters by `status IN (...)`. The existing `schedules` table has `idx_schedules_status` for the same access pattern. The `findRunningIterationsStmt` also joins `loops` with `WHERE l.status = 'running'`, which will require a full table scan on `loops`.
- Impact: As the `loops` table grows, `findByStatus()`, `cleanupOldLoops()`, and recovery queries (`findRunningIterations`) degrade to full table scans. While the table may stay small in practice, this is a gap compared to every other table's indexing strategy in the codebase.
- Fix: Add a status index in migration v10:
```sql
CREATE INDEX IF NOT EXISTS idx_loops_status ON loops(status);
```

**Missing index on `loops.completed_at` column** - `src/implementations/database.ts:568-618`
**Confidence**: 90%
- Problem: The `cleanupOldLoopsStmt` executes `DELETE FROM loops WHERE status IN (...) AND completed_at < ?`. Without an index on `completed_at`, the database must scan all rows matching the status filter to evaluate the timestamp condition. This runs during every recovery cycle.
- Impact: Cleanup query performance degrades linearly with table size. Combined with the missing status index above, this is a compound concern for the cleanup path.
- Fix: Add a composite index in migration v10:
```sql
CREATE INDEX IF NOT EXISTS idx_loops_status_completed ON loops(status, completed_at);
```
This single composite index would cover both `findByStatus()` and `cleanupOldLoops()`, replacing the need for a standalone status index.

### MEDIUM

**Missing CHECK constraint on `eval_direction` column** - `src/implementations/database.ts:577`
**Confidence**: 85%
- Problem: The `eval_direction` column in the `loops` table has no CHECK constraint. Every other enum-like column in this migration uses CHECK constraints (`strategy`, `status`), and the project consistently applies CHECK constraints for defense-in-depth (migrations v2, v3, v4 all add them). The repository's `toOptimizeDirection()` throws on unknown values, but the database should enforce this at the schema level.
- Impact: Without a DB-level constraint, invalid values could be inserted via direct database access or future bugs, causing runtime exceptions in `toOptimizeDirection()` instead of clean INSERT/UPDATE failures.
- Fix: Add a CHECK constraint to the column definition:
```sql
eval_direction TEXT CHECK(eval_direction IS NULL OR eval_direction IN ('minimize', 'maximize')),
```

**Non-atomic iteration result + loop update in `recordAndContinue`** - `src/services/handlers/loop-handler.ts:868-904`
**Confidence**: 82%
- Problem: The `recordAndContinue` method performs 3 sequential database writes (updateIteration, emit event, update loop) without a transaction. If the process crashes between step 1 (iteration marked complete) and step 3 (loop updated with new consecutiveFailures/bestScore), the loop state becomes inconsistent: the iteration is recorded as done, but the loop's aggregate counters are stale.
- Impact: After a crash at this exact point, recovery (`recoverStuckLoops`) would find the loop still running with a stale `currentIteration` value, and could re-evaluate or re-start the same iteration. The recovery logic handles this somewhat gracefully, but the state inconsistency window exists.
- Fix: Wrap the iteration update and loop update in a single transaction using the sync methods that already exist:
```typescript
this.database.runInTransaction(() => {
  this.loopRepo.updateIterationSync({...iteration, status: iterationStatus, ...});
  this.loopRepo.updateSync(updateLoop(loop, loopUpdate));
});
// Emit event AFTER commit
await this.eventBus.emit('LoopIterationCompleted', {...});
```
Note: This pattern is already used in `startPipelineIteration` (line 498) and `startNextIteration` (line 377) for the same reason.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**No migration rollback (`down`) for migration v10** - `src/implementations/database.ts:562-619`
**Confidence**: 80%
- Problem: Migration v10 adds two new tables and indexes but provides no rollback path. The database-patterns checklist calls for rollback scripts on all migrations.
- Impact: If migration v10 causes issues in production, the only recovery path is manual SQL or restoring from backup. However, this is consistent with all previous migrations (v1-v9) in this codebase, which also lack `down()` methods. The project has chosen not to implement rollbacks as a pattern.
- Fix: This is an informational finding given the project's established convention. If rollbacks are ever needed, the migration framework would need to be extended to support `down()` methods project-wide. No action needed for this PR specifically.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**No index on `loops` table for the `findRunningIterations` JOIN** - `src/implementations/loop-repository.ts:249-253`
**Confidence**: 80%
- Problem: The `findRunningIterationsStmt` joins `loop_iterations` to `loops` with `WHERE l.status = 'running' AND li.status = 'running'`. While `idx_loop_iterations_status` covers the iteration side, the `loops` side has no status index (as noted above in BLOCKING). The query plan will scan `loops` for status = 'running' then join.
- Impact: Same as the missing status index issue above. This is the same root cause manifesting in a different query.

## Suggestions (Lower Confidence)

- **Async wrappers on synchronous SQLite operations** - `src/implementations/loop-repository.ts:267-335` (Confidence: 70%) -- The async methods like `save()`, `update()`, `findById()` wrap synchronous `better-sqlite3` calls in `tryCatchAsync`. This is consistent with the existing schedule-repository pattern, so it is not a defect, but it does add overhead with no actual async benefit. Consider whether a sync-first API with async adapters at the service layer would be cleaner in a future refactor.

- **`updateIteration` updates only by `id` but `id` is auto-increment** - `src/implementations/loop-repository.ts:227-235` (Confidence: 65%) -- The `updateIterationStmt` updates by `WHERE id = @id`, but when an iteration is first created via `recordIteration`, the auto-increment `id` is not returned to the caller (the domain object passes `id: 0`). This works because `findIterationByTaskId` fetches the real `id` before updates occur, but it creates an implicit dependency on always fetching before updating.

- **`pipeline_task_ids` JSON parse failure is silently swallowed** - `src/implementations/loop-repository.ts:553-558` (Confidence: 75%) -- In `rowToIteration`, invalid `pipeline_task_ids` JSON is caught and silently set to `undefined` with a `// Non-fatal` comment, while `task_template` and `pipeline_steps` JSON parse failures in `rowToLoop` throw errors. The inconsistent error handling could mask data corruption.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Database Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The schema design is solid overall -- proper FK constraints with appropriate ON DELETE actions, CHECK constraints on key enum columns, appropriate use of transactions for critical operations (`startNextIteration`, `startPipelineIteration`), prepared statements throughout, and Zod validation at the database boundary. The two HIGH issues (missing indexes on `loops.status` and `loops.completed_at`) are straightforward additions to migration v10 that align with the indexing patterns already established by the `schedules` table.
