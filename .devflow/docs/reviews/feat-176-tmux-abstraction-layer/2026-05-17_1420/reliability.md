# Reliability Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17T14:20

## Issues in Your Changes (BLOCKING)

### HIGH

**triggerExit calls flushPendingFiles before setting `session.exited = true` -- race between sentinel watcher and staleness timer** - `src/implementations/tmux/tmux-connector.ts:443-448`
**Confidence**: 85%

- Problem: In `triggerExit`, `flushPendingFiles(session)` is called on line 445 before `session.exited` is set to `true` on line 447. During the flush, `deliverPendingMessages` calls `callbacks.onOutput(msg)` which is user-supplied and could take arbitrary time. If the staleness timer fires during this window (a real scenario since `setInterval` callbacks run between turns of the event loop, and `flushPendingFiles` is synchronous but calls `onOutput` which may yield), a second `triggerExit` call passes the `session.exited` guard on line 443 because `exited` is still `false`. This means `flushPendingFiles` is called again.

  The re-entrancy guard (`session.flushing`) prevents the second `flushPendingFiles` from doing real work, but `session.exited` is then set to `true` by the second caller, `closeSession` is called a second time (closing already-nulled watchers), `activeSessions.delete` runs a second time, and `callbacks.onExit` fires a second time. The double `onExit` is the real bug -- the consumer gets two exit notifications.

  This is a narrow window but real: staleness timer fires on `setInterval`, sentinel watcher fires on `fs.watch` -- both are I/O callbacks that share the event loop. If `onOutput` is async or triggers microtasks, the interleaving is possible.

- Fix: Set `session.exited = true` before calling `flushPendingFiles`:
  ```typescript
  private triggerExit(taskId, session, code, signal, callbacks): void {
    if (session.exited) return;
    session.exited = true;        // <-- move BEFORE flush
    this.flushPendingFiles(session);
    this.closeSession(session);
    this.activeSessions.delete(taskId);
    callbacks.onExit(code, signal);
  }
  ```
  This eliminates the race entirely. The flushing guard is still useful as defense-in-depth for the `onOutput -> destroy -> flush` re-entrancy path, but it should not be the primary guard for triggerExit.

---

**`dispose()` calls `this.activeSessions.clear()` before iterating sessions -- concurrent sentinel/staleness callbacks see empty map but session objects are still live** - `src/implementations/tmux/tmux-connector.ts:276-283`
**Confidence**: 82%

- Problem: `dispose()` on line 277 clears the map, then iterates the snapshot. During that iteration (specifically during `flushPendingFiles` which calls user-supplied `onOutput`), if an `fs.watch` callback fires for one of the sessions being disposed, `handleSentinel` on line 354 does `this.activeSessions.get(taskId)` which returns `undefined` (map was cleared), so it bails. This is safe. However, the staleness timer callback (line 211) also checks `session.exited` -- but `session.exited` is never set to `true` in the `dispose()` path because `dispose` calls `closeSession` but not `triggerExit`. The staleness timer is cleared in `closeSession`, so this is safe in practice because `clearInterval` is called before the timer can fire again.

  The real issue: `dispose()` never sets `session.exited = true` on any session. If an `fs.watch` callback fires between `activeSessions.clear()` (line 277) and `closeSession` (line 280) for a session, the sentinel watcher closure (lines 144-148) captures `config.taskId` and `callbacks` from the `spawn()` scope, not from `activeSessions`. The sentinel callback calls `handleSentinel` which does `this.activeSessions.get(taskId)` -- returns undefined, bails. So sentinel is actually safe.

  But: `onOutput` callbacks during `flushPendingFiles` in `dispose()` have the session's `callbacks` reference. If `onOutput` calls `destroy(handle)`, `destroy` looks up the session in `activeSessions` -- already cleared, so it skips to `sessionManager.destroySession`. The re-entrancy guard protects flush. So this is actually safe but the safety depends on multiple subtle guards, not explicit state. Setting `session.exited = true` in the `dispose` loop would make the safety explicit.

- Fix: Set `session.exited = true` in the dispose loop:
  ```typescript
  dispose(): void {
    const sessions = Array.from(this.activeSessions.values());
    this.activeSessions.clear();
    for (const session of sessions) {
      session.exited = true;  // <-- make exit state explicit
      this.flushPendingFiles(session);
      this.closeSession(session);
      this.deps.sessionManager.destroySession(session.handle.sessionName);
    }
  }
  ```

---

### MEDIUM

**`destroy()` calls `flushPendingFiles` then `closeSession` but does not set `session.exited = true`** - `src/implementations/tmux/tmux-connector.ts:250-258`
**Confidence**: 85%

