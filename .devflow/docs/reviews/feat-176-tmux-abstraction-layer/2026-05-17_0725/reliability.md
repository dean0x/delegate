# Reliability Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17
**Focus**: Reliability (bug hunting pass 3 — sibling issues to prior findings)

## Issues in Your Changes (BLOCKING)

### HIGH

**fs.watch 'error' event not handled — watcher error crashes the process** - `tmux-connector.ts:251-260, 268-286`
**Confidence**: 90%
- Problem: `fs.watch()` emits an `'error'` event when the watched path is deleted or becomes inaccessible (e.g., session directory removed externally). The code assigns the return value of `this.deps.watch()` but never attaches an `'error'` listener. On Node.js, an unhandled `'error'` event on an EventEmitter throws, crashing the process. This is distinct from the try/catch around the initial `watch()` call — that only catches synchronous construction errors, not runtime errors emitted later.
- Impact: If the session directory is removed while the watcher is active (race between tmux cleanup and the OS), the process crashes with an uncaught error.
- Fix:
```typescript
session.sentinelWatcher = this.deps.watch(
  sessionDir,
  { persistent: false },
  (_eventType: string, filename: string | null) => { /* ... */ },
);
session.sentinelWatcher.on('error', (err) => {
  this.deps.logger.warn('Sentinel watcher error', { taskId, error: String(err) });
  // Degrade gracefully — staleness timer is the fallback
});
```
Same pattern needed for `session.messagesWatcher`.

---

**Staleness timer and sentinel watcher can race to both call triggerExit** - `tmux-connector.ts:302-330, 397-414`
**Confidence**: 82%
- Problem: Consider this sequence: (1) sentinel watcher fires `handleSentinel`, (2) `handleSentinel` calls `triggerExit`, (3) inside `triggerExit`, `session.exited = true` is set, `flushPendingFiles` begins. During the *synchronous* flush the staleness interval fires (possible if the event loop yields between microtasks). The `if (session.exited) return;` guard at line 302 protects against this. **However**, there is still a narrow window in `handleSentinel` itself: the `if (!session || session.exited) return` guard at line 399 checks the session is not exited, then proceeds to call `triggerExit`. But between the guard check at 399 and the `session.exited = true` at line 483, if the staleness timer fires on the same tick (Node single-threaded, so not truly concurrent — but `setInterval` callbacks can interleave with `fs.watch` callbacks in the same event loop turn if the interval fires while the microtask queue processes)... Actually, since Node.js is single-threaded and `setInterval`/`fs.watch` both fire as macrotasks, true interleaving within a single synchronous execution is impossible. The existing `if (session.exited) return` guard is sufficient.
- **Downgrade**: After careful analysis, the guard at line 478 (`if (session.exited) return`) in `triggerExit` is the definitive protection. Since JavaScript is single-threaded, no two macrotask callbacks can execute concurrently. This is NOT a real issue.
- Status: **DISMISSED** — false positive after deeper analysis.

---

