# TypeScript Review Report

**Branch**: feat/178-worker-pool-rewiring -> main
**Date**: 2026-05-19

## Issues in Your Changes (BLOCKING)

### HIGH

**`spawn(config: unknown, ...)` weakens the TmuxConnectorPort contract** - `src/core/tmux-types.ts:93`
**Confidence**: 85%
- Problem: `TmuxConnectorPort.spawn()` accepts `config: unknown`, which disables type checking for all callers. The concrete `TmuxConnector` then performs an unsafe `rawConfig as TmuxSpawnConfig` assertion (tmux-connector.ts:143). This means any caller can pass anything -- a string, null, or a mismatched object -- and it silently compiles. The `unknown` type trades compile-time safety for runtime failures.
- Impact: Callers (EventDrivenWorkerPool.launchAndRegister) pass `config: unknown` through without any narrowing. A bug in `buildTmuxCommand()` returning the wrong shape would only manifest as a runtime error deep inside TmuxConnector, not at the call site.
- Fix: Use a generic parameter or a minimal structural type that captures the required fields without pulling in full `TmuxSpawnConfig`:

```typescript
// Option A: Minimal structural type in core
export interface TmuxSpawnConfigCore {
  readonly taskId: TaskId;
  readonly sessionsDir: string;
  readonly name: string;
  readonly command: string;
  readonly agent: string;
  readonly cwd?: string;
}

export interface TmuxConnectorPort {
  spawn(config: TmuxSpawnConfigCore, callbacks: SpawnCallbacks): Result<TmuxHandle, AutobeatError>;
  // ...
}

// Option B: If the circular dep is the true blocker, a branded unknown
// at minimum documents the intent:
type TmuxSpawnConfigOpaque = unknown & { readonly __brand: 'TmuxSpawnConfig' };
```

The documented ARCHITECTURE EXCEPTION is understandable given the circular dependency constraint, but `unknown` with `as` cast is the anti-pattern this project's CLAUDE.md explicitly prohibits ("No any types"). `unknown` without a type guard or narrowing before use provides the same level of unsafety as `any` at the assertion boundary.

**`as unknown as AgentAdapter` cast in mock fixture** - `tests/fixtures/mock-agent.ts:53`
**Confidence**: 82%
- Problem: The `createMockTmuxAgentAdapter()` function builds a plain object literal and casts it via `as unknown as AgentAdapter`. This double-cast bypasses all type checking -- if `AgentAdapter` gains new required methods, this mock will silently compile without implementing them.
- Impact: Test doubles drift from the real interface, causing false-positive test passes. When new `AgentAdapter` methods are added, tests using this mock continue to pass while production code breaks.
- Fix: Implement the interface directly or use `satisfies` to ensure structural conformance:

```typescript
export function createMockTmuxAgentAdapter(): AgentAdapter {
  const adapter: AgentAdapter = {
    provider: 'claude',
    spawn: vi.fn().mockReturnValue(err(new AutobeatError(ErrorCode.INVALID_OPERATION, 'use buildTmuxCommand'))),
    spawnInteractive: vi.fn().mockReturnValue(err(new AutobeatError(ErrorCode.INVALID_OPERATION, 'N/A'))),
    kill: vi.fn().mockReturnValue(ok(undefined)),
    dispose: vi.fn(),
    cleanup: vi.fn(),
    buildTmuxCommand: vi.fn().mockImplementation(/* ... existing logic ... */),
  };
  return adapter;
}
```

### MEDIUM

**`handleWorkerCompletion` changed from async to sync but still calls async `eventBus.emit`** - `src/implementations/event-driven-worker-pool.ts:620`
**Confidence**: 85%
- Problem: `handleWorkerCompletion` was changed from `async` to sync (`private handleWorkerCompletion(...): void`). The event emit calls are now fire-and-forget with `.catch()`. While the DECISION comment explains this rationale, the `.catch()` handler only logs the error -- if `eventBus.emit('TaskCompleted', ...)` fails, the task completion is silently lost from the event bus perspective. PersistenceHandler will never receive the event.
- Impact: If the eventBus emitter ever rejects (e.g., subscriber throws synchronously before await), the task remains in RUNNING status in the database forever, since PersistenceHandler processes events to persist state.
- Fix: The DECISION comment acknowledges this tradeoff. Consider at minimum logging at ERROR level with the task's exit code so the failure is diagnosable:

```typescript
.catch((e) => this.logger.error('Failed to emit TaskCompleted — task may remain RUNNING in DB', toError(e), { taskId, exitCode }));
```
The current code already does this; this finding is informational about the architectural risk. The explicit DECISION comment demonstrates awareness. No code change strictly required.

**`launchAndRegister` accepts `config: unknown` parameter** - `src/implementations/event-driven-worker-pool.ts:159`
**Confidence**: 83%
- Problem: The private method `launchAndRegister` passes `config: unknown` straight through to `tmuxConnector.spawn()`. No narrowing or validation occurs between `buildTmuxCommand()` returning the config and `spawn()` consuming it.
- Impact: The `unknown` type propagates through the entire spawn pipeline -- from `AgentAdapter.buildTmuxCommand()` (which returns `TmuxSpawnConfig`) through `launchAndRegister(config: unknown)` to `TmuxConnectorPort.spawn(config: unknown)`. The typed value is erased at the port boundary and never recovered.
- Fix: Since `launchAndRegister` is private and only called from `spawn()`, it could accept `TmuxSpawnConfig` directly (importing it as a type-only import):

