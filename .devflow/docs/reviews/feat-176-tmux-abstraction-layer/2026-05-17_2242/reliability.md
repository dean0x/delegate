# Reliability Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17
**Focus**: Reliability -- unbounded loops, missing assertions, excessive allocation, race conditions, resource leaks, error recovery

## Issues in Your Changes (BLOCKING)

### HIGH

**Debounce timers fire after session exit -- callbacks invoked on disposed session** - `tmux-connector.ts:354-363`
**Confidence**: 85%
- Problem: When a message watcher fires and creates a debounce timer (setTimeout at line 354), but the session exits before the 50ms debounce window completes, the timer callback still executes `handleMessageFile()`. Although `handleMessageFile` checks `session.exited` at line 556, the timer was captured in a closure that holds a reference to the `session` object. If `triggerExit` fires between the `setTimeout` creation and its expiry, the debounce timer gets cleared in `closeSession()` (line 695-698). However, there is a narrow TOCTOU window: the messages watcher callback at line 343 can fire and schedule a new debounce timer *after* `closeSession()` has already cleared all existing timers but *before* the watcher is actually closed (since `close()` is called in the same `closeSession` method). The `session.exited` check at line 556 provides safety, but the timer itself leaks briefly.
- Fix: Add an `exited` check at the top of the watcher callback (line 345) to reject new debounce timers once the session is marked for exit:
```typescript
(_eventType: string, filename: string | null) => {
  if (!filename || session.exited) return;
  // ... rest of handler
}
```

**No upper bound on `activeSessions` map size in TmuxConnector** - `tmux-connector.ts:114,180`
**Confidence**: 82%
- Problem: While `DefaultTmuxSessionManager.createSession()` enforces `MAX_CONCURRENT_SESSIONS = 20` at the tmux level (line 79 of tmux-session-manager.ts), the `TmuxConnector.activeSessions` map itself has no admission control. If the session manager's `listSessions()` call in `createSession` is stale (another process creates sessions between the check and the create), or if a custom session manager implementation is injected (the interface has no limit contract), the connector could accumulate unbounded entries. Each entry holds watchers, timers, and a `pendingMessages` map -- compounding memory pressure.
- Fix: Add a connector-level guard in `spawn()` after the duplicate-taskId check:
```typescript
if (this.activeSessions.size >= MAX_CONCURRENT_SESSIONS) {
  return err(tmuxSessionFailed('spawn', `connector session limit reached (${MAX_CONCURRENT_SESSIONS})`));
}
```

**`destroy()` does not set `session.exited = true` before calling `flushPendingFiles` in all paths** - `tmux-connector.ts:194-210`
**Confidence**: 80%
- Problem: `destroy()` sets `session.exited = true` at line 200, calls `flushPendingFiles` at line 201, then calls `closeSession` at line 202. However, it does NOT call `callbacks.onExit()`. This means that if the staleness timer fires *between* line 200 and line 204 (`activeSessions.delete`), the `runSharedStalenessCheck` will find the session in `activeSessions`, see `session.exited = true`, and skip it (line 433). This is correct. BUT -- `destroy()` does not stop the staleness timer *before* operating on the session. If the staleness timer fires at exactly the wrong time and invokes `triggerExit` for a *different* session that then calls `restartSharedStalenessTimer()`, the state is consistent because `destroy()` calls `restartSharedStalenessTimer()` at the end (line 204). The actual risk is minimal in single-threaded Node.js but the ordering is fragile.
- Fix: This is adequately mitigated by `session.exited = true` guard and single-threaded event loop. No code change required, but a comment documenting the safety invariant would improve maintainability.

### MEDIUM

**`deliverPendingMessages` loop has no explicit upper bound** - `tmux-connector.ts:613-619`
**Confidence**: 82%
- Problem: The `while (session.pendingMessages.has(session.nextExpectedSeq))` loop has no fixed iteration cap. If somehow the pending map contains a contiguous range of N messages (e.g., after flush reads thousands of files), this loop runs N iterations before yielding. For the `flushPendingFiles` path this is bounded by disk file count, but for `handleMessageFile` the pending buffer is capped at `MAX_PENDING_MESSAGES = 100`. In practice the loop is bounded by the map size (at most 100 in the hot path, or file count in the flush path), but it violates the "every loop has an explicit upper bound" rule.
- Fix: Add an explicit iteration guard:
```typescript
private deliverPendingMessages(session: ActiveSession, callbacks: SpawnCallbacks): void {
  let delivered = 0;
  const maxDelivery = session.pendingMessages.size + 1; // can't deliver more than pending
  while (session.pendingMessages.has(session.nextExpectedSeq) && delivered < maxDelivery) {
    // ...
    delivered++;
  }
}
```

