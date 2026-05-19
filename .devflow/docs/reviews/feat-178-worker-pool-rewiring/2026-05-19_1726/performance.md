# Performance Review Report

**Branch**: feat/178-worker-pool-rewiring -> main
**Date**: 2026-05-19

## Issues in Your Changes (BLOCKING)

### HIGH

**Synchronous `spawnSync` used inside heartbeat-triggered `isAlive` check blocks the event loop every 30 seconds per worker** - `src/implementations/event-driven-worker-pool.ts:570`
**Confidence**: 90%
- Problem: The `setupHeartbeatForWorker` method runs every 30 seconds and calls `this.tmuxConnector.isAlive(worker.handle)`, which delegates to `TmuxSessionManager.isAlive()`, which executes `spawnSync('tmux has-session ...')`. This is a synchronous child process spawn that blocks the Node.js event loop for 5-20ms per call. With N concurrent workers, each heartbeat tick blocks for up to N * 5-20ms. The heartbeat already does a synchronous DB write (`updateHeartbeat`), but adding a second blocking syscall doubles the event-loop stall. This is on top of the shared staleness timer in TmuxConnector that already performs periodic liveness checks via `listSessions()` (one tmux call for all sessions). The heartbeat `isAlive` check is redundant with the connector's staleness detection.
- Fix: Remove the per-worker `isAlive` check from the heartbeat timer. The TmuxConnector's shared staleness timer already detects dead sessions efficiently (one `listSessions()` call per tick covering all sessions). If you want defense-in-depth beyond the connector's staleness timer, batch the heartbeat liveness checks into a single call rather than N individual `spawnSync` calls:
```typescript
// Option A: Remove the redundant check entirely (recommended)
private setupHeartbeatForWorker(worker: WorkerState): void {
  const timer = setInterval(() => {
    // DB heartbeat update only — session liveness handled by TmuxConnector staleness timer
    const result = this.workerRepository.updateHeartbeat(worker.id);
    if (!result.ok) {
      this.logger.warn('Heartbeat update failed', {
        workerId: worker.id,
        error: result.error.message,
      });
    }
  }, 30_000);
  timer.unref();
  worker.heartbeatTimer = timer;
}
```

**Kill poll loop blocks the event loop with synchronous `spawnSync` calls for up to 5 seconds** - `src/implementations/event-driven-worker-pool.ts:251-260`
**Confidence**: 85%
- Problem: The `kill()` method polls `isAlive()` every 250ms for up to 20 iterations (5 seconds total). Each `isAlive()` call is a synchronous `spawnSync('tmux has-session ...')` that blocks the event loop for 5-20ms. During `killAll()`, this is called sequentially for every worker (line 294: `Promise.all(workerIds.map((workerId) => this.kill(workerId)))`). Despite using `Promise.all`, each `kill()` call is dominated by the synchronous poll loop, so with 10 workers this could block the event loop intermittently for 50+ seconds total (10 workers * up to 5s each, with async sleeps between polls). The event loop can service other work during the `setTimeout` gaps, but each `isAlive` check still blocks.
- Fix: After sending C-c, use a single `setTimeout` for the grace period (e.g. 3-5 seconds), then check `isAlive` once. If still alive, force-destroy. This reduces the number of blocking syscalls from up to 20 per kill to just 1-2:
```typescript
// Step 4: Wait grace period, then check once
await new Promise<void>((resolve) => setTimeout(resolve, 3000));
const checkResult = this.tmuxConnector.isAlive(worker.handle);
const sessionDied = checkResult.ok && !checkResult.value;

// Step 5: Force-destroy if still alive
if (!sessionDied) {
  this.tmuxConnector.destroy(worker.handle);
}
```

### MEDIUM

