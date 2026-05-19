# Regression Review Report

**Branch**: feat/178-worker-pool-rewiring -> main
**Date**: 2026-05-19

## Issues in Your Changes (BLOCKING)

### HIGH

**Double cleanupWorkerState during kill() + onExit race** - `src/implementations/event-driven-worker-pool.ts:279`
**Confidence**: 92%
- Problem: The `kill()` method sends C-c (line 237), then polls `isAlive` in a loop (lines 251-260). During this async polling window, the tmux session may die and the `onExit` callback fires synchronously, entering `handleWorkerCompletion` which calls `cleanupWorkerState(workerId, taskId)`. After the poll loop exits, `kill()` calls `cleanupWorkerState` a second time (line 279). `cleanupWorkerState` unconditionally calls `this.monitor.decrementWorkerCount()` (line 494) and `this.workerRepository.unregister(workerId)` (line 497). This results in a double-decrement of the monitor worker count and a redundant DB unregister call. The `completionHandled` guard (line 609) only prevents duplicate event emission inside `handleWorkerCompletion`, not duplicate `cleanupWorkerState` calls from `kill()`.
- Impact: Worker count in ResourceMonitor becomes negative or inaccurate, potentially allowing more workers than the configured limit. The redundant unregister is benign (DELETE on absent row is no-op) but wastes a DB call.
- Fix: Either set `worker.completionHandled = true` at the start of `kill()` to prevent `onExit` from entering `handleWorkerCompletion`, or guard `cleanupWorkerState` to be idempotent by checking `this.workers.has(workerId)` before decrementing the monitor count:
```typescript
private cleanupWorkerState(workerId: WorkerId, taskId: TaskId): void {
  if (!this.workers.has(workerId)) {
    return; // Already cleaned up
  }
  // ... rest of existing code
}
```

**Duplicate event emission on timeout (TaskFailed + TaskTimeout)** - `src/implementations/event-driven-worker-pool.ts:669-673`
**Confidence**: 85%
- Problem: `handleWorkerTimeout` calls `await this.kill(workerId)` (line 669). During the async kill flow, `onExit` fires and `handleWorkerCompletion` emits either `TaskFailed` or `TaskCompleted` (lines 623-633). Then `handleWorkerTimeout` proceeds to emit `TaskTimeout` (lines 671-674). A single task timeout can produce two events: `TaskFailed` (exit code != 0 from the C-c signal) followed by `TaskTimeout`. Downstream handlers (PersistenceHandler, DependencyHandler) may process both, causing double state transitions or confusing log entries.
- Impact: Task may be marked FAILED by the first event, then receive a second TaskTimeout event on an already-terminal task. While PersistenceHandler likely guards against terminal-state updates, the behavior is inconsistent with the documented expectation that timeout produces exactly one event.
- Fix: Set `worker.completionHandled = true` before calling `this.kill(workerId)` in `handleWorkerTimeout`, or check `completionHandled` after `kill()` returns and skip the `TaskTimeout` emit if the worker already completed:
```typescript
private async handleWorkerTimeout(taskId: TaskId, timeoutMs: number): Promise<void> {
  // ... worker lookup ...
  worker.completionHandled = true; // Prevent onExit from emitting
  await this.kill(workerId);
  
  await this.eventBus.emit('TaskTimeout', {
    taskId,
    error: taskTimeout(taskId, timeoutMs),
  });
}
```

### MEDIUM

