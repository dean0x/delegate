# Consistency Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17

## Issues in Your Changes (BLOCKING)

### HIGH

**Inconsistent deps injection style within tmux module** - `tmux-session-manager.ts:63`, `tmux-validator.ts:40`
**Confidence**: 85%
- Problem: `DefaultTmuxSessionManager` and `DefaultTmuxValidator` use anonymous inline object types for their constructor deps (`{ exec: ExecFn; maxConcurrentSessions?: number }` and `{ exec: ExecFn }`), while `TmuxConnector` and `DefaultTmuxHooks` use named exported interfaces (`TmuxConnectorDeps`, `TmuxHooksDeps`). Within the same module, two of four classes follow one pattern and two follow another.
- Impact: Makes it harder for consumers to pass the correct deps object without reading the constructor signature. Named interfaces are discoverable via autocomplete and importable for mock factories. The codebase's handler pattern (`*HandlerDeps`) consistently uses named interfaces.
- Fix: Extract named deps interfaces for both classes:
  ```typescript
  // tmux-session-manager.ts
  export interface TmuxSessionManagerDeps {
    exec: ExecFn;
    maxConcurrentSessions?: number;
  }
  export class DefaultTmuxSessionManager implements TmuxSessionManager {
    constructor(private readonly deps: TmuxSessionManagerDeps) { ... }
  }

  // tmux-validator.ts
  export interface TmuxValidatorDeps {
    exec: ExecFn;
  }
  export class DefaultTmuxValidator implements TmuxValidator {
    constructor(private readonly deps: TmuxValidatorDeps) { ... }
  }
  ```
  Then re-export both from `index.ts`.

### MEDIUM

**`TmuxConnector` does not implement an interface** - `tmux-connector.ts:113`
**Confidence**: 82%
- Problem: `TmuxConnector` is the only implementation class in the tmux module (and one of very few in `src/implementations/`) that does not implement a named interface. All comparable classes do: `DefaultTmuxSessionManager implements TmuxSessionManager`, `DefaultTmuxHooks implements TmuxHooks`, `DefaultTmuxValidator implements TmuxValidator`, `EventDrivenWorkerPool implements WorkerPool`.
- Impact: Consumers cannot depend on an abstraction for testing or future alternative implementations. The three sub-components have clean interfaces but the orchestrating class does not.
- Fix: Define a `TmuxConnectorInterface` (or similar) in `types.ts` and have `TmuxConnector` implement it. At minimum, the public methods `spawn`, `destroy`, `sendKeys`, `isAlive`, `getActiveHandles`, and `dispose` should appear on the interface.

**`injectEnvironment` silently discards exec failures** - `tmux-session-manager.ts:140`
**Confidence**: 80%
- Problem: `injectEnvironment` calls `this.deps.exec(commands)` but does not inspect the result at all. The method is documented as "best-effort" which justifies not returning an error, but the codebase's established "best-effort" pattern (e.g., `loggedCleanup` in `tmux-connector.ts:666-675`) logs a warning on failure. Here, a failed environment injection produces no log output.
- Impact: Debugging why `AUTOBEAT_TASK_ID` is missing from a session would be difficult since the failure is entirely silent.
- Fix: Log a warning when the exec result has a non-zero status:
  ```typescript
  const result = this.deps.exec(commands);
  if (result.status !== 0) {
    // Best-effort — log but don't roll back
    // Note: Logger would need to be added to deps
  }
  ```
  Since `DefaultTmuxSessionManager` does not currently have a logger dep, this could be deferred to when the session manager gains a logger. Alternatively, return the exec result to let the caller decide.

