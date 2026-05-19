# Architecture Review Report

**Branch**: feat/178-worker-pool-rewiring -> main
**Date**: 2026-05-19

## Issues in Your Changes (BLOCKING)

### HIGH

**TmuxConnectorPort.spawn() uses `any` for config parameter** - `src/core/tmux-types.ts:92`
**Confidence**: 85%
- Problem: The port interface in the core layer uses `any` for the spawn config parameter to break a circular dependency with `TmuxSpawnConfig` in the implementations layer. The JSDoc says "uses `unknown`" but the actual type is `any`. Using `any` disables all type checking at call sites -- callers can pass arbitrary objects with no compile-time validation. This is a DIP/ISP violation: the core-layer port should define its own minimal shape rather than surrendering type safety entirely.
- Impact: Any caller using `TmuxConnectorPort.spawn()` gets zero type checking on the config argument. The `EventDrivenWorkerPool` calls `this.tmuxConnector.spawn(config, callbacks)` where `config` comes from `adapter.buildTmuxCommand()` -- currently safe because TypeScript infers the return type, but the port's `any` means a future refactor could silently break the contract.
- Fix: Define a minimal `TmuxSpawnCoreConfig` interface in `core/tmux-types.ts` with the fields the port contract actually requires (e.g. `taskId`, `sessionsDir`, `name`), then use `TmuxSpawnCoreConfig & Record<string, unknown>` or just `TmuxSpawnCoreConfig` as the spawn parameter. The concrete `TmuxConnector` can accept the full `TmuxSpawnConfig` which extends this core type. This preserves the layering boundary without sacrificing type safety.

```typescript
// src/core/tmux-types.ts
export interface TmuxSpawnCoreConfig {
  readonly taskId: TaskId;
  readonly sessionsDir: string;
  readonly name: string;
}

export interface TmuxConnectorPort {
  spawn(config: TmuxSpawnCoreConfig, callbacks: SpawnCallbacks): Result<TmuxHandle, AutobeatError>;
  // ...
}
```

**`handleWorkerCompletion` changed from async to sync with fire-and-forget event emission** - `src/implementations/event-driven-worker-pool.ts:593-634`
**Confidence**: 83%
- Problem: `handleWorkerCompletion` was changed from `async` (awaiting `eventBus.emit`) to synchronous (fire-and-forget `.catch()`). The previous implementation `await`ed `eventBus.emit('TaskCompleted', ...)` and `eventBus.emit('TaskFailed', ...)`, ensuring handlers ran to completion before the method returned. The new pattern `.emit(...).catch(...)` means the emit promise is unhandled from the caller's perspective -- if an event handler throws, the error is logged but the calling code has no way to know emission failed. This breaks the previously-consistent async pattern for event emission in this class.
- Impact: `handleWorkerTimeout` still `await`s `this.eventBus.emit('TaskTimeout', ...)`, creating an inconsistency within the same class. More importantly, downstream handlers (PersistenceHandler, DependencyHandler) may not have finished persisting task status by the time the next operation occurs. The `onExit` callback calls `handleWorkerCompletion` from within a `.finally()` chain, so the async nature is already lost -- but making this explicit with a comment documenting the tradeoff would be appropriate.
- Fix: Either (a) make `handleWorkerCompletion` async again and have `onExit` properly chain it:
```typescript
onExit: (code: number | null) => {
  this.flushOutput(taskId)
    .catch(...)
    .finally(() => {
      this.outputCapture.clear(taskId);
      this.handleWorkerCompletion(taskId, code ?? 0)
        .catch(e => this.logger.error('Completion handling failed', toError(e), { taskId }));
    });
}
```
Or (b) keep it synchronous but add a `// DECISION:` comment explaining why fire-and-forget is acceptable and make `handleWorkerTimeout` consistent by also using fire-and-forget for its emit.

### MEDIUM

**`ProcessSpawnerAdapter.buildTmuxCommand` returns a fake config instead of an error** - `src/implementations/process-spawner-adapter.ts:47-63`
**Confidence**: 85%
- Problem: Previously `buildTmuxCommand` returned `err(...)` indicating ProcessSpawnerAdapter does not support tmux. Now it returns a synthetic `TmuxSpawnConfig` with `command: 'echo'` and `as unknown as TmuxSpawnConfig` type assertion. This means tests using `ProcessSpawnerAdapter` (via `BootstrapOptions.processSpawner`) will get a config that looks valid but would spawn an `echo` session if actually passed to a real `TmuxConnector`. The `as unknown as TmuxSpawnConfig` cast bypasses type safety.
- Impact: Test compatibility is achieved but at the cost of a Liskov Substitution violation -- callers of `AgentAdapter.buildTmuxCommand()` now cannot trust that a successful return means the config is actually usable. The old behavior (returning an error) was more honest. This could mask integration bugs where a test passes because the mock connector accepts anything, but production code would fail with a misconfigured session.
- Fix: Consider keeping the old `err()` return and handling it in `EventDrivenWorkerPool.spawn()` with a check, or create a proper `MockTmuxSpawnConfig` type for test doubles rather than casting through `unknown`. Alternatively, since tests now have `createMockTmuxConnector`, the `ProcessSpawnerAdapter.buildTmuxCommand` path may not even be exercised -- verify and remove the fake config if unused. *avoids PF-002*

