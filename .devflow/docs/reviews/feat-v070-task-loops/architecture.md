# Architecture Review Report

**Branch**: feat/v070-task-loops -> main
**Date**: 2026-03-21
**PR**: #110
**Files Changed**: 32 (30 source + 2 docs) | +5,910 / -82 lines

## Issues in Your Changes (BLOCKING)

### HIGH

**`toOptimizeDirection` export from service layer imported by adapter/CLI** - `src/services/loop-manager.ts:31`, `src/adapters/mcp-adapter.ts:38`, `src/cli/commands/loop.ts:4`
**Confidence**: 82%
- Problem: The MCP adapter (adapter layer) and CLI (interface layer) import `toOptimizeDirection` from the service layer (`loop-manager.ts`). This creates an upward dependency from adapter/interface to a concrete service implementation rather than through an abstraction. The existing `toMissedRunPolicy` in `schedule-manager.ts` has the same pattern, but it is worth noting this compounds the issue. A pure mapping function like this belongs in the domain/core layer or a shared utility, not inside a service class file.
- Impact: Tighter coupling between layers. If `LoopManagerService` moves or is refactored, adapter and CLI imports break. This is a layering concern rather than a functional bug.
- Fix: Move `toOptimizeDirection()` to a domain utility (e.g., `src/core/domain.ts` alongside the `OptimizeDirection` enum, or `src/utils/format.ts`). The same refactor should apply to `toMissedRunPolicy` in `schedule-manager.ts` for consistency, but that is a pre-existing issue.

### MEDIUM

**`execSync` hard-coded in LoopHandler violates Dependency Inversion** - `src/services/handlers/loop-handler.ts:9,580`
**Confidence**: 85%
- Problem: `LoopHandler.evaluateExitCondition()` directly calls `child_process.execSync()` -- a concrete infrastructure dependency hard-wired into a service-layer handler. This makes the exit condition evaluation logic untestable without actually spawning a shell process. The handler already uses DI for all other dependencies (repos, event bus, transaction runner, checkpoint repo).
- Impact: Unit tests for `evaluateExitCondition` cannot mock the shell execution. Any test that triggers this path must provide a real executable on disk. This also makes the handler harder to port to sandboxed environments.
- Fix: Extract an `ExitConditionEvaluator` interface (or a simple function signature) in `core/interfaces.ts` and inject it through the constructor/factory. The default implementation wraps `execSync`. Tests can inject a mock evaluator.

```typescript
// core/interfaces.ts
export interface ExitConditionEvaluator {
  evaluate(command: string, options: {
    cwd: string;
    timeout: number;
    env: Record<string, string>;
  }): { stdout: string; exitCode: number };
}
```

**`updateLoop` accepts `Partial<Loop>` -- overly permissive type** - `src/core/domain.ts:608`
**Confidence**: 80%
- Problem: The `updateLoop` function takes `Partial<Loop>` as its update parameter, unlike `updateTask` which uses a dedicated `TaskUpdate` type and `updateSchedule` which uses `ScheduleUpdate`. This means callers can accidentally overwrite immutable fields like `id`, `strategy`, or `createdAt`. The existing `updateSchedule` has the same `Partial<Schedule>` issue, but `updateTask` shows the preferred pattern.
- Impact: No compile-time protection against accidentally overwriting identity or creation fields on loops. The spread pattern `{ ...loop, ...update }` would silently accept invalid field overwrites.
- Fix: Create a `LoopUpdate` interface listing only mutable fields (status, currentIteration, bestScore, bestIterationId, consecutiveFailures, completedAt, updatedAt), matching the `TaskUpdate` pattern.

**LoopHandler at 1,106 lines approaches God Class territory** - `src/services/handlers/loop-handler.ts`
**Confidence**: 80%
- Problem: `LoopHandler` handles loop creation, iteration dispatch (single-task and pipeline), exit condition evaluation, result handling (retry and optimize strategies), termination checks, cooldown scheduling, prompt enrichment, pipeline cleanup, map rebuilding, and stuck loop recovery. That is at least 6 distinct responsibilities in one class. By contrast, `ScheduleHandler` (~450 lines) handles a comparable but smaller set of concerns. The `recordAndContinue` extraction was a good deduplication step, but the class still has too many reasons to change.
- Impact: Maintenance burden. Changes to exit condition evaluation, recovery logic, or pipeline iteration dispatch all require touching the same file. Test setup for this handler is complex because it covers so many paths.
- Fix: Consider extracting: (1) `ExitConditionEvaluator` (evaluation logic, ~60 lines), (2) `LoopRecovery` (rebuildMaps + recoverStuckLoops, ~120 lines), (3) keep iteration dispatch and result handling in `LoopHandler`. This would bring each component under 400 lines with a single responsibility.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**RecoveryManager `loopRepository` is optional -- inconsistent DI** - `src/services/recovery-manager.ts:27`
**Confidence**: 85%
- Problem: The `loopRepository` parameter in `RecoveryManager`'s constructor is marked optional (`loopRepository?: LoopRepository`), requiring a null guard in `cleanupOldLoops()`. Every other repository parameter is required. Since loop support is now a core feature (v0.7.0), there is no scenario where the system runs without a loop repository. The bootstrap always provides it.
- Impact: The optional parameter adds defensive null checks that obscure the actual contract. If someone creates a RecoveryManager without a loop repository, loop cleanup silently does nothing -- no error, no warning.
- Fix: Make `loopRepository` a required parameter. Update the constructor signature to `private readonly loopRepository: LoopRepository` and remove the null guard in `cleanupOldLoops()`.

