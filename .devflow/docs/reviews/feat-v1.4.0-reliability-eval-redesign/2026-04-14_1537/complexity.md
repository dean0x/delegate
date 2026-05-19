# Complexity Review Report

**Branch**: feat/v1.4.0-reliability-eval-redesign -> main
**Date**: 2026-04-14T15:37

## Issues in Your Changes (BLOCKING)

### HIGH

**`handleTaskTerminal` method — high cyclomatic complexity (nesting 4+ levels, ~140 lines)** - `src/services/handlers/loop-handler.ts:197-341`
**Confidence**: 88%
- Problem: The `handleTaskTerminal` method handles both TaskCompleted and TaskFailed events in a single method with deeply nested conditionals. The agent-eval stale-state guard (lines 297-333) adds a nested block with two consecutive fetch-and-check sequences, each with 3+ levels of nesting. The method spans ~140 lines and contains at minimum 12 decision points (cyclomatic complexity well above the "warning" threshold of 10).
- Fix: Extract the stale-state guard into a dedicated helper method (e.g., `refetchLoopAndIterationAfterEval`) that returns the fresh loop+iteration or a signal to bail out. This reduces `handleTaskTerminal` to a linear flow: lookup -> guard -> dispatch-to-failure-or-success. Example:

```typescript
private async refetchAfterEval(
  loopId: LoopId, taskId: TaskId, iteration: LoopIteration
): Promise<{ loop: Loop; iteration: LoopIteration } | null> {
  const freshLoopResult = await this.loopRepo.findById(loopId);
  if (!freshLoopResult.ok || !freshLoopResult.value ||
      (freshLoopResult.value.status !== LoopStatus.RUNNING &&
       freshLoopResult.value.status !== LoopStatus.PAUSED)) {
    this.cleanupIterationTracking(taskId, loopId, iteration);
    return null;
  }
  const freshIterationResult = await this.loopRepo.findIterationByTaskId(taskId);
  if (!freshIterationResult.ok || !freshIterationResult.value ||
      freshIterationResult.value.status !== 'running') {
    this.cleanupIterationTracking(taskId, loopId, iteration);
    return null;
  }
  return { loop: freshLoopResult.value, iteration: freshIterationResult.value };
}
```

**`handleRetryResult` and `handleOptimizeResult` — structural duplication and long method bodies** - `src/services/handlers/loop-handler.ts:834-1070`
**Confidence**: 82%
- Problem: Both methods follow the same three-phase pattern: (1) check `decision === 'continue'`, (2) check `decision === 'stop'`, (3) fall through to score/pass logic. The `decision === 'stop'` blocks in both methods are nearly identical (15+ lines each) — they both call `handleIterationGitOutcome`, run an atomic transaction to update iteration + loop status, and call `completeLoop`. `handleOptimizeResult` is 130 lines with 8+ branches.
- Fix: Extract the shared `decision === 'stop'` block into a helper:

```typescript
private async handleStopDecision(
  loop: Loop, iteration: LoopIteration, evalResult: EvalResult,
  iterationStatus: LoopIteration['status'],
): Promise<boolean> { /* returns true if handled */ }
```

This would reduce each method by ~20 lines and centralize the transaction logic for stop decisions.

### MEDIUM

**`runJudgeAgent` — 70+ lines with 4 sequential fallback paths** - `src/services/judge-exit-condition-evaluator.ts:172-244`
**Confidence**: 83%
- Problem: The method has four sequential decision paths (emission failure -> completion failure -> structured output -> file-based -> default fallback), each with its own error handling and cleanup. While the linear flow is readable, the method is 72 lines with 6 early returns and several nested conditions. It sits above the 50-line "warning" threshold for function length.
- Fix: The decision extraction (lines 221-243) could be a separate method `extractDecision(judgeTaskId, decisionFilePath)` that encapsulates the structured-output-then-file-then-default fallback chain:

```typescript
private async extractDecision(
  judgeTaskId: TaskId, decisionFilePath: string, loopId: LoopId
): Promise<{ continue: boolean; reasoning: string }> {
  // Try structured output, then file, then default
}
```

**`enrichPromptWithCheckpoint` — accumulating complexity with feedback history** - `src/services/handlers/loop-handler.ts:1444-1499`
**Confidence**: 80%
- Problem: This method now has two distinct responsibilities: (1) injecting previous iteration checkpoint context and (2) accumulating evaluation feedback history from up to 10 iterations with a byte cap. The feedback accumulation loop (lines 1480-1497) adds a second concern that increases the method to ~55 lines. The byte-capping logic (`totalBytes + entry.length > MAX_FEEDBACK_BYTES`) mixes sizing logic into the prompt builder.
- Fix: Extract feedback accumulation into a helper:

