# Testing Review Report

**Branch**: fix-retry-loop-git-reset -> main
**Date**: 2026-05-12

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Missing recovery test for 'progress' iteration status** - `tests/unit/services/handlers/loop-handler.test.ts`
**Confidence**: 85%
- Problem: The `recoverSingleLoop()` method explicitly handles `progress` in its comment (line 1808: `fail / discard / crash / keep / progress / cancelled`) by falling through to `checkTerminationConditions` then `startNextIteration`. However, there is no dedicated recovery test for the `progress` status, unlike `pass`, `fail`, `keep`, and `cancelled` which all have explicit tests in the "Fix J -- Recovery with terminal iterations" describe block (lines 1029-1176). Since `progress` is a new status introduced in this PR with specific semantics (consecutiveFailures=0, work committed), a crash-window recovery test would validate that recovery correctly resumes after a server crash between persisting a `progress` iteration and starting the next iteration.
- Fix: Add a test case in the "Fix J" describe block using `setupCrashWindowScenario`:
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

**Missing OPTIMIZE strategy TaskFailed git reset test** - `tests/unit/services/handlers/loop-handler.test.ts`
**Confidence**: 82%
- Problem: The PR changed `resetIterationGitState` to be strategy-conditional -- RETRY uses `preIterationCommitSha` while OPTIMIZE uses the default `getResetTargetSha` (bestIterationCommitSha or gitStartCommitSha). There are tests for RETRY task failure reset (T2, T6, T7) and for OPTIMIZE discard/crash git reset, but there is no test verifying that OPTIMIZE TaskFailed (task crash, not exit condition failure) still resets to `gitStartCommitSha` (or `bestIterationCommitSha` when available). The strategy-conditional logic at line 268 (`loop.strategy === LoopStrategy.RETRY ? iteration.preIterationCommitSha : undefined`) means OPTIMIZE should use the old behavior, but this is not directly verified for the TaskFailed code path.
- Fix: Add a test in the "Git commit-per-iteration" describe block:
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
  expect(vi.mocked(resetToCommit)).toHaveBeenCalledWith('/tmp', 'aaa1111222233334444555566667777888899990000');
});
```

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

_No critical pre-existing issues found._

## Suggestions (Lower Confidence)

- **OPTIMIZE strategy uses 'fail' for exit-condition-not-met while RETRY uses 'progress'** - `src/services/handlers/loop-handler.ts` (Confidence: 65%) -- The `handleOptimizeResult` method still uses `'discard'` for decision=continue path and increments consecutiveFailures on worse scores, which is correct for OPTIMIZE semantics. However, there is an asymmetry: OPTIMIZE decision=continue uses `'discard'` while RETRY decision=continue uses `'progress'`. This is intentional (OPTIMIZE discards work, RETRY preserves it) but could benefit from a brief JSDoc note explaining the deliberate divergence.

- **No test for enrichPromptWithCheckpoint handling of 'progress' status label** - `tests/unit/services/handlers/loop-handler.test.ts` (Confidence: 62%) -- The `enrichPromptWithCheckpoint` method at line 1549 calls `iter.status.toUpperCase()`, which for `progress` iterations would emit `PROGRESS` in the evaluation history. There is no test verifying this label appears in the enriched prompt, though the existing enrichment test covers the general mechanism.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Testing Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The test suite is well-structured and thorough. The PR adds 6 new dedicated test cases (T4-T9) that cover the core behavioral changes: progress status semantics, git commit preservation, preIterationCommitSha reset isolation, pipeline step failure handling, and consecutiveFailures reset behavior. Existing tests were updated to reflect the new semantics rather than being patched around. The two medium findings are additive coverage gaps (recovery path for the new status, and OPTIMIZE TaskFailed git reset verification) that would strengthen confidence but do not indicate broken behavior. All 187 handler tests and 94 integration tests pass. Applies PF-002: migration v26 uses clean break for the CHECK constraint update, and tests reflect the new status without backward-compatibility scaffolding.
