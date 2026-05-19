# Consistency Review Report

**Branch**: feat/orchestrator-mode -> main
**Date**: 2026-03-27
**PR**: #123
**Files changed**: 51 (+4206 / -703 lines)
**Commits**: 22

## Issues in Your Changes (BLOCKING)

### HIGH

**OrchestrationHandler uses positional constructor/factory params while all other handlers use deps objects** - `src/services/handlers/orchestration-handler.ts:25-31`, `src/services/handlers/orchestration-handler.ts:38-44`
**Confidence**: 95%
- Problem: Every other handler refactored in this PR (CheckpointHandler, DependencyHandler, LoopHandler, ScheduleHandler, WorkerHandler) now uses a typed `XxxDeps` interface and a `deps` object parameter for both their private constructor and static `create()` factory. OrchestrationHandler is the only handler that still uses positional parameters in both the constructor and factory method. This is the exact pattern deviation this PR was designed to eliminate.
- Fix: Add an `OrchestrationHandlerDeps` interface and convert to deps-object pattern:
  ```typescript
  export interface OrchestrationHandlerDeps {
    readonly orchestrationRepo: SyncOrchestrationOperations;
    readonly loopRepo: SyncLoopOperations;
    readonly database: TransactionRunner;
    readonly eventBus: EventBus;
    readonly logger: Logger;
  }
  ```
  Update the private constructor to accept `deps: OrchestrationHandlerDeps`, and update `create()` to accept the deps interface. Update the call site in `handler-setup.ts:362-367` accordingly.

**Inconsistent repository field naming in RecoveryManagerDeps** - `src/services/recovery-manager.ts:20-28`
**Confidence**: 88%
- Problem: The `RecoveryManagerDeps` interface mixes three naming conventions for repository fields:
  - `repository` (bare name for TaskRepository)
  - `dependencyRepo` (abbreviated suffix)
  - `workerRepository`, `loopRepository`, `orchestrationRepository` (full suffix)

  Other deps interfaces in this PR consistently use the abbreviated `Repo` suffix: `taskRepo`, `checkpointRepo`, `dependencyRepo`, `scheduleRepo`, `loopRepo`, `orchestrationRepo`. The RecoveryManagerDeps interface is the outlier.
- Fix: Rename fields to match the codebase convention:
  ```typescript
  export interface RecoveryManagerDeps {
    readonly taskRepo: TaskRepository;
    readonly queue: TaskQueue;
    readonly eventBus: EventBus;
    readonly logger: Logger;
    readonly workerRepo: WorkerRepository;
    readonly dependencyRepo: DependencyRepository;
    readonly loopRepo?: LoopRepository;
    readonly orchestrationRepo?: OrchestrationRepository;
  }
  ```

### MEDIUM

**State file status enum values diverge from domain OrchestratorStatus enum** - `src/core/orchestrator-state.ts:20`
**Confidence**: 85%
- Problem: The `OrchestratorStateFile.status` field uses string literal union `'planning' | 'executing' | 'validating' | 'complete' | 'failed'`, while the domain `OrchestratorStatus` enum uses `'planning' | 'running' | 'completed' | 'failed' | 'cancelled'`. Two mismatches exist:
  - `'executing'` vs `'running'` (different word for same concept)
  - `'complete'` vs `'completed'` (different tense)
  - State file adds `'validating'` (not in domain)
  - Domain adds `'cancelled'` (not in state file)

  While these are intentionally different schemas (state file is agent-facing, domain is system-facing), the overlapping statuses using different names (`executing`/`running`, `complete`/`completed`) creates a mapping hazard and cognitive overhead when debugging.
- Fix: Align the overlapping status values. Use `'running'` and `'completed'` in the state file schema (matching the domain), while keeping `'validating'` and adding `'cancelled'` to the state file type:
  ```typescript
  readonly status: 'planning' | 'running' | 'validating' | 'completed' | 'failed' | 'cancelled';
  ```
  Update the Zod schema and the `createInitialState()` function accordingly. Update the exit-condition script in `writeExitConditionScript()` to check for `'completed'` instead of `'complete'`.