```typescript
private buildFeedbackHistory(
  iterations: LoopIteration[], currentIterationNumber: number
): string | undefined
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`loop-handler.ts` file length: 1834 lines** - `src/services/handlers/loop-handler.ts`
**Confidence**: 90%
- Problem: The file is 1834 lines, well above the 500-line "critical" threshold for file length. This PR adds ~208 net lines to an already-large file, pushing it further from maintainability. The file contains iteration engine, result handling, git operations, pipeline management, recovery, and prompt enrichment — at least 6 distinct concerns.
- Fix: This is acknowledged pre-existing technical debt but the PR should not make it worse. Consider extracting one or more of: (a) git operations (`setupGitForIteration`, `handleIterationGitOutcome`, `commitAndCaptureDiff`, `resetIterationGitState`, `getResetTargetSha`) into a `LoopGitManager` helper class (~150 lines); (b) the pipeline iteration methods into a separate module. This is not blocking for this PR but should be addressed soon.

**`handleLoopCancelled` iterates all entries in `taskToLoop` map** - `src/services/handlers/loop-handler.ts:406-410`
**Confidence**: 80%
- Problem: The cancellation handler iterates every entry in `this.taskToLoop` to find and delete entries matching `loopId`. With many concurrent loops, this is O(n) where n is total tracked tasks across all loops. The same pattern repeats for `pipelineTasks` (lines 426-430). Two linear scans in a single event handler.
- Fix: Add a reverse index `loopToTasks: Map<LoopId, Set<TaskId>>` maintained alongside `taskToLoop` insertions/deletions. Cancellation then becomes O(tasks-in-loop) instead of O(all-tracked-tasks).

## Pre-existing Issues (Not Blocking)

### HIGH

**`cli.ts` main dispatch — deeply nested if/else chain (300+ lines)** - `src/cli.ts:50-340`
**Confidence**: 92%
- Problem: The main CLI dispatch is a single function with 20+ else-if branches, each containing argument parsing and validation logic. The `run --foreground` branch alone is 130+ lines with 12 nested if/else blocks for flag parsing. This PR adds another branch (`schedule executor`), further extending the chain. This is the single most complex function in the codebase.
- Fix: Refactor to a command registry pattern or use a CLI framework. Each command handler should be a separate module with its own argument parser. Not blocking this PR since only 4 lines were added.

**`database.ts` `getMigrations` — monolithic 600+ line method** - `src/implementations/database.ts:262-861`
**Confidence**: 95%
- Problem: The `getMigrations()` method returns an array of 21 migration objects totaling ~600 lines. Each migration is a closure with inline SQL. This is the longest single method in the codebase. This PR adds migration v21 (lines 840-860), which is clean and small, but the container method is critically long.
- Fix: Move migrations to separate files (`migrations/v001.ts`, `migrations/v021.ts`, etc.) and auto-load them. This is established practice in every migration framework. Not blocking since the PR's addition (20 lines) is clean.

## Suggestions (Lower Confidence)

- **`extractHandlerDependencies` repetitive pattern** - `src/services/handler-setup.ts:133-216` (Confidence: 72%) — The function has 18 sequential `getDependency` calls each followed by an `if (!result.ok) return` guard. A generic extraction loop or batch-get utility would reduce the 80+ lines of boilerplate to ~20 lines.

- **`buildEvalPrompt` duplication across three evaluators** - `src/services/agent-exit-condition-evaluator.ts:158-204`, `src/services/feedforward-evaluator.ts:128-157`, `src/services/judge-exit-condition-evaluator.ts:249-278` (Confidence: 68%) — All three evaluators build similar prompts with preIterationCommitSha lookup, git diff instructions, and template interpolation. The shared logic could be extracted to a utility function.

- **`DEFAULT_CONFIG` removal shifts defaults to Zod schema only** - `src/core/configuration.ts:58-84` (Confidence: 62%) — The explicit `DEFAULT_CONFIG` object was removed, relying entirely on Zod `.default()` values. While DRY, this means configuration defaults are now only discoverable by reading the schema definition, which mixes validation with documentation.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 2 | 0 | 0 |

**Complexity Score**: 6/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The PR introduces a well-architected strategy pattern (CompositeExitConditionEvaluator routing to Feedforward/Judge/Schema evaluators) with good separation of concerns at the module level. The `eval-task-waiter.ts` extraction is a textbook deduplication. However, the loop-handler.ts file continues to accumulate complexity and is now 1834 lines with several methods exceeding the 50-line threshold. The two HIGH-severity blocking items (`handleTaskTerminal` nesting and `handleRetryResult`/`handleOptimizeResult` duplication) are addressable with targeted method extraction without restructuring the architecture.

Conditions for approval:
1. Extract the stale-state guard from `handleTaskTerminal` into a dedicated helper method
2. Extract the shared `decision === 'stop'` transaction block from the two result handlers
