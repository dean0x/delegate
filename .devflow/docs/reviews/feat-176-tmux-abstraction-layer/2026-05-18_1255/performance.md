# Performance Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-18
**Reviewer focus**: Timer/interval cleanup, watcher cleanup, memory growth in long-running sessions, buffer accumulation, exec call frequency

## Issues in Your Changes (BLOCKING)

### HIGH

**Redundant `listSessions()` exec call on every spawn** - `tmux-session-manager.ts:81` + `tmux-connector.ts:151`
**Confidence**: 90%
- Problem: `TmuxConnector.spawn()` enforces the session cap at line 151 via `activeSessions.size`, then calls `sessionManager.createSession()` which immediately calls `listSessions()` at line 81 for its own concurrent-session limit check. `listSessions()` spawns a synchronous `tmux list-sessions` process. This means every spawn incurs two admission-control checks: one in-memory (O(1), correct) and one shelling out to tmux (synchronous exec, ~5-20ms). The connector-level check alone is sufficient since the connector is the sole owner of session lifecycle -- the session-manager-level check is defense-in-depth that doubles the exec cost on the hot spawn path.
- Fix: The session manager's limit check is architecturally reasonable as defense-in-depth, but it should accept an optional `skipAdmissionCheck` flag or the connector should pass its already-known count. Alternatively, accept this as a deliberate tradeoff (defense-in-depth at ~10ms cost) and document it with a `DESIGN DECISION` comment. Since spawn is not a high-frequency operation (max 20 sessions), this is HIGH not CRITICAL.

**Synchronous `readFileSync` in `flushPendingFiles` reads all undelivered files serially** - `tmux-connector.ts:530-573`
**Confidence**: 85%
- Problem: `flushPendingFiles` calls `readdirSyncFn` then loops over all JSON files calling `parseMessageFile` -> `readFileSyncFn` for each. With a chatty agent producing many messages, the flush path blocks the event loop for the duration of N sequential synchronous file reads. This runs on the exit/destroy/dispose path, meaning the event loop is blocked during shutdown for every session.
- Fix: This is a deliberate design choice (sync on exit path to guarantee delivery before teardown), which is a valid tradeoff. However, for sessions with hundreds of undelivered messages, the blocking duration could be significant. Consider adding a structured log with the file count and elapsed time so production monitoring can detect if this becomes a bottleneck:
  ```typescript
  const start = Date.now();
  // ... existing flush logic ...
  if (jsonFiles.length > 0) {
    this.deps.logger.info('Flush completed', {
      taskId: session.handle.taskId,
      filesRead: jsonFiles.length,
      elapsedMs: Date.now() - start,
    });
  }
  ```

### MEDIUM

**`pendingMessages` Map grows unbounded until MAX_PENDING_MESSAGES cap triggers** - `tmux-connector.ts:649-666`
**Confidence**: 82%
- Problem: When messages arrive out of order (e.g., sequence 5 arrives before 3 and 4), messages accumulate in `pendingMessages` Map. The safety cap at `MAX_PENDING_MESSAGES = 100` prevents true unbounded growth, but the gap-skip logic at lines 662-665 sorts all pending keys, resets `nextExpectedSeq` to the lowest, then re-runs `deliverPendingMessages`. If the gap is at the beginning, this re-delivery loop may still leave entries in the map (the gap after the lowest sequence is still a gap). The map is only fully drained by `forceDeliverRemaining` on exit.
- Fix: The cap at 100 messages is reasonable for bounding memory. However, the gap-skip logic should drain more aggressively -- after skipping, consider delivering all contiguous messages from the new `nextExpectedSeq` AND then force-delivering any remaining if the count is still above a lower watermark (e.g., 50). This prevents a pathological pattern where the map oscillates near the cap. Current behavior is safe but sub-optimal for throughput.

**`Array.from(...).sort()` allocation in `forceDeliverRemaining`** - `tmux-connector.ts:600`
**Confidence**: 80%
- Problem: `forceDeliverRemaining` converts the pending map to an array of entries, sorts it, then iterates. This allocates a full copy of the map contents. Called on every exit/destroy/dispose after `flushPendingFiles`.
- Fix: With `MAX_PENDING_MESSAGES = 100`, this is bounded to at most ~101 entries. The allocation is negligible at this scale. Note only for awareness -- no action needed unless `MAX_PENDING_MESSAGES` is raised significantly.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`restartSharedStalenessTimer()` called on every spawn and every exit** - `tmux-connector.ts:222,249,514,719`
**Confidence**: 82%
- Problem: Each spawn calls `restartSharedStalenessTimer()` which calls `stopSharedStalenessTimer()` (clearInterval) then `setInterval()`. When spawning N sessions rapidly (e.g., pipeline with 10 tasks), this creates and tears down the interval N times. Each restart iterates all active sessions to compute the minimum interval.
- Fix: The overhead is small (Map iteration over max 20 entries + one clearInterval + one setInterval), and the batch-stale path already uses `skipTimerRestart` to avoid O(N) churn. For rapid spawning, consider debouncing the restart or deferring it with `queueMicrotask` so multiple spawn calls in the same tick coalesce into a single timer restart:
  ```typescript
  private pendingTimerRestart = false;
  private scheduleTimerRestart(): void {
    if (this.pendingTimerRestart) return;
    this.pendingTimerRestart = true;
    queueMicrotask(() => {
      this.pendingTimerRestart = false;
      this.restartSharedStalenessTimer();
    });
  }
  ```

## Pre-existing Issues (Not Blocking)

No pre-existing performance issues identified in the touched files.

## Suggestions (Lower Confidence)

- **Debounce timer Map accumulation during high-frequency output** - `tmux-connector.ts:410-422` (Confidence: 70%) -- Each new fs.watch event for a message file creates a setTimeout entry in `debounceTimers`. If the same file fires rapidly, the old timer is cleared and a new one is created. For very chatty agents, the Map could have entries for many distinct filenames simultaneously. The 50ms debounce window bounds exposure, but with hundreds of files arriving within 50ms, the Map grows proportionally. Bounded by natural fs.watch rate limits.

- **`new Set()` allocation on every staleness tick** - `tmux-connector.ts:482` (Confidence: 65%) -- `runSharedStalenessCheck` creates `new Set(listResult.value.map(s => s.name))` on every tick (default 30s). The allocation is small (max 20 entries) and short-lived (GC'd after the function returns). Not worth optimizing but noted for completeness.

- **Synchronous `exec` for environment injection during `createSession`** - `tmux-session-manager.ts:165` (Confidence: 62%) -- `injectEnvironment` batches all env vars into a single `exec` call (good), but uses synchronous exec which blocks during the spawn path. The batch approach already avoids N+1 spawns. No action needed.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Performance Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The tmux abstraction layer demonstrates strong performance awareness throughout. The shared staleness timer (single `listSessions()` per tick instead of O(N) `isAlive()` calls), the `MAX_PENDING_MESSAGES` cap, the debounce on fs.watch events, the batch environment injection, and the `skipTimerRestart` optimization for batch stale detection all show deliberate performance thinking.

The two HIGH findings (redundant `listSessions` on spawn, sync I/O in flush) are bounded by the max session limit (20) and are on infrequent code paths (spawn and exit). The MEDIUM findings around timer restart churn and pending message drainage are optimizations worth considering but not blocking.

Conditions for approval:
1. Add a `DESIGN DECISION` comment on the double admission-control check (connector + session-manager) documenting the tradeoff, or eliminate the redundant `listSessions()` call
2. Add observability (structured log with count + elapsed) to `flushPendingFiles` so sync I/O duration is measurable in production
