# Complexity Review Report

**Branch**: feat-agent-eval-mode -> main
**Date**: 2026-03-30T12:14
**PR**: #125

## Issues in Your Changes (BLOCKING)

### HIGH

**`parseLoopCreateArgs` exceeds function length threshold (238 lines, ~25 branches)** - `src/cli/commands/loop.ts:40-278`
**Confidence**: 88%
- Problem: This function was already long before this PR. The agent eval mode additions (lines 153-206) added ~60 lines of validation and early return logic, pushing the total to 238 lines with approximately 25 decision points. The function now handles two distinct code paths (agent mode vs. shell mode) with duplicated pipeline validation and shared-object construction at lines 187-205 and 258-277.
- Impact: Hard to maintain. Adding a third eval mode or new flags requires understanding the entire function. The agent and shell branches each construct their own `shared` object with nearly identical fields.
- Fix: Extract the two code paths into helper functions. The agent path (lines 153-206) and shell path (lines 208-277) are cleanly separable:
  ```typescript
  // In parseLoopCreateArgs, after the flag parsing loop:
  if (evalPrompt && evalMode !== 'agent') {
    return err('--eval-prompt requires --eval-mode agent');
  }
  if (evalMode === 'agent') {
    return parseAgentModeArgs({ promptWords, untilCmd, evalCmd, strategyFlag, ... });
  }
  return parseShellModeArgs({ promptWords, untilCmd, evalCmd, strategyFlag, ... });
  ```

**`handleTaskTerminal` exceeds function length threshold (148 lines)** - `src/services/handlers/loop-handler.ts:182-330`
**Confidence**: 85%
- Problem: The stale state guard (lines 279-318) added 43 new lines of re-fetch-and-validate logic inline. The method now has 148 lines with 3 early-return cleanup blocks that each repeat the same 3 cleanup calls (`cleanupPipelineTaskTracking`, `taskToLoop.delete`, `cleanupPipelineTasks`). The stale guard checks are structurally identical (fetch, validate status, log, cleanup, return) but written out twice.
- Impact: The duplicated cleanup blocks are a maintenance hazard -- if a fourth tracking map is added, all 4 cleanup sites must be updated. The method mixes high-level flow (task failed vs. completed) with low-level guard details.
- Fix: Extract the stale state guard into a private method that returns `{ freshLoop, freshIteration } | null`, and extract the 3-line cleanup sequence into a helper:
  ```typescript
  private cleanupIterationTracking(taskId: TaskId, iteration: LoopIteration, loopId: string): void {
    this.cleanupPipelineTaskTracking(iteration);
    this.taskToLoop.delete(taskId);
    this.cleanupPipelineTasks(loopId, iteration.iterationNumber);
  }

  private async refetchAfterEval(loopId, taskId, iteration): Promise<{ loop: Loop; iteration: LoopIteration } | null> {
    // Consolidated re-fetch + validation for both loop and iteration
  }
  ```

### MEDIUM

**Duplicated cleanup triplet repeated 4 times** - `src/services/handlers/loop-handler.ts:236,294,313,324`
**Confidence**: 90%
- Problem: The exact 3-line sequence `cleanupPipelineTaskTracking(iteration); taskToLoop.delete(taskId); cleanupPipelineTasks(loopId, iteration.iterationNumber);` appears at lines 236, 294, 313, and 324. This PR added 2 of those 4 occurrences (lines 294, 313).
- Impact: Violation of DRY. If cleanup logic changes, 4 sites must be updated in sync.
- Fix: Extract to a single `cleanupIterationTracking` method as shown above.

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

_No CRITICAL pre-existing issues in reviewed files._

## Suggestions (Lower Confidence)

- **Test boilerplate in agent evaluator tests** - `tests/unit/services/agent-exit-condition-evaluator.test.ts` (Confidence: 72%) -- The spy-on-emit + capture-task-id + setImmediate + simulate-completion pattern is repeated 17 times across the test file (651 lines). A shared `evaluateWithCompletion(evaluator, loop, taskId)` helper that combines these 4 steps would reduce each test case by ~10 lines and improve readability. This is a test-only concern and does not block.

- **`waitForTaskCompletion` Promise constructor with multiple subscriptions** - `src/services/agent-exit-condition-evaluator.ts:157-217` (Confidence: 65%) -- The method manually manages 4 event subscriptions plus a timer inside a Promise constructor. This is a well-known "deferred" pattern and the implementation is clean, but the 60-line Promise constructor body is at the edge of comfortable comprehension. If more terminal states are added, consider an AbortController-based approach.

- **Two `shared` object constructions with near-identical shapes** - `src/cli/commands/loop.ts:187-205,258-277` (Confidence: 70%) -- The agent and shell paths each build a `shared` object with 11 identical fields. A `buildSharedArgs(...)` helper would eliminate this duplication and ensure both paths stay in sync.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Complexity Score**: 6/10
**Recommendation**: CHANGES_REQUESTED

The new `AgentExitConditionEvaluator` (263 lines) and `CompositeExitConditionEvaluator` (22 lines) are well-structured with clear single responsibilities and clean separation of concerns. The strategy/composite pattern is the right decomposition. The complexity concerns are concentrated in two pre-existing functions (`parseLoopCreateArgs`, `handleTaskTerminal`) that were pushed past maintainability thresholds by the additions in this PR. Extracting the agent/shell paths in the CLI parser and the stale-state guard in the loop handler would bring both back under control.
