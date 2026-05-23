# Architecture Review Report

**Branch**: feat/180-phase-5-bootstrap-usage-parsing-cleanup -> main
**Date**: 2026-05-23
**Cycle**: 3 (incremental — 20 issues resolved in prior cycles)

## Issues in Your Changes (BLOCKING)

### HIGH

(none)

### MEDIUM

(none)

## Issues in Code You Touched (Should Fix)

### MEDIUM

**reuseSession() unregister-then-reregister is not atomic** - `src/implementations/event-driven-worker-pool.ts:469-492`
**Confidence**: 82%
- Problem: In the `worker` still-present branch of `reuseSession()`, the code calls `workerRepository.unregister(workerId)` (line 469) then `workerRepository.register(...)` (line 477). If the process crashes between these two calls, RecoveryManager will find no worker registration for this workerId, yet the tmux session is still alive and holding the session name. The heartbeat won't fire because the worker row is gone, so recovery can't detect staleness.
- Impact: On crash between unregister and re-register, a tmux session becomes orphaned with no DB record. RecoveryManager cannot discover or clean it up. TmuxConnector's dispose() is the only safety net, but it only runs on the owning process (which just crashed).
- Fix: Wrap both operations in a synchronous SQLite transaction. The existing codebase already uses `db.transaction()` for TOCTOU protection in DependencyHandler. If WorkerRepository doesn't expose a transaction method, consider a single `updateTaskId(workerId, newTaskId)` method instead of unregister/register:
```typescript
// Option A: single atomic update
const updateResult = this.workerRepository.updateTaskId(workerId, task.id, Date.now());

// Option B: wrap in transaction (if repo exposes transaction)
this.workerRepository.transaction(() => {
  this.workerRepository.unregister(workerId);
  this.workerRepository.register({ workerId, taskId: task.id, ... });
});
```

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **PersistentSessionEntry stores a mutable TaskIdRef by reference** - `src/implementations/event-driven-worker-pool.ts:125` (Confidence: 65%) -- The `taskIdRef` stored in PersistentSessionEntry is a mutable shared reference. Both the entry and the WorkerState (when present) point to the same ref. The re-registration path in reuseSession (line 425) mutates `taskIdRef.current` before `registerWorker()` creates the new WorkerState, so the new WorkerState inherits the already-updated ref. This works correctly today but is subtle -- a future developer adding another reader of `entry.taskIdRef.current` might get a value from a different iteration. A comment or type-level annotation clarifying "this ref is intentionally shared and mutated by reuseSession" would help.

- **attachAndFinalize signal handler restoration casts to NodeJS.SignalsListener** - `src/cli/commands/orchestrate-interactive.ts:336` (Confidence: 62%) -- `process.listeners('SIGINT')` returns `Function[]`. The cast to `NodeJS.SignalsListener` on line 336 is technically unsound if a non-signal listener was installed. This is unlikely in practice (only SIGINT handlers), but a typed wrapper would be cleaner.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | 0 |
| Should Fix | - | - | 1 | - |
| Pre-existing | - | - | 0 | 0 |

**Architecture Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

## Architectural Assessment

### What This PR Does Well

**1. Clean separation of concerns via function extraction (SRP)**
The `orchestrate-interactive.ts` refactoring follows SRP rigorously. `resolveContainerDeps`, `spawnAndDeliverPrompt`, and `attachAndFinalize` each own a single phase of the lifecycle. The `failWith` helper eliminates the repeated `ui.error → container.dispose → process.exit` pattern, reducing 5 nearly-identical error blocks to single-line calls. The parameter objects (`SpawnPromptContext`, `AttachAndFinalizeContext`) replace 6-parameter positional calls with self-documenting named fields.

**2. Dependency direction is correct**
The `env` field promotion from an `unknown` cast on `rawTmuxConfig` to a proper optional field on `TmuxSpawnCoreConfig` eliminates a layering violation. The previous code cast from `TmuxSpawnCoreConfig` through `unknown` to access `env` -- an infrastructure detail leaking through a type boundary. Now `TmuxSpawnCoreConfig.env` is explicit, and the interactive orchestrator accesses it directly without crossing type layers. This applies the Clean Architecture dependency rule: the core type now declares what it needs, and adapters populate it.

**3. Interface narrowing (ISP)**
Removing `updateInteractiveOrchestrationPid` from `OrchestrationService` is correct ISP application. The method was a pre-Phase-5 artifact with zero callers. The test that exercised the PID-based cancel path was preserved by seeding the PID directly via the repository (`updateOrchestration` + `orchestrationRepo.update`), which is the correct test pattern for backward-compatibility verification without maintaining dead API surface. Avoids PF-002: no migration path was added for this removal because the method had zero external consumers.

**4. PersistentSessionEntry stores survival state (B1-1 fix)**
The architectural choice to store `taskIdRef` and `agentProvider` in `PersistentSessionEntry` (which survives `cleanupWorkerState`) rather than only in `WorkerState` (which is deleted on each iteration completion) is the correct data ownership pattern. The persistent session's lifecycle is longer than any single worker state, so its metadata belongs in the longer-lived structure.

**5. tryReuseSession extraction flattens nesting**
Extracting the reuse guard chain from `spawn()` into `tryReuseSession()` reduces nesting depth from 4 levels (if-psk → if-not-reusing → if-existing → if-alive) to 1 level with early returns. This follows Ousterhout's "deep module" principle -- the interface (`tryReuseSession(task, psk, prompt) -> Worker | null`) is simple, the implementation handles all the guard complexity internally.

### Conditions for Approval

1. **Should-Fix**: The unregister/register non-atomicity in reuseSession (lines 469-492) is a crash-window concern. Consider wrapping in a transaction or providing a single `updateTaskId` repository method.
