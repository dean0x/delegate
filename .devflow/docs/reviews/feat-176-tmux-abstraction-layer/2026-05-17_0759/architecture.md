# Architecture Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Diff**: `git diff 1bec153be5..40f9537` (6 incremental commits)
**Date**: 2026-05-17
**Focus**: Architecture -- SOLID violations, layer boundaries, tight coupling, dependency direction, abstractions

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Cleanup Result silently discarded at 4 call sites** -- `tmux-connector.ts:185,218,255,576`
**Confidence**: 85%
- Problem: `this.deps.hooks.cleanup(...)` returns `Result<void, AutobeatError>` but all 4 call sites discard the return value. `cleanup` performs `rmSync` with `recursive: true, force: true` -- if the directory removal fails (permissions, busy file handle), the error is swallowed with no logging. This violates the project's "Result types for all fallible operations" principle: returning a Result is meaningless if the caller never inspects it.
- Impact: Failed directory cleanup leaks disk space with no diagnostic trace. In a long-running server managing many sessions, this is a resource leak with no observability.
- Fix: Log a warning on failure (consistent with the `destroySession` error handling pattern at line 250):
```typescript
// In triggerExit (line 576), destroy (line 218), dispose (line 255):
const cleanupResult = this.deps.hooks.cleanup(session.handle.taskId, session.handle.sessionsDir);
if (!cleanupResult.ok) {
  this.deps.logger.warn('cleanup failed', {
    taskId: session.handle.taskId,
    error: cleanupResult.error.message,
  });
}
```
For the spawn failure path (line 185), the same pattern applies.

---

**Mock watcher objects lack `.on()` method -- watcher error handlers silently unregistered** -- `tmux-connector.test.ts:74-75`
**Confidence**: 82%
- Problem: `makeWatchMock()` returns watcher objects as `{ close: vi.fn() }` (lines 74-75), but the production code now calls `sentinelWatcher.on('error', ...)` (connector line 282) and `messagesWatcher.on('error', ...)` (connector line 316). Since these calls are inside try/catch blocks, the `TypeError: on is not a function` is silently caught, logging a spurious "Failed to start sentinel watcher" warning. The watcher error handler is never registered in unit tests.
- Impact: Tests functionally pass but silently degrade both watchers to "failed to start" state. The graceful degradation behavior introduced in this diff (logging watcher errors and falling back to staleness detection) has zero unit test coverage despite being a new code path. The sentinel watcher catch block was designed for "directory may not exist yet", not for mock incompatibility.
- Fix: Add `.on` to the mock watcher objects:
```typescript
const sentinelWatcher = { close: vi.fn(), on: vi.fn() };
const messageWatcher = { close: vi.fn(), on: vi.fn() };
```
This is a 2-character fix that restores correct watcher initialization in all tests.

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

_No critical pre-existing issues found in changed files._

## Suggestions (Lower Confidence)

- **`runSharedStalenessCheck` mutates `activeSessions` Map during iteration** -- `tmux-connector.ts:375-392` (Confidence: 65%) -- `triggerExit` at line 389 calls `this.activeSessions.delete(taskId)` while the `for...of` loop on line 375 is iterating over `activeSessions`. Per the ES6 spec this is defined behavior (deleted-but-not-yet-visited entries are skipped), but it is a fragile pattern that could break if iteration logic changes. Consider collecting stale taskIds into an array first, then triggering exits after the loop.

- **`handleMessageFile` is async but its caller (setTimeout callback) ignores the returned Promise** -- `tmux-connector.ts:310,492` (Confidence: 70%) -- The debounce `setTimeout` callback on line 310 calls `this.handleMessageFile(...)` which is now async (returns `Promise<void>`). The returned Promise is not awaited or `.catch()`-ed. Any rejection (e.g., from `readFileFn`) would surface as an unhandled promise rejection. The try/catch inside `handleMessageFile` covers `JSON.parse` and `readFileFn` errors, so this is mitigated in practice, but a defensive `.catch()` on the call site would be more robust.

- **`spawn()` signature is synchronous but tests await it** -- `tmux-connector.test.ts:166,184,...` (Confidence: 60%) -- `spawn()` returns `Result<TmuxHandle, AutobeatError>` (sync), but every test uses `await connector.spawn(...)`. The `await` on a non-Promise value is harmless (resolves immediately) but is misleading -- it implies spawn is async. This may be leftover from a prior iteration or anticipatory of a future async refactor.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Architecture Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Assessment

The incremental changes demonstrate strong architectural decisions:

1. **Shared staleness timer** -- Consolidating N per-session `isAlive` syscalls into a single `listSessions()` call per tick is a textbook O(N) -> O(1) optimization that reduces process spawning overhead. The `listSessions()` addition to the `TmuxSessionManager` interface is correctly motivated by a consumer need (avoids PF-001 -- the interface change is addressed in this PR, not deferred).

2. **Async hot-path read** -- Moving `handleMessageFile` from sync `readFileSync` to async `readFile` is architecturally sound: the hot output path should not block the Node event loop while the sentinel/flush paths (one-shot, at exit) remain correctly synchronous.

3. **Input validation at boundary** -- `TASK_ID_REGEX` and `SAFE_PATH_REGEX` validation in `generateWrapper` is the correct location (parse at boundary, trust internally). The `WrapperManifest.sessionsDir` -> `sessionDir` rename fixes a naming confusion that could have caused bugs.

4. **Layer separation preserved** -- The four-class stack (Validator -> SessionManager -> Hooks -> Connector) maintains strict dependency direction with all deps injected. No new circular dependencies or layer violations introduced.

5. **`deliverSingle` extraction** -- DRY refactoring of the watermark dedup logic shared by ordered delivery and force-flush paths. Correct application of SRP.

The two MEDIUM findings (discarded cleanup Results and mock watcher `.on()`) should be addressed before merge to maintain the codebase's observability standards and test fidelity.
