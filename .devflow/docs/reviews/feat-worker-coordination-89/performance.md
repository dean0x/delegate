# Performance Review Report

**Branch**: feat/worker-coordination-89 -> main
**Date**: 2026-03-17
**PR**: #94

## Issues in Your Changes (BLOCKING)

### HIGH

**Periodic output flush at 500ms interval creates excessive DB writes** - `src/services/process-connector.ts:70-74`
- Problem: Every connected worker process triggers a `setInterval` that calls `flushOutput()` every 500ms. Each flush reads the entire in-memory buffer via `getOutput()` and writes a full snapshot via `outputRepository.save()`. With N workers running for M seconds, this produces `N * (M / 0.5)` DB write operations. For 5 workers running 10 minutes each, that is 6,000 save operations.
- Impact: Heavy SQLite write amplification under load. Each `save()` overwrites the full output blob, meaning early flushes write small data and later flushes write increasingly large payloads. Combined with WAL mode journaling, this puts significant I/O pressure on the system.
- Fix: Increase the flush interval or use an incremental/append strategy. Consider:
  ```typescript
  // Option A: Longer interval (5-10 seconds is sufficient for cross-process visibility)
  const interval = setInterval(() => {
    this.flushOutput(taskId).catch(/* ... */);
  }, 5000); // 10x fewer writes

  // Option B: Dirty flag — only flush when new output has arrived
  // Track last-flushed size and skip flush if unchanged
  ```

**Sequential DB queries in recovery Phase 0 (N+1 pattern)** - `src/services/recovery-manager.ts:39-63`
- Problem: `findAll()` retrieves all worker registrations, then for each dead worker, two sequential operations occur: `unregister()` and `repository.update()`. The `update()` call is async (goes through the task repository). With K dead workers from a crash, this is 1 + 2K sequential DB operations where the updates could be batched.
- Impact: On a server restart after a crash with many stale workers (the exact scenario this PR targets), recovery time scales linearly with the number of dead workers. Each `repository.update()` is an individual SQLite transaction.
- Fix: Batch the dead worker cleanup into a single transaction:
  ```typescript
  // Collect dead workers first, then process in one transaction
  const deadWorkers = allWorkers.value.filter(reg => !this.isProcessAlive(reg.ownerPid));
  if (deadWorkers.length > 0) {
    // Consider using runInTransaction to batch all unregister + update calls
    // Or at minimum, batch the unregister calls with deleteByOwnerPid per dead PID
  }
  ```

### MEDIUM

**`canSpawnWorker()` issues synchronous DB query on every spawn check** - `src/implementations/resource-monitor.ts:89`
- Problem: `canSpawnWorker()` calls `this.workerRepository.getGlobalCount()` synchronously on every invocation. This method is called from the worker pool before each spawn, and also during periodic resource monitoring checks. The synchronous SQLite call blocks the event loop briefly each time.
- Impact: For a single-process setup, this is negligible (synchronous better-sqlite3 calls are fast, typically <1ms). However, this is called in the hot path for spawn decisions. If resource monitoring interval is short (100ms default), the DB is queried frequently even when no spawn is pending.
- Fix: This is acceptable for the current workload. Consider caching the count with a short TTL if profiling shows contention:
  ```typescript
  // Cache global count for 1-2 seconds to reduce DB hits
  private cachedGlobalCount: number = 0;
  private cacheTimestamp: number = 0;
  private readonly CACHE_TTL_MS = 2000;
  ```

**`flushOutput` writes full snapshot each time instead of appending** - `src/services/process-connector.ts:113-124`
- Problem: Each periodic flush calls `outputRepository.save(taskId, output)` with the entire accumulated output. This means if a task has produced 10MB of output, every 500ms flush writes 10MB to SQLite, even if only 100 bytes were added since the last flush.
- Impact: Write amplification grows with output size. For chatty workers, this becomes increasingly expensive over the task lifetime.
- Fix: The `OutputRepository` interface has an `append` method. Consider tracking what was already flushed and only appending the delta:
  ```typescript
  private lastFlushedSize = new Map<TaskId, number>();

  async flushOutput(taskId: TaskId): Promise<void> {
    const outputResult = this.outputCapture.getOutput(taskId);
    if (!outputResult.ok) return;
    const output = outputResult.value;
    const lastSize = this.lastFlushedSize.get(taskId) ?? 0;
    if (output.totalSize === lastSize) return; // No new data
    // Save full snapshot (or use append for delta)
    await this.outputRepository.save(taskId, output);
    this.lastFlushedSize.set(taskId, output.totalSize);
  }
  ```

