# Database Review Report

**Branch**: feat/orchestrator-mode -> main
**Date**: 2026-03-27
**PR**: #123

---

## Issues in Your Changes (BLOCKING)

### HIGH

**Cancelling a PLANNING orchestration never updates DB status** - `src/services/orchestration-manager.ts:228-271`
**Confidence**: 92%
- Problem: When `cancelOrchestration()` is called on an orchestration in `PLANNING` state (no `loopId` yet), the method emits an `OrchestrationCancelled` event and returns `ok`. However, nothing subscribes to that event. The `OrchestrationHandler` only subscribes to `LoopCompleted` and `LoopCancelled` -- not `OrchestrationCancelled`. Since there is no loop to cancel, the `LoopCancelled` event is never fired, and the orchestration row stays in `planning` status forever. This is a data integrity bug: the API reports success but the database state is never updated.
- Fix: Either (a) have the `OrchestrationHandler` subscribe to `OrchestrationCancelled` and update the DB status directly, or (b) perform a direct DB update in `cancelOrchestration()` when `orchestration.loopId` is undefined, bypassing the event:
```typescript
// In cancelOrchestration(), after the loopId check:
if (!orchestration.loopId) {
  // No loop to cancel -- update DB directly
  const updated = updateOrchestration(orchestration, {
    status: OrchestratorStatus.CANCELLED,
    completedAt: Date.now(),
  });
  const updateResult = this.orchestrationRepo.update(updated);
  if (!updateResult.ok) return err(updateResult.error);
}
```

---

**`cleanupOldOrchestrations` SELECT and DELETE are not atomic** - `src/implementations/orchestration-repository.ts:204-227`
**Confidence**: 85%
- Problem: The cleanup method performs a SELECT to find old orchestrations, then deletes state files with `unlinkSync`, then runs a separate DELETE query. These operations are not wrapped in a transaction. If the process crashes between the file deletions and the DB delete, state files are removed but DB rows remain (orphaned rows pointing to missing files). Additionally, new orchestrations completing between the SELECT and DELETE could theoretically be caught, though this is very unlikely given the 7-day retention.
- Fix: Wrap the DB operations in a transaction and move file deletions to after the transaction commits (or accept best-effort on file cleanup):
```typescript
async cleanupOldOrchestrations(retentionMs: number): Promise<Result<number>> {
  return tryCatchAsync(async () => {
    const cutoff = Date.now() - retentionMs;
    const rows = this.cleanupStmt.all(cutoff) as Array<{ id: string; state_file_path: string }>;
    if (rows.length === 0) return 0;

    // Delete DB rows first (atomic)
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM orchestrations WHERE id IN (${placeholders})`).run(...ids);

    // Then delete state files (best effort -- orphan files are harmless)
    for (const row of rows) {
      try { unlinkSync(row.state_file_path); } catch { /* noop */ }
    }

    return rows.length;
  }, operationErrorHandler('cleanup old orchestrations'));
}
```

### MEDIUM

**`findByStatus` does not support offset -- pagination silently broken** - `src/implementations/orchestration-repository.ts:112-114`, `src/services/orchestration-manager.ts:217-226`
**Confidence**: 90%
- Problem: The `OrchestrationService.listOrchestrations()` interface accepts `(status?, limit?, offset?)`. When `status` is provided, the manager calls `findByStatus(status, limit)` which silently drops the `offset` parameter. The prepared statement only has `LIMIT ?` without `OFFSET ?`. The MCP adapter's `ListOrchestrators` tool exposes `offset` to users, so callers expect pagination to work with status filters, but it does not.
- Fix: Add `offset` support to `findByStatus`:
```sql
-- Repository: update findByStatusStmt
SELECT * FROM orchestrations WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?
```
```typescript
// Repository: findByStatus signature
async findByStatus(status: OrchestratorStatus, limit?: number, offset?: number)

