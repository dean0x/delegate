# Reliability Review Report

**Branch**: feat/180-phase-5-bootstrap-usage-parsing-cleanup -> main
**Date**: 2026-05-23

## Issues in Your Changes (BLOCKING)

### HIGH

**Orphaned worker state and callback interference after reuseSession sendKeys failure** - `src/implementations/event-driven-worker-pool.ts:387-396`
**Confidence**: 90%
- Problem: In `reuseSession()`, the worker state is mutated (lines 373-385: `taskToWorker`, `taskIdRef.current`, `taskId`, `task`, `completionHandled`) before the `sendKeys` call on line 388. If `sendKeys` fails, `cleanupPersistentSession(key)` is called which destroys the tmux session handle and removes the entry from `persistentSessions`, but does NOT clean up the old `WorkerState` from `this.workers` or clear its timers. The method returns `ok(null)`, and `spawn()` falls through to `launchAndRegister()` which creates a new worker.

  The old worker remains as an orphan in `this.workers` under `workerId = worker-beat-{previousTaskId}`:
  1. Its heartbeat timer keeps firing every 30s, calling `workerRepository.updateHeartbeat()` for a worker that was already unregistered, leaking resources until process exit.
  2. The destroyed session's `onExit` callback reads `taskIdRef.current` (now the new task ID), resolves to the NEW worker via `taskToWorker`, stops the new worker's flush interval and heartbeat timer, and calls `handleWorkerCompletion` with the new task ID -- potentially emitting a spurious `TaskCompleted` or `TaskFailed` for the new task before it actually finishes.

- Fix: Before returning `ok(null)` from the sendKeys failure path (and ideally from the `existingWorker` null path too), clean up the orphaned worker state. Also consider resetting `taskIdRef.current` back to the previous task ID before cleanup, or calling `cleanupWorkerState` on the old worker to clear its timers and remove it from maps:
  ```typescript
  // After line 385, wrap the sendResult check:
  const sendResult = this.tmuxConnector.sendKeys(handle, prompt + '\n');
  if (!sendResult.ok) {
    this.logger.warn('Failed to send prompt to reused session — destroying, will spawn fresh', {
      taskId: task.id,
      key,
      error: sendResult.error.message,
    });
    // Roll back the state mutation before destroying the session.
    // This prevents the old onExit callback from interfering with the fresh spawn.
    this.cleanupWorkerState(workerId, task.id);
    this.cleanupPersistentSession(key);
    return ok(null);
  }
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Flush interval uses mutable worker.taskId but flushingInProgress set is not cleaned up on reuse** - `src/implementations/event-driven-worker-pool.ts:723-736`
**Confidence**: 82%
- Problem: The flush interval closure reads `worker.taskId` on each tick, which correctly picks up the updated task ID after `reuseSession()`. However, `flushingInProgress` is keyed by `TaskId`. If a flush is in-flight for the OLD task ID when `reuseSession()` changes `worker.taskId`, the `flushingInProgress.has(worker.taskId)` check on the next tick uses the NEW task ID, which is NOT in the set. Meanwhile, the old flush completes and calls `flushingInProgress.delete(oldTaskId)`, which is a no-op since the old ID was removed by `stopFlushing` in `reuseSession` -- wait, `reuseSession` does NOT call `stopFlushing`. The flush interval continues across reuse, and an in-flight flush for the old task ID could overlap with a flush for the new task ID. In practice this is low-risk because the output capture is keyed by task ID and the old task's data should be empty, but the inconsistency could cause a spurious duplicate-flush skip if task IDs happen to overlap in the set.
- Fix: In `reuseSession()`, after updating the task ID, call `this.flushingInProgress.delete(prevTaskId)` to clean up any stale entry:
  ```typescript
  // After line 384:
  existingWorker.taskId = task.id;
  this.flushingInProgress.delete(prevTaskId);
  ```

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **CLEAR_SETTLE_MS is a hardcoded timing assumption** - `src/implementations/event-driven-worker-pool.ts:125` (Confidence: 65%) -- The 300ms settle delay is documented as "empirically stable minimum on a local machine." On slow CI machines or under load, this could be insufficient, leading to output mis-attribution. The comment mentions a future dep injection point but none is implemented. Consider making it configurable via `EventDrivenWorkerPoolDeps`.

- **exitPromise pattern in spawnAndDeliverPrompt uses Promise.race with an uncleared timeout** - `src/cli/commands/orchestrate-interactive.ts:427` (Confidence: 62%) -- `Promise.race([exitPromise, new Promise(resolve => setTimeout(resolve, 2000))])` creates a timer that is never cleared if `exitPromise` wins the race. This is a minor leak (the timer fires after 2s and is garbage collected), but in strict resource-accounting environments it is a loose end. Low practical impact since this is CLI code that exits shortly after.

- **Type-casting through unknown for env stripping in spawnAndDeliverPrompt** - `src/cli/commands/orchestrate-interactive.ts:219-225` (Confidence: 70%) -- The double cast `(rawTmuxConfig as unknown as { env?: Record<string, string> })` bypasses type safety to access the `env` field. If the underlying type changes (e.g., env becomes a Map or gets renamed), this cast will silently produce `undefined` and the AUTOBEAT_WORKER stripping will be silently skipped. A type guard or an explicit interface widening would be more robust.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | - |
| Should Fix | - | 0 | 1 | - |
| Pre-existing | - | - | 0 | 0 |

**Reliability Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The core reliability improvements in this PR are well-designed: the `TaskIdRef` pattern solves the stale-closure bug elegantly, the `ok(null)` fallthrough-to-fresh-spawn pattern is a significant improvement over the previous `err()` return that could stall loops, and the `exitPromise` replacing the setInterval polling in the interactive orchestrator is a proper event-driven upgrade. The test coverage for the new behaviors is thorough.

The HIGH-severity blocking issue is a narrow but real state inconsistency in the `reuseSession` sendKeys failure path. When the session is partially remapped and then destroyed, the old worker's timers and callbacks become orphaned and can interfere with the fresh spawn. The fix is straightforward: call `cleanupWorkerState` on the old worker before destroying the persistent session in the failure path.
