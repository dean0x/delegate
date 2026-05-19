# Reliability Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

### [P1] destroy() does not call onExit -- callers may leave tasks stuck in RUNNING
- **Location**: `src/implementations/tmux/tmux-connector.ts:224-241`
- **Confidence**: 90%
- **Description**: `destroy()` sets `session.exited = true`, flushes messages, closes watchers, kills the tmux session, and cleans up -- but it never calls `session.callbacks.onExit()`. Compare with `dispose()` (line 277) which explicitly calls `session.callbacks.onExit(null, 'SHUTDOWN')` and the comment says "Notify callers so tasks don't remain stuck in RUNNING after shutdown." The `triggerExit()` path also calls `session.callbacks.onExit(code, signal)` at line 705. Only `destroy()` is silent. If a caller uses `destroy()` to externally terminate a session (e.g., user cancellation), the task will never receive an exit notification and may remain stuck in RUNNING state indefinitely.
- **Impact**: Tasks terminated via `destroy()` never transition out of RUNNING state. The upstream task lifecycle depends on the `onExit` callback to mark the task as completed/failed.
- **Suggestion**: Add an `onExit` callback invocation in `destroy()` after cleanup, similar to `dispose()`. For example:
  ```typescript
  // After loggedCleanup, before return:
  session.callbacks.onExit(null, 'DESTROYED');
  return destroyResult;
  ```
  Alternatively, if the omission is intentional (the caller is expected to handle the state transition themselves after calling destroy), document this contract explicitly with a JSDoc `@design` comment explaining why `destroy()` is silent.

### MEDIUM

### [P1] Sentinel watcher does not debounce -- double-fire can invoke triggerExit twice for the same session
- **Location**: `src/implementations/tmux/tmux-connector.ts:335-360`
- **Confidence**: 82%
- **Description**: The messages watcher applies a 50ms debounce to suppress platform double-fire events (lines 380-393), but the sentinel watcher has no debounce. On macOS, `fs.watch()` frequently fires the callback twice for a single file creation. If `.done` or `.exit` fires twice, `handleSentinel()` will be called twice. The second call is currently protected by the `session.exited` guard in `handleSentinel` (line 580: `if (!session || session.exited) return;`), so the second invocation returns early. However, this relies on `triggerExit` completing synchronously before the second callback fires, which is true in Node.js's single-threaded model. While safe under current conditions, the protection is implicit rather than explicit -- there is no debounce or explicit deduplication for sentinel events. If any future change makes `triggerExit` async, the guard will break.
- **Impact**: Currently safe due to synchronous execution, but fragile against future changes. A defensive debounce or explicit "sentinel already processed" flag would make the invariant explicit.
- **Suggestion**: Add a `sentinelProcessed: boolean` field to `ActiveSession` (like the existing `exited` flag) and check it at the top of `handleSentinel()`, or apply a debounce similar to the messages watcher. The current `session.exited` guard works but the design relies on a non-obvious synchronous invariant.

### [P1] Unbounded pendingMessages growth window between MAX_PENDING_MESSAGES checks
- **Location**: `src/implementations/tmux/tmux-connector.ts:620-637`
- **Confidence**: 80%
- **Description**: The `MAX_PENDING_MESSAGES` cap (100) is checked only after a message is added to the pending buffer in `handleMessageFile()`. Each message file triggers an independent debounced `handleMessageFile()` call. If many messages arrive simultaneously (e.g., a burst of output), each one adds to `pendingMessages` independently. The cap check at line 627 fires per-message, but between checks the map can grow above 100 because each debounced callback runs independently and each adds one entry before checking the cap. In the worst case, if 200 debounced callbacks all resolve between event loop ticks, the map could temporarily hold 200+ entries before any single callback's cap check triggers the skip-ahead logic. The cap provides eventual bounding, not strict bounding.
- **Impact**: Temporary memory spike during burst output scenarios. The cap will eventually drain the buffer, so this is not unbounded growth, but the peak memory usage can exceed the intended 100-message cap transiently.
- **Suggestion**: This is an acceptable trade-off for the current design. Consider documenting the transient overshoot behavior. If strict bounding is needed, add a size check before inserting at line 620.

## Issues in Code You Touched (Should Fix)

### MEDIUM

