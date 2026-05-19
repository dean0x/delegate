# Performance Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17

## Issues in Your Changes (BLOCKING)

### MEDIUM

**listSessions() called on every createSession for admission control** - `tmux-session-manager.ts:77`
**Confidence**: 82%
- Problem: `createSession()` calls `listSessions()` (which shells out to `tmux list-sessions`) on every spawn for admission control. When spawning sessions in rapid succession (e.g., 10 tasks delegated at once), this produces 10 synchronous `exec()` calls that each fork a process just to count sessions. With MAX_CONCURRENT_SESSIONS = 20, this is far below pathological territory, but it is an extra shell fork per spawn.
- Impact: Under burst-spawn conditions (e.g., an orchestrator delegating 10+ tasks simultaneously), the extra shell forks serialize on the event loop since `exec` wraps `spawnSync`. At typical usage (1-5 spawns/min) this is negligible; at 20 simultaneous spawns it adds ~200ms cumulative latency.
- Fix: The connector already tracks `activeSessions.size` — it could pass the count into `createSession` or skip the tmux-level check when the in-memory count is under the limit. However, since the two are intentionally decoupled (session manager doesn't know about the connector), this is an acceptable trade-off for correctness. Consider caching the list result for a short window (e.g., 1 second) if burst-spawn becomes a measured issue.

**flushPendingFiles reads ALL message files from disk on exit** - `tmux-connector.ts:484-508`
**Confidence**: 83%
- Problem: On every session exit (including destroy, dispose, and stale detection), `flushPendingFiles` calls `readdirSync` then reads and parses every `.json` file in the messages directory. For a long-running agent that produced thousands of output lines, this means thousands of synchronous `readFileSync` + `JSON.parse` calls during shutdown.
- Impact: For a typical agent with 50-200 output lines, this completes in <50ms. For an agent that ran for hours and produced 5,000+ messages, this could block the event loop for 500ms+. The `dispose()` path is called during process shutdown so it is less impactful, but `triggerExit` (stale detection) is called from the event loop.
- Fix: The flush re-reads files that were already delivered (the `if (parsed.sequence <= session.lastDeliveredSeq) continue` guard handles dedup). Consider tracking delivered filenames in a Set and skipping them during flush, or only reading files with sequence numbers above `lastDeliveredSeq` (filenames already encode the sequence: `00001-stdout.json`). Example optimization:
  ```typescript
  const jsonFiles = files
    .filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'))
    .filter((f) => {
      const seq = parseInt(f.split('-')[0]!, 10);
      return !isNaN(seq) && seq > session.lastDeliveredSeq;
    })
    .sort();
  ```

## Issues in Code You Touched (Should Fix)

### LOW

**Debounce timer Map grows and shrinks per message file event** - `tmux-connector.ts:352-364`
**Confidence**: 80%
- Problem: Each unique filename that triggers a watch event gets a timer entry in `session.debounceTimers`. The entry is deleted after the 50ms debounce fires. Under normal conditions (sequential message writes), the Map holds at most 1-2 entries. However, if the agent produces a burst of output (e.g., 100 lines in <50ms), the Map temporarily holds 100 timer references. These are cleaned up promptly but the Map allocation pattern is suboptimal for high-throughput output.
- Impact: Minimal in practice. Each Map entry is a string key + timer reference (~100 bytes). Even 100 entries = 10KB, well within acceptable limits. The timers fire and entries are deleted within 50ms.
- Fix: Not required — documented here for awareness. If throughput becomes extreme, a single debounce timer per session (rather than per file) would reduce overhead, but at the cost of potentially batching more messages into a single read cycle.

## Pre-existing Issues (Not Blocking)

None identified. All code in these files is new to this branch.

## Suggestions (Lower Confidence)

- **Synchronous exec in staleness timer path** - `tmux-session-manager.ts:204` (Confidence: 65%) — `listSessions()` is called from the shared staleness `setInterval` callback. Since `exec` wraps `spawnSync`, this blocks the event loop for ~10-30ms per tick. At the default 30s interval this is negligible (0.03% duty cycle), but if a user configures `checkIntervalMs: 1000`, the duty cycle rises to ~3%. The current MIN_CHECK_INTERVAL_MS=1000 floor already guards against this.

- **No file deletion after message delivery** - `tmux-connector.ts:576-579` (Confidence: 62%) — Delivered message files remain on disk until `cleanup()` removes the entire session directory. For very long-running agents, this means the messages directory accumulates thousands of small files, which can slow down subsequent `readdirSync` calls during flush. Since cleanup always runs on exit, this is bounded by session lifetime.

- **restartSharedStalenessTimer called in destroy() even when session not stale** - `tmux-connector.ts:204` (Confidence: 60%) — Every `destroy()` call clears and recreates the interval timer. Under rapid sequential destroys (e.g., batch cancel of 10 sessions), this produces 10 `clearInterval` + `setInterval` cycles. The `skipTimerRestart` optimization exists for the stale batch path but not for explicit destroy. Impact is negligible (timer setup is ~microseconds).

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 1 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Performance Score**: 8/10
**Recommendation**: APPROVED

The tmux abstraction layer demonstrates strong performance awareness throughout:
- Push-based detection (fs.watch) eliminates polling overhead
- Shared staleness timer avoids O(N) concurrent process forks
- Bounded pending message buffer (MAX_PENDING_MESSAGES=100) prevents unbounded memory growth
- Debounce window prevents redundant filesystem reads
- Timer cleanup is thorough in all exit paths (destroy, dispose, triggerExit, closeSession)
- Async readFile on hot path, sync only on one-shot exit/flush paths
- Environment injection batched into single exec call

The two MEDIUM findings are real but not blocking: (1) the per-spawn `listSessions` shell-out is a correctness-first design choice that only matters under burst-spawn conditions, and (2) the flush path re-reads already-delivered files which could be optimized by leveraging the sequence-encoded filenames. Neither represents a regression or production risk at the current MAX_CONCURRENT_SESSIONS=20 scale.
