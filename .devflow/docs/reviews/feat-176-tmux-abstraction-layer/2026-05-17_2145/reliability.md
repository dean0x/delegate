# Reliability Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17
**Diff**: `git diff 40f9537...HEAD`

## Issues in Your Changes (BLOCKING)

### HIGH

**restartSharedStalenessTimer called inside setInterval callback via triggerExit creates timer churn** - `tmux-connector.ts:628`
**Confidence**: 85%

- Problem: `triggerExit()` calls `restartSharedStalenessTimer()` (line 628), which calls `stopSharedStalenessTimer()` + `setInterval()`. When multiple sessions go stale in the same tick, `runSharedStalenessCheck()` (line 444) iterates `staleEntries` and calls `triggerExit()` for each. Each call stops and restarts the shared timer. For N stale sessions in one tick, this creates N-1 orphaned `setInterval` handles (each `restartSharedStalenessTimer` call clears the previous and creates a new one, but the intermediate ones fire at least once before being cleared). While the final state is correct (only the last timer survives), the intermediate `clearInterval`/`setInterval` churn is wasteful and the brief window where the old timer is cleared but the new one hasn't ticked yet could theoretically cause a missed check.
- Fix: Move the `restartSharedStalenessTimer()` call out of `triggerExit()` and into `runSharedStalenessCheck()` after the stale-entries loop completes, similar to how `dispose()` handles timer management separately from per-session teardown. Alternatively, add a batching flag that defers the timer restart until the stale-entries loop finishes:
  ```typescript
  for (const [taskId, session] of staleEntries) {
    this.triggerExit(taskId, session, null, 'STALE', session.callbacks);
  }
  // Restart once after all stale sessions are cleaned up
  if (staleEntries.length > 0) {
    this.restartSharedStalenessTimer();
  }
  ```
  This requires `triggerExit` to not call `restartSharedStalenessTimer` when invoked from the staleness check. A simple approach: extract the cleanup logic from `triggerExit` into a shared helper, and have the staleness check path skip the timer restart.

### MEDIUM

**Math.min(...intervals) throws RangeError on very large activeSessions maps** - `tmux-connector.ts:394`
**Confidence**: 82%

- Problem: `Math.min(...intervals)` spreads the array as function arguments. If `activeSessions` grows large (e.g., via a tight spawn loop or misconfigured caller), this can exceed the JS engine's call stack argument limit (typically ~65k-125k on V8). While `MAX_CONCURRENT_SESSIONS` is 20 in constants, this limit is not enforced in `TmuxConnector.spawn()` -- it's only a constant, not a guard. The pre-existing code iterated with a `for` loop which has no such limit.
- Fix: Use a loop or `reduce` instead of spread:
  ```typescript
  let minInterval = Infinity;
  for (const s of this.activeSessions.values()) {
    if (s.stalenessConfig.checkIntervalMs < minInterval) {
      minInterval = s.stalenessConfig.checkIntervalMs;
    }
  }
  const clampedInterval = Math.max(minInterval, MIN_CHECK_INTERVAL_MS);
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**deliverPendingMessages while loop lacks upper bound** - `tmux-connector.ts:602-607`
**Confidence**: 80%

- Problem: The `while (session.pendingMessages.has(session.nextExpectedSeq))` loop at line 602 is bounded only by the contents of `pendingMessages`. If a pathological message producer writes messages with contiguous sequence numbers faster than the consumer can drain them, the loop runs without yielding to the event loop. Additionally, `handleMessageFile` (the async hot path) calls `deliverPendingMessages` after inserting a message, and the MAX_PENDING_MESSAGES cap at line 572 also calls it again. While the practical risk is low (messages arrive from fs.watch debounce which yields), a fixed iteration cap would align with the bounded-iteration principle.
- Fix: Add a maximum iteration count:
  ```typescript
  private deliverPendingMessages(session: ActiveSession, callbacks: SpawnCallbacks): void {
    let delivered = 0;
    while (session.pendingMessages.has(session.nextExpectedSeq) && delivered < MAX_PENDING_MESSAGES) {
      const msg = session.pendingMessages.get(session.nextExpectedSeq)!;
      session.pendingMessages.delete(session.nextExpectedSeq);
      this.deliverSingle(msg, session, callbacks);
      session.nextExpectedSeq++;
      delivered++;
    }
  }
  ```

## Pre-existing Issues (Not Blocking)

### MEDIUM

**No admission control enforcement in spawn()** - `tmux-connector.ts:135`
**Confidence**: 85%

- Problem: `MAX_CONCURRENT_SESSIONS` (20) is exported as a constant but never checked during `spawn()`. A caller could spawn an unlimited number of sessions, each with its own watchers, debounce timers, and pending message buffers. This is a resource bounding gap -- the constant exists but isn't enforced.

### MEDIUM

**Sentinel watcher and messages watcher failure is silent beyond logging** - `tmux-connector.ts:324-327, 372-373`
**Confidence**: 80%

- Problem: When both watchers fail to start (catch blocks at lines 324 and 372), the session proceeds with no push-based event detection at all. The staleness timer is the only fallback, but it requires `maxSilenceMs` to elapse (default 60s) before detecting completion. During that window, the session appears stuck. There is no precondition assertion that at least one detection mechanism is active.

## Suggestions (Lower Confidence)

- **Potential stale closure over `callbacks` in sentinel watcher** - `tmux-connector.ts:304,312` (Confidence: 65%) -- `startSentinelWatcher` captures `session.callbacks` at construction time via destructuring (`const { callbacks } = session`). If `session.callbacks` were ever reassigned after watcher creation, the watcher would hold a stale reference. Currently callbacks are never reassigned so this is not a live bug, but the destructured capture creates a subtle coupling.

- **`forceDeliverRemaining` does not advance `nextExpectedSeq`** - `tmux-connector.ts:514-521` (Confidence: 70%) -- After force-delivering, `session.nextExpectedSeq` stays at whatever gap existed. If more messages somehow arrived after flush (e.g., a late fs.watch event fires), the delivery pipeline would re-attempt gap-filling from the old `nextExpectedSeq`. The `session.exited = true` guard makes this unlikely in practice, but `nextExpectedSeq` could be advanced to `max(delivered) + 1` for defensive correctness.

- **`handleMessageFile` .catch handler only logs; no retry or escalation** - `tmux-connector.ts:353-359` (Confidence: 62%) -- If `handleMessageFile` throws (e.g., disk read error), the message is silently dropped with only a warn log. The flush-on-exit path will re-attempt via `flushPendingFiles`, but only if the file still exists on disk. For transient I/O errors this means messages can be lost without any retry.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 2 | 0 |

**Reliability Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The incremental changes are strong improvements -- MIN_CHECK_INTERVAL_MS prevents tight-loop timers, the collect-then-mutate pattern in `runSharedStalenessCheck` fixes the iterator-invalidation bug, hooks.cleanup Result handling closes error-swallowing gaps, and the `.catch()` on `handleMessageFile` prevents unhandled promise rejections. The two blocking items (timer churn during batch stale exit and spread-args limit) are straightforward to fix and would bring reliability to 8-9/10.
