# Consistency Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17

## Issues in Your Changes (BLOCKING)

### HIGH

**Inconsistent escaping logic for env var values vs rest of file** - `src/implementations/tmux/tmux-session-manager.ts:122`
**Confidence**: 90%
- Problem: The `escapeSingleQuoted` function (line 45-46) was introduced in this PR with the documented principle: "Only single quotes need escaping — all other characters are literal inside single quotes per POSIX shell rules." This principle is correctly applied to `cwd` (line 90), `command` (line 93), and `sendKeys` (line 168). However, env var value escaping at line 122 still applies BOTH backslash escaping AND single-quote escaping: `value.replace(/\\/g, '\\\\').replace(/'/g, "'\\''")`. This over-escapes backslashes — a value containing `a\b` will be stored as `a\\b` in the tmux environment, which is wrong. The exact same over-escaping bug was fixed for `sendKeys` but not for env var values.
- Fix: Use `escapeSingleQuoted` for env var values:
```typescript
const commands = validEntries
  .map(([key, value]) => {
    return `tmux set-environment -t ${config.name} ${key} '${escapeSingleQuoted(value)}'`;
  })
  .join(' && ');
```

**Incomplete TmuxSessionManager interface — missing methods used by integration tests** - `src/implementations/tmux/types.ts:189`
**Confidence**: 85%
- Problem: The `TmuxSessionManager` interface defines only 4 methods: `createSession`, `destroySession`, `sendKeys`, `isAlive`. But `DefaultTmuxSessionManager` also exposes `listSessions()` and `getSessionEnvironment()` which are used directly by integration tests typed as the interface (`let manager: TmuxSessionManager` at `tests/integration/tmux/session-lifecycle.test.ts:55`). These calls at lines 97 and 117 are type errors masked only because `tsconfig.json` excludes tests. Any consumer coding against the `TmuxSessionManager` interface would not have access to these methods, yet they are part of the public API exported from `index.ts` (via the concrete class). The interface does not match what the implementation exposes as its public contract.
- Fix: Either add `listSessions` and `getSessionEnvironment` to the interface (if they are part of the contract), or change the integration test to type `manager` as `DefaultTmuxSessionManager` (if they are implementation details). Given that `createSession` internally calls `this.listSessions()`, and tests validate these methods, adding them to the interface is the correct approach:
```typescript
export interface TmuxSessionManager {
  createSession(config: TmuxSessionConfig): Result<TmuxSessionResult, AutobeatError>;
  destroySession(name: string): Result<void, AutobeatError>;
  sendKeys(name: string, keys: string): Result<void, AutobeatError>;
  isAlive(name: string): Result<boolean, AutobeatError>;
  listSessions(): Result<TmuxSessionInfo[], AutobeatError>;
  getSessionEnvironment(name: string, varName: string): Result<string | undefined, AutobeatError>;
}
```

### MEDIUM

**Inline escaping instead of using `escapeSingleQuoted` for `cwd`** - `src/implementations/tmux/tmux-session-manager.ts:90`
**Confidence**: 82%
- Problem: The `cwd` value at line 90 uses inline `.replace(/'/g, "'\\''")` rather than calling the `escapeSingleQuoted()` function defined 45 lines above for exactly this purpose. While functionally identical today, this pattern risks future drift — if the escaping logic changes, `cwd` won't be updated.
- Fix: Use the existing function:
```typescript
const cwdFlag = config.cwd ? ` -c '${escapeSingleQuoted(config.cwd)}'` : '';
```

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Unnecessary `await` on synchronous `spawn()`** - `tests/unit/implementations/tmux/tmux-connector.test.ts` (30+ occurrences) (Confidence: 70%) — The `spawn()` method was changed from `async` to synchronous in this PR, but all test call sites still use `await connector.spawn(...)`. While `await` on a non-Promise is harmless in JavaScript (it returns the value), the async test functions and awaits are misleading about the API's synchronous nature. This may confuse future developers.

- **Mock includes surplus `listSessions` method** - `tests/unit/implementations/tmux/tmux-connector.test.ts:134` (Confidence: 65%) — The `makeValidSessionManager` mock includes `listSessions` which is not on the `TmuxSessionManager` interface and is never used by the connector. Cast via `as unknown as TmuxSessionManager` suppresses this, but it creates false expectation that the connector depends on it.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Consistency Score**: 6/10
**Recommendation**: CHANGES_REQUESTED
