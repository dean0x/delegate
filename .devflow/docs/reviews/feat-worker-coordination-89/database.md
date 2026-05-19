# Database Review Report

**Branch**: feat/worker-coordination-89 -> main
**Date**: 2026-03-17
**Commits**: 7324e28 feat: SQLite worker coordination + output persistence (#89), 0c496f3 fix: address self-review issues

---

## Issues in Your Changes (BLOCKING)

### CRITICAL

_None found._

### HIGH

_None found._

### MEDIUM

**No migration rollback (down) for version 9** - `src/implementations/database.ts:536-560`
- Problem: Migration version 9 adds the `workers` table but provides no `down()` function. If the migration needs to be rolled back (e.g., a bug is discovered post-deploy), there is no automated path to revert the schema change.
- Impact: Consistent with existing migrations (versions 1-8 all omit `down()`), but this is worth flagging for a table that will have active rows deleted on rollback. Orphaned worker registrations in a rolled-back schema could cause confusing errors.
- Fix: This is a pre-existing pattern decision. If the project decides to add rollback support, all migrations should be updated together. No blocking action required here.

**Periodic output flush at 500ms fixed interval has no backpressure** - `src/services/process-connector.ts:69-74`
- Problem: The 500ms `setInterval` for output flushing calls `outputRepository.save()` which does a synchronous `INSERT OR REPLACE` on the `task_output` table. If a previous save is still in-flight (e.g., file-based large output), the next interval fires regardless, creating overlapping writes. Since `save()` is async (file path) but the SQLite write is synchronous, this is mostly safe for DB-only saves, but the file fallback path could have overlapping filesystem writes.
- Impact: For typical workloads with small output this is fine. For large outputs (above `fileStorageThresholdBytes`), concurrent `saveToFile` calls could corrupt the output JSON file.
- Fix: Guard with a flushing-in-progress flag:
  ```typescript
  private flushingInProgress = new Set<TaskId>();

  // In the interval callback:
  if (!this.flushingInProgress.has(taskId)) {
    this.flushingInProgress.add(taskId);
    this.flushOutput(taskId)
      .catch(...)
      .finally(() => this.flushingInProgress.delete(taskId));
  }
  ```

## Issues in Code You Touched (Should Fix)

### HIGH

_None found._

### MEDIUM

**Worker registration and in-memory map not atomic** - `src/implementations/event-driven-worker-pool.ts:107-126`
- Problem: The spawn flow adds the worker to `this.workers` (line 106-107) and `this.taskToWorker` (line 108), then performs the DB registration (lines 112-126). If the DB registration fails (UNIQUE constraint), the code correctly cleans up the in-memory state and kills the process. However, between lines 108 and 112, there is a window where the in-memory maps contain a worker that is not yet registered in the DB. If `getWorkerCount()` or `getActiveWorkers()` is called during this window by another async path, it would see an inconsistent state.
- Impact: Low probability in practice since `spawn()` is typically sequential. The cleanup on failure is correct, so this is a theoretical race rather than a practical bug.
- Fix: Acceptable as-is. If needed, register in DB first, then add to in-memory maps.

**Recovery manager iterates all workers with no batch size limit** - `src/services/recovery-manager.ts:35-55`
- Problem: Phase 0 of recovery calls `findAll()` and iterates every worker registration, issuing individual `unregister()` and `repository.update()` calls per dead worker. With many crashed workers (e.g., 50+), this generates O(n) individual SQLite writes.
- Impact: Recovery runs once at startup, so this is unlikely to be a performance bottleneck. However, wrapping the dead worker cleanup in `runInTransaction()` would be more efficient and atomic.
- Fix: Consider batching via transaction:
  ```typescript
  // Instead of individual unregister + update calls per dead worker:
  this.database.runInTransaction(() => {
    for (const reg of deadWorkers) {
      this.workerRepository.unregister(reg.workerId);
      // sync update for task status...
    }
  });
  ```
  Note: This requires `TaskRepository` to have a sync update path and `RecoveryManager` to receive a `TransactionRunner` dependency.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**OutputRepository.save uses INSERT OR REPLACE without transaction protection** - `src/implementations/output-repository.ts:46-51`
- Problem: The `save()` method uses `INSERT OR REPLACE` which atomically replaces the row, but the decision between DB storage and file storage (line 69-73) is made outside any transaction. If two concurrent callers save the same task output, one might write to file while the other writes to DB, leaving the DB row pointing at a stale file reference.
- Impact: With the new periodic flush design, concurrent saves to the same task from different code paths (periodic flush + final flush) could theoretically race. In practice, `stopFlushing()` is called before the final flush, so this is mitigated.

**No cleanup of workers table rows when tasks table rows are cleaned up by `cleanupOldTasks`** - `src/implementations/database.ts:550`
- Problem: The `workers` table has `ON DELETE CASCADE` from `task_id` referencing `tasks(id)`, so deleting a task will cascade-delete its worker row. This is correct. However, if a worker row exists for a task that was never cleaned up (orphaned worker), it will persist indefinitely.
- Impact: Worker rows should be short-lived (registered on spawn, removed on completion/kill), so orphans are unlikely. The recovery manager's Phase 0 handles the common orphan scenario (dead owner PID).

### LOW

**Duplicate `createMockWorkerRepo` factory across 4+ test files** - multiple test files
- Problem: The `createMockWorkerRepo()` helper is copy-pasted identically in `task-persistence.test.ts`, `event-flow.test.ts`, `system-resource-monitor.test.ts`, and `event-driven-worker-pool.test.ts`. The `TestWorkerRepository` in `test-doubles.ts` provides a real in-memory implementation, but these tests use a simpler mock version.
- Impact: Code duplication in tests. If the `WorkerRepository` interface changes, all four copies need updating.
- Fix: Extract `createMockWorkerRepo()` into `tests/fixtures/mocks.ts` or use `TestWorkerRepository` from `test-doubles.ts` consistently.

---

## Schema Analysis

### New Table: `workers` (Migration v9)

| Column | Type | Constraints | Assessment |
|--------|------|-------------|------------|
| `worker_id` | TEXT | PRIMARY KEY | Correct - natural key from PID |
| `task_id` | TEXT | NOT NULL UNIQUE, FK -> tasks(id) CASCADE | Correct - enforces 1:1 worker-to-task |
| `pid` | INTEGER | NOT NULL | Correct - worker process PID |
| `owner_pid` | INTEGER | NOT NULL | Correct - parent process PID for crash detection |
| `agent` | TEXT | NOT NULL DEFAULT 'claude' | Correct - consistent with tasks.agent |
| `started_at` | INTEGER | NOT NULL | Correct - epoch timestamp |

### Indexes Added

| Index | Column(s) | Assessment |
|-------|-----------|------------|
| `idx_workers_owner_pid` | `owner_pid` | Correct - used by `findByOwnerPid()` and `deleteByOwnerPid()` in recovery |
| `idx_workers_pid` | `pid` | Correct - supports process-level lookups |

### Foreign Keys

| FK | Reference | On Delete | Assessment |
|----|-----------|-----------|------------|
| `task_id` | `tasks(id)` | CASCADE | Correct - worker row is meaningless without its task |

### Query Efficiency

| Method | Query | Index Used | Assessment |
|--------|-------|------------|------------|
| `register()` | INSERT with named params | PK + UNIQUE | Correct, prepared statement |
| `unregister()` | DELETE by worker_id | PK | Optimal |
| `findByTaskId()` | SELECT by task_id | UNIQUE constraint index | Optimal |
| `findByOwnerPid()` | SELECT by owner_pid | idx_workers_owner_pid | Optimal |
| `findAll()` | SELECT * ORDER BY started_at | Full scan + sort | Acceptable for small table |
| `getGlobalCount()` | SELECT COUNT(*) | Full scan | Acceptable for small table |
| `deleteByOwnerPid()` | DELETE by owner_pid | idx_workers_owner_pid | Optimal |

All queries use prepared statements (cached at construction time). No SQL injection risks. No N+1 patterns.

---

## Database Checklist

- [x] All queries have appropriate indexes
- [x] N+1 patterns identified and resolved (no N+1 present)
- [ ] Migrations have rollback scripts (consistent with existing pattern - no rollbacks in project)
- [x] Data types are appropriate (TEXT for IDs, INTEGER for PIDs/timestamps)
- [x] Constraints enforce business rules (UNIQUE on task_id, NOT NULL on all columns)
- [x] Foreign keys maintain referential integrity (CASCADE on task_id -> tasks)
- [x] No SQL injection vulnerabilities (all queries parameterized via prepared statements)
- [x] Repository uses synchronous Result<T> pattern (compatible with runInTransaction)

---

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 2 | 1 |

**Database Score**: 8/10

The schema design is clean and well-indexed. The repository follows project conventions (synchronous Result<T>, prepared statements, proper error wrapping). The migration is consistent with existing patterns. The main concerns are the lack of backpressure on the 500ms periodic flush interval (MEDIUM) and the non-atomic recovery loop (MEDIUM, should-fix). The UNIQUE constraint on `task_id` provides correct cross-process coordination semantics. Foreign key with CASCADE is appropriate. Overall, this is solid database work.

**Recommendation**: APPROVED_WITH_CONDITIONS

Conditions:
1. Consider adding the flush-in-progress guard to prevent overlapping file writes for large outputs (MEDIUM blocking)
2. The recovery batch transaction is a should-fix improvement that can be addressed in a follow-up