- Problem: `destroy()` does not set `session.exited = true` before or after flushing. After `destroy` returns, the session object has been removed from `activeSessions` and watchers are closed, so no new callbacks will fire from the connector's perspective. However, the session object itself (captured in closures by the `fs.watch` callbacks and the staleness `setInterval`) still exists in memory with `exited = false`.

  On Node.js, `fs.watch.close()` can still fire a pending callback that was queued before `close()` was called. If that happens, the sentinel callback closure has `config.taskId` and `callbacks` -- it calls `handleSentinel` which looks up `this.activeSessions.get(taskId)`, finds nothing (already deleted), and returns. Safe.

  The staleness timer closure captures the `session` object. `clearInterval` in `closeSession` prevents future ticks but does not cancel an in-flight tick. If a staleness tick is mid-execution when `destroy` is called (impossible in single-threaded JS for synchronous code, but `flushPendingFiles -> onOutput` could yield to microtasks), it checks `session.exited` -- which is `false`. Since the session is gone from `activeSessions`, the staleness callback would call `triggerExit`, which calls `flushPendingFiles` (re-entrancy guard catches it since `destroy` already called flush), sets `exited = true`, calls `closeSession` (watchers already null, timer already null -- idempotent), deletes from `activeSessions` (already gone -- no-op), and fires `callbacks.onExit`. This means `onExit` fires unexpectedly after `destroy()` returns.

  This is the same race as the triggerExit ordering issue above, manifested through a different path.

- Fix: Set `session.exited = true` in `destroy()` after flushing:
  ```typescript
  destroy(handle: TmuxHandle): Result<void, AutobeatError> {
    const session = this.activeSessions.get(handle.taskId);
    if (session) {
      this.flushPendingFiles(session);
      session.exited = true;  // <-- prevent late callbacks
      this.closeSession(session);
      this.activeSessions.delete(handle.taskId);
    }
    return this.deps.sessionManager.destroySession(handle.sessionName);
  }
  ```

---

**Wrapper script `flock` fallback silently degrades to no locking** - `src/implementations/tmux/tmux-hooks.ts:75`
**Confidence**: 80%

- Problem: The generated wrapper script does `flock -x 200 2>/dev/null || true` inside `next_seq()`. On macOS, `flock` is not available by default (it is a Linux util-linux tool). When `flock` is missing, the `|| true` means the sequence number file is read and written without any locking. If two lines of output are processed concurrently in a subshell pipeline, both could read the same sequence number, write the same incremented value, and produce two messages with the same sequence number.

  In practice, the `while IFS= read -r line` loop is sequential, so concurrent subshell invocations of `next_seq` are unlikely. But the `( ... ) 200>lockfile` construct creates a subshell for each call, and bash does not guarantee serialization of subshell execution within a pipeline on all platforms.

  Since macOS is an explicitly supported platform (per KNOWLEDGE.md: "standard on Linux/macOS"), the silent degradation to no-lock on macOS is a reliability gap.

- Fix: Either use `mkdir`-based locking (portable), or document that `flock` absence is acceptable because the read loop is sequential and note the assumption explicitly:
  ```bash
  next_seq() {
    # Lock is best-effort: sequential read loop prevents concurrent access,
    # but flock provides defense-in-depth on Linux.
    (
      flock -x 200 2>/dev/null || true
      ...
    ) 200>"$SEQ_FILE.lock"
  }
  ```

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Late fs.watch events after close()** - `src/implementations/tmux/tmux-connector.ts:454-462` (Confidence: 65%) -- On some Node.js platforms, `FSWatcher.close()` does not guarantee that no further events will be emitted for callbacks already queued in the I/O poll phase. The sentinel watcher callback accesses `this.activeSessions` which provides safety (returns undefined after deletion), but the messages watcher callback captures `session` directly in the closure and checks `session.exited` -- if `exited` is not set (see destroy() finding above), a late callback could attempt message delivery to a destroyed session. This is mitigated if the `session.exited` fix is applied.

- **`flushPendingFiles` sorts filenames lexicographically, not numerically** - `src/implementations/tmux/tmux-connector.ts:310` (Confidence: 60%) -- `files.filter(...).sort()` uses default lexicographic sort. Filenames are zero-padded to 5 digits (`00001-stdout.json`), so lexicographic and numeric sort produce the same result for sequences 1-99999. If a session ever produces 100,000+ messages, the sort would break. The `MAX_PENDING_MESSAGES = 100` cap and the sequence-based delivery pipeline make this practically unreachable, so this is informational only.

- **No upper bound on `deliverPendingMessages` while-loop iteration count** - `src/implementations/tmux/tmux-connector.ts:425-434` (Confidence: 60%) -- The while loop delivers consecutive messages and is bounded by `pendingMessages.size` (which is capped at `MAX_PENDING_MESSAGES = 100`). So the effective bound is 100 iterations. This is acceptable but not explicitly documented as bounded -- adding a comment would improve auditability.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Reliability Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The core reliability mechanisms (re-entrancy guard, staleness detection, message ordering, MAX_PENDING_MESSAGES cap) are well-designed and thoroughly tested. The primary concern is the `triggerExit` ordering: `session.exited` must be set before `flushPendingFiles` to close the race window between sentinel detection and staleness timer callbacks. The same pattern should be applied to `destroy()` and `dispose()` for consistency. These are straightforward fixes that do not require architectural changes.
