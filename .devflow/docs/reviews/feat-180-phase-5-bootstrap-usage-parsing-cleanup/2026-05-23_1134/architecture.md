# Architecture Review Report

**Branch**: feat/180-phase-5-bootstrap-usage-parsing-cleanup -> main
**Date**: 2026-05-23

## Issues in Your Changes (BLOCKING)

### HIGH

**Leaky abstraction: double `as unknown` cast to strip AUTOBEAT_WORKER from opaque config** - `src/cli/commands/orchestrate-interactive.ts:219-225`
**Confidence**: 85%
- Problem: `spawnAndDeliverPrompt()` casts `rawTmuxConfig` through `unknown` twice to reach the `env` field that `TmuxSpawnCoreConfig` intentionally hides. The comment acknowledges the type boundary is "intentionally opaque at this call site," yet the code bypasses it anyway. This couples the CLI command to the implementation-layer `TmuxSpawnConfig` shape without a type-safe contract, meaning any rename or restructuring of `env` in the implementation layer silently breaks this code at runtime with no compile-time signal.
- Fix: Add an env-override mechanism to the port or adapter layer. For example, `BaseAgentAdapter.buildTmuxCommand()` could accept an optional `envOverrides` or `stripEnvKeys` parameter, letting the caller declaratively request `AUTOBEAT_WORKER` removal. Alternatively, add a `withEnvOverride(config, overrides)` utility that operates on `TmuxSpawnCoreConfig` with the `env` field promoted to the core type. Either approach keeps the type boundary intact and surfaces breakage at compile time.

### MEDIUM

**`spawnAndDeliverPrompt` calls `process.exit(1)` internally but returns `Promise<SpawnedSession | null>`** - `src/cli/commands/orchestrate-interactive.ts:181-274`
**Confidence**: 82%
- Problem: The function's return type suggests it may return `null` on failure, but every failure path calls `process.exit(1)` before returning. The caller checks `if (!session) return;` (line 351) which is dead code -- it can never execute because `process.exit` already terminated the process. This creates a misleading contract: the type says "nullable," but the behavior says "never returns null." Future maintainers may add a code path that returns null without exiting, or may try to test this function and discover it kills the process. The same pattern exists in `resolveContainerDeps()` (line 133).
- Fix: Choose one pattern consistently: either (a) have these functions return `Result<T, string>` and let the caller decide whether to exit, or (b) document the `process.exit` behavior explicitly in the return type comment and remove the dead null-check at the call site. Option (a) is architecturally cleaner and aligns with the project's Result-type convention. Option (b) is acceptable for CLI-only code where process.exit is the standard pattern.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**WorkerState widens `taskId` and `task` from readonly to mutable, breaking Liskov substitution** - `src/implementations/event-driven-worker-pool.ts:79-82`
**Confidence**: 83%
- Problem: The base `Worker` interface declares `taskId: TaskId` (implicitly readonly in usage) and WorkerState redeclares it as mutable so `reuseSession()` can overwrite it. While TypeScript's structural typing permits this at compile time, it violates LSP: code holding a `Worker` reference does not expect `taskId` to change after construction. The `handleWorkerCompletion`, `handleWorkerTimeout`, `startFlushing`, and `stopFlushing` methods all read `worker.taskId` and assume stability -- if the ref is updated by `reuseSession()` concurrently (within the same event loop tick is impossible, but across async gaps it is possible), they would read the wrong ID. The `taskIdRef` pattern already solves the callback case correctly; the mutable `taskId`/`task` on WorkerState is a second mutation channel that adds confusion.
- Fix: Keep `taskId` and `task` readonly on WorkerState. In `reuseSession()`, instead of mutating the existing WorkerState, create a new WorkerState object with the updated fields and replace it in the `workers` map. This preserves the invariant that Worker fields are stable after construction, and the `taskIdRef` continues to handle callback routing. The `taskToWorker` map update already happens; the workers map update would be one additional line.

## Pre-existing Issues (Not Blocking)

(none -- no CRITICAL pre-existing issues found in unchanged code)

## Suggestions (Lower Confidence)

- **`CLEAR_SETTLE_MS` as a magic constant rather than injectable** - `src/implementations/event-driven-worker-pool.ts:125` (Confidence: 65%) -- The comment says "a future dep injection point can override this via EventDrivenWorkerPoolDeps if needed" but the value is a module-level constant. If it is anticipated to need tuning, adding it to `EventDrivenWorkerPoolDeps` now avoids a future change.

- **Defensive validation in `buildSetupShim` throws rather than returning Result** - `src/implementations/tmux/tmux-hooks.ts:172-174` (Confidence: 62%) -- The project convention is to return Result types for fallible operations. This `throw` is defense-in-depth (the outer function validates first), but if this function is ever called from a new site, the throw would bypass the Result contract.

- **Persistent session reuse protocol lacks worker DB re-registration** - `src/implementations/event-driven-worker-pool.ts:355-397` (Confidence: 70%) -- When `reuseSession()` remaps a worker to a new task, it updates in-memory maps but does not call `workerRepository.unregister` + `register` for the new task ID. The DB record still points at the old task ID. If the server crashes between reuse and the next heartbeat, RecoveryManager would see a stale task ID in the workers table.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Architecture Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The refactoring of `orchestrate-interactive.ts` into phased helper functions is a solid structural improvement (SRP). The `TaskIdRef` pattern for persistent session callback routing is a well-designed solution to the stale-closure problem. However, the double `as unknown` cast to strip `AUTOBEAT_WORKER` from the opaque config type is a leaky abstraction that should be addressed before merge -- it creates a silent runtime coupling that bypasses the intentional type boundary between core and implementation layers.