**handleWorkerCompletion changed from async/await to fire-and-forget** - `src/implementations/event-driven-worker-pool.ts:593-642`
**Confidence**: 82%
- Problem: The method signature changed from `private async handleWorkerCompletion(...)` to `private handleWorkerCompletion(...)`. Event emission changed from `await this.eventBus.emit(...)` to `this.eventBus.emit(...).catch(...)`. This means events are now fire-and-forget: the function returns before event handlers have run. Callers of `handleWorkerCompletion` (the `onExit` callback at line 367) no longer wait for handler completion. In the old code, the `processConnector.connect` callback awaited the handler chain.
- Impact: Subtle ordering change -- downstream event handlers (PersistenceHandler, DependencyHandler, UsageCaptureHandler) may still be running when the caller considers the completion "handled." In practice, this is unlikely to cause issues because the event bus is decoupled, but it changes the timing guarantees of the prior implementation. If any handler depended on the completion being fully processed before the next tick (e.g., a test assertion), it could fail intermittently.
- Fix: If the fire-and-forget pattern is intentional (the comment says "matches existing pattern"), document explicitly that callers must not assume event handlers have completed when `handleWorkerCompletion` returns. If ordering is important, restore `async` and `await`.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Orchestration zombie detection does not account for tmux workers** - `src/services/orchestration-liveness.ts:68`
**Confidence**: 80%
- Problem: `checkOrchestrationLiveness` traces the chain orchestration -> loop -> iteration -> task -> worker, then calls `deps.isProcessAlive(workerResult.value.ownerPid)`. For tmux workers, `ownerPid` is the autobeat server PID. This means: (a) while the server is running, all tmux workers appear "live" regardless of whether their tmux session is alive, and (b) after a server restart, all tmux workers correctly appear "dead" because the old server PID is gone. The mid-operation case (server alive, tmux session dead) is NOT detected by the zombie checker. The recovery-manager's `cleanDeadWorkerRegistrations` does handle this via `isTmuxSessionAlive`, but the orchestration zombie detector does not.
- Impact: A RUNNING orchestration whose tmux worker session has crashed mid-operation will not be detected as a zombie until the server restarts. The dashboard may show it as "live" indefinitely. This is consistent with pre-existing behavior for process-based workers (ownerPid was always the server PID), so it is not a new regression but a missed opportunity in the tmux migration. The `cleanDeadWorkerRegistrations` method (lines 164-256) does correctly handle tmux liveness via session name, but that only runs at startup.
- Fix: Update `checkOrchestrationLiveness` to accept an optional tmux session liveness check and use it when `workerRegistration.pid === 0`:
```typescript
export interface LivenessDeps {
  readonly loopRepo: LoopRepository;
  readonly taskRepo: TaskRepository;
  readonly workerRepo: WorkerRepository;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly isTmuxSessionAlive?: (sessionName: string) => boolean;
}
```

**Dead code: ProcessConnector is now orphaned** - `src/services/process-connector.ts`
**Confidence**: 95%
- Problem: `ProcessConnector` is no longer imported by any source file. The import was removed from `event-driven-worker-pool.ts` (the only consumer), and its functionality was reimplemented inline in the worker pool (startFlushing, stopFlushing, flushOutput methods). The class still exists and is exported but has zero consumers.
- Impact: Dead code increases maintenance burden and confuses future developers who may think it is still in use. The comment in `usage-capture-handler.ts:` "ProcessConnector flush is guaranteed complete before TaskCompleted" now references a non-existent integration, which is documentation drift.
- Fix: Delete `src/services/process-connector.ts` and update the comment in `usage-capture-handler.ts`. (avoids PF-002 -- this is dead code with zero consumers, no migration needed)

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Orchestration liveness comment references PID-only model** - `src/services/orchestration-liveness.ts:11-12`
**Confidence**: 90%
- Problem: The module-level comment says "orchestration -> loop -> most-recent-iteration -> task -> worker.ownerPid -> process.kill(pid, 0)" which only describes the PID-based check. With tmux workers, this documentation is now incomplete/misleading.
- Impact: Documentation drift -- future developers reading this file will not understand that tmux workers require different liveness semantics.

## Suggestions (Lower Confidence)

- **killAll changed from Promise.allSettled to Promise.all** - `src/implementations/event-driven-worker-pool.ts:294` (Confidence: 65%) -- While `kill()` never rejects (catches all errors), the behavioral change from `allSettled` (guarantees all settle) to `all` (short-circuits on rejection) is a semantic weakening. If a future change introduces a code path where `kill()` can reject, the remaining workers would not be killed. Consider keeping `allSettled` for defensive robustness.

- **ProcessSpawnerAdapter.buildTmuxCommand returns mock data instead of error** - `src/implementations/process-spawner-adapter.ts:49-62` (Confidence: 70%) -- Previously returned `err()` indicating tmux is unsupported; now returns a fabricated config. Tests using `ProcessSpawnerAdapter` via `options.processSpawner` would now proceed through the tmux spawn path in the worker pool, which may produce unexpected results if the mock tmux connector is not also injected.

- **WorkerId format changed from `worker-{pid}` to `worker-beat-{taskId}`** - `src/implementations/event-driven-worker-pool.ts:434` (Confidence: 60%) -- The WorkerId format change is intentional per the PR description. No hardcoded references to the old format were found in source code. However, any external consumers (dashboard, logs, monitoring tools) that parse WorkerId strings by extracting the PID would break.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 1 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Regression Score**: 5/10
**Recommendation**: CHANGES_REQUESTED

The two HIGH-severity blocking issues represent genuine race conditions introduced by the tmux kill flow:
1. Double `cleanupWorkerState` (monitor count corruption) when `onExit` fires during `kill()`'s polling loop.
2. Duplicate event emission (TaskFailed + TaskTimeout) on timeout scenarios.

Both are fixable with small, targeted changes (idempotent cleanup guard or setting `completionHandled` before kill). The core architecture of the tmux migration is sound -- these are race-condition edge cases in the kill/timeout paths.

The dead ProcessConnector code and orchestration liveness gap should be addressed while the changes are fresh (applies PF-001 -- fix while we are here rather than deferring).
