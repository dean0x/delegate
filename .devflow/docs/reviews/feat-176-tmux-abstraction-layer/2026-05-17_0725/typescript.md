# TypeScript Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17

## Issues in Your Changes (BLOCKING)

### HIGH

**Interface/implementation mismatch: `TmuxSessionManager` interface missing `listSessions` and `getSessionEnvironment`** - `tests/integration/tmux/session-lifecycle.test.ts:55,97,117`
**Confidence**: 90%
- Problem: The variable `manager` is declared as `TmuxSessionManager` (the interface), but the test calls `manager.listSessions()` (line 97) and `manager.getSessionEnvironment(...)` (line 117) — neither method exists on the `TmuxSessionManager` interface (defined at `src/implementations/tmux/types.ts:189-194`). These calls would produce a compile error if tests were included in tsc type-checking. Currently hidden because `tsconfig.json` excludes `tests/`.
- Fix: Either (a) widen the interface to include these methods if they should be part of the contract, or (b) change the variable type to `DefaultTmuxSessionManager`:
  ```typescript
  // Option A: Add to interface (types.ts)
  export interface TmuxSessionManager {
    createSession(config: TmuxSessionConfig): Result<TmuxSessionResult, AutobeatError>;
    destroySession(name: string): Result<void, AutobeatError>;
    sendKeys(name: string, keys: string): Result<void, AutobeatError>;
    isAlive(name: string): Result<boolean, AutobeatError>;
    listSessions(): Result<TmuxSessionInfo[], AutobeatError>;
  }

  // Option B: Use concrete type in integration test (session-lifecycle.test.ts)
  let manager: DefaultTmuxSessionManager;
  ```
  Note: `getSessionEnvironment` is intentionally concrete-class-only (per KNOWLEDGE.md), so Option B is likely the correct fix for the test.

### MEDIUM

**`as unknown as TmuxSessionManager` casts in test mocks include `listSessions` not on interface** - `tests/unit/implementations/tmux/tmux-connector.test.ts:128-136`
**Confidence**: 82%
- Problem: The test double `makeValidSessionManager()` adds `listSessions` to the mock object and then casts it with `as unknown as TmuxSessionManager`. The `as unknown as` pattern hides the mismatch between the mock shape and the interface. If `TmuxConnector` ever calls `listSessions` through the interface, this would work at runtime but mask a design issue. Currently harmless since the connector does not call `listSessions`, but the extra mock method is misleading.
- Fix: Remove `listSessions` from the mock since the `TmuxSessionManager` interface (used by `TmuxConnector`) does not define it:
  ```typescript
  function makeValidSessionManager(taskId = 'task-abc'): TmuxSessionManager {
    return {
      createSession: vi.fn().mockReturnValue(ok(makeSessionResult(taskId, `beat-${taskId}`))),
      destroySession: vi.fn().mockReturnValue(ok(undefined)),
      sendKeys: vi.fn().mockReturnValue(ok(undefined)),
      isAlive: vi.fn().mockReturnValue(ok(true)),
    } as TmuxSessionManager;
  }
  ```

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **`await` on synchronous `spawn()` return** - `tests/unit/implementations/tmux/tmux-connector.test.ts:165,183,199,...` (Confidence: 65%) — `spawn()` was changed from `async` to synchronous, but all test call sites still use `await connector.spawn(...)`. Awaiting a non-Promise is harmless at runtime (JS wraps and unwraps it), and Vitest handles it fine, but it suggests stale test boilerplate that could confuse future readers about whether the method is truly async. A bulk find-and-replace removing the `await` and `async` from these test functions would improve clarity.

- **`as [string, string, string, string, string]` tuple cast on `split(':')` result** - `src/implementations/tmux/tmux-session-manager.ts:218` (Confidence: 62%) — The `parts.length < 5` guard ensures at least 5 elements exist, making the cast safe for the first 5 destructured values. However, if tmux output contained a colon in an unexpected field (e.g., in a timestamp format), the later fields would be split incorrectly. This is unlikely given tmux's `#{session_name}` format and the `SESSION_NAME_REGEX` filter, but a more defensive approach would be to use `split(':')` with a limit or `indexOf` for known-position fields.

- **`isOutputMessage` type guard uses `Set<string>` instead of literal union check** - `src/implementations/tmux/tmux-connector.ts:42,55` (Confidence: 60%) — `VALID_OUTPUT_TYPES` is typed `Set<string>` which means `has(v.type)` does not narrow `v.type` to the literal union `'stdout' | 'stderr' | 'result'` — the predicate return (`value is OutputMessage`) does the full narrowing. This is functionally correct, but if the `OutputMessage.type` union is extended in the future without updating `VALID_OUTPUT_TYPES`, the guard would reject valid messages silently. Consider deriving the set from the type definition or adding a comment linking the two.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**TypeScript Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The type-level design is clean: interfaces extracted properly, `TmuxSessionResult = Omit<TmuxHandle, 'sessionsDir'>` is correctly used (no code destructures `sessionsDir` from `createSession` results), the `isOutputMessage` type guard is sound, and the `as` casts in source code are minimal and justified. The HIGH finding is a test-only issue where the interface variable type does not match the methods called, hidden by the tsconfig exclusion of test files. Fixing it requires either widening the interface or narrowing the test variable's declared type to the concrete class.
