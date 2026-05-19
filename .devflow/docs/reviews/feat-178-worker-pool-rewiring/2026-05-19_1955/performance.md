# Performance Review Report

**Branch**: feat/178-worker-pool-rewiring -> main
**Date**: 2026-05-19T19:55

## Issues in Your Changes (BLOCKING)

### HIGH

**killAll() serializes N blocking spawnSync calls before the 3s grace period** - `src/implementations/event-driven-worker-pool.ts:264-267`
**Confidence**: 85%
- Problem: `gracefulShutdownSession()` calls `this.tmuxConnector.isAlive(worker.handle)` at line 266, which delegates to `tmux has-session` via `spawnSync`. When `killAll()` launches N `kill()` calls via `Promise.all`, each one synchronously blocks the event loop for the `isAlive()` call *before* entering the async 3s grace period. With N workers, the event loop is blocked for N consecutive `spawnSync` calls (each ~5-20ms). For a typical 5-worker pool this is ~25-100ms of cumulative blocking -- tolerable. For 10+ workers this approaches 200ms+ of event loop stall before any grace period begins.
- Impact: Event loop latency spike proportional to worker count during `killAll()`. Heartbeat timers, output flushing, and other async operations are delayed.
- Fix: The pre-kill liveness check is an optimization (skip grace period for already-dead sessions), not a correctness requirement. For `killAll()` specifically, the cost/benefit shifts -- skipping the liveness check and proceeding directly to C-c + destroy would avoid N blocking calls. However, the current approach is a clear improvement over the old 20-iteration poll loop (reduced from up to 20 blocking syscalls per worker to 2), and the PR description explicitly calls this out as an intentional design choice. Consider batching: a single `tmux list-sessions` call (already used by the staleness timer) could determine liveness for all workers at once, then feed into per-worker shutdown logic.

### MEDIUM