**Double `Date.now()` call in spawn registration** - `src/implementations/event-driven-worker-pool.ts:97-115`
- Problem: `Date.now()` is called at line 97 for `worker.startedAt` and again at line 115 for the DB registration's `startedAt`. These will produce slightly different timestamps for the same logical spawn event.
- Impact: Minimal performance impact (two syscalls), but creates a data consistency issue where the in-memory worker and DB registration have different `startedAt` values. This could cause confusion during debugging or cross-process coordination.
- Fix: Capture `Date.now()` once and reuse:
  ```typescript
  const startedAt = Date.now();
  const worker: WorkerState = { /* ... */ startedAt, /* ... */ };
  const regResult = this.workerRepository.register({ /* ... */ startedAt });
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`flushIntervals` Map is never fully cleared on shutdown** - `src/services/process-connector.ts:12`
- Problem: The `flushIntervals` Map grows as workers are connected and entries are removed individually on exit/stop. However, there is no `dispose()` or `shutdown()` method to clear all intervals at once. If `killAll()` fails to cleanly exit all workers, leaked intervals will continue attempting DB writes.
- Impact: During ungraceful shutdown, lingering intervals could attempt writes against a closed database, producing errors in logs. The intervals also keep the Node.js event loop alive, preventing clean process exit.
- Fix: Add a `dispose()` method and call it from the pool's `killAll()`:
  ```typescript
  dispose(): void {
    for (const [taskId, interval] of this.flushIntervals) {
      clearInterval(interval);
    }
    this.flushIntervals.clear();
  }
  ```

**`findAll()` in recovery loads all worker registrations into memory** - `src/services/recovery-manager.ts:37`
- Problem: `workerRepository.findAll()` uses `SELECT * FROM workers ORDER BY started_at ASC`. While the workers table should be small in practice (bounded by max concurrent workers), there is no architectural bound preventing stale rows from accumulating if cleanup fails repeatedly.
- Impact: Low risk in practice. The workers table is self-cleaning by design (rows are removed on completion/kill, and stale rows are cleaned during recovery). This is a defensive observation.
- Fix: No action needed unless profiling shows an issue. The table is inherently bounded.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`findAllUnbounded()` in TaskManager.getStatus()** - `src/services/task-manager.ts:117`
- Problem: When `getStatus()` is called without a `taskId`, it calls `this.taskRepo.findAllUnbounded()` which loads all tasks from the database with no pagination or limit. Over time, the tasks table grows indefinitely.
- Impact: As the tasks table accumulates entries (only cleaned up after 7 days for completed tasks), this query returns increasingly large result sets. Not introduced by this PR.

### LOW

**`TestWorkerRepository.findByTaskId` uses linear scan** - `tests/fixtures/test-doubles.ts:724-727`
- Problem: The test double iterates all workers to find by taskId instead of using a secondary index Map. This is O(n) per lookup.
- Impact: Test-only code, no production impact. Acceptable for small test datasets.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 1 | 1 |

**Performance Score**: 6/10

The core architecture (SQLite-backed worker coordination, PID-based recovery, DB-backed global worker count) is sound and well-designed. Prepared statements in `SQLiteWorkerRepository` are a good pattern. The synchronous better-sqlite3 approach avoids async overhead in the hot path. The main performance concern is the 500ms periodic flush interval which creates significant write amplification, especially for chatty workers producing large output. The full-snapshot-per-flush strategy compounds this issue.

**Recommendation**: CHANGES_REQUESTED

Two HIGH issues should be addressed before merge:
1. The 500ms flush interval is too aggressive -- increase to 5-10 seconds or add a dirty-data check to skip no-op flushes.
2. The recovery N+1 pattern with sequential async updates per dead worker should at minimum add a no-op short-circuit when there are no dead workers (which is the common case and already happens implicitly), but ideally batch the updates for crash scenarios with many stale workers.
