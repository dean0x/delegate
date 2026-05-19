# Performance Review Report

**Branch**: feat-176-tmux-abstraction-layer -> main
**Date**: 2026-05-17

## Issues in Your Changes (BLOCKING)

### HIGH

**Unbounded `deliveredSequences` Set — memory grows monotonically per session** - `src/implementations/tmux/tmux-connector.ts:60,308-309,329`
**Confidence**: 92%
- Problem: The `deliveredSequences: Set<number>` accumulates every sequence number ever delivered for the lifetime of a session. Unlike `pendingMessages` which has a `MAX_PENDING_MESSAGES` cap, `deliveredSequences` grows without bound. For long-running agent sessions producing thousands of output lines, this set will consume memory that is never reclaimed until session exit.
- Impact: A Claude Code agent session producing 10,000 lines of output accumulates a 10,000-entry Set. While each entry is small (8 bytes for a number), the real concern is that the set's purpose (deduplication) is only needed for out-of-order messages near the delivery frontier — old sequences will never arrive again.
- Fix: Since `nextExpectedSeq` advances monotonically, any message with `sequence < nextExpectedSeq` is already delivered by definition. Replace the unbounded Set with a simple comparison:
  ```typescript
  // Replace deliveredSequences.has(msg.sequence) check with:
  if (msg.sequence < session.nextExpectedSeq) continue; // Already delivered
  ```
  This eliminates the Set entirely — `nextExpectedSeq` already encodes "everything below this was delivered."

**`listSessions()` exec on every `createSession()` — O(n) shell spawns per session creation** - `src/implementations/tmux/tmux-session-manager.ts:86`
**Confidence**: 85%
- Problem: `createSession()` calls `listSessions()` which spawns `tmux list-sessions` via `spawnSync` on every session creation. This is a synchronous shell invocation (process fork + exec) just to count active sessions for the concurrency limit check.
- Impact: With 20 concurrent sessions (the MAX_CONCURRENT_SESSIONS limit), each `createSession` call parses all sessions, running a regex test per line. The shell spawn itself is ~5-10ms on macOS, which is negligible for infrequent calls. However, burst session creation (e.g., orchestrator spawning multiple tasks) serializes these sync calls.
- Fix: Track active session count internally and validate against the limit without spawning a process. The connector already maintains `activeSessions` Map. Alternative: cache the list result with a short TTL (similar to the validator cache pattern).
  ```typescript
  // In TmuxSessionManager, track count internally:
  private activeCount = 0;
  
  createSession(config: ...): Result<...> {
    if (this.activeCount >= this.maxConcurrentSessions) {
      return err(tmuxSessionFailed('create', `Concurrent session limit reached...`));
    }
    // ... create session ...
    this.activeCount++;
    return ok(handle);
  }
  
  destroySession(name: string): Result<...> {
    // ... destroy session ...
    this.activeCount = Math.max(0, this.activeCount - 1);
    return ok(undefined);
  }
  ```

### MEDIUM

**Synchronous `readFileSync` in fs.watch callbacks blocks the event loop** - `src/implementations/tmux/tmux-connector.ts:267,284`
**Confidence**: 82%
- Problem: `handleSentinel()` and `handleMessageFile()` both use `readFileSyncFn` (which defaults to `fs.readFileSync`) inside fs.watch callbacks. These callbacks execute on the main event loop. If multiple sessions emit messages simultaneously, the synchronous reads serialize and block the event loop.
- Impact: Each message file is small (one JSON line), so individual reads are fast (~0.1ms). The concern scales with concurrent sessions: 20 sessions emitting messages simultaneously could stack 20 sync reads. In practice, the 50ms debounce staggers these, mitigating the worst case. Severity is MEDIUM because the files are tiny and debounce helps, but the pattern prevents optimal concurrency.
- Fix: Use `fs.promises.readFile` and make the handler async, or accept this as a deliberate design tradeoff documented in the DESIGN DECISION comment (sync simplifies ordering guarantees). If keeping sync, add a comment noting the tradeoff:
  ```typescript
  // DESIGN DECISION: Sync reads are intentional here — message files are small
  // (<1KB) and sync delivery preserves strict sequence ordering without
  // additional queuing complexity. Acceptable for up to 20 concurrent sessions.
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Staleness timer fires `isAlive` exec even after sentinel-based exit** - `src/implementations/tmux/tmux-connector.ts:190-214`
**Confidence**: 80%
- Problem: The staleness `setInterval` calls `sessionManager.isAlive()` (which spawns `tmux has-session`) at the configured interval (default 30s). When a session exits via sentinel detection, `triggerExit` sets `session.exited = true` and calls `closeSession` which clears the timer. However, there is a window between sentinel file write and the debounced watcher firing (50ms) during which the staleness timer could fire and spawn an unnecessary `tmux has-session` process.
- Impact: Minimal — one extra shell spawn in a 50ms race window is negligible. But the `if (session.exited)` guard at line 191 already handles this, making it correct. The broader concern is that `checkIntervalMs` defaults to 30s while `maxSilenceMs` defaults to 60s, meaning it takes at minimum 60s after a silent crash to detect staleness — two full interval cycles. This is acceptable for a safety net but worth noting.
- Fix: No code change needed — the guard is correct. Consider documenting that detection latency for silent crashes is `checkIntervalMs + maxSilenceMs` in the worst case (90s default).

## Pre-existing Issues (Not Blocking)

No pre-existing performance issues identified in the changed files.

## Suggestions (Lower Confidence)

- **Wrapper script `jq` invocation per output line** - `src/implementations/tmux/tmux-hooks.ts:78` (Confidence: 70%) — The generated bash script pipes every stdout line through `jq -Rs .` for JSON escaping. For agents producing thousands of lines, this forks a new `jq` process per line. A pure-bash escaping approach (printf with %q or sed) would avoid the process overhead, though `jq` is more correct for all Unicode.

- **`Array.from().sort()` in overflow path allocates unnecessarily** - `src/implementations/tmux/tmux-connector.ts:323` (Confidence: 65%) — When the pending buffer overflows (>100 messages), `Array.from(session.pendingMessages.keys()).sort()` allocates an intermediate array. Given this is an exceptional path (gap that will never fill), the allocation is acceptable, but `Math.min(...session.pendingMessages.keys())` avoids the sort.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Performance Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The architecture is sound — push-based fs.watch with debounce, capped pending buffer (100 messages per FEATURE_KNOWLEDGE spec), and staleness safety net are all well-designed. The two HIGH findings are: (1) `deliveredSequences` Set growing without bound when `nextExpectedSeq` already encodes the same information (simple fix — remove the Set), and (2) unnecessary shell spawn on every `createSession` for limit enforcement (can track count internally). The sync I/O in fs.watch callbacks is acceptable given file sizes and debounce, but should be documented as an intentional tradeoff.
