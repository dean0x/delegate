# Architecture Review Report

**Branch**: feat/agent-eval-mode -> main
**Date**: 2026-03-30T12:14
**PR**: #125

## Issues in Your Changes (BLOCKING)

### HIGH

**Eval task not cancelled when loop is cancelled during agent evaluation** - `src/services/handlers/loop-handler.ts:277`, `src/services/agent-exit-condition-evaluator.ts:64`
**Confidence**: 85%
- Problem: When a loop is cancelled while the agent evaluator is running, the `handleLoopCancelled` method (line 370-420) updates the loop status to CANCELLED and cleans up `taskToLoop` entries, but the eval task spawned by `AgentExitConditionEvaluator` is NOT tracked in `taskToLoop` (by design, per the architecture comment on line 42: "Eval tasks are NOT registered in LoopHandler.taskToLoop"). This means the eval agent task continues running as an orphan even after the loop is cancelled. The stale state guard (line 279-317) correctly prevents stale results from being processed, but the eval agent process itself is never cancelled. This wastes compute resources (a full Claude Code instance running unnecessarily).
- Impact: Orphan eval agent tasks run to completion consuming worker slots, even after the loop they serve has been cancelled. In a system with limited concurrent workers, this can block real work.
- Fix: Track the in-flight eval task ID in `LoopHandler` (or a dedicated map) so that `handleLoopCancelled` can emit a `TaskCancelled` event for any running eval task. Alternatively, have `AgentExitConditionEvaluator` accept an `AbortSignal` that `LoopHandler` can trigger on cancellation:
  ```typescript
  // In AgentExitConditionEvaluator
  async evaluate(loop: Loop, taskId: TaskId, signal?: AbortSignal): Promise<EvalResult> {
    // ...spawn eval task...
    if (signal?.aborted) {
      await this.eventBus.emit('TaskCancelled', { taskId: evalTaskId, reason: 'loop-cancelled' });
      return { passed: false, error: 'Eval cancelled — loop was cancelled' };
    }
  }
  ```

### MEDIUM

