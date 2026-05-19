# Code Review Summary

**Branch**: fix-retry-loop-git-reset -> main
**Date**: 2026-05-12
**Review Timestamp**: 2026-05-12_1058

## Merge Recommendation: APPROVED WITH CONDITIONS

This PR is **well-crafted and ready to merge** with three optional improvements to prevent latent bugs and improve maintainability. The changes demonstrate strong architectural discipline across all layers (domain types, Zod schemas, migrations, handler logic, UI, tests). The new `progress` status for RETRY loops correctly preserves accumulated work instead of resetting to the loop start on failed exit conditions, fixing a critical semantic bug.

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------|----------|------|--------|-----|-------|
| Blocking | 0 | 0 | 2 | 0 | 2 |
| Should Fix | 0 | 1 | 4 | 0 | 5 |
| Pre-existing | 0 | 1 | 0 | 0 | 1 |

---

## Blocking Issues (Must Fix)

### 1. `getResetTargetSha` Has Latent RETRY Fallback (MEDIUM, 100% confidence)

**Location**: `src/services/handlers/loop-handler.ts:1449-1454`

**Problem**: The method still has a fallback that returns `loop.gitStartCommitSha` when called for RETRY loops. All current RETRY callers pass `overrideTarget = iteration.preIterationCommitSha`, so this path is dead code today. However, the method is strategy-unaware — a future caller that forgets to pass `overrideTarget` for a RETRY loop would silently wipe all accumulated progress by resetting to `gitStartCommitSha`.

**Why it matters**: This is defense-in-depth protection. The method's JSDoc says "Retry callers pass overrideTarget directly" but enforces this as a documentation convention, not via the type system or runtime guard. A new contributor could easily violate this unwritten rule.

**Proposed fix**: Add a defensive warning log that fires if this method is reached for a RETRY loop:

```typescript
private getResetTargetSha(loop: Loop): string | undefined {
  if (loop.strategy === LoopStrategy.RETRY) {
    // RETRY callers must pass overrideTarget to resetIterationGitState.
    // Reaching this method for RETRY indicates a caller forgot the override.
    // This is a footgun — log as warning.
    this.logger.warn('getResetTargetSha called for RETRY loop', {
      loopId: loop.id,
      strategy: loop.strategy,
    });
  }
  if (loop.strategy === LoopStrategy.OPTIMIZE && loop.bestIterationCommitSha) {
    return loop.bestIterationCommitSha;
  }
  return loop.gitStartCommitSha;
}
```

---

### 2. Strategy-Conditional Reset Target Duplicated Across 3 Call Sites (MEDIUM, 95% confidence)

**Locations**: `src/services/handlers/loop-handler.ts:268`, `:1623`, `:1865`

**Problem**: The ternary expression `loop.strategy === LoopStrategy.RETRY ? iteration.preIterationCommitSha : undefined` appears verbatim in three callers: `handleTaskTerminal`, `handlePipelineIntermediateTask`, and `recoverSingleLoop`. This is a violation of DRY — the strategy logic lives in the callers instead of in the method that owns the domain knowledge.

**Why it matters**: If RETRY reset semantics change (or a third strategy is added), all three sites must be updated in lockstep. This is a maintenance multiplier and a regression risk.

**Proposed fix**: Move the strategy-aware target selection into `getResetTargetSha` so the method accepts both `loop` and `iteration` and decides internally:

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

Then drop the `overrideTarget` parameter from `resetIterationGitState` and update all three callers to simply call `resetIterationGitState(loop, iteration)` — the method handles the strategy logic internally.

---

## Should-Fix Issues (Recommended Improvements)

### 3. `handleTaskTerminal` Method is 130 Lines (MEDIUM, 82% confidence)

**Location**: `src/services/handlers/loop-handler.ts:198-316`

**Problem**: At 130 lines, this method exceeds the 50-line warning threshold by 2.6x. It handles loop lookup, status guards, iteration guards, event-type branching (TaskFailed vs TaskCompleted), git reset, atomic transactions, failure limit checks, agent eval stale-state refetch, and cleanup. The new changes add further branching inside the TaskFailed path (strategy-dependent override target), increasing cyclomatic complexity.

**Why it matters**: This method is hard to review and easy to miss a path during maintenance. Nesting inside the `handleEvent` callback means the logic body starts at ~3 levels of indentation.

**Proposed fix**: Extract the TaskFailed branch (lines 258-291) to a private helper `handleTaskFailedForLoop(loop, iteration, event)`. This would bring `handleTaskTerminal` under 100 lines and make the two branches (failed vs completed) independently testable.

---

### 4. `handleOptimizeResult` and `recoverSingleLoop` Are Also Over-Long (MEDIUM, 80% confidence)

**Locations**: 
- `src/services/handlers/loop-handler.ts:951-1061` (handleOptimizeResult, 112 lines)
- `src/services/handlers/loop-handler.ts:1782-1904` (recoverSingleLoop, 123 lines)