```typescript
import type { TmuxSpawnConfig } from '../implementations/tmux/types.js';

private launchAndRegister(
  task: Task,
  config: TmuxSpawnConfig,  // type safety preserved within the implementation
  // ...
```
This keeps the port interface using `unknown` while preserving type safety within the worker pool itself.

**`SAFE_PATH_REGEX` allows spaces via backslash-escaped space** - `src/implementations/tmux/types.ts:281`
**Confidence**: 80%
- Problem: The regex `[a-zA-Z0-9/_.\ \-]` uses `\ ` (backslash-space) inside a character class. While this works in JavaScript regex (backslash before a non-special character is ignored, matching the literal space), the backslash is misleading -- it suggests escaping is needed when it is not. A plain space in the character class works identically.
- Impact: Readability and maintenance concern. A developer reading `\ ` might wonder what the backslash escapes, or might think it matches a literal backslash followed by a space.
- Fix:

```typescript
export const SAFE_PATH_REGEX = /^(?!.*\.\.)([a-zA-Z0-9/_. \-]+)$/;
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`AgentAdapter` interface in core imports from implementations layer** - `src/core/agents.ts:14`
**Confidence**: 85%
- Problem: `src/core/agents.ts` imports `TmuxSpawnConfig` (even as type-only) from `src/implementations/tmux/types.ts`. This creates a core -> implementation dependency that violates the documented architecture boundary. The PR description states port interfaces were moved to `core/tmux-types.ts` specifically to avoid this pattern, yet the `AgentAdapter.buildTmuxCommand()` return type still references the implementation-layer `TmuxSpawnConfig`.
- Impact: Core layer is coupled to implementation details. Changes to `TmuxSpawnConfig` in the implementation layer force recompilation of all core consumers.
- Fix: Extract a minimal `TmuxSpawnConfigCore` type into `core/tmux-types.ts` (same approach used for `TmuxConnectorPort`) and have `AgentAdapter.buildTmuxCommand()` return that. The implementation-layer `TmuxSpawnConfig` can extend it.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`bootstrap.ts` non-null assertion on `tmuxSessionManager!`** - `src/bootstrap.ts:521`
**Confidence**: 90%
- Problem: `tmuxSessionManager!` uses a non-null assertion on line 521. The variable is `undefined` when `options.tmuxConnector` is provided, and the `!` assertion only appears inside the `else` branch of `if (options.tmuxConnector)`, so it is logically safe. However, non-null assertions are a code smell in TypeScript -- they bypass the compiler's null safety and are fragile if the control flow changes.
- Impact: If future refactoring moves this code outside the `else` branch, the `!` assertion silently allows a runtime null dereference.
- Fix: Pre-existing pattern; note for future cleanup. Could use an assertion function or restructure the branching.

## Suggestions (Lower Confidence)

- **`toError` utility placement** - `src/implementations/event-driven-worker-pool.ts:29` (Confidence: 65%) -- The `toError` helper is defined as a module-level function. Consider moving it to a shared utility if it is needed elsewhere, or making it a private static method for locality.

- **`completionHandled` flag is mutable on a readonly-modeled interface** - `src/implementations/event-driven-worker-pool.ts:46` (Confidence: 70%) -- `WorkerState` has `readonly handle` and `readonly task`, but `completionHandled` is mutable. This is intentional (it is a guard flag mutated at runtime), but the mixed readonly/mutable fields in the interface could benefit from a comment explaining which fields are intentionally mutable.

- **Fire-and-forget emit pattern could lose events under memory pressure** - `src/implementations/event-driven-worker-pool.ts:653-664` (Confidence: 65%) -- The `.catch()` handlers on fire-and-forget emits only log. Under memory pressure, unhandled promise rejections could accumulate. The DECISION comment acknowledges this tradeoff.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**TypeScript Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The PR successfully migrates the worker pool from process-based to tmux-session-based workers with proper DI, branded type constructors, `type`-only imports, and idempotent cleanup guards. The `WorkerId()` constructor usage (avoids PF-001 -- issue is addressed in this PR, not deferred), `TmuxConnectorPort`/`TmuxSessionManagerCorePort` port interfaces in core, and `completionHandled` guard are well-designed.

The primary concern is the `spawn(config: unknown)` pattern on `TmuxConnectorPort` which trades compile-time type safety for a clean dependency graph. While the ARCHITECTURE EXCEPTION comment explains the rationale, `unknown` with an `as` cast at the boundary is functionally equivalent to `any` -- it defeats TypeScript's value proposition at the most critical API surface (the spawn call). A minimal structural type or generic parameter would preserve the architectural boundary while retaining type safety.

The `as unknown as AgentAdapter` cast in the test fixture is a secondary concern that could cause test drift as the interface evolves.
