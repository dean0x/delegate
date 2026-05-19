# Performance Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17

## Issues in Your Changes (BLOCKING)

### HIGH

**Synchronous file I/O on every message delivery** - `tmux-connector.ts:377-379`
**Confidence**: 90%
- Problem: `handleMessageFile` calls `readFileSyncFn` (which defaults to `fs.readFileSync`) inside the debounced `fs.watch` callback. This runs on the main Node.js event loop. Under high agent output rates (e.g., a chatty agent writing hundreds of lines per second), each message triggers a synchronous file read after the 50ms debounce window. While individual reads are fast (small JSON files), they block the event loop and cannot be parallelized or batched. With 20 concurrent sessions each producing output, this creates serialized blocking I/O on the event loop.
- Fix: This is acceptable for Phase 1 given the expected throughput profile (agent output is human-speed, not machine-speed). However, if this layer will be reused for high-throughput scenarios, consider switching to async `fs.promises.readFile`. The injectable `readFileSync` dep would need to become async. Flag this for Phase 2 if throughput requirements increase.

**Synchronous file I/O in flushPendingFiles blocks event loop during shutdown** - `tmux-connector.ts:302-310`
**Confidence**: 85%
- Problem: `flushPendingFiles` calls both `readdirSyncFn` and `readFileSyncFn` in a loop over all JSON files in the messages directory. During `dispose()` (process shutdown), this runs for every active session sequentially. With 20 sessions, each with potentially hundreds of message files, this creates a burst of synchronous I/O that blocks the event loop. The `dispose()` path iterates all sessions (line 276-282) calling `flushPendingFiles` per session.
- Fix: For a graceful shutdown path, blocking is often acceptable since no new work is expected. However, consider adding a bounded limit to the number of files read per flush (e.g., skip files already delivered based on `lastDeliveredSeq` filename prefix). The current code already skips delivered sequences at line 335 (`if (msg.sequence <= session.lastDeliveredSeq) continue`), but it still reads and parses every file to check. A filename-based filter before reading would reduce I/O:
  ```typescript
  const jsonFiles = files
    .filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'))
    .filter((f) => {
      const seqMatch = f.match(/^(\d+)-/);
      return seqMatch ? parseInt(seqMatch[1]!, 10) > session.lastDeliveredSeq : true;
    })
    .sort();
  ```

### MEDIUM

**N+1 shell exec pattern in createSession env var injection** - `tmux-session-manager.ts:123-130`
**Confidence**: 92%
- Problem: `createSession` calls `this.deps.exec()` once per environment variable inside a `for...of` loop. With the 2 auto-vars (`AUTOBEAT_TASK_ID`, `AUTOBEAT_SPAWN_TIME`) plus any caller-provided env vars, this spawns N+1 child processes (1 for the session + N for env vars). Each `exec` call spawns a shell process via `spawnSync`. With 5 env vars, that is 6 synchronous process spawns per `createSession` call.
- Fix: Batch environment variable injection into a single tmux command. tmux does not natively support setting multiple env vars in one call, but you can chain them in a single shell invocation:
  ```typescript
  const envCmds = Object.entries(allEnv)
    .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    .map(([key, value]) => {
      const quotedValue = `'${value.replace(/'/g, "'\\''")}'`;
      return `tmux set-environment -t ${config.name} ${key} ${quotedValue}`;
    });
  if (envCmds.length > 0) {
    this.deps.exec(envCmds.join(' && '));
  }
  ```
  This reduces N process spawns to 1.

**Regex creation on every env var key validation** - `tmux-session-manager.ts:125`
**Confidence**: 80%
- Problem: The regex `/^[A-Za-z_][A-Za-z0-9_]*$/` is created as a literal on every iteration of the env var loop. While V8 caches regex literals, moving it to a module-level constant is clearer and guarantees no re-compilation.
- Fix: Extract to a module constant alongside other validation patterns:
  ```typescript
  const POSIX_ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
  ```
  Then reference `POSIX_ENV_KEY_REGEX.test(key)` in both `createSession` (line 125) and `getSessionEnvironment` (line 246).

## Issues in Code You Touched (Should Fix)

### MEDIUM

**listSessions spawned on every createSession call** - `tmux-session-manager.ts:86`
**Confidence**: 85%
- Problem: `createSession` calls `this.listSessions()` to enforce the concurrent session cap. This spawns a `tmux list-sessions` process synchronously. Since `TmuxConnector` already tracks sessions in `activeSessions` Map, the connector could check `activeSessions.size >= maxConcurrentSessions` before calling `createSession`, avoiding the shell exec in most cases. The `listSessions` call is still needed as a safety net (other processes could create beat-* sessions), but it could be a secondary check or gated behind a threshold.
- Fix: In `TmuxConnector.spawn()`, add an early check before calling `createSession`:
  ```typescript
  if (this.activeSessions.size >= MAX_CONCURRENT_SESSIONS) {
    return err(tmuxSessionFailed('create', 'Concurrent session limit reached', {
      current: this.activeSessions.size,
      limit: MAX_CONCURRENT_SESSIONS,
    }));
  }
  ```
  The `listSessions` check in `TmuxSessionManager` remains as a defense-in-depth measure. This is a minor optimization since spawn is not a hot path, but it avoids an unnecessary process spawn in the common case.

## Pre-existing Issues (Not Blocking)

No pre-existing issues found. All files in this review are new.

## Suggestions (Lower Confidence)

- **debounceTimers Map unbounded within session lifetime** - `tmux-connector.ts:73-74` (Confidence: 65%) -- Each unique filename gets a key in `debounceTimers`. Timers are deleted after firing (line 171), so the map stays bounded in practice. However, if the wrapper generates unique filenames faster than the 50ms debounce window, the map could accumulate entries. Given the sequential naming scheme (`{SEQ:05d}-stdout.json`), each filename appears exactly once, so the map size equals at most the number of files written in a 50ms window. Not a practical concern at expected throughput.

- **Per-session staleness timer precision with 20 sessions** - `tmux-connector.ts:209` (Confidence: 60%) -- With 20 concurrent sessions, there are 20 independent `setInterval` timers at 30s intervals. Node.js handles this fine; `setInterval` is implemented with a single timer thread internally. No practical concern at this scale, but worth noting that if `MAX_CONCURRENT_SESSIONS` were raised significantly (hundreds), timer coalescing or a single shared timer loop would be more efficient.

- **Wrapper script flock contention under very high output rate** - `tmux-hooks.ts:75` (Confidence: 62%) -- The generated wrapper script uses `flock -x` on the sequence file for every line of output. Under extremely high output rates from the agent, this creates lock contention in the bash process. Not a concern at expected agent output rates (human-readable text at conversational speed).

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Performance Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The tmux abstraction layer has solid performance characteristics for its design envelope (up to 20 concurrent sessions with human-speed agent output). The synchronous file I/O is the primary concern but is acceptable for Phase 1 given the throughput profile. The N+1 exec pattern in env var injection is a concrete optimization opportunity. The MAX_PENDING_MESSAGES cap (100) correctly prevents unbounded memory growth. All watchers and timers have explicit cleanup paths through `closeSession()`, and `dispose()` reliably drains everything. No memory leaks detected in the watcher/timer lifecycle.

Conditions: Address the N+1 env var exec pattern (MEDIUM/Blocking) to reduce process spawn overhead. The sync I/O findings are flagged for awareness but acceptable for Phase 1.
