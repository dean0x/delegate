# Reliability Review Report

**Branch**: feat/180-phase-5-bootstrap-usage-parsing-cleanup -> main
**Date**: 2026-05-23

## Issues in Your Changes (BLOCKING)

### HIGH

**Timer leak in reuseSession() else branch (WorkerState-present path)** - `src/implementations/event-driven-worker-pool.ts:494-500`
**Confidence**: 85%
- Problem: When the `else` branch executes (WorkerState still present -- "reuse called before onExit cleanup"), `setupTimeoutForWorker()`, `setupHeartbeatForWorker()`, and `startFlushing()` are called without first clearing any existing timers on the worker. These three methods unconditionally overwrite `worker.timeoutTimer`, `worker.heartbeatTimer`, and `worker.flushInterval` respectively. If the previous iteration's timers are still running (which is the exact scenario this branch handles), the old timer handles are silently dropped, leaking `setInterval`/`setTimeout` handles. The leaked heartbeat timer will continue writing stale DB heartbeats; the leaked flush timer will continue flushing output under the wrong task ID (since `worker.taskId` was already updated on line 463).
- Fix: Clear existing timers before restarting them, matching the pattern used by `cleanupWorkerState()`:
```typescript
// B1-3 fix: Restart timers stopped by the previous iteration's onExit callback.
// Clear any running timers first to prevent leaks when the else branch
// executes (reuse before onExit cleanup).
this.clearTimeoutForWorker(worker);
if (worker.heartbeatTimer) {
  clearInterval(worker.heartbeatTimer);
  worker.heartbeatTimer = undefined;
}
this.stopFlushing(worker);

this.setupTimeoutForWorker(worker);
this.setupHeartbeatForWorker(worker);
this.startFlushing(worker);
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Spawned attach process lacks error handler -- potential dangling promise** - `src/cli/commands/orchestrate-interactive.ts:326-332`
**Confidence**: 80%
- Problem: The `nodeSpawn('tmux', ['attach-session', ...])` child process only registers an `exit` event handler. If `spawn` fails (e.g., `ENOENT` if tmux binary vanishes after validation, or `EMFILE` if file descriptors are exhausted), the `error` event fires but nobody handles it. The `exit` event may not fire at all in some error scenarios, causing the promise on line 330 to hang indefinitely. While tmux is validated earlier, the spawn could still fail for transient OS-level reasons (e.g., resource exhaustion).
- Fix: Add an `error` handler that resolves the promise, preventing an indefinite hang:
```typescript
const attachExitCode = await new Promise<number | null>((resolve) => {
  attachProcess.on('exit', (code) => resolve(code));
  attachProcess.on('error', () => resolve(null)); // Treat spawn failure as session-ended
});
```

## Pre-existing Issues (Not Blocking)

(none at CRITICAL severity in unchanged lines)

## Suggestions (Lower Confidence)

- **PersistentSessionEntry.workerId becomes stale after B1-1 re-registration** - `src/implementations/event-driven-worker-pool.ts:426` (Confidence: 70%) -- After the B1-1 path calls `registerWorker(task, ...)`, the new WorkerState gets `WorkerId('worker-beat-${task2.id}')`, but the `PersistentSessionEntry` still holds the original workerId. Subsequent iterations always enter the B1-1 re-registration path because the lookup on the stale workerId always returns `undefined`. Functionally correct (each iteration self-heals), but the entry's workerId field is misleading and the per-iteration DB register/unregister cycle is unnecessary overhead. Consider updating the entry's workerId after re-registration or using a consistent workerId across iterations.

- **Repeated tmuxConnector.destroy() calls on 3+ Ctrl+C presses** - `src/cli/commands/orchestrate-interactive.ts:312-314` (Confidence: 65%) -- After `sigintCount >= 2`, every subsequent Ctrl+C calls `tmuxConnector.destroy(handle)` again. While `destroy` is likely idempotent, the unbounded re-invocation is a reliability anti-pattern per bounded iteration rules. Consider guarding with `if (sigintCount === 2)` to call destroy exactly once.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | - |
| Should Fix | - | 0 | 1 | - |
| Pre-existing | - | - | 0 | 0 |

**Reliability Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The core session reuse lifecycle is well-designed with proper bounded waits (EXIT_CALLBACK_DEADLINE_MS), concurrency guards (reuseInProgress), completion de-duplication (G2), and graceful fallbacks to fresh spawn. The B1-1 through B1-5 fixes address real-world loop lifecycle issues comprehensively, and the test coverage for these paths is thorough. The extracted `attachAndFinalize` and `tryReuseSession` reduce nesting and improve readability.

The blocking finding (timer leak in the else branch) is a genuine resource leak that could cause stale heartbeat writes and incorrect output flushing when the rare "reuse before onExit" path executes. The fix is straightforward -- clear timers before restarting them.
