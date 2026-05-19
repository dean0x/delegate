# Performance Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17

## Issues in Your Changes (BLOCKING)

### HIGH

**Synchronous flush I/O blocks the event loop during dispose() with 20 sessions** - `tmux-connector.ts:218-237`
**Confidence**: 85%
- Problem: `dispose()` iterates all active sessions sequentially, calling `flushPendingFiles()` (sync `readdirSync` + N x `readFileSync`) + `destroySession()` (sync `spawnSync` to tmux) + `loggedCleanup()` (sync `rmSync`) for each session. With the MAX_CONCURRENT_SESSIONS cap of 20, worst case is 20 x (readdirSync + N readFileSync + spawnSync for kill-session + rmSync) — all blocking the event loop.
- Impact: At 20 concurrent sessions with substantial output files, `dispose()` could block the Node.js event loop for hundreds of milliseconds to seconds. During this time, no other async operations (including the MCP server's request handling) can proceed.
- Fix: This is acceptable for a process-shutdown path where `dispose()` is called once. However, if `dispose()` is ever called during normal operation (e.g., graceful degradation), consider batching the `destroySession` calls into a single `tmux kill-session -t s1 \; kill-session -t s2 ...` command to reduce the number of sync exec invocations from O(N) to O(1).

```typescript
// Current: O(N) exec calls
for (const session of sessions) {
  this.deps.sessionManager.destroySession(session.handle.sessionName);
}

// Alternative for non-shutdown paths: batch into single tmux command
const names = sessions.map(s => s.handle.sessionName);
const batchCmd = names.map(n => `tmux kill-session -t ${n}`).join(' ; ');
this.deps.exec(batchCmd);
```

**Sync exec admission control in createSession blocks event loop on every spawn** - `tmux-session-manager.ts:77`
**Confidence**: 82%
- Problem: Every `createSession()` call invokes `listSessions()` which shells out synchronously to `tmux list-sessions`. This is the admission-control gate for the concurrent session limit. Combined with the session creation exec and the env var injection exec, each spawn performs 2-3 synchronous subprocesses.
- Impact: Each `spawnSync` call blocks the event loop for ~5-50ms depending on system load and tmux state. For rapid sequential spawns (e.g., a pipeline creating 10 tasks), this accumulates to 100-500ms of event loop blocking. The MCP server cannot process other requests during this window.
- Fix: The design decision comment explains the rationale (synchronous exec so callers control async boundaries). This is a conscious architectural choice. For the current use case (spawn is infrequent relative to output streaming), the impact is low. If spawn frequency increases, consider caching `listSessions()` results with a short TTL (e.g., 1 second) rather than querying tmux on every spawn.

```typescript
// Potential optimization if spawn frequency increases:
private sessionListCache: { result: Result<TmuxSessionInfo[]>; expiresAt: number } | null = null;

listSessions(): Result<TmuxSessionInfo[], AutobeatError> {
  const now = Date.now();
  if (this.sessionListCache && now < this.sessionListCache.expiresAt) {
    return this.sessionListCache.result;
  }
  const result = this.listSessionsUncached();
  this.sessionListCache = { result, expiresAt: now + 1000 };
  return result;
}
```

### MEDIUM

**debounceTimers Map grows proportionally to unique filenames without bound within a session** - `tmux-connector.ts:340-351`
**Confidence**: 83%
- Problem: Each unique filename creates an entry in `session.debounceTimers`. The entry is deleted when the timer fires (line 343: `session.debounceTimers.delete(filename)`), but if new files arrive faster than the 50ms debounce window settles, the map grows. With rapid output (e.g., a busy agent producing hundreds of lines per second), each line creates a unique filename (`00001-stdout.json`, `00002-stdout.json`, ...) so the map holds at most ~50ms worth of filenames at any time.
- Impact: At worst, a few dozen entries during a burst. This is bounded by the debounce window (50ms) and is not a real unbounded growth issue. The `closeSession()` method (line 672-675) clears the map as a safety net.
- Fix: No fix needed. The effective bound is `(messages_per_second * 0.05)` entries. Documented here for completeness.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**forceDeliverRemaining sorts the entire pendingMessages map on every flush** - `tmux-connector.ts:513-520`
**Confidence**: 80%
- Problem: `forceDeliverRemaining()` converts the pending messages Map to an array, sorts it, then iterates. This is O(n log n) on the pending buffer size. With MAX_PENDING_MESSAGES capped at 100, the worst case is sorting 100 entries — trivial.
- Impact: Negligible. 100 entries sorted is sub-microsecond. The cap prevents this from ever becoming a real issue.
- Fix: No fix needed. The MAX_PENDING_MESSAGES=100 cap effectively bounds this operation. Documented here for completeness.

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Staleness timer calls listSessions via synchronous exec on every tick** - `tmux-connector.ts:392,403` (Confidence: 70%) -- The shared staleness timer calls `listSessions()` (sync exec to `tmux list-sessions`) at the minimum `checkIntervalMs` (default 30s, floor 1s). At 1s interval with 20 sessions, this is one `spawnSync` call per second, which is acceptable. If the floor were lowered below 1s, this could become tight-loop blocking. The MIN_CHECK_INTERVAL_MS=1000 floor guards against this.

- **flushPendingFiles reads all JSON files from disk synchronously on exit** - `tmux-connector.ts:480-497` (Confidence: 65%) -- The sync I/O in flush is intentional (documented: "Sentinel and flush paths remain sync (one-shot on exit)"). For agents producing thousands of output files, this could briefly stall the event loop. However, since flush only runs once per session exit and most files will already have been delivered via the async hot path, the number of files to read is typically small (just those in the debounce window).

- **createSession admission control has TOCTOU race** - `tmux-session-manager.ts:77-86` (Confidence: 72%) -- The `listSessions()` check followed by `createSession()` has a time-of-check/time-of-use gap: two concurrent `spawn()` calls could both pass the admission check and exceed the limit by 1. With the current sequential architecture (single Node.js event loop, sync exec), this cannot actually happen. If spawn ever becomes async, this gap would need an atomic check-and-create.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Performance Score**: 8/10
**Recommendation**: APPROVED

**Rationale**: The tmux abstraction layer demonstrates strong performance awareness throughout:
- The hot path (message handling) correctly uses async I/O via `readFile`
- The shared staleness timer avoids O(N) concurrent syscalls by using a single `listSessions()` call
- The debounce window prevents fs.watch double-fire storms
- The MAX_PENDING_MESSAGES cap prevents unbounded memory growth
- The MIN_CHECK_INTERVAL_MS floor prevents tight-loop timers
- All timer/interval resources are properly cleaned up on all exit paths (destroy, dispose, triggerExit)
- All fs.watch watchers are closed in `closeSession()` which is called from every exit path

The two HIGH findings are architectural observations about synchronous I/O blocking during spawn and dispose. Both are acceptable for the current use case (spawn is infrequent, dispose is once at shutdown) and are explicitly documented design decisions. No CRITICAL performance bugs found. Timer and watcher cleanup is thorough and correct across all code paths.
