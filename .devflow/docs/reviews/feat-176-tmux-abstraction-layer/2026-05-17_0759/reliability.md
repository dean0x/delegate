# Reliability Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17
**Diff**: `git diff 1bec153be5..40f9537` (6 commits)

## Issues in Your Changes (BLOCKING)

### HIGH

**Map mutation during iteration in `runSharedStalenessCheck`** - `src/implementations/tmux/tmux-connector.ts:375-392`
**Confidence**: 85%
- Problem: `runSharedStalenessCheck` iterates `this.activeSessions` via `for (const [taskId, session] of this.activeSessions)` (line 375). When a session is stale, it calls `triggerExit` (line 389), which calls `this.activeSessions.delete(taskId)` (line 574). If multiple sessions go stale in the same tick, deleting entries from the Map while iterating it is fragile. While the ECMAScript spec technically allows deleting the *current* entry during `Map.prototype[Symbol.iterator]`, this pattern is a reliability hazard: future refactors that reorder or add entries during iteration will silently break. More critically, `triggerExit` also calls `stopSharedStalenessTimerIfEmpty` which clears the interval from within its own callback -- harmless alone, but combined with mutation-during-iteration makes the function hard to reason about for correctness.
- Fix: Collect stale session IDs into an array, then process exits after the iteration completes:
```typescript
private runSharedStalenessCheck(): void {
  if (this.activeSessions.size === 0) return;

  const listResult = this.deps.sessionManager.listSessions();
  if (!listResult.ok) {
    this.deps.logger.warn('listSessions failed — transient error, skipping staleness check', {
      error: listResult.error.message,
    });
    return;
  }

  const aliveSessions = new Set<string>(listResult.value.map((s: TmuxSessionInfo) => s.name));
  const now = Date.now();

  // Collect stale sessions — do not mutate activeSessions during iteration
  const stale: Array<[string, ActiveSession]> = [];

  for (const [taskId, session] of this.activeSessions) {
    if (session.exited) continue;

    if (aliveSessions.has(session.handle.sessionName)) {
      session.lastAliveCheck = now;
    } else {
      const silentMs = now - session.lastAliveCheck;
      if (silentMs >= session.stalenessConfig.maxSilenceMs) {
        stale.push([taskId, session]);
      }
    }
  }

  // Process exits after iteration completes
  for (const [taskId, session] of stale) {
    this.deps.logger.warn('Session stale — no heartbeat detected', {
      sessionName: session.handle.sessionName,
      silentMs: now - session.lastAliveCheck,
    });
    this.triggerExit(taskId, session, null, 'STALE', session.callbacks);
  }
}
```

### MEDIUM

**Shared timer not restarted when session exits -- interval drift risk** - `src/implementations/tmux/tmux-connector.ts:338-353,559-578`
**Confidence**: 82%
- Problem: `restartSharedStalenessTimer` is only called from `spawn` (line 199). It computes the minimum `checkIntervalMs` across all active sessions. When a session exits (via `triggerExit` or `destroy`), `stopSharedStalenessTimerIfEmpty` only clears the timer if the map is empty. If the session that was removed had the *minimum* `checkIntervalMs`, the remaining sessions continue being checked at a faster rate than necessary (benign waste). Conversely, if a new session with a *smaller* interval is spawned, `restartSharedStalenessTimer` recalculates correctly. But the interesting case is: session A has `checkIntervalMs: 1000`, session B has `checkIntervalMs: 30000`. Timer runs at 1000ms. Session A exits. Timer continues at 1000ms for session B (30x over-polling). Not a correctness bug, but unnecessary syscall overhead via `listSessions` every second when only 30-second checking is needed.
- Fix: Call `restartSharedStalenessTimer()` at the end of `triggerExit` and `destroy` (after the delete, but only when `activeSessions.size > 0`):
```typescript
// In triggerExit, after this.activeSessions.delete(taskId):
if (this.activeSessions.size > 0) {
  this.restartSharedStalenessTimer();
} else {
  this.stopSharedStalenessTimer();
}
```