**Problem**: These methods have multiple distinct logical paths that make them hard to audit for correctness:
- `handleOptimizeResult`: 5 paths (decision=continue, decision=stop, crash, first-iteration, score comparison)
- `recoverSingleLoop`: 7 paths (no iterations, 7 terminal iteration statuses, task status recovery)

**Why it matters**: The PR adds a new `progress` status, so correctness is critical. Large methods make it harder to verify exhaustiveness.

**Proposed fix**: Extract cohesive sub-paths into private helpers:
- `handleOptimizeResult`: Extract "crash" path (lines 977-994) and "score comparison" path (lines 1017-1060) into named helpers → ~50 lines
- `recoverSingleLoop`: Extract "terminal iteration recovery" (lines 1802-1815) and "task status recovery" (lines 1850-1903) into separate helpers → ~40 lines

---

### 5. Missing Recovery Test for 'progress' Iteration Status (MEDIUM, 85% confidence)

**Location**: `tests/unit/services/handlers/loop-handler.test.ts`

**Problem**: The `recoverSingleLoop()` method explicitly handles `progress` in its comment (line 1808) by falling through to `checkTerminationConditions` then `startNextIteration`. However, there is no dedicated recovery test for `progress` status, unlike `pass`, `fail`, `keep`, and `cancelled` which all have explicit tests in the "Fix J -- Recovery with terminal iterations" describe block (lines 1029-1176).

**Why it matters**: `progress` is a new status with specific semantics (consecutiveFailures=0, work committed). A crash-window recovery test would validate that recovery correctly resumes after a server crash between persisting a `progress` iteration and starting the next iteration.

**Proposed fix**: Add a test in the "Fix J" describe block:

```typescript
it('should start next iteration when recovering progress iteration', async () => {
  const { loop } = await setupCrashWindowScenario({
    iterationStatus: 'progress',
    loopOverrides: { consecutiveFailures: 0 },
  });

  const freshEventBus = new InMemoryEventBus(createTestConfiguration(), new TestLogger());
  await LoopHandler.create({
    loopRepo,
    taskRepo,
    checkpointRepo: createMockCheckpointRepo(),
    eventBus: freshEventBus,
    database,
    exitConditionEvaluator: mockEvaluator,
    logger: new TestLogger(),
  });

  const recoveredLoop = await getLoop(loop.id);
  expect(recoveredLoop!.status).toBe(LoopStatus.RUNNING);
  expect(recoveredLoop!.currentIteration).toBe(2);

  freshEventBus.dispose();
});
```

---

### 6. Missing OPTIMIZE TaskFailed Git Reset Test (MEDIUM, 82% confidence)

**Location**: `tests/unit/services/handlers/loop-handler.test.ts`

**Problem**: The PR made git reset strategy-conditional: RETRY uses `preIterationCommitSha`, OPTIMIZE uses `getResetTargetSha` (bestIterationCommitSha or gitStartCommitSha). There are tests for RETRY task failure reset (T2, T6, T7) and OPTIMIZE crash/discard paths, but no test verifying that OPTIMIZE TaskFailed still resets to `gitStartCommitSha` (or `bestIterationCommitSha` when available).

**Why it matters**: The strategy-conditional logic at line 268 means OPTIMIZE should use the old behavior, but this is not directly verified for the TaskFailed code path. A regression could silently slip through.

**Proposed fix**: Add a test in the "Git commit-per-iteration" describe block:

```typescript
it('OPTIMIZE: task failure resets to gitStartCommitSha (not preIterationCommitSha)', async () => {
  const loop = await createGitLoop({
    strategy: LoopStrategy.OPTIMIZE,
    evalDirection: OptimizeDirection.MAXIMIZE,
    maxConsecutiveFailures: 5,
  });
  const taskId = await getLatestTaskId(loop.id);

  vi.mocked(resetToCommit).mockClear();

  await eventBus.emit('TaskFailed', {
    taskId: taskId!,
    error: { message: 'Task crashed', code: 'SYSTEM_ERROR' },
    exitCode: 1,
  });
  await flushEventLoop();

  // OPTIMIZE uses gitStartCommitSha (not preIterationCommitSha)
  expect(vi.mocked(resetToCommit)).toHaveBeenCalledWith(
    '/tmp',
    'aaa1111222233334444555566667777888899990000'
  );
});
```

---

## Pre-existing Issues (Informational)

### 7. loop-handler.ts File is 1905 Lines (PRE-EXISTING HIGH, 90% confidence)

**Location**: `src/services/handlers/loop-handler.ts`

**Problem**: The file far exceeds the 500-line critical threshold. It contains the full loop lifecycle, two strategies, git operations, prompt enrichment, pipeline handling, and crash recovery. This is not a regression introduced by the PR — the PR adds ~50 lines net — but the file's size means any change requires reading substantial context.

