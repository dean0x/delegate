# Reliability Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17

## Issues in Your Changes (BLOCKING)

### HIGH

**Wrapper script `flock` unavailable on macOS — sequence counter unprotected** - `src/implementations/tmux/tmux-hooks.ts:84`
**Confidence**: 90%
- Problem: The generated wrapper script uses `flock -x 200 2>/dev/null || true` for atomic sequence number increments. `flock` is a Linux-only utility (part of `util-linux`). On macOS (the primary development platform per `darwin` in env), `flock` silently fails and the `|| true` swallows the error, leaving the sequence file unprotected against concurrent writes. While the single-pipeline design makes concurrent `next_seq()` calls unlikely today, this is a latent correctness bug: if the wrapper is ever extended to support multiple output sources (stderr as a separate stream, or communication targets writing back), interleaved `cat + echo > $SEQ_FILE` operations will produce duplicate or skipped sequence numbers, leading to message reordering or loss.
- Fix: Use a cross-platform atomic increment. Since each wrapper script runs a single pipeline today, the simplest fix is to document the single-writer assumption with an assertion and remove the false sense of safety from the no-op flock:
```bash
# Option A: Remove flock, document single-writer assumption
next_seq() {
  # DESIGN: Single writer (one pipeline per wrapper), no lock needed.
  SEQ=$(cat "$SEQ_FILE" 2>/dev/null || echo 0)
  SEQ=$((SEQ + 1))
  echo $SEQ > "$SEQ_FILE"
  printf "%05d" $SEQ
}

# Option B: Cross-platform lock via mkdir (works on macOS + Linux)
next_seq() {
  local lockdir="$SEQ_FILE.lock"
  while ! mkdir "$lockdir" 2>/dev/null; do :; done
  trap 'rmdir "$lockdir"' EXIT
  SEQ=$(cat "$SEQ_FILE" 2>/dev/null || echo 0)
  SEQ=$((SEQ + 1))
  echo $SEQ > "$SEQ_FILE"
  rmdir "$lockdir"
  trap - EXIT
  printf "%05d" $SEQ
}
```

**`destroy()` always calls `sessionManager.destroySession` even for unknown handles** - `src/implementations/tmux/tmux-connector.ts:200`
**Confidence**: 85%
- Problem: When `destroy(handle)` is called with a handle whose `taskId` is not in `activeSessions` (e.g., after a sentinel-triggered exit already cleaned it up, or with a fabricated handle), the method skips internal cleanup but still calls `this.deps.sessionManager.destroySession(handle.sessionName)`. Since `destroySession` is idempotent for "not found" cases, this is not a crash. However, it means any caller with any `TmuxHandle` object can destroy any tmux session matching the session name pattern, even one not managed by this connector instance. In a multi-connector scenario (or in tests sharing a tmux server), this can destroy another connector's session.
- Fix: Return early with `ok(undefined)` when the session is not tracked, or guard the destroy call:
```typescript
destroy(handle: TmuxHandle): Result<void, AutobeatError> {
  const session = this.activeSessions.get(handle.taskId);
  if (!session) {
    // Session already cleaned up (sentinel exit, prior destroy, or unknown handle).
    // Do NOT call sessionManager.destroySession — this handle may not belong to us.
    return ok(undefined);
  }
  session.exited = true;
  this.flushPendingFiles(session);
  this.closeSession(session);
  this.activeSessions.delete(handle.taskId);
  this.restartSharedStalenessTimer();
  this.loggedCleanup('destroy', handle.taskId, handle.sessionsDir);
  return this.deps.sessionManager.destroySession(handle.sessionName);
}
```

### MEDIUM

**`dispose()` does not call `onExit` for active sessions** - `src/implementations/tmux/tmux-connector.ts:218-237`
**Confidence**: 85%
- Problem: `dispose()` flushes pending output and destroys tmux sessions, but never calls `callbacks.onExit()` for any of the active sessions. Callers waiting for an `onExit` signal (e.g., to update task state from RUNNING to COMPLETED/FAILED) will never receive it during a process shutdown. The session's `exited` flag is set to `true`, preventing any later staleness-triggered exit, so the callback is permanently lost. This means tasks may remain stuck in RUNNING state in the database after a graceful server shutdown.
- Fix: Call `callbacks.onExit` with a shutdown-specific signal for each session during dispose:
```typescript
dispose(): void {
  const sessions = Array.from(this.activeSessions.values());
  this.activeSessions.clear();
  this.stopSharedStalenessTimer();
  for (const session of sessions) {
    session.exited = true;
    this.flushPendingFiles(session);
    this.closeSession(session);
    // Notify callers so they can transition task state
    session.callbacks.onExit(null, 'SHUTDOWN');
    const result = this.deps.sessionManager.destroySession(session.handle.sessionName);
    if (!result.ok) {
      this.deps.logger.warn('Dispose: failed to destroy session', {
        sessionName: session.handle.sessionName,
        error: result.error.message,
      });
    }
    this.loggedCleanup('dispose', session.handle.taskId, session.handle.sessionsDir);
  }
}
```