**flushOutput() called synchronously during kill() blocks the shutdown path** - `src/implementations/event-driven-worker-pool.ts:241`
**Confidence**: 82%
- Problem: `kill()` at line 241 calls `await this.flushOutput(worker.taskId)` before entering the graceful shutdown sequence. `flushOutput()` reads from in-memory `OutputCapture` and writes to SQLite via `outputRepository.save()`. If the output buffer is large or the database is under write contention (WAL mode helps but doesn't eliminate this), the flush adds latency to every kill operation. In `killAll()` this is serialized per-worker (each `kill()` awaits its flush before starting the grace period).
- Impact: `killAll()` latency = sum of (flush time + 3s grace + post-grace isAlive check) for all workers, though the 3s grace periods overlap via Promise.all. The flush operations are sequential within each kill() but parallel across workers.
- Fix: This is defensive (Edge Case I -- don't lose output on kill). The cost is acceptable for correctness. No action needed unless profiling reveals flush times > 100ms in practice.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Recovery manager calls isAlive() serially for each worker registration** - `src/services/recovery-manager.ts:187-210`
**Confidence**: 83%
- Problem: `cleanDeadWorkerRegistrations()` iterates all worker registrations and calls `this.isWorkerAlive(reg)` for each one. For tmux workers (pid=0), this calls `isAlive()` which is a `spawnSync('tmux has-session ...')` call. Each call blocks the event loop for ~5-20ms. With N stale worker registrations (common after a crash), this produces N sequential blocking calls at startup.
- Impact: Startup recovery time increases linearly with stale worker count. For 10 stale workers, expect ~50-200ms of event loop blocking during recovery. This runs once at startup, not on the hot path, so the impact is bounded.
- Fix: Replace the serial `isAlive()` loop with a single `listSessions()` call (already available on `TmuxSessionManagerCorePort`) to get all live sessions, then check each registration against the resulting Set. This matches the pattern already used by `runSharedStalenessCheck()` in TmuxConnector. The interface would need `listSessions()` added to `TmuxSessionManagerCorePort`.

```typescript
// Current: N blocking spawnSync calls
for (const reg of allWorkers.value) {
  if (!this.isWorkerAlive(reg)) { ... }
}

// Suggested: 1 blocking call + N Map lookups
const liveSessions = this.tmuxSessionManager
  ? new Set(this.tmuxSessionManager.listSessions().ok
    ? this.tmuxSessionManager.listSessions().value.map(s => s.name) : [])
  : new Set<string>();

for (const reg of allWorkers.value) {
  const alive = reg.pid === 0
    ? (reg.sessionName ? liveSessions.has(reg.sessionName) : false)
    : this.isProcessAlive(reg.ownerPid);
  if (!alive) { ... }
}
```

## Pre-existing Issues (Not Blocking)

### MEDIUM

**spawnSync with shell: true for every tmux operation** - `src/bootstrap.ts:508-511`
**Confidence**: 80%
- Problem: The shared `tmuxExec` function uses `spawnSync(cmd, { shell: true, ... })`. Every tmux operation (isAlive, sendKeys, createSession, destroySession, listSessions, sendControlKeys) goes through this path, which spawns a shell process to interpret the command. The `shell: true` option adds ~2-5ms overhead per call compared to `shell: false` with explicit argument arrays.
- Impact: Low per-call, but multiplied by all tmux operations. The staleness timer calls `listSessions()` every 30s (1 call), heartbeat removal eliminated the per-worker isAlive calls, and kill flow uses 2-3 calls per worker. The aggregate impact is modest.
- Fix: Pre-existing design decision documented in tmux-session-manager. The `shell: true` is needed for compound commands (e.g., chained `set-environment` calls in `injectEnvironment`). Splitting into `shell: true` for compound commands and `shell: false` with argument arrays for simple single-command calls would reduce overhead. Not blocking -- this is an optimization for a future PR.

## Suggestions (Lower Confidence)

- **Double isAlive() in gracefulShutdownSession** - `src/implementations/event-driven-worker-pool.ts:266,289` (Confidence: 70%) -- The method calls `isAlive()` twice: once before C-c (line 266) and once after the 3s wait (line 289). The first check is an optimization to skip the grace period for dead sessions. Both calls are blocking spawnSync. If the session is known to be alive (e.g., just received output), the first check could be skipped. However, the current approach is correct and the optimization is marginal (saves 1 spawnSync per kill for sessions that are still alive).

- **Promise.all in killAll() with 3s grace overlap** - `src/implementations/event-driven-worker-pool.ts:321` (Confidence: 65%) -- `killAll()` launches all kill() calls in parallel via `Promise.all`. Each kill() has a 3s `setTimeout` grace period. Because all promises start concurrently, all 3s waits overlap -- total wall time is ~3s regardless of worker count. This is a correct and performant design. The only concern is that all workers simultaneously resume after the 3s wait and issue concurrent `isAlive()` spawnSync calls, which will serialize on the event loop. For typical pool sizes (< 10) this is fine.

- **getWorkers() creates frozen array copy on every call** - `src/implementations/event-driven-worker-pool.ts:344` (Confidence: 62%) -- `Object.freeze(Array.from(this.workers.values()))` creates a new array and freezes it on every call. If called frequently (e.g., dashboard polling), this allocates per call. Pre-existing pattern, and the workers Map is typically small (< 10 entries).

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Performance Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The PR represents a significant performance improvement over the previous implementation:
- Removed isAlive() from the heartbeat loop (was N blocking spawnSync per tick, now 0)
- Replaced 20-iteration poll loop in kill() with single 3s wait + 1 isAlive check (from up to 20 blocking syscalls to 2)
- Shared staleness timer uses 1 listSessions() call for all workers instead of N individual isAlive() calls
- Backpressure guard on output flushing prevents concurrent flush storms
- Timer.unref() on all timers prevents keeping the process alive unnecessarily

The HIGH-severity item (killAll serializing N isAlive calls) is a minor regression relative to the staleness timer's batched approach but a major improvement over the old poll loop. The MEDIUM items are optimization opportunities, not correctness issues. The recovery manager serial isAlive pattern should be addressed to maintain consistency with the batched approach used elsewhere in the tmux layer.
