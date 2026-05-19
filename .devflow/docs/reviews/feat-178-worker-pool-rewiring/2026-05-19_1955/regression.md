# Regression Review Report

**Branch**: feat/178-worker-pool-rewiring -> main
**Date**: 2026-05-19

## Issues in Your Changes (BLOCKING)

### HIGH

**Dashboard orchestration liveness always returns 'unknown' for tmux workers** - `src/cli/dashboard/use-dashboard-data.ts:278-283`
**Confidence**: 90%
- Problem: The dashboard constructs `livenessDeps` without `isTmuxSessionAlive`. With Phase 3, all workers are tmux-based (pid=0). The `checkOrchestrationLiveness` function returns `'unknown'` when `worker.pid === 0` and `deps.isTmuxSessionAlive` is not provided (line 84 of `orchestration-liveness.ts`). This means the dashboard will never show `'live'` or `'dead'` for orchestrations backed by tmux workers -- they will always be `'unknown'`.
- Impact: Dashboard shows degraded orchestration liveness for all Phase 3 workers. Users cannot tell whether an orchestration's worker is alive or dead from the dashboard. The recovery manager correctly passes `isTmuxSessionAlive`, but the dashboard does not.
- Fix: Pass `isTmuxSessionAlive` in the dashboard's `livenessDeps` construction. The dashboard does not have access to `TmuxSessionManager` directly, so the bootstrap or container would need to expose it. Alternatively, the dashboard could construct a liveness checker by importing `TmuxSessionManager` or have the bootstrap register it in the container. Example:
  ```typescript
  const livenessDeps = {
    loopRepo: loopRepository,
    taskRepo: taskRepository,
    workerRepo: workerRepository,
    isProcessAlive,
    isTmuxSessionAlive: (name: string) => {
      // Needs access to TmuxSessionManager or TmuxSessionManagerCorePort
      const result = tmuxSessionManager.isAlive(name);
      return result.ok ? result.value : false;
    },
  };
  ```

**Accidental empty file `=` committed to repository root** - `=`
**Confidence**: 95%
- Problem: A zero-byte file named `=` was added to the repository root. This is a classic shell accident (e.g., `> =` or a misplaced redirect operator). The file has no content and serves no purpose.
- Impact: Pollutes the repository root. While harmless at runtime, it is confusing and should not be shipped.
- Fix: Delete the file and add it to `.gitignore` or simply remove it:
  ```bash
  git rm =
  ```

### MEDIUM

**`handleWorkerCompletion` changed from async to sync with fire-and-forget emit** - `src/implementations/event-driven-worker-pool.ts:620`
**Confidence**: 80%
- Problem: The method signature changed from `private async handleWorkerCompletion(...)` to `private handleWorkerCompletion(...)`. Event emission (`TaskCompleted`/`TaskFailed`) is now fire-and-forget with `.catch()`. The DECISION comment explains the rationale (avoiding async callback chains), and `PersistenceHandler` independently persists state. However, this is a behavior change: callers that previously awaited the emit no longer get back-pressure. If emit() fails (e.g., DB write in PersistenceHandler throws), the error is logged but the caller does not know.
- Impact: In the old code, the `ProcessConnector.connect` callback chain was also async (`onExit(code ?? null)` called synchronously from `.finally()`), so the behavioral change is smaller than it appears. The real concern is that during high load or error conditions, fire-and-forget emits could lose ordering guarantees relative to cleanup. The DECISION comment documents this trade-off explicitly.
- Fix: This is an intentional design decision documented with a DECISION comment. No action required unless tests reveal ordering issues. Consider adding an integration test that verifies TaskCompleted/TaskFailed events are always emitted (even under error conditions) to guard against future regressions.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`clearTimeoutForWorker` no longer clears heartbeat timer** - `src/implementations/event-driven-worker-pool.ts:574-584`
**Confidence**: 82%
- Problem: In the old code, `clearTimeoutForWorker` cleared both the timeout timer AND the heartbeat timer (lines 362-366 of the old code). In the new code, `clearTimeoutForWorker` only clears the timeout timer. The heartbeat timer is cleared separately in `cleanupWorkerState` and in the `onExit` callback. This is a deliberate restructuring, but it means `clearTimeoutForWorker` no longer matches its old behavior. The kill() path calls `clearTimeoutForWorker` at line 239, then `stopFlushing` at 240, then `flushOutput` at 241, then `gracefulShutdownSession` which includes a 3-second await. During this 3-second window, the heartbeat timer is still active because `cleanupWorkerState` has not yet been called.
- Impact: During the 3-second grace period in `gracefulShutdownSession`, the heartbeat timer fires one more time (30s interval, so only if kill happens to align with the timer). The timer writes to the DB via `updateHeartbeat`, which is harmless but unnecessary since the worker is being killed. The `onExit` callback also clears heartbeat before the async flush (line 392-395). Risk is low.
- Fix: No immediate action needed. The heartbeat during the 3s grace period is a minor inefficiency, not a functional regression. The cleanup paths all converge to clear the timer.

## Pre-existing Issues (Not Blocking)

No critical pre-existing issues found in the reviewed files.

## Suggestions (Lower Confidence)

- **`killAll` calls `this.tmuxConnector.dispose()` after individual kills** - `src/implementations/event-driven-worker-pool.ts:333` (Confidence: 70%) -- `dispose()` calls `destroySession` for each active handle and fires `onExit` with `'SHUTDOWN'` signal. Since `kill()` already destroyed each session individually, `dispose()` will find an empty `activeSessions` map (each `kill` -> `cleanupWorkerState` removes from maps, and `destroy()` returns early if handle is not tracked). This is a no-op safety net, not a double-destroy bug. However, if `kill()` fails for some workers (leaves them in `activeSessions`), `dispose()` would correctly clean them up. The concern is whether `dispose()` firing `onExit('SHUTDOWN')` for already-cleaned-up workers could trigger duplicate `handleWorkerCompletion`. Verified: `dispose()` calls `this.activeSessions.clear()` at line 300 before iterating, so it iterates the snapshot. The `safeCallOnExit` in dispose fires `onExit`, but `completionHandled` guard in the callback prevents duplicate events. Safe as-is.

- **Recovery manager `isWorkerAlive` for pid=0 workers without sessionName** - `src/services/recovery-manager.ts:131-133` (Confidence: 65%) -- If a tmux worker has pid=0 but no sessionName (e.g., crash during registration before sessionName was written), `isWorkerAlive` returns false, marking the worker as dead. This is correct behavior (if we cannot identify the session, assume dead), but worth noting as a potential edge case during crash recovery.

- **`TmuxConnectorPort.spawn()` uses `unknown` config type** - `src/core/tmux-types.ts:93` (Confidence: 65%) -- The port interface uses `unknown` for the config parameter to break a circular dependency. The concrete implementation casts to `TmuxSpawnConfig`. This is a documented architecture exception. Type safety is maintained at the implementation boundary but not at the interface level.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Regression Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The core migration from process-based to tmux-based workers is thorough. All consumers of the deleted `ProcessConnector` have been updated. The `WorkerRegistration.sessionName` field and migration v29 are additive. The recovery manager correctly handles both worker types. The breaking changes (pid=0 sentinel, WorkerId format, deps interface) are documented in the PR description and are a clean break forward (avoids PF-002 -- no migration needed for unpublished internal interfaces).

However, the dashboard liveness regression (HIGH) means orchestration health monitoring is degraded for all tmux workers, and the accidental `=` file (HIGH) should be removed before merge.