**Recommendation**: Out of scope for this PR (pre-existing), but a future refactoring could extract:
- Git operations (setupGitForIteration, handleIterationGitOutcome, commitAndCaptureDiff, resetIterationGitState, getResetTargetSha) → `LoopGitManager`
- Recovery methods (rebuildMaps, recoverStuckLoops, recoverSingleLoop) → `LoopRecovery`

---

## What This PR Does Well

### Architecture

1. **Clean separation of concerns**: The new `progress` status is introduced at the right layer — domain type → Zod schema → migration → handler logic → UI. Each layer is updated consistently.

2. **Strategy-aware design via parameter injection**: Rather than embedding strategy knowledge inside `resetIterationGitState`, the PR adds an `overrideTarget` parameter, following the Open/Closed principle. (Note: This would be further improved by moving the strategy logic into `getResetTargetSha` per blocking issue #2.)

3. **Atomic transactions**: The `recordAndContinue` method atomically commits both the iteration `progress` status and the `consecutiveFailures: 0` reset in a single transaction, preventing consistency windows.

4. **Migration pattern**: Migration v26 follows the established pattern (v2, v3, v11, v22) for SQLite CHECK constraint updates. The citation of `PF-002` (no backward-compat path) is appropriate.

5. **Event-driven consistency**: State mutations go through transactions, events are emitted after commit, and the recovery path correctly handles the new `progress` status.

### Semantic Correctness

The PR correctly identifies that RETRY and OPTIMIZE have fundamentally different git semantics:
- **RETRY**: Accumulates progress (commit-and-build). Failure resets only to the iteration boundary (`preIterationCommitSha`), preserving prior iterations' work.
- **OPTIMIZE**: Explores alternatives that may be worse. Failure resets to the globally best state (`bestIterationCommitSha` or `gitStartCommitSha`).

### Testing

1. **6 new dedicated test cases** (T4-T9) covering progress semantics, git commit preservation, isolation, and consecutiveFailures reset.
2. **Existing tests updated** (T1-T3) to reflect new semantics, not patched around.
3. **187 handler tests and 94 integration tests** all pass.
4. **Comprehensive coverage** of single-task, pipeline, multi-iteration crash isolation, and recovery scenarios.

### Code Quality

1. **No TypeScript violations**: The `'progress'` status is added to all three sources of truth (domain type, Zod schema, CHECK constraint).
2. **UI consistency**: New status is handled in all presentation layers (format icon, detail view color, CLI color).
3. **Security**: No security issues detected.
4. **Performance**: No algorithmic regressions. Migration v26 is O(n) where n = existing loop iterations (one-time startup cost).
5. **Database**: All 14 columns, 4 indexes, 2 FK constraints, and 1 UNIQUE constraint are preserved in migration v26.
6. **React**: 3-line UI changes are clean and logically placed (cyan color for progress status, filled-circle icon).

---

## Reviewer Scores

| Reviewer | Focus | Score | Recommendation |
|----------|-------|-------|-----------------|
| Security | Security practices | 9/10 | APPROVED |
| Architecture | Design patterns | 9/10 | APPROVED_WITH_CONDITIONS |
| Performance | Algorithmic efficiency | 9/10 | APPROVED |
| Complexity | Code size & cyclomatic complexity | 6/10 | APPROVED_WITH_CONDITIONS |
| Consistency | Pattern consistency | 9/10 | APPROVED |
| Regression | Lost functionality & breaking changes | 9/10 | APPROVED |
| Testing | Test coverage & assertions | 8/10 | APPROVED_WITH_CONDITIONS |
| TypeScript | Type safety & inference | 8/10 | APPROVED_WITH_CONDITIONS |
| React | Component & hook correctness | 10/10 | APPROVED |
| Database | Schema migrations & constraints | 9/10 | APPROVED |

---

## Action Plan

### Before Merge (Blocking)
1. Add defensive warning log to `getResetTargetSha` for RETRY strategy (blocking issue #1)
2. Centralize strategy-conditional reset target into `getResetTargetSha` to eliminate duplication across three callers (blocking issue #2)

### After Merge (Recommended)
1. Extract `handleTaskFailedForLoop` helper from `handleTaskTerminal` to reduce method length
2. Extract cohesive sub-paths from `handleOptimizeResult` and `recoverSingleLoop`
3. Add recovery test for `progress` iteration status
4. Add OPTIMIZE TaskFailed git reset test
5. Consider extracting git operations and recovery methods into separate classes in a future refactoring

---

## Summary

This PR is **high-quality and ready to merge**. The core fix (preserve RETRY loop progress instead of resetting to start) is correct, well-tested, and architecturally sound. The two blocking issues are straightforward: adding a defensive log and centralizing duplicated logic. These changes would eliminate latent bugs and reduce maintenance burden with minimal code churn.

**Confidence**: 95%