// Manager: pass offset through
return this.orchestrationRepo.findByStatus(status, limit, offset);
```

---

**Migration v14 missing `created_at` index for ORDER BY performance** - `src/implementations/database.ts:722-745`
**Confidence**: 82%
- Problem: The `findAllPaginatedStmt` and `findByStatusStmt` both use `ORDER BY created_at DESC`. The migration creates indexes on `status` and `loop_id` but not on `created_at`. For large tables, the ORDER BY without an index causes a full table sort. Other tables in this codebase (e.g., `tasks`, `schedules`) have `created_at` indexes.
- Fix: Add an index on `created_at` in migration v14:
```sql
CREATE INDEX IF NOT EXISTS idx_orchestrations_created_at ON orchestrations(created_at);
```
Optionally, a compound index for the status+created_at query pattern:
```sql
CREATE INDEX IF NOT EXISTS idx_orchestrations_status_created ON orchestrations(status, created_at DESC);
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`cleanupOldOrchestrations` uses dynamic SQL with unbounded IN clause** - `src/implementations/orchestration-repository.ts:219-222`
**Confidence**: 80%
- Problem: The cleanup method dynamically constructs `DELETE FROM orchestrations WHERE id IN (?, ?, ?, ...)` with one placeholder per row. If there are thousands of old orchestrations (e.g., after extended operation), this generates a very large SQL statement. SQLite has a default `SQLITE_MAX_VARIABLE_NUMBER` of 999. Exceeding this limit will cause a runtime error.
- Fix: Batch the deletions in groups of 500:
```typescript
// Delete DB rows in batches (SQLite variable limit)
const BATCH_SIZE = 500;
for (let i = 0; i < ids.length; i += BATCH_SIZE) {
  const batch = ids.slice(i, i + BATCH_SIZE);
  const placeholders = batch.map(() => '?').join(',');
  this.db.prepare(`DELETE FROM orchestrations WHERE id IN (${placeholders})`).run(...batch);
}
```

## Pre-existing Issues (Not Blocking)

No pre-existing database issues found in the reviewed files.

## Suggestions (Lower Confidence)

- **State file path not validated on read from DB** - `src/implementations/orchestration-repository.ts:276` (Confidence: 65%) -- The `state_file_path` column value is used directly in `unlinkSync` during cleanup. While the path originates from controlled code (not user input), a corrupted DB row could cause deletion of an arbitrary file. The CLI `handleOrchestrateStatus` validates the path before reading (defense-in-depth), but the cleanup code does not. Consider adding `validatePath()` before `unlinkSync`.

- **`save()` and `update()` are synchronous but interface peers are async** - `src/core/interfaces.ts:700-701` (Confidence: 62%) -- The `OrchestrationRepository` interface defines `save` and `update` as returning `Result<void>` (synchronous) while `findById`, `findAll`, etc. return `Promise<Result<...>>`. This is intentional (matches the project's sync-write pattern for `better-sqlite3`), but the mixed sync/async surface may surprise callers. This is consistent with other repositories in the codebase, so this is informational only.

- **No `UNIQUE` constraint on `loop_id` in orchestrations table** - `src/implementations/database.ts:729` (Confidence: 70%) -- The `loop_id` column is queried with `findByLoopId` which expects at most one result. If two orchestrations are accidentally linked to the same loop (e.g., due to a bug), only one would be found. A `UNIQUE` constraint would enforce the 1:1 relationship at the DB level.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | - | 2 | 2 | - |
| Should Fix | - | - | 1 | - |
| Pre-existing | - | - | - | - |

**Database Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The migration schema is well-structured and follows established project conventions (version-based, transactional, idempotent). The repository implementation uses prepared statements, Zod boundary validation, and the Result pattern consistently. The two HIGH findings are the cancellation status bug (silent data inconsistency) and the non-atomic cleanup operation. The missing offset in `findByStatus` breaks the pagination contract exposed by the MCP tool. All issues are straightforward to fix.
