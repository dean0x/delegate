# Complexity Review Report

**Branch**: fix-git-integration -> main
**Date**: 2026-03-25
**PR**: #120

## Issues in Your Changes (BLOCKING)

### HIGH

**`loop-handler.ts` exceeds file length threshold at 1647 lines** - `src/services/handlers/loop-handler.ts`
**Confidence**: 92%
- Problem: The file was already at ~1400 lines before this branch and the new git integration methods push it to 1647 lines. This significantly exceeds the 500-line critical threshold. While the individual methods added are well-decomposed (20-40 lines each), the class itself has grown into a god-handler encompassing iteration dispatch, git commit/reset orchestration, pipeline management, recovery, cooldown scheduling, and evaluation routing.
- Impact: Cognitive load for any developer entering this file. Finding relevant code requires scanning 1600+ lines. New features touching loops will compound the problem further.
- Fix: Extract the five new git-related methods (`setupGitForIteration`, `handleIterationGitOutcome`, `commitAndCaptureDiff`, `getResetTargetSha`, `resetIterationGitState`) into a dedicated `LoopGitManager` or `IterationGitHandler` class. The LoopHandler would hold a reference and delegate git operations. This is a natural seam -- the git methods only depend on `loop`, `iteration`, `loopRepo`, `logger`, and the imported git-state utilities; no access to `eventBus`, `taskRepo`, or `database` is needed.

```typescript
// Sketch: extracted class
class LoopGitManager {
  constructor(
    private readonly loopRepo: LoopRepository,
    private readonly logger: Logger,
  ) {}

  async setupForIteration(loop: Loop, iterationNumber: number): Promise<string | undefined> { ... }
  async handleOutcome(loop: Loop, iteration: LoopIteration, status: LoopIteration['status']): Promise<GitOutcome> { ... }
  async resetState(loop: Loop, iteration: LoopIteration, context: string): Promise<void> { ... }
}
```

### MEDIUM

**`getResetTargetSha` fetches up to 100 iterations to find one record** - `src/services/handlers/loop-handler.ts:1227`
**Confidence**: 85%
- Problem: `getResetTargetSha` calls `this.loopRepo.getIterations(loop.id, 100)` then uses `.find()` to locate a single iteration by `iterationNumber`. This is a linear scan of up to 100 rows when the target is known ahead of time. The `bestIterationId` field stores the iteration number, not a DB primary key, so there is no direct lookup path.
- Impact: Unnecessary memory and CPU for long-running loops (100 iterations is a realistic ceiling for optimize loops). The complexity is hidden behind a simple-looking `.find()` call.
- Fix: Either (a) add a `findIterationByNumber(loopId, iterationNumber)` method to the repository for O(1) indexed lookup, or (b) store the `gitCommitSha` directly on the loop alongside `bestIterationId` so no iteration fetch is needed at all:

```typescript
// Option B: store best commit SHA on the loop
private async getResetTargetSha(loop: Loop): Promise<string | undefined> {
  if (loop.strategy === LoopStrategy.OPTIMIZE && loop.bestGitCommitSha) {
    return loop.bestGitCommitSha;
  }
  return loop.gitStartCommitSha;
}
```

**`commitAllChanges` has implicit control flow via try/catch as branching** - `src/utils/git-state.ts:331-365`
**Confidence**: 82%
- Problem: The `commitAllChanges` function uses a try/catch inside a try/catch to distinguish "nothing staged" (exit code 0) from "things staged" (non-zero exit code). The inner catch has an empty body that silently swallows the error to mean "proceed to commit." This is a readability anti-pattern where exception control flow substitutes for explicit boolean checks.
- Impact: A reader must understand that `git diff --cached --quiet` returns non-zero when there ARE changes (counterintuitive), and that the empty catch block is intentional, not a bug. Future maintenance risk if someone adds logic to the inner catch.
- Fix: Extract the staged-changes check into a named helper for clarity:

```typescript
async function hasStagedChanges(execOpts: ExecOpts): Promise<boolean> {
  try {
    await execFileAsync('git', ['diff', '--cached', '--quiet'], execOpts);
    return false; // exit 0 = nothing staged
  } catch {
    return true; // non-zero = staged changes exist
  }
}
```

Then the main function reads linearly without nested try/catch.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`handleTaskTerminal` has high cyclomatic complexity (~12 decision paths)** - `src/services/handlers/loop-handler.ts:183-288`
**Confidence**: 83%
- Problem: This method (mostly unchanged in this PR) is the main event handler and spans ~105 lines with many decision branches: null checks on loopId, loop, iteration, status guards (RUNNING/PAUSED), isTaskFailed branching, consecutiveFailures limits, and post-cleanup. The new git reset call at line 252 adds another operation into an already-dense method.
- Impact: Difficult to trace the execution path through all the early returns and conditional branches. The git reset insertion is correct but easy to miss in the noise.
- Fix: The task-failed branch (lines 246-274) could be extracted to a `handleTaskFailure(loop, iteration, event)` method, reducing `handleTaskTerminal` to a dispatcher.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`recoverSingleLoop` has 7+ early-return branches across 115 lines** - `src/services/handlers/loop-handler.ts:1533-1646`
**Confidence**: 80%
- Problem: This recovery method handles 7 distinct cases (no iterations, terminal non-running, pass, fail/discard/crash/keep, no taskId, task still running, task completed/failed/cancelled) across 115 lines. While each branch is individually clear, the sheer number of conditions makes the overall recovery logic hard to reason about as a whole.
- Impact: Informational only -- this method was not modified in this PR.

## Suggestions (Lower Confidence)

- **Dual-responsibility in `setupGitForIteration`** - `src/services/handlers/loop-handler.ts:531-580` (Confidence: 70%) -- This method handles two concerns: branch creation/checkout AND SHA capture. These could be two separate methods for single-responsibility, though the current implementation is readable enough.

- **`captureGitState` has 3 nested try/catch blocks** - `src/utils/git-state.ts:119-171` (Confidence: 65%) -- Pre-existing pattern with outer try/catch wrapping 3 inner try/catch blocks for branch, SHA, and status. Functional but could be simplified with a `safeExec` wrapper.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Complexity Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The new git-related methods are individually well-decomposed (each under 40 lines, clear single responsibilities, good JSDoc contracts, early-return style). The `handleIterationGitOutcome` / `commitAndCaptureDiff` / `resetIterationGitState` / `getResetTargetSha` / `setupGitForIteration` decomposition is solid and follows the existing codebase's patterns. The new utility functions in `git-state.ts` are clean and focused. Notably, the previous review's two HIGH findings have been resolved: `setupGitForIteration` was extracted from `startNextIteration`, and `recordAndContinue`'s git logic was extracted into `handleIterationGitOutcome` with a clean delegation to `resetIterationGitState` -- both reducing nesting and branching as recommended.

The primary remaining concern is the cumulative file size of `loop-handler.ts` (1647 lines), which should be addressed by extracting the git orchestration into its own class. The `getResetTargetSha` iteration scan and `commitAllChanges` nested try/catch are secondary concerns. None of these issues should block merge, but the file length should be addressed before the next feature addition to this file.

**Conditions for approval**: Address file length in a follow-up PR by extracting the five git methods into a `LoopGitManager` class.
