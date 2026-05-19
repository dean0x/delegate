# Performance Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17
**Commits reviewed**: 5ea7f99, 554b954, 76b7e70, 738730e, e5be200 (incremental from 40f9537)

## Issues in Your Changes (BLOCKING)

### HIGH

**restartSharedStalenessTimer() called on every triggerExit during batch stale detection** - `tmux-connector.ts:628`
**Confidence**: 85%
- Problem: When `runSharedStalenessCheck()` detects multiple stale sessions in a single tick (lines 444-446), it calls `triggerExit()` for each one. Each `triggerExit()` call invokes `restartSharedStalenessTimer()` (line 628), which does `stopSharedStalenessTimer()` + `clearInterval` + `setInterval` + iterates all remaining `activeSessions` to compute `Math.min()`. For N stale sessions detected in one tick, this is O(N) timer restarts, each iterating the remaining sessions -- O(N^2) total work. In practice N is bounded by `MAX_CONCURRENT_SESSIONS` (20), so this is unlikely to cause real degradation, but the pattern is wasteful.
- Fix: Defer the timer restart until after the stale batch loop completes. Either: (a) call `restartSharedStalenessTimer()` once after the `for` loop in `runSharedStalenessCheck()` if any stale entries were processed, or (b) extract the cleanup logic from `triggerExit` into a variant that skips the timer restart and call the restart once at the end.

```typescript
// In runSharedStalenessCheck(), after the stale loop:
for (const [taskId, session] of staleEntries) {
  this.triggerExit(taskId, session, null, 'STALE', session.callbacks);
}
// Add: single restart after all stale sessions processed
if (staleEntries.length > 0) {
  this.restartSharedStalenessTimer();
}
```

This requires `triggerExit` to conditionally skip its own `restartSharedStalenessTimer()` call when invoked from the batch path, or splitting the concern.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Array allocation on every staleness timer tick** - `tmux-connector.ts:393`
**Confidence**: 82%
- Problem: `restartSharedStalenessTimer()` creates a temporary array via `Array.from(this.activeSessions.values()).map(...)` to compute the minimum interval. This method is called every time a session spawns, exits, or is destroyed. The allocation itself is cheap for small N (bounded at 20), but the prior code used a simple `for` loop with a local variable which avoids the allocation entirely. The new code is slightly less efficient for the same result.
- Fix: Revert to the loop-based minimum computation to avoid the intermediate array allocation, or accept as-is given the small bound. The functional style is fine for bounded N.

```typescript
// Zero-allocation alternative (matches prior code):
let minInterval = Infinity;
for (const s of this.activeSessions.values()) {
  if (s.stalenessConfig.checkIntervalMs < minInterval) {
    minInterval = s.stalenessConfig.checkIntervalMs;
  }
}
minInterval = Math.max(minInterval, MIN_CHECK_INTERVAL_MS);
```

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Synchronous readFileSync in handleSentinel on fs.watch callback path** - `tmux-connector.ts:531`
**Confidence**: 85%
- Problem: `handleSentinel()` uses `readFileSyncFn()` to read the sentinel file content. This runs synchronously on the Node.js event loop, triggered by the `fs.watch` callback. While sentinel files are tiny (a few bytes -- just an exit code), synchronous I/O inside an event-driven callback is an anti-pattern that could block the event loop if the filesystem is slow (e.g., NFS, encrypted volumes). The message hot path correctly uses async reads (line 550).
- Fix: This is a pre-existing design choice documented in the code ("Sentinel and flush paths remain sync (one-shot on exit)"). The impact is negligible for local filesystems. No change required.

### MEDIUM

**flushPendingFiles uses synchronous readdirSync + readFileSync in a loop** - `tmux-connector.ts:473-490`
**Confidence**: 80%
- Problem: `flushPendingFiles()` calls `readdirSyncFn()` followed by `readFileSyncFn()` for each JSON file, all synchronously. This runs on the exit/destroy/dispose path. For sessions with many output files, this blocks the event loop for the duration of all file reads. However, this is intentional -- flush must complete before the exit callback fires, and making it async would introduce re-entrancy complexity.
- Fix: Acceptable tradeoff for correctness. The MAX_PENDING_MESSAGES cap (100) bounds the worst case. No change required unless session output volume grows significantly.

## Suggestions (Lower Confidence)

- **forceDeliverRemaining creates sorted array from Map entries** - `tmux-connector.ts:516` (Confidence: 65%) -- `Array.from(session.pendingMessages.entries()).sort(...)` allocates an intermediate array. At flush time with up to 100 pending messages this is negligible, but a heap/priority-queue would avoid the sort cost. Not worth optimizing at current scale.

- **Math.min(...intervals) with spread on empty array** - `tmux-connector.ts:394` (Confidence: 70%) -- If `activeSessions` were empty, `Math.min(...[])` returns `Infinity`, then `Math.max(Infinity, 1000)` returns `Infinity`, which would create a setInterval with Infinity ms (never fires). However, the guard `if (this.activeSessions.size === 0) return;` on line 389 prevents this. Safe as written.

- **restartSharedStalenessTimer in destroy() is redundant when session was already exited** - `tmux-connector.ts:203` (Confidence: 62%) -- When `destroy()` is called on an already-exited session (via sentinel/stale path), `triggerExit` already called `restartSharedStalenessTimer()`. The `destroy()` path guards with `if (session)` but the session may have already been removed from `activeSessions` by `triggerExit`. In that case the `if (session)` block is skipped entirely, so the restart doesn't execute. No issue.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | - |
| Should Fix | - | 0 | 1 | - |
| Pre-existing | - | - | 2 | 0 |

**Performance Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The changes improve performance safety significantly: the `MIN_CHECK_INTERVAL_MS` clamp prevents tight-loop timers, the stale-entry collection prevents mutation-during-iteration, and the async `.catch()` on `handleMessageFile` prevents unhandled rejections. The one blocking HIGH issue (repeated timer restarts during batch stale detection) is bounded by `MAX_CONCURRENT_SESSIONS=20` and unlikely to cause real-world degradation, but the fix is straightforward and worth addressing. Overall, the performance characteristics of this connector are sound for its design constraints.