### [P1] destroy() calls loggedCleanup (rmSync) AFTER killing tmux session -- but tmux kill may fail leaving orphaned directories
- **Location**: `src/implementations/tmux/tmux-connector.ts:238-240`
- **Confidence**: 82%
- **Description**: In `destroy()`, if `destroySession()` returns an error (e.g., tmux is unresponsive), the error result is returned immediately on line 240 -- but `loggedCleanup()` on line 239 still runs. This is correct. However, the `destroyResult` error is returned to the caller, who may interpret it as a failure and retry `destroy()`. On the retry, `this.activeSessions.get(handle.taskId)` returns `undefined` (line 225, since the session was deleted on line 233), so destroy() returns `ok(undefined)` without retrying the tmux kill. The orphaned tmux session persists until the staleness timer on another session detects it (if any sessions are still active) or until the process exits. If this was the last session, no staleness timer is running.
- **Impact**: A tmux session that survives a failed destroySession call becomes an orphan with no mechanism to detect or reclaim it if no other sessions are active. The directory is cleaned up but the tmux process lives on.
- **Suggestion**: Consider not deleting from `activeSessions` until `destroySession` succeeds, or keeping a separate "pendingDestroy" set for sessions whose tmux kill failed. Alternatively, document that `destroy()` is best-effort for the tmux session and callers should not retry.

### [P1] dispose() swallows all exceptions from flushPendingFiles -- a readFileSync crash could skip remaining sessions
- **Location**: `src/implementations/tmux/tmux-connector.ts:258-279`
- **Confidence**: 80%
- **Description**: `dispose()` iterates over all active sessions and calls `flushPendingFiles()` and `closeSession()` for each. `flushPendingFiles()` has a try/finally block internally (lines 504-543), and the inner `readFileSync` is in a try/catch. However, if `readFileSyncFn` throws an unexpected error type (e.g., `TypeError`, out-of-memory) not caught by the inner catch, or if `deliverPendingMessages()` throws due to a bug in the `onOutput` callback, the exception would propagate out of `flushPendingFiles()` and terminate the `dispose()` loop, leaving remaining sessions un-flushed, un-destroyed, and without `onExit` notifications. The `for...of` loop has no try/catch around individual session teardown.
- **Impact**: If any single session's teardown throws, all subsequent sessions in the `dispose()` loop are skipped -- their watchers leak, tmux sessions are not killed, and their tasks are stuck in RUNNING.
- **Suggestion**: Wrap each iteration in the `dispose()` loop in a try/catch:
  ```typescript
  for (const session of sessions) {
    try {
      session.exited = true;
      this.flushPendingFiles(session);
      this.closeSession(session);
      // ... destroySession, loggedCleanup, onExit ...
    } catch (e) {
      this.deps.logger.error('Dispose: unexpected error cleaning up session', {
        sessionName: session.handle.sessionName,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  ```

## Pre-existing Issues (Not Blocking)

(none -- all files are new in this branch)

## Suggestions (Lower Confidence)

- **Wrapper script sentinel guard race with normal exit** - `src/implementations/tmux/tmux-hooks.ts:108-114` (Confidence: 65%) -- The `_sentinel_guard` EXIT trap checks for sentinel file existence, but there is a TOCTOU window: the normal exit path writes `.done.tmp` and `mv`s it to `.done`, and if the trap fires between those two operations, the guard may write a duplicate `.exit` sentinel. The `mv` is atomic on POSIX but the check-then-write in the trap is not. This is unlikely to cause issues because the connector reads whichever sentinel appears first.

- **No upper bound on the number of debounce timers per session** - `src/implementations/tmux/tmux-connector.ts:381-393` (Confidence: 68%) -- Each unique filename gets its own debounce timer in `session.debounceTimers`. If a high-output agent generates thousands of unique message files within the 50ms debounce window, the timer map could hold thousands of entries. In practice, the debounce window is short enough that this is unlikely to be a problem, and the `closeSession()` cleanup clears all timers.

- **Staleness timer restart on every spawn/exit could cause check delay** - `src/implementations/tmux/tmux-connector.ts:419-434` (Confidence: 62%) -- `restartSharedStalenessTimer()` clears and recreates the timer on every spawn/destroy/exit. If sessions are spawned/destroyed rapidly (e.g., 10 tasks completing in quick succession), each restart resets the interval clock. A session that just barely passed `maxSilenceMs` might get an extra interval delay before the next check. The batch stale logic at line 484 mitigates this by restarting only once after a batch, but individual sentinel-triggered exits still restart per-exit.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Reliability Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The implementation demonstrates strong reliability fundamentals: bounded iteration in `deliverPendingMessages` (explicit loop cap), a `MAX_PENDING_MESSAGES` safety cap for the message buffer, `MIN_CHECK_INTERVAL_MS` floor to prevent tight-loop timers, re-entrancy guards on flush, idempotent destroy, and graceful degradation when watchers fail. The `session.exited` flag prevents double-fire in the sentinel path, and the shared staleness timer design avoids O(N) syscalls.

The HIGH-severity finding (destroy not calling onExit) is the primary concern -- it could leave tasks permanently stuck in RUNNING state when sessions are externally terminated. The MEDIUM findings are about defensive robustness: the dispose() loop should be crash-resilient per session, and the sentinel watcher's double-fire protection relies on an implicit synchronous invariant that should be made explicit. avoids PF-001 -- all findings are reported here rather than deferred.
