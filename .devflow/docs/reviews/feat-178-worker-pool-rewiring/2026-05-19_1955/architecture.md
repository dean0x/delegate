# Architecture Review Report

**Branch**: feat/178-worker-pool-rewiring -> main
**Date**: 2026-05-19

## Issues in Your Changes (BLOCKING)

### HIGH

**TmuxConnectorPort.spawn() uses `unknown` config type -- type safety gap at port boundary** - `src/core/tmux-types.ts:93`
**Confidence**: 85%
- Problem: The port interface uses `unknown` for the config parameter to avoid pulling implementation-layer types (`TmuxSpawnConfig`) into the core layer. While this is documented as an "ARCHITECTURE EXCEPTION", it means every consumer and implementation must use unchecked casts (`rawConfig as TmuxSpawnConfig` at `src/implementations/tmux/tmux-connector.ts:143`). This is a DIP violation workaround that trades compile-time safety for dependency direction correctness.
- Impact: Any caller passing a malformed config will get a runtime error, not a compile-time error. The port interface cannot enforce its own contract.
- Fix: Define a minimal `TmuxSpawnCoreConfig` in `core/tmux-types.ts` containing only the fields the port needs (taskId, sessionsDir, name, command, agentArgs, agent enum, staleness). Let the implementations layer extend it with implementation-specific fields. This preserves the dependency direction while restoring type safety at the port boundary.

```typescript
// core/tmux-types.ts
export interface TmuxSpawnCoreConfig {
  readonly taskId: TaskId;
  readonly sessionsDir: string;
  readonly name: string;
  readonly command: string;
  // ... only fields visible to core consumers
}

// TmuxConnectorPort
spawn(config: TmuxSpawnCoreConfig, callbacks: SpawnCallbacks): Result<TmuxHandle, AutobeatError>;

// implementations/tmux/types.ts
export interface TmuxSpawnConfig extends TmuxSpawnCoreConfig {
  readonly agent: TmuxAgentType; // implementation detail
  // ... additional implementation fields
}
```

**`handleWorkerCompletion` changed from async to fire-and-forget -- event delivery is best-effort** - `src/implementations/event-driven-worker-pool.ts:620-665`
**Confidence**: 82%
- Problem: The old implementation `await`-ed `eventBus.emit()`, ensuring the `TaskCompleted`/`TaskFailed` event was delivered before the method returned. The new implementation fires `.emit().catch()` without awaiting, making event delivery best-effort. The DECISION comment explains the rationale (avoiding async callback chains), but this means a crash between the fire-and-forget emit and the event handler processing would silently lose the completion event.
- Impact: In practice, the PersistenceHandler processes events synchronously within the same process, so this is unlikely to cause data loss. However, the architectural contract has weakened -- callers of `handleWorkerCompletion` can no longer assume the event was delivered when the method returns.
- Fix: This is a conscious tradeoff documented with a DECISION comment. If accepted, no code change needed. If the team prefers guaranteed delivery, consider returning a Promise from the `.finally()` chain and awaiting it in the `onExit` callback (making onExit async is acceptable since TmuxConnector already handles async callbacks).

## Issues in Code You Touched (Should Fix)

### MEDIUM

**ChildProcess import retained in core/interfaces.ts despite tmux migration** - `src/core/interfaces.ts:6`
**Confidence**: 80%
- Problem: `core/interfaces.ts` still imports `ChildProcess` from `child_process` for the `ProcessSpawner` interface (line 70). While `EventDrivenWorkerPool` no longer uses `ChildProcess`, the core layer still has a runtime import from Node.js built-ins that ties the domain layer to process-based semantics. The `ProcessSpawner` interface itself returns `{ process: ChildProcess; pid: number }`.
- Impact: Pre-existing interface used by `ProcessSpawnerAdapter` and the interactive orchestrator path. Not introduced by this PR, but the PR's stated goal is to eliminate process-based worker management. The core layer retaining `ChildProcess` in its interface definitions means the architectural migration is incomplete.
- Fix: This is a pre-existing interface not modified by this PR. Track as follow-up: when the interactive orchestrator is migrated to tmux, remove `ProcessSpawner` and its `ChildProcess` dependency from core. No action required for this PR. (avoids PF-001 -- surfacing explicitly rather than silently deferring)

### MEDIUM

