# Complexity Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17

## Issues in Your Changes (BLOCKING)

### HIGH

**Staleness timer closure captures `taskId` by value but `session.handle.sessionName` by reference** - `tmux-connector.ts:296-331`
**Confidence**: 85%
- Problem: In `startStalenessTimer`, the `taskId` is destructured from `session.handle` at line 297 and captured as a stable value. However, `session.handle.sessionName` is read live at lines 304 and 309 from the `session` reference. Between `startWatchers` (line 157) and session handle update (lines 172-175), the `sessionName` on the handle changes. This is safe for the staleness timer because it starts AFTER the handle update (line 182). However, the sentinel watcher callback at line 257 captures `taskId` from the scope at line 246, which is also safe since `session.handle` is updated after `startWatchers` returns. The risk is subtle: if `startStalenessTimer` were ever called before the handle update (e.g., during a refactor), the timer would reference the wrong `sessionName`. The coupling between ordering and correctness is implicit.
- Fix: Consider passing the final `sessionName` explicitly to `startStalenessTimer` rather than relying on read-through-reference timing:
  ```typescript
  private startStalenessTimer(session: ActiveSession, stalenessConfig: StalenessConfig, sessionName: string): void {
    // Use sessionName directly instead of session.handle.sessionName
  }
  ```

### MEDIUM

**`flushPendingFiles` has two delivery mechanisms that must maintain the same invariant** - `tmux-connector.ts:339-395`
**Confidence**: 82%
- Problem: The flush function has two distinct delivery paths: (1) `deliverPendingMessages` at line 379 which delivers consecutive sequences from `nextExpectedSeq`, and (2) the force-deliver loop at lines 383-390 which iterates remaining messages sorted by sequence. Both paths must respect the `lastDeliveredSeq` watermark to avoid duplicates. The second path manually checks `msg.sequence > session.lastDeliveredSeq` and updates `session.lastDeliveredSeq` inline rather than going through `deliverPendingMessages`. If a future change adds logic to `deliverPendingMessages` (e.g., logging, metrics, validation), the force-deliver path will silently bypass it. The two paths should ideally share a single delivery primitive.
- Fix: Extract a `deliverSingle(session, msg, callbacks)` helper that both paths call:
  ```typescript
  private deliverSingle(session: ActiveSession, msg: OutputMessage): void {
    if (msg.sequence > session.lastDeliveredSeq) {
      session.lastDeliveredSeq = msg.sequence;
      session.callbacks.onOutput(msg);
    }
  }
  ```
  Then both `deliverPendingMessages` and the flush force-deliver loop call this helper.

**Env var escaping inconsistency between `createSession` and `escapeSingleQuoted`** - `tmux-session-manager.ts:118-128`
**Confidence**: 80%
- Problem: The `escapeSingleQuoted` function (line 45-46) only escapes single quotes. But the env var injection block at lines 120-123 applies BOTH backslash escaping AND single-quote escaping (`value.replace(/\\/g, '\\\\').replace(/'/g, "'\\''")`) before embedding in single quotes. The comment says "Escape value: backslashes first, then single quotes" but inside single quotes, backslashes are literal per POSIX (only single quotes need escaping). This means env var values containing `\n` or `\t` will be double-escaped into `\\n` / `\\t`. This is inconsistent with how `escapeSingleQuoted` works elsewhere (command in `createSession` line 93 and `sendKeys` line 168-169). One of these conventions is wrong.
- Fix: Use `escapeSingleQuoted` consistently for the env var values. If backslash escaping is needed here (because tmux `set-environment` interprets backslashes differently than POSIX shell), document why with a comment explaining the deviation from `escapeSingleQuoted`:
  ```typescript
  const escaped = escapeSingleQuoted(value);
  return `tmux set-environment -t ${config.name} ${key} '${escaped}'`;
  ```
  Or if the backslash escaping is intentional for tmux, rename to make the semantics clear.

## Issues in Code You Touched (Should Fix)

_(none)_

## Pre-existing Issues (Not Blocking)

_(none)_

## Suggestions (Lower Confidence)

- **`dispose()` destroys sessions sequentially after clearing the map** - `tmux-connector.ts:220-237` (Confidence: 65%) — If `destroySession` throws (rather than returning err), the remaining sessions leak. The iteration already has error handling for the Result, but an unexpected throw from the injected `sessionManager` would stop the loop. A try/catch around each iteration would be more defensive.

- **`startWatchers` silently degrades on both watchers** - `tmux-connector.ts:245-290` (Confidence: 62%) — If both sentinel and messages watchers fail to start (catch blocks at lines 261 and 287), the session runs with no observation at all — only the staleness timer provides detection. This silent degradation may mask configuration errors in production.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Complexity Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The refactoring significantly reduces complexity — extracting `startWatchers`, `startStalenessTimer`, the `isOutputMessage` type guard, and interface-based DI are all improvements. The `spawn` method went from async with interleaved setup to a clear 5-step synchronous flow. The main concern is the dual-path delivery in `flushPendingFiles` and the escaping inconsistency in `createSession` env var handling, both of which could harbor bugs on the next change.
