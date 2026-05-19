# TypeScript Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17
**Diff**: `git diff 1bec153be5..40f9537`

## Issues in Your Changes (BLOCKING)

### HIGH

**Mock watchers missing `.on()` method — tests silently swallow TypeError in `startWatchers`** - `tests/unit/implementations/tmux/tmux-connector.test.ts:74-75`
**Confidence**: 90%
- Problem: The `makeWatchMock()` helper creates watchers as `{ close: vi.fn() }` but the production code (added in this diff at lines 282 and 316 of `tmux-connector.ts`) calls `.on('error', handler)` on the returned watcher objects. Because the `.on()` call is inside a `try` block, the TypeError is silently caught and the test proceeds — but it means the error-handler registration path is never exercised, and the sentinel/messages watcher tests are all running in "degraded mode" (where `startWatchers` caught an error) without the test knowing it. The special degradation test at line 295 correctly includes `on: vi.fn()`, confirming this was an oversight in `makeWatchMock`.
- Fix: Add `on: vi.fn()` to both watcher mocks in `makeWatchMock`:
```typescript
const sentinelWatcher = { close: vi.fn(), on: vi.fn() };
const messageWatcher = { close: vi.fn(), on: vi.fn() };
```
This also avoids PF-001 (not deferring fix to a future PR) since the code that calls `.on()` was introduced in this same diff.

### MEDIUM

**Redundant explicit type annotation on `TmuxSessionInfo` in `map` callback** - `src/implementations/tmux/tmux-connector.ts:372`
**Confidence**: 85%
- Problem: The explicit annotation `(s: TmuxSessionInfo)` in `listResult.value.map((s: TmuxSessionInfo) => s.name)` is redundant. TypeScript already infers `s` as `TmuxSessionInfo` from `listResult.value` which has type `TmuxSessionInfo[]` (narrowed by the `listResult.ok` guard above). Redundant annotations add noise and can mask inference issues.
- Fix:
```typescript
const aliveSessions = new Set<string>(listResult.value.map((s) => s.name));
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Unchecked `cleanup()` Result at 4 call sites — silent failure** - `src/implementations/tmux/tmux-connector.ts:185,218,255,576`
**Confidence**: 82%
- Problem: `hooks.cleanup()` returns `Result<void, AutobeatError>`, but all 4 call sites discard the return value. Two of these (lines 255 and 576) were added in this diff. While cleanup is best-effort, silently discarding a typed Result violates the project's "always use Result types" principle. At minimum, a failed cleanup should log a warning so operators can diagnose disk-space issues.
- Fix: Log when cleanup fails, similar to the `dispose` pattern already used for `destroySession`:
```typescript
const cleanupResult = this.deps.hooks.cleanup(session.handle.taskId, session.handle.sessionsDir);
if (!cleanupResult.ok) {
  this.deps.logger.warn('cleanup failed', {
    taskId: session.handle.taskId,
    error: cleanupResult.error.message,
  });
}
```

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`getSessionEnvironment` missing from `TmuxSessionManager` interface** - `src/implementations/tmux/types.ts:189-196`
**Confidence**: 85%
- Problem: `DefaultTmuxSessionManager` implements `getSessionEnvironment()` but it is not declared on the `TmuxSessionManager` interface. The test file was changed from `let manager: TmuxSessionManager` to `let manager: DefaultTmuxSessionManager` to access this method — which is the correct workaround. However, this means any code consuming `TmuxSessionManager` (e.g., the connector's `deps.sessionManager`) cannot call `getSessionEnvironment` without downcasting. If this method is part of the public contract, it should be on the interface.
- Fix: Either add `getSessionEnvironment` to `TmuxSessionManager` interface, or document that it is intentionally implementation-specific (e.g., only used by integration tests, not by the connector).

**`spawn()` tests use `await` on a synchronous `Result` return** - `tests/unit/implementations/tmux/tmux-connector.test.ts:166,184,200,...`
**Confidence**: 80%
- Problem: `spawn()` returns `Result<TmuxHandle, AutobeatError>` (synchronous), but all tests call `await connector.spawn(...)`. While `await` on a non-Promise is a no-op in JS, it's misleading — a reader might assume `spawn` is async. This pattern was present before this diff but is widespread in the modified tests.
- Fix: Remove `await` from `spawn()` calls or make `spawn` `async` if it's intended to become asynchronous in the future.

## Suggestions (Lower Confidence)

- **`SAFE_PATH_REGEX` rejects paths with spaces** - `src/implementations/tmux/tmux-hooks.ts:35` (Confidence: 65%) — The regex `/^[a-zA-Z0-9/_.\-]+$/` does not allow spaces in the sessions base directory path. While this is a security hardening choice, macOS default paths (e.g., `/Users/user/Library/Application Support/`) contain spaces. If sessions are ever stored under such paths, the validation would reject them. Consider whether this is intentional or should be documented.

- **`TASK_ID_REGEX` does not enforce a max length** - `src/implementations/tmux/types.ts:228` (Confidence: 60%) — The regex `/^[a-z0-9][a-z0-9_-]*$/` has no upper bound. An extremely long task ID would produce an extremely long session directory path and session name. Consider adding a reasonable max length (e.g., 128 chars) to prevent path-length issues on some filesystems.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 2 | 0 |

**TypeScript Score**: 8/10
**Recommendation**: CHANGES_REQUESTED

The type system usage across this diff is strong: proper Result types throughout, no `any` types, well-defined interfaces with `TmuxSessionResult = Omit<TmuxHandle, 'sessionsDir'>`, discriminated union for `OutputMessage.type`, and a proper type guard (`isOutputMessage`). The `TmuxSessionManager` interface addition of `listSessions()` and the `TASK_ID_REGEX` export are clean. The HIGH-severity mock issue (missing `.on()`) should be fixed before merge as it means watcher error-handler registration is untested.
