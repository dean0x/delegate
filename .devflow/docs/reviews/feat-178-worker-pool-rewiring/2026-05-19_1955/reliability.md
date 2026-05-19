# Reliability Review Report

**Branch**: feat/178-worker-pool-rewiring -> main
**Date**: 2026-05-19

## Issues in Your Changes (BLOCKING)

### HIGH

**killAll() always returns ok(undefined) even when workers fail to kill** - `src/implementations/event-driven-worker-pool.ts:335`
**Confidence**: 90%
- Problem: `killAll()` logs failures but always returns `ok(undefined)` at line 335, regardless of how many workers failed to kill. The caller has no way to know that some sessions were not shut down. In a shutdown path, this means the process could exit believing all workers are cleaned up when orphaned tmux sessions remain alive.
- Impact: Silent session leaks on shutdown. The `dispose()` safety net on line 333 catches some orphaned sessions, but relies on TmuxConnector's internal tracking which may be incomplete after partial failures.
- Fix: Return an error result when one or more workers fail to kill:
```typescript
if (failureCount > 0) {
  this.logger.error('Some workers failed to kill', undefined, {
    failures: failureCount,
    total: workerIds.length,
  });
  // Safety net: dispose catches orphaned sessions
  this.tmuxConnector.dispose();
  return err(
    new AutobeatError(
      ErrorCode.WORKER_KILL_FAILED,
      `${failureCount}/${workerIds.length} workers failed to kill`,
    ),
  );
}

// Safety net: dispose catches orphaned sessions
this.tmuxConnector.dispose();
return ok(undefined);
```

---

**gracefulShutdownSession unconditionally waits 3s even when session exits immediately after C-c** - `src/implementations/event-driven-worker-pool.ts:287`
**Confidence**: 82%
- Problem: The `gracefulShutdownSession` method always waits the full 3 seconds (line 287) after sending C-c, regardless of whether the session has already exited. For `killAll()` with N workers, this serializes into N x 3s of blocking wait time (since `kill()` is called sequentially per worker via `Promise.all` which runs concurrently but each `kill()` blocks on the 3s sleep). While an improvement over the 20-iteration poll loop, the fixed 3s wait is still suboptimal for quick-exit sessions.
- Impact: `killAll()` with 5 workers takes a minimum of 3 seconds total (concurrent via Promise.all) but each individual kill takes at least 3s even if the session dies in 100ms. This is acceptable for single kills but compounds if there are dependencies or if `killAll()` is called in a critical shutdown path.
- Fix: Consider a bounded poll with short intervals (e.g., check every 200ms for up to 3s = max 15 checks). This preserves the bounded iteration principle while reducing latency for fast exits:
```typescript
// Bounded poll: check every 200ms for up to 3s (max 15 iterations)
const GRACE_CHECK_INTERVAL_MS = 200;
const MAX_GRACE_CHECKS = 15;
for (let i = 0; i < MAX_GRACE_CHECKS; i++) {
  await new Promise<void>((resolve) => setTimeout(resolve, GRACE_CHECK_INTERVAL_MS));
  const checkResult = this.tmuxConnector.isAlive(worker.handle);
  if (checkResult.ok && !checkResult.value) return true; // session exited
}
```

### MEDIUM