**MCP adapter constructor signature growing (6 params)** - `src/adapters/mcp-adapter.ts:261-266`
**Confidence**: 80%
- Problem: `MCPAdapter` now takes 6 constructor parameters: `taskManager`, `logger`, `scheduleService`, `loopService`, `agentRegistry`, `config`. Each new feature adds another service. This is not critical yet but is approaching the threshold where a parameter object or service locator pattern would improve readability.
- Impact: Adding future services (e.g., pipeline service, monitoring service) will make the constructor unwieldy and harder to test.
- Fix: Consider grouping services into a `MCPAdapterDependencies` interface (same pattern as `HandlerDependencies` in handler-setup.ts). Not blocking, but worth doing before the next service is added.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`toMissedRunPolicy` in schedule-manager.ts has same layering issue** - `src/services/schedule-manager.ts:37`
**Confidence**: 85%
- Same pattern as the `toOptimizeDirection` issue above. Pure enum mapping function exported from a service and imported by adapter layer. Both should live in core/utils.

**`updateSchedule` also uses `Partial<Schedule>`** - `src/core/domain.ts:353` (pre-existing)
**Confidence**: 80%
- Same overly permissive update type as `updateLoop`. The `updateTask`/`TaskUpdate` pattern shows the correct approach.

## Suggestions (Lower Confidence)

- **Dual `toOptimizeDirection` implementations** - `src/services/loop-manager.ts:31` vs `src/implementations/loop-repository.ts:612` (Confidence: 70%) -- Two separate implementations of the same string-to-enum mapping exist: one public in the service (returns `undefined` for unknown), one private in the repository (throws for unknown). Consider consolidating to a single implementation. The repo version has stricter error handling which is appropriate for boundary validation, while the service version is lenient. Both are defensible for their contexts, hence lower confidence.

- **In-memory maps in LoopHandler not persisted on graceful shutdown** - `src/services/handlers/loop-handler.ts:56-58` (Confidence: 65%) -- The `taskToLoop` and `pipelineTasks` maps are rebuilt from DB on startup via `rebuildMaps()`, but there is no `destroy()` or `shutdown()` method on LoopHandler to clear timers or perform cleanup. The cooldown timers use `.unref()` which prevents blocking, but a graceful shutdown path would be more explicit.

- **Pipeline iteration saves tasks via `saveSync` but does not add dependencies via DependencyHandler** - `src/services/handlers/loop-handler.ts:498-519` (Confidence: 65%) -- Pipeline iterations create tasks with `dependsOn` set in the task object and save them directly via `taskRepo.saveSync()`. The DependencyHandler normally handles adding dependencies when it receives `TaskDelegated` events. This appears to work because the `TaskDelegated` event emission after the transaction triggers the dependency handler, but the flow is implicit and relies on event ordering.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 2 | 0 |

**Architecture Score**: 8/10

The loop feature follows the established project architecture with high fidelity. The layering is consistent: domain types in `core/domain.ts`, interfaces in `core/interfaces.ts`, events in `core/events/events.ts`, handler in `services/handlers/`, service in `services/`, repository in `implementations/`, and adapter/CLI integration in their respective layers. The factory pattern for async handler initialization, the Result type pattern, immutable domain objects with factory functions, event-driven lifecycle management, and the read-only context for CLI queries all mirror the existing Schedule feature precisely. The DI wiring through bootstrap and handler-setup is clean and follows the established container pattern. The primary concerns are: (1) a minor layering violation with `toOptimizeDirection` exported from the service layer, (2) hard-coded `execSync` that should be injected, and (3) the handler's size pushing toward SRP violation territory.

**Recommendation**: APPROVED_WITH_CONDITIONS

Conditions:
1. Move `toOptimizeDirection` to domain/utils layer (non-breaking, 5-minute fix)
2. Consider extracting `ExitConditionEvaluator` interface before the handler grows further (can be a follow-up PR)