**`killAll` runs kill operations sequentially despite `Promise.all` wrapper** - `src/implementations/event-driven-worker-pool.ts:294`
**Confidence**: 82%
- Problem: `Promise.all(workerIds.map((workerId) => this.kill(workerId)))` looks parallel but each `kill()` contains a synchronous poll loop with `spawnSync` calls that block the event loop. The `Promise.all` only parallelizes the async `setTimeout` gaps between polls. When shutting down 10+ workers, the total wall-clock time is the sum of all grace periods rather than the maximum. For a clean shutdown of 10 workers, worst case is ~50 seconds.
- Fix: If the C-c + single-check pattern from the previous finding is adopted, the actual async wait becomes truly parallelizable through `Promise.all`. Alternatively, send C-c to all sessions first, then wait once, then force-destroy any survivors:
```typescript
async killAll(): Promise<Result<void>> {
  const workerIds = Array.from(this.workers.keys());
  // Send C-c to all sessions
  for (const workerId of workerIds) {
    const worker = this.workers.get(workerId);
    if (worker) this.tmuxConnector.sendControlKeys(worker.handle, 'C-c');
  }
  // Single grace period for all
  await new Promise<void>((resolve) => setTimeout(resolve, 3000));
  // Force-destroy survivors
  for (const workerId of workerIds) {
    const worker = this.workers.get(workerId);
    if (!worker) continue;
    const alive = this.tmuxConnector.isAlive(worker.handle);
    if (alive.ok && alive.value) this.tmuxConnector.destroy(worker.handle);
    this.cleanupWorkerState(workerId, worker.taskId);
  }
  this.tmuxConnector.dispose();
  return ok(undefined);
}
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`handleWorkerCompletion` changed from `async` to sync but event emission uses fire-and-forget `.catch()`** - `src/implementations/event-driven-worker-pool.ts:593-634`
**Confidence**: 80%
- Problem: The old `handleWorkerCompletion` was `async` and `await`ed the event emission. The new version is synchronous and uses fire-and-forget: `this.eventBus.emit(...).catch(...)`. This means `handleWorkerTimeout` (line 669) calls `this.kill(workerId)` (which calls `cleanupWorkerState` which triggers `handleWorkerCompletion` which fires the event), and then immediately `await this.eventBus.emit('TaskTimeout', ...)`. The TaskTimeout emission does not wait for the TaskCompleted/TaskFailed emission from the kill path to settle. If the event bus has ordering guarantees or handlers that expect TaskFailed to be fully processed before TaskTimeout arrives, this could cause subtle race conditions. This is a latent correctness concern rather than a pure performance issue, but the fire-and-forget pattern has performance implications: if the event bus is slow (e.g., persisting to DB), multiple unresolved promises accumulate without backpressure.
- Fix: Consider tracking the fire-and-forget promise and awaiting it in `handleWorkerTimeout` to preserve emission ordering. Alternatively, document that TaskCompleted/TaskFailed from kill may race with TaskTimeout by design.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Synchronous `spawnSync` used as the `ExecFn` foundation for all tmux operations** - `src/bootstrap.ts:508-511`
**Confidence**: 80%
- Problem: The shared `tmuxExec` function wraps `spawnSync` which blocks the Node.js event loop for 5-20ms per call. Every tmux operation (validate, createSession, isAlive, sendKeys, destroySession, listSessions) goes through this. While individual calls are fast, the cumulative impact under load (N workers * periodic checks) is meaningful. This is a pre-existing architectural choice from the tmux infrastructure that predates this PR.
- Fix: In a future iteration, consider an async exec function using `child_process.execFile` with promisification for the hot-path operations (isAlive, listSessions) while keeping sync for bootstrap-time validation. The TmuxSessionManager interface would need async variants.

## Suggestions (Lower Confidence)

- **Double `Date.now()` in registerWorker** - `src/implementations/event-driven-worker-pool.ts:439,457` (Confidence: 65%) -- `Date.now()` is called twice in `registerWorker` (once for in-memory WorkerState at line 439, once for DB registration at line 457). These could differ by a few microseconds. Minor, but a single `const now = Date.now()` used for both would be cleaner and consistent.

- **Periodic flush interval per worker creates timer overhead** - `src/implementations/event-driven-worker-pool.ts:380-391` (Confidence: 70%) -- Each worker gets its own `setInterval` for output flushing (default 1000ms). With 10+ workers, that is 10+ timers firing every second. A single shared flush timer that iterates all active workers (similar to the shared staleness timer pattern in TmuxConnector) would reduce timer overhead and simplify the flushing logic.

- **`flushOutput` calls `outputCapture.getOutput` then `outputRepository.save` without checking if content changed** - `src/implementations/event-driven-worker-pool.ts:408-416` (Confidence: 62%) -- If no new output arrived since the last flush, the getOutput + save cycle runs unnecessarily. A dirty flag or sequence number in OutputCapture could skip no-op flushes.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Performance Score**: 6/10
**Recommendation**: CHANGES_REQUESTED

The main performance concern is the redundant per-worker synchronous `spawnSync` call in the heartbeat timer. The TmuxConnector already has a well-designed shared staleness timer that performs session liveness checks efficiently using a single `listSessions()` call per tick. Adding a second per-worker `isAlive` check in the WorkerPool layer doubles the blocking syscall load without adding meaningful detection speed (both check on similar intervals). Removing the redundant heartbeat `isAlive` check is the highest-impact fix. The kill poll loop is a secondary concern that affects shutdown latency but not steady-state performance.
