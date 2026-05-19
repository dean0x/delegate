# Security Review Report

**Branch**: feat/worker-coordination-89 -> main
**Date**: 2026-03-17
**Commits**: 7324e28, 0c496f3

## Issues in Your Changes (BLOCKING)

### MEDIUM

**PID Reuse Race Condition in Recovery** - `src/services/recovery-manager.ts:24-31`
- Problem: `isProcessAlive()` uses `process.kill(pid, 0)` to check if an owner PID is alive. On Unix systems, PIDs are recycled. If the original process crashed and a new unrelated process took the same PID, `isProcessAlive()` returns `true`, causing the recovery manager to leave a definitively crashed task in RUNNING state indefinitely. The task would never be recovered until the replacement process exits.
- Impact: Stale tasks could remain stuck in RUNNING state if the PID gets reused by an unrelated process. This is a low-probability but real concern on long-running systems with high process churn.
- Category: Business Logic - Race Condition (OWASP A04 Insecure Design)
- Fix: This is an inherent limitation of PID-based detection. Mitigate by combining PID check with a maximum staleness threshold as a safety net. Alternatively, store the process start time alongside the PID and compare against `/proc/<pid>/stat` (Linux) or equivalent. The current approach is still a significant improvement over the 30-minute heuristic -- documenting the limitation is sufficient for now.
  ```typescript
  // Optional safety net: combine PID check with max age fallback
  private isDefinitelyDead(reg: WorkerRegistration): boolean {
    if (!this.isProcessAlive(reg.ownerPid)) return true;
    // Safety net: if alive but older than 24 hours, treat as suspicious
    const MAX_WORKER_AGE_MS = 24 * 60 * 60 * 1000;
    return Date.now() - reg.startedAt > MAX_WORKER_AGE_MS;
  }
  ```

**No Input Validation on PID Values from Database** - `src/implementations/worker-repository.ts:193-201`
- Problem: `rowToRegistration()` directly casts `row.pid` and `row.owner_pid` from the database to `number` without validating they are positive integers. If database corruption or manual tampering sets a PID to 0, negative, or a non-integer value, calling `process.kill(pid, 0)` with PID 0 sends the signal to the entire process group, and PID -1 sends to all processes the caller has permission to signal. This could cause unintended signal delivery.
- Impact: If `owner_pid` is 0 or negative due to DB corruption, `process.kill(0, 0)` would check the current process group (returning true), causing the recovery manager to incorrectly believe a dead worker is alive.
- Category: Input Validation (OWASP A03 Injection / A04 Insecure Design)
- Fix: Validate PID before using it in `isProcessAlive()`:
  ```typescript
  private isProcessAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  ```

### LOW

**Worker Registration Not Atomic with Process Spawn** - `src/implementations/event-driven-worker-pool.ts:108-123`
- Problem: A process is spawned (line ~83-88) and added to in-memory maps (lines 105-106) before the DB registration (lines 109-123). If the DB registration fails for a reason other than UNIQUE violation (e.g., disk full, DB locked), the child process is killed and maps are cleaned, but the process has already consumed resources and may have started work. There is a small window where the process is alive but not registered in the DB.
- Impact: Low -- the process gets killed on registration failure, and the error is properly propagated. The window is extremely small. The current approach is pragmatic because you need a PID before you can register it.
- Category: Business Logic - TOCTOU
- Fix: No change needed. The current approach correctly kills the process and cleans up on failure. The ordering is correct because the PID is needed for registration.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**MAX_WORKERS Environment Override Without Bounds Validation** - `src/implementations/resource-monitor.ts:50`
- Problem: `parseInt(process.env.MAX_WORKERS || ...)` accepts any string from the environment. A value of `0` would prevent all worker spawning. A negative value or `NaN` would bypass the worker limit entirely (since `NaN >= maxWorkers` is always `false`).
- Impact: Misconfigured environment variable could either deny service (MAX_WORKERS=0) or bypass resource limits (MAX_WORKERS=-1 or MAX_WORKERS=abc).
- Fix: Add bounds validation:
  ```typescript
  const envMax = parseInt(process.env.MAX_WORKERS || '', 10);
  this.maxWorkers = Number.isFinite(envMax) && envMax > 0
    ? envMax
    : maxWorkersByCores;
  ```

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Output Repository File Path Construction** - `src/implementations/output-repository.ts:181`
- Problem: `saveToFile` uses `taskId` directly in file path construction (`${taskId}.json`). While task IDs are system-generated (not user-controlled), if the ID format ever changes to include path separators or special characters, this would become a path traversal vulnerability.
- Impact: Currently safe because TaskId is branded and generated internally. Would become a vulnerability if task creation allowed user-supplied IDs.
- Category: Pre-existing defense-in-depth (OWASP A01 / A03)

### LOW

**Interval Not Cleaned Up on Process Connector Disposal** - `src/services/process-connector.ts:12`
- Problem: The `flushIntervals` Map accumulates entries over the lifetime of the ProcessConnector. While `stopFlushing` cleans individual entries, there is no `dispose()` method to clear all intervals if the connector is destroyed. This is a resource leak, not a security issue per se, but could contribute to denial of service under high task churn.
- Impact: Minimal -- intervals are cleaned on task exit via `stopFlushing()`, and the connector lives as long as the worker pool.
- Category: Pre-existing resource management

## Security Strengths

The PR demonstrates several positive security patterns:

1. **Parameterized SQL queries** -- All SQL in `worker-repository.ts` uses prepared statements with parameter binding (`@workerId`, `@taskId`, etc.). No string interpolation in queries.

2. **UNIQUE constraint enforcement** -- Uses plain INSERT (not INSERT OR REPLACE) to detect coordination conflicts via UNIQUE constraint violation on `task_id`. This correctly prevents duplicate worker registrations.

3. **Fail-safe resource checks** -- When `getGlobalCount()` fails in `resource-monitor.ts:92`, the code returns `ok(false)` (don't spawn), which is the secure default.

4. **Foreign key constraint** -- The `workers.task_id` column has `FOREIGN KEY ... ON DELETE CASCADE`, preventing orphaned worker records.

5. **Process cleanup on registration failure** -- When DB registration fails after spawn, the child process is immediately killed with SIGTERM, preventing resource leaks (lines 119-122).

6. **Double-exit guard** -- `ProcessConnector.connect()` uses `exitHandled` flag to prevent multiple `onExit` calls, avoiding race conditions.

7. **Result type consistency** -- All new repository methods return `Result<T>` types, preventing unhandled exceptions.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 1 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 1 |

**Security Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The PID validation issue (validating PID > 0 before calling `process.kill`) should be addressed as it has a concrete failure mode with corrupted data. The PID reuse concern and MAX_WORKERS validation are worth considering but are not blocking. The codebase demonstrates strong security practices with parameterized queries, fail-safe defaults, and proper cleanup.
