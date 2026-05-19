# Reliability Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-18

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

**onExit/onOutput callback exceptions can crash the connector** - `tmux-connector.ts:734`, `tmux-connector.ts:254`, `tmux-connector.ts:677`
**Confidence**: 85%
- Problem: The `SpawnCallbacks.onExit` and `SpawnCallbacks.onOutput` callbacks are invoked without try/catch guards in `triggerExit()` (line 734), `destroy()` (line 254), and `deliverSingle()` (line 677). If a caller-supplied callback throws, the exception propagates uncaught through `triggerExit` or the message delivery loop. In `triggerExit`, this means `loggedCleanup` at line 733 may have already run, but the remaining sessions in a batch stale loop (line 508) would be skipped because the exception escapes `runSharedStalenessCheck`. In `dispose()`, the per-session try/catch on line 280 does protect against this for the shutdown path, but `triggerExit` called from `handleSentinel` or `runSharedStalenessCheck` has no such guard. For `deliverSingle` in the hot path, a throwing `onOutput` callback would abort delivery of remaining pending messages and propagate up through `handleMessageFile`, which does have a `.catch()` on line 414 -- but that catch only logs, meaning all subsequent messages for the session would be silently dropped.
- Fix: Wrap `session.callbacks.onExit(...)` calls in `triggerExit` (and `destroy`) with try/catch, logging the error. Similarly, wrap `callbacks.onOutput(msg)` in `deliverSingle` so one bad message does not block subsequent deliveries:
  ```typescript
  // In triggerExit, line 734:
  try {
    session.callbacks.onExit(code, signal);
  } catch (cbErr: unknown) {
    this.deps.logger.error('onExit callback threw', {
      taskId,
      error: cbErr instanceof Error ? cbErr.message : String(cbErr),
    });
  }

  // In deliverSingle, line 677-678:
  try {
    callbacks.onOutput(msg);
  } catch (cbErr: unknown) {
    this.deps.logger.warn('onOutput callback threw', {
      sequence: msg.sequence,
      error: cbErr instanceof Error ? cbErr.message : String(cbErr),
    });
  }
  ```

### MEDIUM