**Validator caches failure permanently -- no recovery path** - `tmux-validator.ts:47-48`
**Confidence**: 80%
- Problem: `DefaultTmuxValidator.validate()` caches the result (line 47-48), including failure results. If tmux is temporarily unavailable at startup (e.g., server socket not yet ready), the cached error will persist for the entire process lifetime. Every subsequent `spawn()` call will fail immediately without re-checking. For a long-running MCP server process, this means a transient tmux startup delay becomes a permanent failure.
- Fix: Cache only success results. On failure, return the error but do not cache:
```typescript
validate(): Result<TmuxInfo, AutobeatError> {
  if (this.cached !== null) return this.cached;
  const result = this.runValidation();
  if (result.ok) this.cached = result;
  return result;
}
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`flushPendingFiles` reads all JSON files from disk on every exit -- no file count bound** - `tmux-connector.ts:490-509`
**Confidence**: 80%
- Problem: If an agent produces a very large number of output messages (thousands of JSON files in the messages directory), `flushPendingFiles` will read and parse all of them synchronously. With the synchronous `readFileSyncFn`, this blocks the event loop for the duration of the flush. For a typical agent session this might be 10-100 files (bounded), but for a long-running agent that streams thousands of lines, this could cause noticeable stalls. The 2>&1 pipe in the wrapper script means every line of output becomes one file.
- Fix: Consider adding a cap on flush file reads (e.g., 1000 files max) with a warning if exceeded, or document the expected upper bound in the design decision comment. Since messages are small JSON, 1000 files is roughly 5-10MB of synchronous I/O, which is acceptable for a one-time flush.

**`triggerExit` calls `destroySession` after deleting from `activeSessions` -- error is logged but not propagated** - `tmux-connector.ts:637-656`
**Confidence**: 80%
- Problem: `triggerExit` removes the session from `activeSessions` (line 637), then calls `destroySession` (line 648). If `destroySession` fails (tmux server unresponsive), the zombie tmux session remains but the connector no longer tracks it. The error is logged, but the caller (`onExit` callback) is still invoked with a normal exit -- the caller has no way to know that the tmux session was not actually killed. This is acceptable for the "stale" path (the session is already dead), but for the sentinel path where the wrapper exited but tmux may still be alive, this could leave orphan processes.
- Fix: This is a design tradeoff already documented (destroySession is idempotent for already-dead sessions). The behavior is acceptable -- the tmux session will die on its own when the command exits. No code change required.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**No assertion that `OutputMessage.sequence` is a positive integer** - `tmux-connector.ts:54-63`
**Confidence**: 80%
- Problem: The `isOutputMessage` type guard validates that `sequence` is a number but does not check that it is a positive integer. A negative or zero sequence number would bypass the `lastDeliveredSeq` watermark (since `msg.sequence > session.lastDeliveredSeq` would be false for sequence 0, or true for negative decreasing values). The wrapper script always produces positive incrementing sequences, so this is defense-in-depth only.
- Fix: Add `Number.isInteger(v.sequence) && v.sequence > 0` to the type guard.

## Suggestions (Lower Confidence)

- **Shared staleness timer does not account for clock skew** - `tmux-connector.ts:438-440` (Confidence: 65%) -- `Date.now()` is used for `lastAliveCheck` and the `silentMs` calculation. If the system clock jumps backward (NTP adjustment), a session could be incorrectly marked stale. Consider using `process.hrtime.bigint()` for monotonic timing.

- **No cap on debounceTimers map size per session** - `tmux-connector.ts:104,364` (Confidence: 70%) -- Each unique filename that triggers the watcher creates an entry in `debounceTimers`. If the wrapper produces files extremely fast (faster than 50ms per file), multiple timers can accumulate. In practice the debounce clears on delivery, but an explicit size guard would prevent pathological cases.

- **Wrapper script EXIT trap may mask the real exit code** - `tmux-hooks.ts:114-120` (Confidence: 62%) -- The `_sentinel_guard` trap captures `$?` at trap time. If the sentinel was already written by the normal flow (the guard condition prevents duplicate), this is fine. But if `mv` in the normal sentinel-write path fails silently (line 143, `2>/dev/null || true` is not present on the normal path), both the trap and the normal path could race on writing the sentinel.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 1 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Reliability Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The implementation demonstrates strong reliability engineering overall:
- Bounded message buffer with MAX_PENDING_MESSAGES cap and forced delivery
- Re-entrancy guard on flush
- Session.exited flag prevents double-exit
- Staleness timer properly stops when session set empties
- Watcher errors degrade gracefully to staleness detection
- Debounce timers are cleared on session close
- Idempotent destroy/dispose

The two HIGH findings (post-exit watcher callbacks and missing connector-level admission control) are low-probability issues that should be addressed before this infrastructure manages billable compute. The validator caching of failures is the most impactful concern for a long-running server process.