**`spawn()` with duplicate `taskId` silently overwrites existing session** - `src/implementations/tmux/tmux-connector.ts:175`
**Confidence**: 82%
- Problem: If `spawn()` is called twice with the same `taskId`, line 175 (`this.activeSessions.set(config.taskId, session)`) silently overwrites the previous `ActiveSession` entry. The first session's watchers, debounce timers, and pending messages are orphaned — never closed, never flushed. The orphaned `fs.watch` handles leak file descriptors. The orphaned staleness timer reference is lost. The first tmux session continues running but is no longer tracked by the connector.
- Fix: Check for duplicate taskId before proceeding:
```typescript
spawn(config: TmuxSpawnConfig, callbacks: SpawnCallbacks): Result<TmuxHandle, AutobeatError> {
  if (this.activeSessions.has(config.taskId)) {
    return err(tmuxSessionFailed('spawn', `Session already active for taskId: ${config.taskId}`, {
      taskId: config.taskId,
    }));
  }
  // ... rest of spawn
}
```

**Wrapper script does not write sentinel if `jq` crashes mid-pipeline** - `src/implementations/tmux/tmux-hooks.ts:98-105`
**Confidence**: 80%
- Problem: The wrapper script runs with `set -euo pipefail` initially, then `set +e` before the pipeline. However, if `jq` is killed mid-execution (e.g., OOM killer), the `while read` loop terminates and `PIPESTATUS[0]` correctly captures the agent exit code. But if `jq` crashes on every line (e.g., binary named `jq` but wrong version), the pipeline produces no output and the agent appears to hang silently. More critically, if the `mv` command on line 104 fails (filesystem full), the atomic write pattern breaks — the `.tmp` file exists but the final `.json` file does not. The `fs.watch` on the messages directory will never fire for that sequence number, creating a permanent gap in the sequence. The connector handles this via `MAX_PENDING_MESSAGES` overflow, but 100 missing messages accumulate before recovery.
- Fix: Add a trap to ensure the sentinel is always written, even on unexpected script termination:
```bash
# Add after SESSIONS_DIR/MESSAGES_DIR/SEQ_FILE declarations:
cleanup() {
  local exit_code=$?
  if [ ! -f "$SESSIONS_DIR/.done" ] && [ ! -f "$SESSIONS_DIR/.exit" ]; then
    echo "$exit_code" > "$SESSIONS_DIR/.exit.tmp"
    mv "$SESSIONS_DIR/.exit.tmp" "$SESSIONS_DIR/.exit" 2>/dev/null || true
  fi
}
trap cleanup EXIT
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`listSessions` parsing uses `split(':')` without limit — fragile with non-beat sessions** - `src/implementations/tmux/tmux-session-manager.ts:213`
**Confidence**: 80%
- Problem: `trimmed.split(':')` splits on every colon. If a non-beat tmux session has a name containing a colon (e.g., `my:session`), the `parts` array will have 6+ elements. The destructured `[name, createdStr, ...]` will assign `my` to `name` and `session` to `createdStr`. While the `SESSION_NAME_REGEX` filter on line 219 would reject `my` (no `beat-` prefix), it relies on the regex catching all cases. The parsing is correct today but fragile if the regex or session naming convention ever changes.
- Fix: Use a delimiter that tmux guarantees won't appear in session metadata, such as a tab or pipe character:
```typescript
"tmux list-sessions -F '#{session_name}\t#{session_created}\t#{session_attached}\t#{session_width}\t#{session_height}'"
// ...
const parts = trimmed.split('\t');
```

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **`deliverPendingMessages` loop has implicit bound only** - `src/implementations/tmux/tmux-connector.ts:601` (Confidence: 70%) — The `while (session.pendingMessages.has(session.nextExpectedSeq))` loop terminates because `pendingMessages` is finite and each iteration deletes an entry. However, there is no explicit upper bound. If a bug elsewhere caused `pendingMessages` to grow while being iterated (e.g., a callback re-entrantly adding messages), the loop would not terminate. An explicit iteration limit (e.g., `MAX_PENDING_MESSAGES`) would provide defense in depth.

- **`handleMessageFile` async gap allows late delivery after session exit** - `src/implementations/tmux/tmux-connector.ts:550-551` (Confidence: 65%) — The re-check `if (session.exited) return` after `await this.readFileFn()` prevents calling `callbacks.onOutput` after exit, which is correct. However, the message is still parsed and validated, consuming CPU for work that will be discarded. This is a minor efficiency concern, not a correctness issue.

- **Staleness config `maxSilenceMs` smaller than `checkIntervalMs` may cause immediate false positives** - `src/implementations/tmux/tmux-connector.ts:428` (Confidence: 65%) — If a caller passes `{ checkIntervalMs: 30000, maxSilenceMs: 1000 }`, the session may be marked stale on the very first check tick because `silentMs` (30+ seconds from spawn to first check) exceeds `maxSilenceMs` (1 second). While `lastAliveCheck` is initialized to `Date.now()` at spawn time, a slow `listSessions()` call or event loop delay could push the first check past the threshold. A validation asserting `maxSilenceMs >= checkIntervalMs` would prevent this misconfiguration.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | - | 0 | 1 | 0 |
| Pre-existing | - | - | 0 | 0 |

**Reliability Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The tmux abstraction layer demonstrates solid reliability engineering: push-based completion detection with staleness fallback, re-entrancy guards, bounded pending-message buffers, debounce windows, and comprehensive error handling on all exit paths. The architecture is well-designed for production use.

The two HIGH findings are the most actionable: (1) the macOS `flock` silently degrades to no-op locking, creating a latent correctness risk in the wrapper script's sequence counter; (2) `destroy()` forwarding to `sessionManager.destroySession` for untracked handles could affect other connector instances. The MEDIUM findings about `dispose()` not signaling `onExit` and duplicate `taskId` overwriting existing sessions represent scenarios that could cause task state corruption in production.
