# Architecture Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17

## Issues in Your Changes (BLOCKING)

### HIGH

### [P1] TmuxConnectorPort missing from barrel export — Phase 3 consumers cannot depend on the port interface
- **Location**: `src/implementations/tmux/index.ts:17-35`
- **Confidence**: 95%
- **Description**: The `TmuxConnectorPort` interface (the narrow port interface that Phase 3's WorkerPool should depend on) is defined in `types.ts` but is not re-exported from the barrel `index.ts`. The barrel exports the concrete `TmuxConnector` class and its `TmuxConnectorDeps` type, but omits the abstraction that consumers are meant to program against. Phase 3 will need to either import directly from `types.ts` (bypassing the barrel) or add the export then (an avoidable churn commit). avoids PF-001 — fixing now rather than deferring.
- **Impact on future phases**: Phase 3 (WorkerPool rewiring) — the WorkerPool should depend on `TmuxConnectorPort`, not the concrete `TmuxConnector`. Without the barrel export, Phase 3 either introduces a coupling violation or has to patch the barrel.
- **Suggestion**: Add `TmuxConnectorPort` to the type-only re-exports in `index.ts`:
  ```typescript
  export type {
    CommunicationMode,
    ExecFn,
    ExecResult,
    OutputMessage,
    StalenessConfig,
    TmuxConnectorPort,  // <-- add
    TmuxHandle,
    // ... rest
  } from './types.js';
  ```

### MEDIUM

### [P1] Connector assumes all sessions exit — no lifecycle mode for persistent/channel sessions
- **Location**: `src/implementations/tmux/tmux-connector.ts:86-111` (ActiveSession), `src/implementations/tmux/types.ts:245-252` (TmuxConnectorPort)
- **Confidence**: 82%
- **Description**: The `TmuxConnectorPort` interface and `ActiveSession` internal state model assume every session will eventually exit (sentinel-based completion detection, `exited: boolean`, `onExit` callback as the sole lifecycle terminal). Phases 6-9 introduce persistent channel sessions with bidirectional messaging that do NOT exit after a single task — they stay alive across multiple interactions. The current design has no concept of a session that stays alive, receives messages over time, and does not trigger `onExit` until explicitly torn down.

  This is not necessarily a Phase 1 blocker (Phase 1 is task-scoped sessions), but the architecture should be evaluated for whether it can be extended without breaking changes. The key concern: `TmuxConnectorPort.spawn()` returns a `TmuxHandle` and requires `SpawnCallbacks` with a mandatory `onExit`. A channel session would need a different spawn contract (no `onExit`, or optional `onExit`, plus `onMessage` for bidirectional communication). If the interface is published and consumed in Phases 2-5, changing it in Phase 6 becomes a breaking change across all consumers.

  At minimum, this design decision should be documented so Phase 6 knows the planned extension point (e.g., a separate `openChannel()` method on a `TmuxChannelPort` interface, or an optional `mode: 'task' | 'channel'` on spawn config).
- **Impact on future phases**: Phase 6-9 (Channel system) — may require a new interface or breaking change to `TmuxConnectorPort`.
- **Suggestion**: Add a DESIGN DECISION comment to `TmuxConnectorPort` documenting the extension strategy for channels:
  ```typescript
  /**
   * DESIGN DECISION: TmuxConnectorPort is scoped to task-lifecycle sessions
   * (spawn → exit). Persistent channel sessions (Phases 6-9) will use a
   * separate TmuxChannelPort interface rather than overloading spawn() with
   * mode flags, keeping both interfaces narrow (ISP).
   */
  ```

### [P1] Double concurrent-session-limit check creates inconsistency window
- **Location**: `src/implementations/tmux/tmux-connector.ts:143-145` and `src/implementations/tmux/tmux-session-manager.ts:80-89`
- **Confidence**: 85%
- **Description**: Both `TmuxConnector.spawn()` and `DefaultTmuxSessionManager.createSession()` independently enforce `MAX_CONCURRENT_SESSIONS`. The connector checks its in-memory `activeSessions.size`, while the session manager calls `listSessions()` to count tmux processes. These two sources of truth can diverge: (a) orphaned tmux sessions from a previous process appear in `listSessions()` but not in `activeSessions`; (b) the connector's check passes but the session manager's check fails, causing the connector to have already generated wrapper artifacts (via `hooks.generateWrapper()`) that are then cleaned up on the error path.

  The architectural concern is that the session limit is enforced at two different abstraction levels with two different data sources. This is not a correctness bug (the double-check is conservative), but it creates confusing failure modes where the connector reports "limit reached" based on stale tmux sessions that it does not own.
- **Impact on future phases**: Phase 4 (Recovery & persistence) — orphan cleanup will need to reconcile these two views of "active sessions."
- **Suggestion**: Document the intentional double-check as a defense-in-depth pattern. The connector's check is an optimization (avoids generating artifacts when limit is obviously hit); the session manager's check is the authoritative enforcement. Add a comment:
  ```typescript
  // DESIGN DECISION: connector-level check is an early exit optimization.
  // The authoritative limit check lives in DefaultTmuxSessionManager.createSession()
  // which queries real tmux state. Both checks use MAX_CONCURRENT_SESSIONS.
  ```

### [P2] `TmuxInfo.path` always returns the literal string `'tmux'` instead of the resolved path
- **Location**: `src/implementations/tmux/tmux-validator.ts:104`
- **Confidence**: 85%
- **Description**: The `TmuxInfo` interface declares a `path: string` field documented as "Path to the tmux binary," but `DefaultTmuxValidator.runValidation()` always returns the literal string `'tmux'` rather than resolving the actual binary path (e.g., via `command -v tmux`). This is misleading — callers that depend on `TmuxInfo.path` for spawning or diagnostics get a search-path-dependent string rather than an absolute path.

  By contrast, `jqPath` is correctly resolved from `command -v jq`. The inconsistency suggests this was an oversight.
- **Impact on future phases**: Phase 5 (Bootstrap) — if bootstrap uses `TmuxInfo.path` to spawn tmux, it would work incidentally (PATH resolution), but the contract is violated.
- **Suggestion**: Resolve the tmux path with `command -v tmux`:
  ```typescript
  const tmuxPathResult = this.deps.exec('command -v tmux');
  const tmuxPath = tmuxPathResult.status === 0 ? tmuxPathResult.stdout.trim() : 'tmux';
  // ...
  return ok({
    version: `${major}.${minor}`,
    path: tmuxPath,
    jqPath: jqResult.stdout.trim(),
  });
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

### [P2] Error factory functions follow two different parameter conventions
- **Location**: `src/core/errors.ts:193-226`
- **Confidence**: 80%
- **Description**: The new tmux error factory functions use two different conventions for their parameters. `tmuxSessionFailed` and `tmuxHookFailed` take `(operation, reason, context?)` where `context` is a spread-merged bag. `tmuxSendKeysFailed` takes `(sessionName, reason, context?)` — a more specific first parameter. `tmuxValidationFailed` takes `(reason, context?)` with no operation parameter. While all four produce valid `AutobeatError` instances, the inconsistency in parameter naming and shape across the four functions within the same category makes the API harder to learn.

  The existing factories show a similar split (e.g., `taskNotFound(taskId)` vs `processSpawnFailed(reason)` vs `insufficientResources(cpuUsage, memory)`), so this partially matches the broader codebase convention of "use the most natural signature per error." However, within the tmux category, the four functions could have been more consistent.
- **Impact on future phases**: Phase 4-5 — any additional tmux error factories should follow whichever convention is established here.
- **Suggestion**: Low-priority. Consider standardizing on `(operation, reason, context?)` for all tmux factories in a future cleanup pass since `tmuxSendKeysFailed` is essentially `tmuxSessionFailed('sendKeys', ...)` with a specialized message format. Not blocking.

## Pre-existing Issues (Not Blocking)

No critical pre-existing issues found.

## Suggestions (Lower Confidence)

- **Sealed exit code constants** - `src/implementations/tmux/tmux-connector.ts:594` (Confidence: 70%) — The sentinel exit code mapping (`filename === '.done' ? (code ?? 0) : (code ?? 1)`) encodes protocol knowledge inline. As channel phases add more sentinel types (e.g., `.pause`, `.checkpoint`), this will need a more structured sentinel-to-exit-code mapping. Consider extracting a `parseSentinel()` helper.

- **No `readFileSync`/`readFile` function validation in constructor** - `src/implementations/tmux/tmux-connector.ts:122-124` (Confidence: 65%) — The injected `readFileSync`/`readFile`/`readdirSync` functions default to Node fs functions via inline arrow closures. There is no validation that the injected alternatives match the expected signature at runtime. This is standard TypeScript DI (type system enforces it), but a runtime guard could help with misconfigured test doubles.

- **`escapeSingleQuoted` is duplicated in generated bash and TypeScript** - `src/implementations/tmux/tmux-session-manager.ts:49` (Confidence: 62%) — The `escapeSingleQuoted` function handles the TypeScript side of shell escaping, while the wrapper bash script has its own shell quoting via `jq -Rs`. If the escaping strategies diverge (e.g., a future change to one but not the other), shell injection could result. The two escaping contexts serve different purposes (tmux command args vs. JSON content), but the shared concept could benefit from a single documentation comment cross-referencing both.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Architecture Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The architecture is well-designed overall. The layering is clean: `types.ts` (pure types, no runtime) -> `tmux-validator.ts` / `tmux-hooks.ts` / `tmux-session-manager.ts` (low-level, single-responsibility) -> `tmux-connector.ts` (high-level orchestration) -> `index.ts` (barrel). Dependency direction is correct throughout — lower modules never import from higher ones. All modules use the `Result<T, AutobeatError>` pattern consistently. Dependencies are properly injectable via `*Deps` interfaces, enabling isolated testing (confirmed by the 145-test suite). Interface segregation is good — `TmuxConnectorPort` is narrow (6 methods), `TmuxSessionManager` is narrow (6 methods), `TmuxHooks` is narrow (2 methods).

**Conditions for approval**:
1. Add `TmuxConnectorPort` to barrel exports (HIGH) — Phase 3 depends on this
2. Document the channel extension strategy as a DESIGN DECISION comment (MEDIUM) — prevents Phase 6 from having to redesign the interface
3. Resolve the `TmuxInfo.path` inconsistency (MEDIUM) — contract violation
