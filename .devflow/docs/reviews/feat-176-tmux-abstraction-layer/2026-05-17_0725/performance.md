# Performance Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17

## Issues in Your Changes (BLOCKING)

### HIGH

**Synchronous readFileSync in debounced message handler blocks the event loop** - `src/implementations/tmux/tmux-connector.ts:422`
**Confidence**: 85%
- Problem: `handleMessageFile` is invoked from a setTimeout callback (debounce timer). It calls `this.readFileSyncFn(filePath, 'utf8')` which resolves to `fs.readFileSync` in production. With 20 concurrent sessions, each producing output, the event loop is blocked on every message file read. At sustained output (e.g., Claude streaming), this creates back-pressure on all other sessions' callbacks and timers.
- Impact: With 20 sessions producing output concurrently, the worst case is 20 synchronous file reads queuing up within a single event loop turn (multiple debounce timers fire in the same macrotask batch). Each read is typically <1ms for small JSON, but under disk contention or NFS/network mounts this could spike. The real issue is that it serializes I/O that could be parallel.
- Fix: Replace with async readFile in the message handler path (it is already in an async-friendly context via setTimeout). The sentinel handler and flush paths can remain sync since they are one-shot on exit.

```typescript
// Current (sync in timer callback — blocks event loop)
const raw = this.readFileSyncFn(filePath, 'utf8');

// Suggested: inject an async readFile for the hot path
private async handleMessageFile(filePath: string, session: ActiveSession, callbacks: SpawnCallbacks): Promise<void> {
  if (session.exited) return;
  try {
    const raw = await this.readFileFn(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    // ... rest unchanged
  } catch { ... }
}
```

---

**Staleness timer spawns a synchronous process every 30s PER session — 20 sessions = 20 spawnSync calls every 30s** - `src/implementations/tmux/tmux-connector.ts:300-304`
**Confidence**: 82%
- Problem: Each session gets its own `setInterval` that calls `this.deps.sessionManager.isAlive(session.handle.sessionName)`, which resolves to `spawnSync('tmux has-session -t ...')`. With 20 concurrent sessions, this means 20 synchronous child process spawns every 30 seconds. Each `spawnSync` blocks the event loop for ~5-15ms (process fork + exec + wait), meaning ~100-300ms of total event loop blocking per staleness cycle.
- Impact: During the staleness check window, no callbacks, timers, or I/O events can be processed. With 20 sessions, this creates periodic 100-300ms pauses in the event loop every 30 seconds. This is measurable latency that affects message delivery timeliness for all sessions.
- Fix: Batch staleness checks into a single `tmux list-sessions` call on a shared timer, then check session presence from the result. This replaces N spawnSync calls with 1.

```typescript
// Current: N independent timers, each spawning a process
session.stalenessTimer = setInterval(() => {
  const aliveResult = this.deps.sessionManager.isAlive(session.handle.sessionName);
  // ...
}, stalenessConfig.checkIntervalMs);

// Suggested: single shared timer that lists once, checks all sessions
private startSharedStalenessTimer(intervalMs: number): void {
  this.sharedStalenessTimer = setInterval(() => {
    const listResult = this.deps.sessionManager.listSessions(); // 1 spawnSync
    if (!listResult.ok) return;
    const aliveNames = new Set(listResult.value.map(s => s.name));
    for (const [taskId, session] of this.activeSessions) {
      if (session.exited) continue;
      const alive = aliveNames.has(session.handle.sessionName);
      // ... same stale logic, but only 1 process spawn total
    }
  }, intervalMs);
}
```

### MEDIUM

**listSessions() called on every createSession — synchronous process spawn as admission control** - `src/implementations/tmux/tmux-session-manager.ts:77`
**Confidence**: 80%
- Problem: `createSession` calls `this.listSessions()` to enforce the concurrent session limit. This runs `tmux list-sessions` via `spawnSync`. While spawn is a one-time cost per session creation (not a hot path), rapid session creation (e.g., a pipeline spawning 10 tasks simultaneously) means 10 sequential spawnSync calls just for admission control, each blocking ~10ms.
- Impact: ~100ms of event loop blocking when creating 10 sessions in rapid succession. Not a steady-state concern, but a burst-creation latency spike.
- Fix: Consider caching the session count (increment on create, decrement on destroy) and using `listSessions` only as periodic correction. Or accept this as a conscious trade-off for simplicity — the session creation path is already synchronous by design.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**flushPendingFiles reads ALL message files synchronously on exit — blocks event loop proportional to session output volume** - `src/implementations/tmux/tmux-connector.ts:339-395`
**Confidence**: 82%
- Problem: `flushPendingFiles` calls `readdirSync` then iterates ALL json files calling `readFileSync` for each. For a long-running session with hundreds of message files, this could block the event loop for tens of milliseconds. Called from `dispose()` which iterates ALL sessions, the total blocking is O(sessions * messages_per_session).
- Impact: During graceful shutdown (`dispose()`), if 20 sessions each have 50+ unread message files, this could block for 1-2 seconds. Since this is shutdown-only and ordering correctness requires synchronous reads, this is acceptable — but worth noting for very high-output workloads.
- Fix: This is acceptable for a shutdown path. However, document the trade-off: flush is intentionally sync because it guarantees message ordering before onExit fires. For `triggerExit` (called mid-operation), consider reading only files newer than `lastDeliveredSeq` rather than all files.

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Debounce timers accumulate per filename — Map never shrinks between flushes** - `src/implementations/tmux/tmux-connector.ts:278-284` (Confidence: 65%) — The `debounceTimers` Map grows with each unique filename seen, though entries are deleted when the timer fires. Under normal operation this is bounded by message rate * 50ms. Only problematic if fs.watch fires for the same filename many times faster than the 50ms debounce settles (unlikely in practice).

- **Per-session interval timers are not phase-offset — all 20 may fire in the same event loop tick** - `src/implementations/tmux/tmux-connector.ts:300` (Confidence: 70%) — If 20 sessions are spawned within a short window, their 30s intervals will be roughly synchronized and their spawnSync calls will cluster in the same event loop turn, amplifying the blocking effect. Adding a random jitter (e.g., `30_000 + Math.random() * 5000`) would spread the load.

- **Batched env var injection command string could exceed shell ARG_MAX for many vars** - `src/implementations/tmux/tmux-session-manager.ts:120-127` (Confidence: 62%) — The `&&`-joined command string for env var injection grows linearly with the number of env vars and their value lengths. With many large env vars this could theoretically exceed shell command length limits, though in practice Autobeat injects only 2-3 auto vars plus user-provided ones.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Performance Score**: 6/10
**Recommendation**: CHANGES_REQUESTED

The two HIGH-severity blocking issues (synchronous I/O on the message delivery hot path, and per-session spawnSync staleness checks) will cause measurable event loop blocking with 20 concurrent sessions. The per-session staleness timer pattern is the more impactful of the two — it creates periodic 100-300ms pauses that affect all session callbacks. Both have clear fixes: async readFile for the message handler, and a shared single-process staleness check that batches all 20 sessions into one `tmux list-sessions` call.