**Bootstrap non-null assertion on tmuxSessionManager** - `src/bootstrap.ts:521`
**Confidence**: 83%
- Problem: `tmuxSessionManager!` uses a non-null assertion. The conditional logic (`options.tmuxConnector ? undefined : new TmuxSessionManager(...)`) guarantees `tmuxSessionManager` is defined in the else branch, but the TypeScript compiler cannot prove this across the conditional scope. The `!` assertion bypasses compile-time safety.
- Impact: If someone refactors the conditional logic, the assertion could silently pass `undefined` to TmuxConnector, causing a runtime crash.
- Fix: Move the TmuxSessionManager construction into the else branch where it is used, eliminating the need for the assertion:

```typescript
if (options.tmuxConnector) {
  container.registerValue('tmuxConnector', options.tmuxConnector);
} else {
  const tmuxSessionManager = new TmuxSessionManager({ exec: tmuxExec });
  container.registerSingleton('tmuxConnector', () => {
    return new TmuxConnector({
      sessionManager: tmuxSessionManager,
      // ...
    });
  });
  // Also pass tmuxSessionManager to recovery manager registration below
}
```

Note: This requires restructuring the recovery manager registration to also be conditional, which may be more invasive than the current approach. The `!` is safe today -- this is a robustness improvement.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**ProcessSpawner interface in core still exposes ChildProcess** - `src/core/interfaces.ts:69-72`
**Confidence**: 85%
- Problem: The `ProcessSpawner` interface returns `ChildProcess` in its `spawn()` method. With the tmux migration, this interface is only used by the `ProcessSpawnerAdapter` shim for tests and the interactive orchestrator. Having `ChildProcess` as a core-layer concept violates the dependency direction (core depends on Node.js process semantics).
- Impact: Not introduced by this PR. This is the remaining artifact of the old process-based architecture.
- Fix: Future PR should introduce an abstract `WorkerHandle` in core and have both tmux and process adapters implement it, fully removing `ChildProcess` from the core layer.

## Suggestions (Lower Confidence)

- **Flushing logic inlined in EventDrivenWorkerPool** - `src/implementations/event-driven-worker-pool.ts:409-452` (Confidence: 70%) -- The output flushing logic (startFlushing, stopFlushing, flushOutput, flushingInProgress backpressure guard) was previously encapsulated in ProcessConnector and is now inlined into EventDrivenWorkerPool. This makes the pool class larger (~711 lines) and mixes worker lifecycle with output I/O concerns. Consider extracting to a dedicated OutputFlusher collaborator if the class continues to grow.

- **Recovery manager dual-path liveness (PID vs tmux) increases cyclomatic complexity** - `src/services/recovery-manager.ts:130-135` (Confidence: 65%) -- `isWorkerAlive()` dispatches on `reg.pid === 0` as a sentinel for tmux workers vs process workers. This is a transitional pattern that works while both worker types coexist. If all workers become tmux-based in the future, this dispatch and the PID-based path can be removed.

- **killAll() calls dispose() as safety net** - `src/implementations/event-driven-worker-pool.ts:333` (Confidence: 62%) -- `killAll()` calls `this.tmuxConnector.dispose()` after killing all workers. This couples the pool to connector lifecycle management. If `killAll()` is called during normal operation (not shutdown), `dispose()` may destroy the connector's staleness timer prematurely, preventing new workers from being spawned afterward.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 0 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Architecture Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Architectural Assessment

This PR executes a well-structured migration from process-based to tmux-session-based worker management. The key architectural decisions are sound:

1. **Port interface placement** (TmuxConnectorPort in core/tmux-types.ts) correctly follows Hexagonal Architecture -- core defines the port, implementations provide adapters. The dependency direction is correct: core -> port <- implementations.

2. **Dependency injection** is consistently applied -- TmuxConnectorPort is injected via the deps bag, not constructed internally. Bootstrap handles the wiring. Tests can inject mocks.

3. **Recovery manager extension** preserves backward compatibility via the unified `isWorkerAlive()` dispatch, supporting both PID-based and session-based liveness checks. The conservative 'unknown' fallback for tmux workers without session manager is the correct safety choice.

4. **ProcessConnector deletion** is clean -- all flushing, output capture, and exit handling logic has been migrated into EventDrivenWorkerPool's private methods and the TmuxConnector's callback system.

5. **Double-completion guard** (completionHandled flag) and **idempotent cleanup** (workers.has() guard) are correct defenses against the race conditions inherent in event-driven + callback architectures.

The two HIGH findings are the `unknown` config type (type safety gap) and fire-and-forget event emission (delivery guarantee weakening). Both are documented with DECISION/ARCHITECTURE EXCEPTION comments and have clear rationale. The `unknown` type should be addressed before the next major release; the fire-and-forget pattern is acceptable given the in-process event bus.

The migration does not introduce circular dependencies, does not violate layering (no upward imports from core to implementations), and correctly uses the existing event-driven patterns established in the codebase.