**RecoveryManager `tmuxSessionManager` is `undefined` when `options.tmuxConnector` is injected** - `src/bootstrap.ts:513,654`
**Confidence**: 82%
- Problem: When `options.tmuxConnector` is provided (test injection), `tmuxSessionManager` is set to `undefined` (line 513). This `undefined` is then passed to `RecoveryManager` (line 654). In `RecoveryManager.isTmuxSessionAlive()`, when `this.tmuxSessionManager` is undefined, it returns `false` -- meaning all tmux workers are treated as dead during recovery. For tests this is fine (they mock everything), but in a hypothetical scenario where a custom `TmuxConnectorPort` is injected in production (e.g., for a different session backend), recovery would incorrectly kill all tmux workers.
- Impact: Currently tests-only concern since `options.tmuxConnector` is only used in tests. But the architecture couples the `TmuxConnector` injection decision to the `TmuxSessionManager` availability for recovery. These are independent concerns.
- Fix: Extract `TmuxSessionManagerCorePort` from the injected `tmuxConnector` via a method (e.g., `getSessionManager()`) or pass it as a separate bootstrap option. Alternatively, since `TmuxConnectorPort` already has `isAlive(handle)`, recovery could use the connector's `isAlive` method with a reconstructed handle instead of going through the session manager directly.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**JSDoc mismatch: comment says `unknown`, code uses `any`** - `src/core/tmux-types.ts:82-92`
**Confidence**: 90%
- Problem: Line 82 says "spawn() uses `unknown` for config" but line 92 actually uses `any`. This is misleading documentation -- `unknown` and `any` have very different type safety properties. `unknown` requires a type assertion before use (safe); `any` disables checking (unsafe).
- Fix: Either change the type to `unknown` (which would require the concrete class to narrow the type) or update the JSDoc to say `any` with an explanation of why `unknown` was not feasible.

**`fs.watch` cast to `any` in bootstrap tmux wiring** - `src/bootstrap.ts:529`
**Confidence**: 80%
- Problem: `fs.watch as any` is used because the overloads do not match the `WatchFn` type structurally. While documented with a biome-ignore, this is a type-safety escape hatch in the bootstrap composition root.
- Fix: Define `WatchFn` to match the specific `fs.watch` overload being used, or use a thin wrapper function that narrows the signature. This avoids the `any` cast while keeping the implementation identical.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`AgentAdapter` interface retains process-based methods alongside tmux methods** - `src/core/agents.ts:276-333`
**Confidence**: 82%
- Problem: The `AgentAdapter` interface now has both `spawn()` (returns `ChildProcess + pid`) and `buildTmuxCommand()` (returns `TmuxSpawnConfig + prompt`). Since Phase 3 rewires the worker pool to use tmux exclusively, the `spawn()` and `kill()` and `spawnInteractive()` methods are effectively dead code paths for the worker pool flow. The interface violates ISP -- implementors must provide methods they do not use in the primary code path.
- Impact: Every adapter must implement both the process-based and tmux-based paths even though only one is used. This increases maintenance burden and makes it unclear which path is canonical.
- Fix: This is a planned follow-up (removing process-based spawn from the primary path). Track as tech debt -- the interface should be split or the process-based methods removed once the tmux migration is complete.

## Suggestions (Lower Confidence)

- **Core layer depends on `spawnSync` from `child_process`** - `src/bootstrap.ts:508-511` (Confidence: 70%) -- The `tmuxExec` function uses `spawnSync` directly in bootstrap rather than being injected. While bootstrap is the composition root and direct use is acceptable, the `ExecFn` dependency is already a port type -- consider making `tmuxExec` injectable via `BootstrapOptions` for consistency with `tmuxConnector`.

- **Kill poll loop uses 20 iterations x 250ms = 5s max** - `src/implementations/event-driven-worker-pool.ts:246-260` (Confidence: 65%) -- The bounded poll loop is well-designed (avoids unbounded while), but the 5s grace period is hardcoded. If tmux sessions take longer to respond to C-c (e.g., heavy I/O), the grace period may be too short. Consider making this configurable or documenting the rationale for the 5s value.

- **Double `pid: 0` assignment in `registerWorker`** - `src/implementations/event-driven-worker-pool.ts:438,454` (Confidence: 62%) -- `pid: 0` is set both in the `WorkerState` object (line 438) and in the `workerRepository.register()` call (line 454). While not a bug, a single `const PID_SENTINEL = 0` constant would make the sentinel semantics clearer and prevent divergence if the value ever changes.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 1 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Architecture Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The architecture of this change is fundamentally sound: port interfaces in core, implementations in the tmux layer, dependency injection via bootstrap, clean separation of TmuxConnector (session lifecycle) from WorkerPool (task lifecycle). The Dependency Inversion Principle is correctly applied -- the worker pool depends on `TmuxConnectorPort` (abstraction) not `TmuxConnector` (implementation). The migration from process-based to tmux-based workers is well-structured with clear rollback paths (session destroy on registration failure) and double-completion guards.

The two HIGH issues (type safety escape via `any` on the port interface, and the async-to-sync event emission change) are the primary concerns. The `any` type on the spawn config undermines the value of having a port interface at all -- the whole point of the port is to define a contract, and `any` makes half the contract unenforceable. The event emission change introduces an inconsistency within the class and may have subtle ordering implications for downstream handlers.