**Sentinel file read can get a partial/empty file (mv atomicity not guaranteed on all FS)** - `tmux-connector.ts:403-410`
**Confidence**: 80%
- Problem: The wrapper script writes the sentinel via `echo > .tmp` then `mv .tmp .done`. On most POSIX systems, `mv` is atomic at the directory entry level. However, `fs.watch` may fire on the `rename` event before the file content is fully flushed (particularly on network filesystems or under heavy I/O pressure). `readFileSyncFn` could then read an empty string. `parseInt('', 10)` returns `NaN`, which triggers the `code = null` fallback. For `.done` sentinel this gives `code ?? 0 = 0` (correct). For `.exit` this gives `code ?? 1 = 1` (plausible default but may mask the real exit code).
- Impact: On rare occasions the real non-zero exit code from a `.exit` sentinel is lost and defaults to 1. This is a degraded but safe state.
- Fix: Add a brief retry (1-2 attempts with small delay) when the sentinel file is empty/unreadable, before falling back to null. Or log when the sentinel read fails so operators know the exit code was inferred.
```typescript
// Already handles null gracefully, but add observability:
let code: number | null = null;
try {
  const sentinelPath = path.join(sessionDir, filename);
  const raw = this.readFileSyncFn(sentinelPath, 'utf8').trim();
  code = parseInt(raw, 10);
  if (isNaN(code)) {
    this.deps.logger.warn('Sentinel file empty or unparseable — using default', { sentinelPath, raw });
    code = null;
  }
} catch {
  this.deps.logger.warn('Sentinel file unreadable — using default exit code', { filename });
}
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Wrapper script: `flock` failure is silent — sequence counter can produce duplicates under concurrency** - `tmux-hooks.ts:82`
**Confidence**: 82%
- Problem: The `flock -x 200 2>/dev/null || true` in `next_seq()` silently ignores lock failures. If `flock` is unavailable (macOS `flock` is not built-in; it requires Homebrew `util-linux`), two concurrent pipeline processes could race on the sequence file, producing duplicate sequence numbers. Duplicate sequences would cause `pendingMessages.set(seq, msg)` to overwrite, losing a message.
- Impact: On macOS without Homebrew `flock`, the locking is a no-op. Since the wrapper runs a single pipeline (`agent | while read`), concurrency within a single session is unlikely. But if this pattern is extended to multi-pipe setups, it becomes a real issue.
- Fix: Since this is a single-pipeline design, the risk is LOW in practice. Document the assumption explicitly, or use `mkdir`-based locking as a portable fallback:
```bash
next_seq() {
  local lockdir="$SEQ_FILE.lock.d"
  while ! mkdir "$lockdir" 2>/dev/null; do sleep 0.01; done
  trap 'rmdir "$lockdir"' RETURN
  SEQ=$(cat "$SEQ_FILE" 2>/dev/null || echo 0)
  SEQ=$((SEQ + 1))
  echo $SEQ > "$SEQ_FILE"
  printf "%05d" $SEQ
}
```

---

**dispose() does not call onExit for active sessions — consumers may wait indefinitely** - `tmux-connector.ts:220-237`
**Confidence**: 85%
- Problem: `dispose()` flushes messages and calls `closeSession()` + `destroySession()`, but never calls `callbacks.onExit()`. If a consumer is waiting for the `onExit` callback to finalize a task (e.g., mark it complete in the DB), `dispose()` leaves them hanging. Compare with `destroy()` which also skips `onExit` (by design — it's a user-initiated teardown). But `dispose()` is called on process shutdown; without an onExit signal, upstream state machines may record the task as still "running."
- Impact: Tasks that are in-flight when the MCP server shuts down may remain in a "running" state in the database until the staleness recovery mechanism in RecoveryManager kicks in on next boot.
- Fix: Consider calling `callbacks.onExit(null, 'DISPOSED')` after flush so upstream can distinguish "disposed on shutdown" from "still running." This is a design decision, but reliability argues for explicit finalization:
```typescript
for (const session of sessions) {
  session.exited = true;
  this.flushPendingFiles(session);
  this.closeSession(session);
  session.callbacks.onExit(null, 'DISPOSED'); // Signal upstream
  // ...destroySession...
}
```

## Pre-existing Issues (Not Blocking)

None identified.

## Suggestions (Lower Confidence)

- **debounceTimers map can grow with unique filenames before cleanup** - `tmux-connector.ts:284` (Confidence: 65%) — If a session produces thousands of unique message files very rapidly, the `debounceTimers` map grows to thousands of entries (one per file) before any are cleaned. Each entry is a small timer reference, so memory is bounded by message count, but the map is only cleared on exit/destroy. Not a practical concern given MAX_PENDING_MESSAGES=100 triggers gap-skip, but worth noting.

- **readdirSync in flush races with in-progress atomic mv** - `tmux-connector.ts:351` (Confidence: 62%) — `readdirSync` may see a `.json.tmp` file that is mid-rename to `.json`, or miss a `.json` file that hasn't finished its `mv` yet. The filter excludes `.tmp` files correctly, but a file could be in the directory listing as `.json` while its content is still the old `.tmp` content (fs-level race). The try/catch around readFileSync handles this gracefully (logs and continues), so this degrades to a missed message rather than a crash. The staleness timer or the gap-delivery mechanism does not recover these — they are silently dropped.

- **No upper bound on wrapper script output rate** - `tmux-hooks.ts:96-103` (Confidence: 60%) — If the agent produces output faster than `jq` + file I/O can process it, the bash pipeline buffers indefinitely in memory. This is bounded by the agent's output rate (which is external), but there is no backpressure mechanism. A very chatty agent could cause the tmux session's memory to grow.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Reliability Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The primary blocking issue is the missing `'error'` event handler on fs.watch instances. Without it, an external deletion of the session directory (or inotify limit exhaustion) crashes the Node.js process. The staleness timer provides a fallback for detection, but the crash itself is the problem. The other findings are lower severity but worth addressing for production hardening.