**EventDrivenWorkerPoolDeps uses `monitor` while class field is also `monitor`** - `src/implementations/event-driven-worker-pool.ts:34`
**Confidence**: 82%
- Problem: The deps interface uses `monitor` as the field name for `ResourceMonitor`, but every other deps interface names fields after their type: `resourceMonitor`. The WorkerHandlerDeps interface (which also takes a ResourceMonitor) uses `resourceMonitor`. This makes it harder to search for usage by type name.
- Fix: Rename `monitor` to `resourceMonitor` in `EventDrivenWorkerPoolDeps` and update the constructor assignment to match.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**OrchestrationHandler error handling on subscription failure diverges from other handlers** - `src/services/handlers/orchestration-handler.ts:51-59`
**Confidence**: 84%
- Problem: When event subscription fails, OrchestrationHandler logs the error but still returns `ok(handler)` -- the handler is considered successfully created even though it cannot receive events. Other handlers (DependencyHandler, ScheduleHandler, CheckpointHandler, LoopHandler) use `subscribeToEvents()` which returns `Result`, and they propagate the failure by returning `err()` from the factory. This makes OrchestrationHandler silently degrade instead of failing fast.
- Fix: Use the `subscribeToEvents()` pattern from `BaseEventHandler`, or collect subscription results and return `err()` if any subscription fails. The handler-setup.ts call site already handles non-fatal failure gracefully with the warning log, so there is no need to also swallow the error inside the handler itself.

**Inconsistent `config` pass-through comment is orphaned in TaskManagerServiceDeps** - `src/bootstrap.ts:404`
**Confidence**: 80%
- Problem: In the bootstrap task manager registration, the inline comment `config, // Pass complete config - no partial objects needed` is now inside a deps object literal. While factually correct, the comment reads as if it is justifying a design decision about the call site shape (positional vs named), which no longer applies since all services now use deps objects. Minor readability noise.
- Fix: Remove or rephrase the comment to just `config,` since the deps-object pattern makes the "no partial objects" justification self-evident.

## Pre-existing Issues (Not Blocking)

### LOW

**`LoopManagerService` constructor still uses positional parameters** - `tests/integration/orchestration-lifecycle.test.ts:36`
**Confidence**: 82%
- Problem: The test reveals that `LoopManagerService` is constructed with positional params: `new LoopManagerService(eventBus, logger, loopRepo, config)`. This was not converted to a deps object in this PR, even though all other services and handlers were. The PR is internally consistent with what it changed, but leaves one service behind.
- Fix: Convert `LoopManagerService` to deps-object pattern in a follow-up PR for complete consistency.

## Suggestions (Lower Confidence)

- **Mixed `Repo` vs `Repository` suffix in bootstrap container keys vs deps fields** - `src/bootstrap.ts:278-284` (Confidence: 70%) -- Container keys use full names (`'orchestrationRepository'`, `'loopRepository'`), while deps interface fields use abbreviated names (`orchestrationRepo`, `loopRepo`). This is the established pattern in the codebase (container keys are long-form, deps are abbreviated), so it is technically consistent, but worth documenting for future contributors.

- **OrchestratorStateFile factory not frozen** - `src/core/orchestrator-state.ts:88-95` (Confidence: 65%) -- The `createInitialState()` function returns a plain object, while `createOrchestration()` in `domain.ts` returns an `Object.freeze()`-frozen object. Since the state file content is serialized to disk and read back, immutability is less critical here, but it deviates from the convention established by other domain factory functions.

- **`handleDetachMode` async change lacks JSDoc update** - `src/cli/commands/run.ts:90` (Confidence: 62%) -- The function signature changed from `void` to `Promise<void>`, and the call site was correctly updated with `await`. The JSDoc/comment block above the function still describes it as a synchronous-style operation without mentioning the Promise return.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 1 |

**Consistency Score**: 7/10

The PR demonstrates strong consistency overall -- the deps-object refactoring across 8+ classes is well-executed and uniform. The naming conventions for types, events, domain objects, and MCP tools all follow established patterns. The new orchestration feature (domain types, repository, service, handler, CLI, MCP tools) closely follows the Loop feature as a template. Timestamp conventions (epoch ms `number`) are consistent across all domain types. The two HIGH findings (OrchestrationHandler positional params, RecoveryManagerDeps naming inconsistency) are both straightforward fixes that would bring the consistency score to 9/10.

**Recommendation**: CHANGES_REQUESTED
