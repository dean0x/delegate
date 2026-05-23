# Performance Review Report

**Branch**: feat/180-phase-5-bootstrap-usage-parsing-cleanup -> main
**Date**: 2026-05-23

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

### MEDIUM

**Timer leak in reuseSession() else branch -- setupTimeoutForWorker/setupHeartbeatForWorker/startFlushing overwrite without clearing** - `src/implementations/event-driven-worker-pool.ts:498-500`
**Confidence**: 82%
- Problem: In the `else` branch of `reuseSession()` (lines 441-501, where `WorkerState` is still present), `setupTimeoutForWorker(worker)`, `setupHeartbeatForWorker(worker)`, and `startFlushing(worker)` are called without first clearing any existing timers. These setup functions simply overwrite `worker.timeoutTimer`, `worker.heartbeatTimer`, and `worker.flushInterval` without clearing previous values. If the `else` branch is reached while old timers are still active (i.e., onExit has not yet fired), the old timer references are lost and the timers leak. Each leaked `setInterval` (heartbeat every 30s, flush every 1s) continues firing indefinitely, performing redundant DB writes and output flushes.
- Mitigation: The comment on line 442 acknowledges this is "unlikely in steady state" because in production the `if (!worker)` branch (B1-1) is taken instead. In normal loop iteration flow, `cleanupWorkerState` removes the `WorkerState` before the next iteration spawns, so this path is only exercised in test scenarios. The production risk is LOW, but the code pattern is unsafe.
- Fix: Add defensive timer clearing before restarting. Before the three setup calls at lines 498-500, add:
```typescript
this.clearTimeoutForWorker(worker);
if (worker.heartbeatTimer) {
  clearInterval(worker.heartbeatTimer);
  worker.heartbeatTimer = undefined;
}
this.stopFlushing(worker);
```

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Sequential DB unregister + register in reuseSession else branch** - `src/implementations/event-driven-worker-pool.ts:469-491` (Confidence: 65%) -- The B1-5 fix calls `workerRepository.unregister()` then `workerRepository.register()` sequentially. If the server crashes between unregister and register, the worker disappears from the DB entirely. A single UPDATE query (or an atomic transaction wrapping both) would eliminate this window. However, since SQLite operations are synchronous (returns `Result`, not `Promise`) and the crash window is microseconds, this is a very minor concern.

- **300ms fixed sleep in reuseSession for /clear to settle** - `src/implementations/event-driven-worker-pool.ts:409` (Confidence: 62%) -- `await new Promise<void>((resolve) => setTimeout(resolve, CLEAR_SETTLE_MS))` introduces a fixed 300ms delay per session reuse. For loops with many iterations, this adds cumulative latency. However, without a ready signal from the agent, a fixed delay is the pragmatic approach, and 300ms is reasonable for shell command processing.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Performance Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The changes are performance-neutral to performance-positive overall. The persistent session reuse pattern (Phase 5) is a significant performance improvement -- reusing existing tmux sessions across loop iterations avoids the overhead of spawning and destroying sessions per iteration. Timer management (B1-3 fix) correctly restarts heartbeat, flushing, and timeout timers after reuse, and the B1-4 fix prevents spurious backpressure skips. The `tryReuseSession()` extraction keeps the reuse decision chain at O(1) via the `persistentSessions` Map lookup.

The single MEDIUM finding is a defensive timer-clearing gap in a rarely-executed code path. The two suggestions are low-confidence observations about minor latency and crash-window risks that do not warrant blocking.
