# Regression Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17
**Diff Range**: 1bec153be5..40f9537 (6 commits: bug fixes from previous review)
**Focus**: Regression -- removed exports, changed signatures, altered behavior, broken contracts, type narrowing

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

### MEDIUM

**Unhandled promise rejection from fire-and-forget async call** - `tmux-connector.ts:310`
**Confidence**: 82%
- Problem: `handleMessageFile` was changed from sync to `async` (line 492), but it is called fire-and-forget from a `setTimeout` callback (line 310). If any code path inside `handleMessageFile` throws after the `try/catch` block (e.g., `callbacks.onOutput()` throws, or `deliverPendingMessages` throws), the resulting promise rejection is unhandled. This was not a problem when the method was synchronous because the exception would propagate to the `setTimeout` handler (and be caught by the event loop's uncaught exception handler). Now the async wrapper silently swallows the call stack context.
- Impact: An unhandled promise rejection in Node.js >=15 terminates the process by default (unless `--unhandled-rejections=warn`). If `onOutput` throws, the entire MCP server process could crash without a clear error message.
- Fix: Wrap the call with `.catch()` to log and swallow errors, or add a `.catch(noop)`:
  ```typescript
  const timer = setTimeout(() => {
    session.debounceTimers.delete(filename);
    this.handleMessageFile(path.join(messagesDir, filename), session, callbacks)
      .catch((err: unknown) => {
        this.deps.logger.warn('handleMessageFile failed', {
          taskId,
          filename,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }, DEBOUNCE_MS);
  ```
- Severity: P1

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **`TASK_ID_REGEX` not re-exported from barrel** - `index.ts` (Confidence: 65%) -- `TASK_ID_REGEX` is exported from `types.ts` but not from `index.ts`. If future consumers outside the tmux module need to validate task IDs before calling `generateWrapper`, they would need a direct import path rather than using the barrel. Not blocking since there are no current external consumers.

- **`listSessions` mock returning `ok([])` by default could mask latent test issues** - `tmux-connector.test.ts:135` (Confidence: 62%) -- The `makeValidSessionManager` mock returns `ok([])` for `listSessions`, meaning all sessions appear dead to the staleness timer by default. Tests that don't explicitly care about staleness still have their sessions silently marked as "not alive". If a test with fake timers ever advances time past `maxSilenceMs` without intending to test staleness, it would trigger unexpected `onExit(null, 'STALE')` calls. The default mock for a "valid" session manager should arguably include the spawned session in the alive list to match production behavior.

## Regression Analysis Detail

### 1. Renamed Export: `WrapperManifest.sessionsDir` -> `sessionDir`
**Verdict**: No regression. The field was renamed from `sessionsDir` to `sessionDir` with updated semantics (now refers to the task-specific directory, not the parent). All consumers -- `tmux-connector.ts`, integration tests (`hook-script-generation.test.ts`), and unit tests (`tmux-connector.test.ts`, `tmux-hooks.test.ts`) -- were updated in the same diff. No external consumers exist outside the tmux module. This is new code that has never been published, so `avoids PF-002` (no migration needed for unpublished features).

### 2. Renamed Function: `escapeSendKeys` -> `escapeSingleQuoted`
**Verdict**: No regression. The function is module-private (`function`, not `export function`) inside `tmux-session-manager.ts`. It was never exported, so no external callers exist. The implementation also changed: the old version escaped backslashes (`\\` -> `\\\\`) AND single quotes, while the new version only escapes single quotes. This is semantically correct for POSIX single-quoted strings where backslashes are literal. The `cwd` escaping in `createSession` and `set-environment` calls both switched to use the consolidated function. Tests at lines 166-205 explicitly verify backslashes pass through literally.

### 3. `TmuxSessionResult` Type Narrowing: `Omit<TmuxHandle, 'sessionsDir'>`
**Verdict**: No regression. The type was narrowed from `TmuxHandle` (with `sessionsDir`) to `Omit<TmuxHandle, 'sessionsDir'>` (without). The `createSession` method already only returned `{ sessionName, taskId }` -- the type now matches the implementation. The connector assembles the full `TmuxHandle` by adding `sessionsDir` from `config.sessionsDir` at line 158. All test mocks (`makeSessionResult`) correctly return only `{ sessionName, taskId }`.

### 4. `listSessions` Added to `TmuxSessionManager` Interface
**Verdict**: No regression. The method was added to the interface (line 194-195) and was already implemented on `DefaultTmuxSessionManager`. All test mocks (`makeValidSessionManager`, `makeFailingSessionManager`) include `listSessions` stubs. Integration tests use `DefaultTmuxSessionManager` directly.

### 5. Staleness Detection: Per-Session Timer -> Shared Timer
**Verdict**: No regression in behavior. The old model (one `setInterval` per session calling `isAlive()`) was replaced with a single shared timer calling `listSessions()` once per tick. Both models fire `onExit(null, 'STALE')` after `maxSilenceMs` of confirmed-dead status. The shared timer uses the minimum `checkIntervalMs` across all sessions, which ensures no session misses its check window. The `exited` guard prevents double-fire. Tests verify: staleness fires after maxSilenceMs (line 937), timer respects checkIntervalMs (line 966), no double-fire after sentinel exit (line 1035), timer clears on destroy (line 1103).

### 6. `handleMessageFile` Sync -> Async
**Verdict**: Behavioral change. The method changed from sync (`readFileSyncFn`) to async (`readFileFn`) for the message read path. A re-check of `session.exited` was added after the async gap (line 500-501), which is correct. The flush path (`flushPendingFiles`) remains sync, which is correct for exit-time drain. See the MEDIUM finding above about unhandled rejection risk from the fire-and-forget caller.

### 7. `cleanup()` Calls Added to Exit Paths
**Verdict**: No regression (intentional new behavior). `cleanup()` was not called in the base version. It is now called in `triggerExit()`, `destroy()`, and `dispose()`. This means session directories are now cleaned up on exit, which is correct lifecycle management. The `cleanup` method uses `rmSync` with `{ recursive: true, force: true }` and returns a `Result`, so failures are handled gracefully.

### 8. Single-Quoting of `SESSIONS_DIR` in Wrapper Script
**Verdict**: No regression. Changed from `SESSIONS_DIR="${sessionDir}"` (double quotes, subject to shell expansion) to `SESSIONS_DIR='${sessionDir}'` (single quotes, literal). Combined with `SAFE_PATH_REGEX` validation that rejects metacharacters, this eliminates shell injection risk. The downstream references (`$SESSIONS_DIR`) in the script still work because the variable is expanded at runtime, not at definition time.

### 9. Watcher Error Handlers Added
**Verdict**: No regression. Added `.on('error', ...)` handlers for both sentinel and messages watchers (lines 281-288, 315-322). These log warnings and allow degradation to staleness detection. Previously, watcher errors would have been unhandled events, which could crash the process or go silently unreported.

### 10. Test Variable Type Narrowing: `TmuxSessionManager` -> `DefaultTmuxSessionManager`
**Verdict**: No regression. Two test files changed local variable types from the interface to the concrete class (`session-lifecycle.test.ts:55`, `tmux-session-manager.test.ts:37`). This was necessary because `listSessions` was added to the interface, and the tests use `DefaultTmuxSessionManager` directly. The narrowing is test-scoped and does not affect production code.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Regression Score**: 9/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The single condition is the P1 MEDIUM finding: the fire-and-forget async `handleMessageFile` call needs a `.catch()` handler to prevent unhandled promise rejections from crashing the process. All other changes (rename, type narrowing, shared timer, validation, cleanup calls) are complete, well-tested, and introduce no regressions. The 10 regression vectors analyzed all resolve cleanly.