**No upper bound assertion on workers map size** - `src/implementations/event-driven-worker-pool.ts:65`
**Confidence**: 80%
- Problem: The `workers` Map (line 65) grows without bound. While the `ResourceMonitor.canSpawnWorker()` check at line 112 acts as an implicit gate, there is no direct assertion or cap on the map size itself. If the resource monitor returns true erroneously (mock in tests, or config misconfiguration), there is no last-defense guard preventing unbounded worker accumulation.
- Impact: Memory growth proportional to number of workers. In practice bounded by tmux's MAX_CONCURRENT_SESSIONS (in TmuxSessionManager), but the worker pool itself has no assertion.
- Fix: Add an assertion or early-return in `spawn()` after the resource check:
```typescript
// Defense-in-depth: hard cap in case ResourceMonitor is misconfigured
const MAX_POOL_WORKERS = 50; // Or import from config
if (this.workers.size >= MAX_POOL_WORKERS) {
  return err(new AutobeatError(ErrorCode.INSUFFICIENT_RESOURCES, 
    `Worker pool at capacity (${MAX_POOL_WORKERS})`));
}
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**spawnSync in tmuxExec has 10s timeout but no assertion on the command string** - `src/bootstrap.ts:508-511`
**Confidence**: 80%
- Problem: The shared `tmuxExec` function uses `spawnSync` with `shell: true` and a 10-second timeout (line 509), which is good. However, the `cmd` parameter is an arbitrary string passed without any length or content assertion. While the TmuxSessionManager validates session names and paths, the exec function itself is a raw shell executor that trusts its input completely.
- Impact: If a malformed or excessively long command is passed (e.g., by a bug in a caller), `spawnSync` with `shell: true` could have unexpected behavior. The 10s timeout provides a bound on execution time.
- Fix: Add a precondition assertion for defense-in-depth:
```typescript
const tmuxExec: ExecFn = (cmd) => {
  // Defense-in-depth: commands should be reasonable length
  if (cmd.length > 4096) {
    return { stdout: '', stderr: 'Command exceeds max length', status: -1 };
  }
  const result = spawnSync(cmd, { shell: true, encoding: 'utf8', timeout: 10_000 });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status ?? -1 };
};
```

## Pre-existing Issues (Not Blocking)

### MEDIUM

**recovery.recover() fire-and-forget with no completion tracking** - `src/bootstrap.ts:662-666`
**Confidence**: 85%
- Problem: Recovery is launched with `.then()` fire-and-forget (line 662-666). The bootstrap function returns `ok(container)` before recovery completes. If recovery is slow (iterating many dead workers with tmux liveness checks), the system is serving requests while recovery is still marking tasks as FAILED and emitting events. This is pre-existing behavior but Phase 3 tmux liveness checks (which call `spawnSync` per worker) make it more likely to be slow.
- Impact: Race condition window where a restarted server could attempt to spawn workers for tasks that recovery has not yet marked as FAILED. The existing worker UNIQUE constraint in DB protects against duplicate spawns, so the impact is limited to wasted work and error logs.

## Suggestions (Lower Confidence)

- **handleWorkerCompletion fire-and-forget emit errors are only logged** - `src/implementations/event-driven-worker-pool.ts:654-665` (Confidence: 70%) -- If `eventBus.emit('TaskCompleted')` fails, the task completion is lost. The DECISION comment explains the rationale, and PersistenceHandler provides a safety net, but there is no retry mechanism for the emit itself.

- **Heartbeat interval (30s) is hardcoded with no config override** - `src/implementations/event-driven-worker-pool.ts:607` (Confidence: 65%) -- The 30-second heartbeat interval is fixed. In environments with many workers, this means N DB writes every 30 seconds. A configurable interval would allow tuning for different deployment sizes.

- **tmuxSessionManager conditional creation in bootstrap** - `src/bootstrap.ts:513` (Confidence: 62%) -- When `options.tmuxConnector` is provided (tests), `tmuxSessionManager` is set to `undefined` and passed to `RecoveryManager`. This means recovery in tests with mock connectors cannot do tmux liveness checks. This is likely intentional for test isolation, but the undefined path through RecoveryManager means tmux workers in tests always appear dead to recovery.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Reliability Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The core reliability improvements in this PR are strong: the idempotent cleanup guards, completionHandled double-completion prevention, bounded kill grace period (replacing unbounded 20-iteration poll), heartbeat timer clearing before async gaps, and proper tmux session liveness integration in recovery are all well-designed. The main concerns are (1) `killAll()` silently swallowing failures, preventing callers from knowing about leaked sessions, and (2) the fixed 3s grace period that could be more responsive. Neither is CRITICAL -- the `dispose()` safety net catches most orphaned sessions -- but `killAll()` returning success on partial failure violates the Result type contract where errors should be surfaced.
