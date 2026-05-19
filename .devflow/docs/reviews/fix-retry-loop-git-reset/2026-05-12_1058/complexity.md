# Complexity Review Report

**Branch**: fix-retry-loop-git-reset -> main
**Date**: 2026-05-12

## Issues in Your Changes (BLOCKING)

### HIGH

**Repeated strategy-conditional reset target pattern (3 occurrences)** -- Confidence: 85%
- `src/services/handlers/loop-handler.ts:268`, `src/services/handlers/loop-handler.ts:1623`, `src/services/handlers/loop-handler.ts:1865`
- Problem: The ternary expression `loop.strategy === LoopStrategy.RETRY ? iteration.preIterationCommitSha : undefined` is duplicated across three call sites (handleTaskTerminal, handlePipelineIntermediateTask, recoverSingleLoop). Each site passes this computed override to `resetIterationGitState`. If the reset-target logic changes (e.g., a third strategy is added, or RETRY behaviour evolves), three call sites must be updated in lockstep. This is a maintenance multiplier -- the complexity lives in the callers rather than in the method that owns the domain knowledge.
- Fix: Move the strategy-aware reset target selection into `resetIterationGitState` itself (or into `getResetTargetSha`), so callers pass `loop` + `iteration` and the method decides internally:
  ```typescript
  private getResetTargetSha(loop: Loop, iteration: LoopIteration): string | undefined {
    if (loop.strategy === LoopStrategy.RETRY) {
      return iteration.preIterationCommitSha;
    }
    if (loop.strategy === LoopStrategy.OPTIMIZE && loop.bestIterationCommitSha) {
      return loop.bestIterationCommitSha;
    }
    return loop.gitStartCommitSha;
  }
  ```
  Then `resetIterationGitState` drops the `overrideTarget` parameter entirely and callers shrink to a single call without the ternary.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**handleTaskTerminal is 130 lines** -- Confidence: 82%
- `src/services/handlers/loop-handler.ts:198-316`
- Problem: At 130 lines, this method exceeds the 50-line warning threshold by over 2x. It handles loop lookup, status guards, iteration guards, event-type branching (TaskFailed vs TaskCompleted), git reset, atomic transactions, failure limit checks, agent eval stale-state refetch, and cleanup. The new changes add further branching inside the TaskFailed path (strategy-dependent override target), increasing cyclomatic complexity. Nesting inside the `handleEvent` callback means the real logic body starts at ~3 levels of indentation.
- Fix: The TaskFailed branch (lines 258-291) is already a self-contained block -- extract it to a `handleTaskFailedForLoop(loop, iteration, event)` private method. This would bring handleTaskTerminal under 100 lines and make the two branches (failed vs completed) independently testable.

**handleOptimizeResult is 112 lines** -- Confidence: 80%
- `src/services/handlers/loop-handler.ts:951-1061`
- Problem: This method handles 5 distinct paths: decision=continue, decision=stop, crash, first-iteration baseline, and score comparison. While unchanged in this PR, the parallel `handleRetryResult` (84 lines) was modified and both methods share the same structural pattern. handleOptimizeResult's length makes it easy to miss a path during review. Pre-existing but relevant since code was touched in the sibling method.
- Fix: Extract the "crash" path (lines 977-994) and the "score comparison" path (lines 1017-1060) into named helpers. This would reduce the method to ~50 lines of decision routing.

**recoverSingleLoop is 123 lines** -- Confidence: 80%
- `src/services/handlers/loop-handler.ts:1782-1904`
- Problem: This recovery method handles 7 distinct states: no iterations, terminal iteration (pass, fail/discard/crash/keep/progress/cancelled), no task ID, task still running, task completed, task failed, and task cancelled. The new 'progress' status was added to the comment at line 1808 but the method's size makes it difficult to verify exhaustiveness. At 123 lines with multiple early-return branches, this is a maintenance concern for crash recovery correctness.
- Fix: Group the terminal-iteration recovery (lines 1802-1815) and the task-status recovery (lines 1850-1903) into separate helper methods. The parent method would become a simple state router under 40 lines.

## Pre-existing Issues (Not Blocking)

### HIGH

**loop-handler.ts file is 1905 lines** -- Confidence: 90%
- `src/services/handlers/loop-handler.ts`
- Problem: The file far exceeds the 500-line critical threshold (1905 lines). It contains the full loop lifecycle: creation, iteration engine, result handling for two strategies, git operations, prompt enrichment, pipeline handling, and crash recovery. While the file is well-structured with section separators, its sheer size means any change requires reading substantial context.
- Fix: Consider extracting git operations (setupGitForIteration, handleIterationGitOutcome, commitAndCaptureDiff, resetIterationGitState, getResetTargetSha) into a `LoopGitManager` class, and recovery methods (rebuildMaps, recoverStuckLoops, recoverSingleLoop) into a `LoopRecovery` class. Each group is cohesive and has clear dependency boundaries.

## Suggestions (Lower Confidence)

- **Inline ternary in isCommitPath check** - `src/services/handlers/loop-handler.ts:1380` (Confidence: 65%) -- The `isCommitPath` variable now checks three statuses (`pass || keep || progress`); if more statuses are added, consider using a Set or array `.includes()` for readability.

- **Migration v26 table recreation could extract column list** - `src/implementations/database.ts:1039-1044` (Confidence: 60%) -- The SELECT column list in the INSERT INTO...SELECT statement must match the CREATE TABLE column list exactly. A mismatch silently corrupts data. This is the established pattern in the codebase (migrations v2, v3, v11, v22), so not a blocking concern, but the manual synchronization is a maintenance risk each time the table is recreated.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | 0 |
| Should Fix | 0 | 0 | 3 | 0 |
| Pre-existing | 0 | 1 | 0 | 0 |

**Complexity Score**: 6/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The changes themselves are well-contained and follow existing patterns. The new 'progress' status adds one more branch to an already-complex handler, but the branch is handled via the existing `recordAndContinue` helper rather than inline logic, which is the right approach. The primary concern is the duplicated strategy ternary across three call sites -- centralizing the reset-target selection into `getResetTargetSha` would eliminate the duplication and make future strategy changes safer. The Should-Fix items are pre-existing method length issues that become more relevant with this PR's additions, but are not regressions introduced by this PR. The migration (v26) follows the exact pattern established by 4 prior migrations (avoids PF-002 -- clean break with no backward-compat path for zero-user feature).
