# Regression Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17
**Diff**: `git diff a70ed52...HEAD`

## Issues in Your Changes (BLOCKING)

### HIGH

**Env var backslash over-escaping in batched set-environment** - `src/implementations/tmux/tmux-session-manager.ts:122`
**Confidence**: 90%
- Problem: The new batched `set-environment` command escapes backslashes (`value.replace(/\\/g, '\\\\')`) before embedding in a single-quoted context. In single-quoted shell strings, backslashes are literal per POSIX. The old code at line 127 (`value.replace(/'/g, "'\\''")`) correctly only escaped single quotes. The new code introduces double-escaping for backslashes, meaning an env value like `C:\Users\foo` would be stored as `C:\\Users\\foo` in the tmux environment.
- Fix: Remove the backslash replacement to match the `escapeSingleQuoted` function used elsewhere in the file:
  ```typescript
  const escaped = value.replace(/'/g, "'\\''");
  ```
  This is consistent with the commit message's stated intent ("Only single quotes need escaping") and with `escapeSingleQuoted` defined at line 45.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Integration test uses methods not on the TmuxSessionManager interface** - `tests/integration/tmux/session-lifecycle.test.ts:55,97,117`
**Confidence**: 85%
- Problem: The `manager` variable is typed as `TmuxSessionManager` (the interface), but calls `manager.listSessions()` (line 97) and `manager.getSessionEnvironment()` (line 117) which are NOT part of the interface — they exist only on `DefaultTmuxSessionManager`. This compiles only because tests are excluded from `tsconfig.json`. If tests were ever included in typecheck (e.g., via a `tsconfig.test.json`), these would be compile errors.
- Fix: Change the type annotation to the concrete class:
  ```typescript
  let manager: DefaultTmuxSessionManager;
  ```

**Unit test uses method not on the TmuxSessionManager interface** - `tests/unit/implementations/tmux/tmux-session-manager.test.ts:37,310,318,325,332`
**Confidence**: 85%
- Problem: Same issue — `manager` typed as `TmuxSessionManager` interface but calls `getSessionEnvironment()` which only exists on the concrete class.
- Fix: Change to `let manager: DefaultTmuxSessionManager;`

### LOW

**Tests still `await` the now-synchronous `spawn()` method** - `tests/unit/implementations/tmux/tmux-connector.test.ts` (37 occurrences)
**Confidence**: 82%
- Problem: `spawn()` was changed from `async` to synchronous (returns `Result<TmuxHandle, AutobeatError>` directly). All 37 test call sites still use `await connector.spawn(...)`. While `await` on a non-Promise is harmless in JavaScript (resolves immediately), this is misleading and could mask issues if `spawn()` ever needs to become async again or if another developer assumes it returns a Promise based on the test patterns.
- Fix: Remove `await` from all `connector.spawn(...)` calls, and remove `async` from the corresponding test callback functions where `spawn` is the only awaited expression.

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **isOutputMessage type guard is stricter than old inline check** - `src/implementations/tmux/tmux-connector.ts:48-57` (Confidence: 65%) — The new `isOutputMessage` validates `type` against `VALID_OUTPUT_TYPES` (stdout/stderr/result), whereas the old check only verified `typeof type === 'string'`. If any future message type is added to the `OutputMessage` union but not to `VALID_OUTPUT_TYPES`, messages would be silently dropped. Low practical risk since the wrapper only writes `stdout`.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | 0 |
| Should Fix | 0 | 0 | 2 | 1 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Regression Score**: 8/10
**Recommendation**: CHANGES_REQUESTED

The single blocking issue (backslash over-escaping in env vars) is a clear regression from the stated fix intent. The remaining items are test hygiene issues that do not affect runtime behavior. The core fixes (escapeSingleQuoted for sendKeys/createSession, flush gap delivery, EXIT_CODE quoting, TmuxSessionResult narrowing, Default* renames) are all correctly implemented and verified by the passing test suite.