**Duplicated cleanup blocks in stale state guard** - `src/services/handlers/loop-handler.ts:293-296`, `src/services/handlers/loop-handler.ts:312-315`
**Confidence**: 82%
- Problem: The two stale state guard blocks (lines 282-298 and 300-317) each contain identical 3-line cleanup sequences (`cleanupPipelineTaskTracking`, `taskToLoop.delete`, `cleanupPipelineTasks`). These are also identical to the cleanup at lines 324-326 after normal processing. This creates a maintenance risk: any change to the cleanup sequence must be applied in three places.
- Impact: Future changes to cleanup logic could miss one of the three sites, introducing resource leaks. This is the same class of issue that led to PF-001 (git reset missing in one code path).
- Fix: Extract a helper method or use an early-return-with-finally pattern:
  ```typescript
  // Option 1: Extract cleanup into a finally-like wrapper
  try {
    const evalResult = await this.exitConditionEvaluator.evaluate(loop, taskId);
    // ... stale guards that return early ...
    await this.handleIterationResult(freshLoop, freshIteration, evalResult);
  } finally {
    this.cleanupPipelineTaskTracking(iteration);
    this.taskToLoop.delete(taskId);
    this.cleanupPipelineTasks(loopId, iteration.iterationNumber);
  }
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`evalMode` string literal used instead of union type or enum across layers** - `src/core/domain.ts:536`, `src/implementations/loop-repository.ts:484`, `src/adapters/mcp-adapter.ts:2178`
**Confidence**: 83%
- Problem: The `evalMode` field is typed as `'shell' | 'agent'` string literal union in the domain, but there is no single source of truth (enum or const object) for these values. In the MCP adapter (line 2178) and loop repository (line 606), the values are cast with `as 'shell' | 'agent'` from unvalidated strings. The project already uses enums for similar concepts: `LoopStrategy`, `OptimizeDirection`, `LoopStatus`. An `EvalMode` enum would provide compile-time safety and a canonical reference.
- Impact: If a third eval mode is added in the future, every `as 'shell' | 'agent'` cast site must be found and updated. The casts bypass TypeScript's exhaustiveness checking. The `CompositeExitConditionEvaluator` dispatch (line 17) also lacks a default/exhaustive branch.
- Fix: Define an `EvalMode` enum in `domain.ts` alongside `LoopStrategy`:
  ```typescript
  export enum EvalMode {
    SHELL = 'shell',
    AGENT = 'agent',
  }
  ```
  Then use `EvalMode` everywhere instead of raw string literals, and add exhaustive switch in the composite evaluator:
  ```typescript
  async evaluate(loop: Loop, taskId: TaskId): Promise<EvalResult> {
    switch (loop.evalMode) {
      case EvalMode.AGENT:
        return this.agentEvaluator.evaluate(loop, taskId);
      case EvalMode.SHELL:
        return this.shellEvaluator.evaluate(loop, taskId);
      default:
        return loop.evalMode satisfies never;
    }
  }
  ```

## Pre-existing Issues (Not Blocking)

No CRITICAL pre-existing issues found in changed files.

## Suggestions (Lower Confidence)

- **`AgentExitConditionEvaluator` has 4 direct dependencies** - `src/services/agent-exit-condition-evaluator.ts:31-36` (Confidence: 65%) -- The constructor takes `EventBus`, `OutputRepository`, `LoopRepository`, and `Logger`. This is within acceptable limits (4 deps), but the class also does prompt construction, output parsing, and event subscription management. If it grows further, consider extracting the prompt builder and output parser into separate collaborators.

- **`exitCondition: ''` sentinel value for agent mode** - `src/core/domain.ts:621` (Confidence: 70%) -- Using empty string as a sentinel to mean "no shell exit condition" is fragile. The `Loop.exitCondition` field comment says "(empty string for agent mode)" but this convention is implicit. A more explicit approach would be making `exitCondition` optional (`string | undefined`) and using `undefined` for agent mode, though this would require a broader refactor of the existing shell evaluator path.

- **Stale state guard adds ~40 lines of branching to `handleTaskTerminal`** - `src/services/handlers/loop-handler.ts:279-320` (Confidence: 62%) -- The guard is necessary for correctness but adds significant nesting depth to an already complex method. Consider extracting it as a `guardStaleStateAfterEval()` helper that returns `Result<{ loop: Loop; iteration: LoopIteration } | undefined>` where `undefined` means "skip processing."

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Architecture Score**: 8/10
**Recommendation**: CHANGES_REQUESTED

## Architecture Assessment

The overall architecture of this feature is well-designed and follows the established patterns of the codebase:

**Strengths:**
- **Strategy pattern correctly applied**: The `CompositeExitConditionEvaluator` dispatches to `ShellExitConditionEvaluator` or `AgentExitConditionEvaluator` transparently. The `ExitConditionEvaluator` interface is unchanged -- zero modifications to existing consumers.
- **Dependency injection consistently used**: `AgentExitConditionEvaluator` receives all dependencies via constructor. The `HandlerDependencies` interface and `extractHandlerDependencies` function are cleanly extended with `outputRepository`.
- **Event-driven task creation**: Eval tasks are created via `TaskDelegated` event emission rather than direct DB writes, consistent with the hybrid event-driven architecture.
- **Stale state guard is architecturally correct**: Re-fetching loop and iteration state after a potentially slow agent eval prevents processing stale data -- this is a necessary concurrency guard.
- **Domain model cleanly extended**: New fields (`evalMode`, `evalPrompt`, `evalFeedback`) are added to the immutable domain types with proper defaults. The `createLoop` factory function handles defaulting.
- **Database migration is clean**: Migration v15 uses `ALTER TABLE ADD COLUMN` with appropriate defaults (`eval_mode NOT NULL DEFAULT 'shell'`), ensuring backward compatibility.
- **Layer boundaries respected**: Domain types are in `core/domain.ts`, validation in `services/loop-manager.ts`, persistence mapping in `implementations/loop-repository.ts`, and MCP schema in `adapters/mcp-adapter.ts`. No layering violations.

**Primary concern:** The orphan eval task issue (HIGH) is the most significant architectural gap -- the eval task lifecycle is partially outside the loop handler's control, creating a resource leak on cancellation.