**destroy() always calls onExit even when destroySession fails** - `tmux-connector.ts:244-254`
**Confidence**: 82%
- Problem: `destroy()` calls `this.activeSessions.delete(handle.taskId)` on line 248 unconditionally, then calls `session.callbacks.onExit(null, 'DESTROYED')` on line 254, regardless of whether `destroySession` succeeded. The method returns the `destroyResult`, but the session is already removed from tracking. The comment on line 245-246 says "Delete from activeSessions AFTER the destroySession attempt so that on failure the session remains tracked and the caller can retry destroy()." However, the code does NOT implement this conditional logic -- it always deletes. If `destroySession` fails (e.g., tmux is temporarily unavailable), the tmux session remains alive but the connector has lost its tracking handle, making the session permanently orphaned with no way to retry.
- Fix: Only remove from `activeSessions` and call `onExit` when `destroyResult.ok` is true. On failure, keep the session tracked (with `exited` reset to false) so the caller or staleness timer can retry:
  ```typescript
  const destroyResult = this.deps.sessionManager.destroySession(handle.sessionName);
  if (destroyResult.ok) {
    this.activeSessions.delete(handle.taskId);
    this.restartSharedStalenessTimer();
    this.loggedCleanup('destroy', handle.taskId, handle.sessionsDir);
    session.callbacks.onExit(null, 'DESTROYED');
  } else {
    // Keep tracked so staleness timer or caller can retry
    session.exited = false;
    this.deps.logger.warn('destroy: session kill failed, keeping tracked', {
      taskId: handle.taskId,
      error: destroyResult.error.message,
    });
  }
  return destroyResult;
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**No precondition assertion on StalenessConfig values at construction** - `tmux-connector.ts:321-324`
**Confidence**: 83%
- Problem: `buildActiveSession` merges user-provided `config.staleness` into `DEFAULT_STALENESS_CONFIG` without validating that `maxSilenceMs > 0` or that `maxSilenceMs > checkIntervalMs`. While `MIN_CHECK_INTERVAL_MS` (1000ms) is enforced at timer-start time (line 460), `maxSilenceMs` has no lower bound. A caller could pass `{ maxSilenceMs: 0 }`, which would cause every session to be immediately declared stale on the first check tick (line 498: `silentMs >= 0` is always true). The `checkIntervalMs` floor clamp at line 460 only applies to the shared timer interval, not to individual session configs that might have invalid combinations.
- Fix: Validate both fields in `buildActiveSession` or at the top of `spawn()`:
  ```typescript
  const stalenessConfig: StalenessConfig = {
    ...DEFAULT_STALENESS_CONFIG,
    ...config.staleness,
  };
  if (stalenessConfig.maxSilenceMs <= 0) {
    return err(tmuxSessionFailed('spawn', 'maxSilenceMs must be positive'));
  }
  if (stalenessConfig.maxSilenceMs <= stalenessConfig.checkIntervalMs) {
    return err(tmuxSessionFailed('spawn', 'maxSilenceMs must exceed checkIntervalMs'));
  }
  ```

**Wrapper script sentinel guard does not fire onExit for agent crash before first output** - `tmux-hooks.ts:130-136` + `tmux-connector.ts:359-388`
**Confidence**: 80%
- Problem: The wrapper script's `_sentinel_guard` EXIT trap (tmux-hooks.ts line 130) writes a `.exit` sentinel if neither `.done` nor `.exit` exists. The sentinel watcher (tmux-connector.ts line 362) picks this up and calls `handleSentinel`. However, if the agent crashes before the sentinel watcher is fully initialized (the `catch` at line 385 logs a warning and proceeds without a watcher), the connector relies entirely on the staleness timer to detect the dead session. With default settings (`maxSilenceMs: 60_000`), a session that crashes at spawn can silently appear alive for up to 60 seconds. This is documented as a design tradeoff ("degrading to staleness detection"), but the silent 60-second window with no watcher and no logged indication that the degraded path is in effect could surprise callers.
- Fix: This is acceptable with the documented design, but consider logging at INFO level (not just warn) when falling back to staleness-only mode, and consider a reduced initial staleness check (e.g., first check at 5 seconds after spawn, then switching to the configured interval).

## Pre-existing Issues (Not Blocking)

(none -- all files in this review are new)

## Suggestions (Lower Confidence)

- **dispose() clears activeSessions before iterating** - `tmux-connector.ts:274-275` (Confidence: 70%) -- `dispose()` calls `this.activeSessions.clear()` before the teardown loop. If `dispose()` throws partway through the loop (despite the try/catch), the connector's internal state says "no sessions" but tmux sessions may still be running. Consider clearing after the loop completes, or maintaining a "disposing" flag.

- **Potential double onExit from sentinel + staleness race** - `tmux-connector.ts:706` (Confidence: 65%) -- The `session.exited` flag guards against double `onExit` calls. However, if a sentinel watcher fires `handleSentinel` and starts `triggerExit` at the exact same event loop tick as `runSharedStalenessCheck` finding the session dead, both could read `session.exited === false` before either sets it to `true`. In practice, Node.js event loop guarantees synchronous execution within a tick, so the sentinel callback would complete before the interval callback fires. This is safe but worth a brief comment clarifying the single-threaded safety assumption.

- **flushPendingFiles calls deliverSingle which calls onOutput without error boundary** - `tmux-connector.ts:566-569` (Confidence: 75%) -- During flush (called from triggerExit and dispose), `forceDeliverRemaining` calls `deliverSingle` which invokes `callbacks.onOutput`. If `onOutput` throws during flush, the `finally` block at line 570 resets `session.flushing`, but the exception propagates up. In `dispose()` this is caught by the per-session try/catch. In `triggerExit` it is not caught. This overlaps with the HIGH finding above.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Reliability Score**: 8/10
**Recommendation**: CHANGES_REQUESTED

The tmux abstraction layer demonstrates strong reliability fundamentals: all loops are bounded, all timers are cleaned up on dispose, fs.watch resources are closed in failure paths, the `exited` flag prevents double-exit callbacks, and `MAX_PENDING_MESSAGES` caps unbounded memory growth. The shared staleness timer avoids O(N) syscalls and is properly restarted/stopped as the session set changes. The main reliability gap is unprotected callback invocations -- if caller-supplied `onExit`/`onOutput` throw, cleanup paths in `triggerExit` and message delivery can be disrupted. The `destroy()` unconditional deletion also creates an orphan risk on tmux failure. Both are fixable with targeted try/catch guards.