**Unhandled promise from async `handleMessageFile` in debounce callback** - `src/implementations/tmux/tmux-connector.ts:308-311`
**Confidence**: 83%
- Problem: `handleMessageFile` was changed from sync to `async` returning `Promise<void>` (line 492). The debounce timer callback at line 310 calls it:
```typescript
const timer = setTimeout(() => {
  session.debounceTimers.delete(filename);
  this.handleMessageFile(path.join(messagesDir, filename), session, callbacks);
}, DEBOUNCE_MS);
```
Since `handleMessageFile` is now async, this call creates a floating promise. If the async function rejects (e.g., `readFileFn` throws synchronously rather than returning a rejected promise), the rejection becomes an unhandled promise rejection, which in Node.js 18+ terminates the process by default.
- Fix: Add explicit rejection handling:
```typescript
const timer = setTimeout(() => {
  session.debounceTimers.delete(filename);
  this.handleMessageFile(path.join(messagesDir, filename), session, callbacks).catch((e) => {
    this.deps.logger.warn('handleMessageFile rejected unexpectedly', {
      filePath: path.join(messagesDir, filename),
      error: e instanceof Error ? e.message : String(e),
    });
  });
}, DEBOUNCE_MS);
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`minInterval` can remain `Infinity` if all sessions are exited** - `src/implementations/tmux/tmux-connector.ts:343-348`
**Confidence**: 80%
- Problem: `restartSharedStalenessTimer` short-circuits on `activeSessions.size === 0` (line 340), but does not guard against the case where all sessions in the map have `exited: true` and `checkIntervalMs` is somehow invalid (e.g., 0 or negative). The `StalenessConfig` interface has no runtime validation on `checkIntervalMs`, so a caller passing `{ checkIntervalMs: 0, maxSilenceMs: 1000 }` would create a `setInterval` with interval 0, which would fire as fast as the event loop allows -- effectively an unbounded tight loop calling `listSessions()`.
- Fix: Assert a minimum bound on the interval:
```typescript
const MIN_CHECK_INTERVAL_MS = 1000;
// ...
this.sharedStalenessTimer = setInterval(() => {
  this.runSharedStalenessCheck();
}, Math.max(minInterval, MIN_CHECK_INTERVAL_MS));
```

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`flushPendingFiles` does not bound the number of files it reads from disk** - `src/implementations/tmux/tmux-connector.ts:417-470`
**Confidence**: 80%
- Problem: `flushPendingFiles` calls `readdirSyncFn` and reads every `.json` file from the messages directory. For a long-running agent that produces a large volume of output, this could be thousands of files read synchronously in one go. The hot-path `handleMessageFile` has `MAX_PENDING_MESSAGES` (100) as a cap, but the flush path has no such limit.
- Fix: Add a cap or log a warning if the file count exceeds a threshold. Since flush is only called on exit, this is unlikely to cause problems in practice, but a defensive cap would be consistent with the hot-path design.

## Suggestions (Lower Confidence)

- **`callbacks.onOutput` exception propagation in `deliverSingle`** - `src/implementations/tmux/tmux-connector.ts:539-543` (Confidence: 70%) -- If `callbacks.onOutput(msg)` throws, the exception propagates up through `deliverPendingMessages` / `flushPendingFiles` and could leave `session.flushing` stuck as `true` (the `finally` block resets it, but the remaining messages in the loop would be skipped). Consider wrapping the callback invocation in a try/catch with logging so one bad message does not prevent delivery of subsequent messages.

- **`SAFE_PATH_REGEX` rejects paths with spaces** - `src/implementations/tmux/tmux-hooks.ts:35` (Confidence: 65%) -- The regex `/^[a-zA-Z0-9/_.\-]+$/` does not allow spaces in `sessionsDir`. While the single-quoted embedding is safe for paths with spaces, users with spaces in their home directory (e.g., `/Users/John Smith/...`) would get an unhelpful "unsafe sessionsDir path" error. This may be intentional (defense in depth) but could surprise macOS users.

- **Sentinel watcher error handler does not close the watcher** - `src/implementations/tmux/tmux-connector.ts:282-288` (Confidence: 62%) -- When the sentinel watcher emits an error, the handler logs a warning but leaves the watcher open. Depending on the error type, the watcher may continue emitting errors in a loop. Consider closing the watcher on error to avoid log spam.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Reliability Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The shared staleness timer is a good architectural improvement over N per-session timers, but the Map mutation during iteration in `runSharedStalenessCheck` is the primary concern. The floating promise from the sync-to-async `handleMessageFile` conversion and the lack of a floor on `checkIntervalMs` should also be addressed. All three have concrete, low-risk fixes.