**`TmuxSessionResult.taskId` derived independently from session name** - `tmux-session-manager.ts:108`
**Confidence**: 80%
- Problem: `createSession()` derives `taskId` via `config.name.replace(/^beat-/, '')` (line 108) and returns it in `TmuxSessionResult`. However, `TmuxConnector.spawn()` ignores this derived `taskId` and uses `config.taskId` from `TmuxSpawnConfig` instead (line 180). The two values will diverge if `config.name` is not exactly `beat-${config.taskId}`. The session manager's self-derived taskId is never consumed by the only known caller.
- Impact: `TmuxSessionResult.taskId` is dead data that could mislead future callers into thinking it is authoritative. If a caller passes `name: 'beat-worker-1'` and `taskId: 'task-abc'`, the session manager returns `taskId: 'worker-1'` while the connector uses `'task-abc'`.
- Fix: Either (a) accept `taskId` as an explicit parameter to `createSession` rather than deriving it, or (b) remove `taskId` from `TmuxSessionResult` since the session manager's only job is creating the tmux session and the task identity is a higher-level concern. Option (b) is simpler and matches the `Omit<TmuxHandle, 'sessionsDir'>` comment on `TmuxSessionResult` which already acknowledges that not all Handle fields belong at this layer.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Error factory signature inconsistency between tmux factories** - `src/core/errors.ts:193-221`
**Confidence**: 80%
- Problem: Three tmux error factories (`tmuxSessionFailed`, `tmuxHookFailed`, `tmuxSendKeysFailed`) accept a `reason: string` parameter and spread `{ reason, ...context }` into the error context. But `tmuxSendKeysFailed` does not accept an optional `context?` parameter, unlike the other three. This means callers cannot attach additional debugging context (e.g., exitStatus, command) to sendKeys failures.
- Impact: Minor, but creates asymmetry. If debugging requires more context for sendKeys failures, callers must construct the error manually or modify the factory.
- Fix: Add optional `context?` to `tmuxSendKeysFailed` for parity:
  ```typescript
  export const tmuxSendKeysFailed = (
    sessionName: string,
    reason: string,
    context?: Record<string, unknown>,
  ): AutobeatError =>
    new AutobeatError(ErrorCode.TMUX_SEND_KEYS_FAILED, `Failed to send keys to session '${sessionName}': ${reason}`, {
      sessionName,
      reason,
      ...context,
    });
  ```

## Pre-existing Issues (Not Blocking)

No pre-existing consistency issues found in unchanged code.

## Suggestions (Lower Confidence)

- **Raw try/catch instead of `tryCatch` utility** - `tmux-hooks.ts:186-198`, `tmux-connector.ts:494-500` (Confidence: 65%) -- The codebase has 118 uses of `tryCatch/tryCatchAsync` vs 9 raw try/catch blocks. The tmux module uses raw try/catch exclusively. This is functional and the sync nature of the operations means `tryCatch` adds minimal value, but aligning with the dominant pattern would improve grep-ability and consistency.

- **`OutputMessage` used as both type and runtime value** - `tmux-connector.ts:23-33` (Confidence: 62%) -- `OutputMessage` is imported as a value import alongside runtime constants (`DEFAULT_STALENESS_CONFIG`), but it's only used as a type (in the `isOutputMessage` type guard return type and in `ActiveSession.pendingMessages`). The index.ts barrel correctly re-exports it as `type`. This is harmless since TypeScript strips it, but using `import { type OutputMessage, ... }` inline would be more precise. However, the existing codebase does not consistently use inline `type` qualifiers either, so this is a style preference.

- **Hardcoded `agentArgs: []` in TmuxConnector.spawn** - `tmux-connector.ts:151` (Confidence: 60%) -- The spawn method always passes `agentArgs: []` to `generateWrapper`, ignoring any args the agent might need. This may be intentional for the initial implementation, but it is worth noting that `WrapperConfig.agentArgs` exists and is rendered in the wrapper script, so the field is exercised but always empty from the connector's perspective.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 3 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Consistency Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The tmux module is well-structured and follows most codebase conventions (Result types, dependency injection, error codes in `ErrorCode` enum, factory functions, `ok(undefined)` for void results, `dispose(): void` pattern). The main consistency gaps are (1) mixed DI style within the module (inline vs named deps types), (2) the `TmuxConnector` lacking an interface when all peer classes and comparable implementations have one, (3) the `TmuxSessionResult.taskId` being derived differently than the connector's authoritative taskId, and (4) the `injectEnvironment` silently swallowing failures against the module's own logged-best-effort convention. None are critical but all should be resolved for a clean abstraction layer that will be heavily depended upon in v1.6.0.
