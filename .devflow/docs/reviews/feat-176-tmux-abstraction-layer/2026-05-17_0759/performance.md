# Performance Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17
**Diff Range**: 1bec153be5..40f9537 (6 commits)

## Issues in Your Changes (BLOCKING)

### HIGH

**Concurrent map mutation during iteration in `runSharedStalenessCheck`** - `src/implementations/tmux/tmux-connector.ts:375-389`
**Confidence**: 92%
- Problem: `runSharedStalenessCheck` iterates `this.activeSessions` with a `for...of` loop (line 375). Inside that loop, `triggerExit` (line 389) calls `this.activeSessions.delete(taskId)` (line 574). Mutating a `Map` during `for...of` iteration is allowed by the JS spec (the iterator sees deletions), but when multiple sessions go stale in the same tick, `triggerExit` also calls `this.stopSharedStalenessTimerIfEmpty()` (line 575), which may clear the shared timer mid-iteration. More critically, if `triggerExit`'s `callbacks.onExit()` synchronously calls `connector.spawn()` (a re-entrant scenario), `restartSharedStalenessTimer` would be called, mutating state the outer loop depends on. While the current `session.exited` guard prevents double-fire for the *same* session, it does not protect against re-entrant spawn during the iteration.
- Impact: In the stale-multiple-sessions scenario, this could cause skipped sessions or unexpected timer state. The re-entrant spawn case would corrupt the iterator and timer interval.
- Fix: Snapshot the entries before iterating, and defer timer adjustments until after the loop completes:
```typescript
private runSharedStalenessCheck(): void {
  if (this.activeSessions.size === 0) return;

  const listResult = this.deps.sessionManager.listSessions();
  if (!listResult.ok) { /* ... */ return; }

  const aliveSessions = new Set<string>(listResult.value.map((s) => s.name));
  const now = Date.now();

  // Snapshot to avoid concurrent-modification issues
  const entries = Array.from(this.activeSessions.entries());
  for (const [taskId, session] of entries) {
    if (session.exited) continue;
    if (aliveSessions.has(session.handle.sessionName)) {
      session.lastAliveCheck = now;
    } else {
      const silentMs = now - session.lastAliveCheck;
      if (silentMs >= session.stalenessConfig.maxSilenceMs) {
        this.triggerExit(taskId, session, null, 'STALE', session.callbacks);
      }
    }
  }
}
```

### MEDIUM

**`restartSharedStalenessTimer` called on every `spawn` — stops and recreates timer for all sessions** - `src/implementations/tmux/tmux-connector.ts:199,338-353`
**Confidence**: 82%
- Problem: Every `spawn()` call invokes `restartSharedStalenessTimer()`, which calls `clearInterval` + iterates all active sessions to find the minimum interval + creates a new `setInterval`. For the common case where all sessions use `DEFAULT_STALENESS_CONFIG` (same interval), the minimum never changes after the first spawn. Restarting the timer is unnecessary overhead and introduces a brief window with no staleness checking.
- Impact: Low in practice (spawn is not a hot path; sessions are bounded at 20), but the timer gap means a staleness check could be delayed by up to `minInterval` ms after each spawn. With rapid sequential spawns, the timer keeps resetting without ever firing.
- Fix: Only restart the timer when the new session's `checkIntervalMs` is strictly less than the current minimum, or when it is the first session:
```typescript
private ensureSharedStalenessTimer(newConfig: StalenessConfig): void {
  if (this.sharedStalenessTimer === null) {
    // First session — start the timer
    this.sharedStalenessTimer = setInterval(() => this.runSharedStalenessCheck(), newConfig.checkIntervalMs);
    return;
  }
  // Only restart if the new session needs a faster check interval
  // (current minimum is tracked as a field, not recomputed each time)
}
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Unhandled promise from `handleMessageFile` in debounce callback** - `src/implementations/tmux/tmux-connector.ts:310`
**Confidence**: 85%
- Problem: `handleMessageFile` was changed from sync to async (line 492), which is a good performance improvement (avoids blocking the event loop). However, the `setTimeout` callback at line 310 now calls an async function without awaiting or catching the promise:
  ```typescript
  const timer = setTimeout(() => {
    session.debounceTimers.delete(filename);
    this.handleMessageFile(path.join(messagesDir, filename), session, callbacks);
    // ^ returns Promise<void> — unhandled rejection if readFile throws after await
  }, DEBOUNCE_MS);
  ```
  If `readFileFn` rejects (e.g., ENOENT after the file is moved), the rejection is caught by the internal try/catch in `handleMessageFile`. However, if any *other* error occurs after the await (e.g., in `deliverPendingMessages` or `callbacks.onOutput`), it becomes an unhandled promise rejection.
- Impact: Unhandled rejections in Node.js cause process warnings and can crash the process in strict mode. The current code is *mostly* safe because the try/catch covers the await, but the code after the try/catch (lines 508-531) runs without a catch wrapper and calls user-provided callbacks.
- Fix: Add `.catch()` to the fire-and-forget promise, or wrap the entire post-try/catch block:
```typescript
const timer = setTimeout(() => {
  session.debounceTimers.delete(filename);
  this.handleMessageFile(path.join(messagesDir, filename), session, callbacks).catch((err) => {
    this.deps.logger.warn('Unhandled error in message handler', {
      filePath: path.join(messagesDir, filename),
      error: err instanceof Error ? err.message : String(err),
    });
  });
}, DEBOUNCE_MS);
```

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`createSession` calls `listSessions` on every session creation for admission control** - `src/implementations/tmux/tmux-session-manager.ts:77`
**Confidence**: 80%
- Problem: `createSession` calls `listSessions()` (which spawns `tmux list-sessions`) as an admission check. The shared staleness timer also calls `listSessions()` periodically. If `spawn` is called during a staleness tick, two `tmux list-sessions` processes run nearly simultaneously. With 20 sessions, this means 2 process spawns in quick succession, though the data volume is small.
- Impact: Minimal with the current 20-session cap. Would only matter if the cap were raised significantly or if tmux latency is high.

## Suggestions (Lower Confidence)

- **Set allocation in `runSharedStalenessCheck` on every tick** - `tmux-connector.ts:372` (Confidence: 65%) -- A new `Set` is constructed from `listResult.value.map(...)` on every timer tick. For typical session counts (1-20), this is negligible. For very high session counts it could be optimized by comparing against a pre-built lookup, but this is premature optimization given the 20-session cap.

- **`flushPendingFiles` sorts and iterates remaining pending messages** - `tmux-connector.ts:461-465` (Confidence: 60%) -- After the ordered delivery loop, remaining messages are sorted and force-delivered. The sort is O(k log k) where k is the gap count. With MAX_PENDING_MESSAGES=100 this is bounded and not a concern.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Performance Score**: 8/10
**Recommendation**: CHANGES_REQUESTED

The major architectural improvement in this diff -- replacing O(N) per-session `isAlive` syscalls with a single shared `listSessions()` call -- is a clear performance win. The async `readFile` migration on the hot message-handling path is also a good improvement. The blocking issue is the concurrent map mutation in `runSharedStalenessCheck`, which should be addressed before merge to avoid iterator corruption in edge cases (multiple stale sessions in one tick, or re-entrant spawn from `onExit` callbacks).
