# Tests Review Report

**Branch**: fix-git-integration -> main
**Date**: 2026-03-25

## Issues in Your Changes (BLOCKING)

### HIGH

**Test comment contradicts source behavior -- missing assertion for git reset on TaskFailed** - `tests/unit/services/handlers/loop-handler.test.ts:1434-1453`
**Confidence**: 95%
- Problem: The test "should reset to gitStartCommitSha on task failure" contains comments stating "Task failure does NOT go through git commit/reset path" and "(only exit condition evaluation triggers git operations)". However, the source code at `src/services/handlers/loop-handler.ts:252` explicitly calls `await this.resetIterationGitState(loop, iteration, 'task failure')` on the TaskFailed path -- this was a deliberate v0.8.1 addition. The test verifies that the iteration status is `'fail'` but never asserts that `resetToCommit` was called. This means the key v0.8.1 behavior (revert working directory on task crash) is completely unverified. The misleading comments compound the issue by actively discouraging future developers from adding the assertion.
- Fix: Correct the comments and add the missing assertion:
```typescript
it('should reset to gitStartCommitSha on task failure', async () => {
  const loop = await createGitLoop({ maxConsecutiveFailures: 5 });
  const taskId = await getLatestTaskId(loop.id);

  await eventBus.emit('TaskFailed', {
    taskId: taskId!,
    error: { message: 'Task crashed', code: 'SYSTEM_ERROR' },
    exitCode: 1,
  });
  await flushEventLoop();

  // v0.8.1: task failure DOES trigger git reset to revert working directory
  expect(vi.mocked(resetToCommit)).toHaveBeenCalledWith(
    '/tmp',
    'aaa1111222233334444555566667777888899990000',
  );

  const allIters = await loopRepo.getIterations(loop.id, 10);
  expect(allIters.ok).toBe(true);
  const iter1 = allIters.value.find((i) => i.iterationNumber === 1);
  expect(iter1).toBeDefined();
  expect(iter1!.status).toBe('fail');
});
```

### MEDIUM

**No direct unit tests for `captureLoopGitContext` in git-state.test.ts** - `src/utils/git-state.ts:301-319`
**Confidence**: 88%
- Problem: `captureLoopGitContext` is a new exported function added in this branch with 3 distinct code paths: (1) `captureGitState` returns error, (2) not a git repo (null value), (3) git repo with/without `gitBranch`. It is tested only indirectly via mocked calls in `loop-manager.test.ts` and `schedule-handler.test.ts`, but those tests mock `captureLoopGitContext` itself -- they never exercise the real function's branching logic. The git-state.test.ts file tests all other exported functions but omits this one.
- Fix: Add a `describe('captureLoopGitContext')` block to `tests/unit/utils/git-state.test.ts` that imports and tests the real function with mocked `execFile` responses covering all 3 paths.

**No test for pipeline iteration git reset on failure** - `src/services/handlers/loop-handler.ts:1383`
**Confidence**: 82%
- Problem: The source code at line 1383 calls `await this.resetIterationGitState(loop, iteration, 'pipeline step failure')` when a pipeline step fails. The existing pipeline failure test (line 486) pre-dates the git integration and does not verify git reset behavior. The new git integration tests (line 1251+) only cover single-task loops. This leaves the pipeline-specific git reset path untested.
- Fix: Add a test to the "Git commit-per-iteration" describe block that creates a pipeline git loop, fails an intermediate step, and asserts `resetToCommit` was called with the loop's `gitStartCommitSha`.

## Issues in Code You Touched (Should Fix)

_None found._

## Pre-existing Issues (Not Blocking)

_None found._

## Suggestions (Lower Confidence)

- **No test for `git clean -fd` failure within `resetToCommit`** - `tests/unit/utils/git-state.test.ts:456` (Confidence: 65%) -- The `resetToCommit` tests verify `git reset --hard` failure, but there is no test where `git reset` succeeds and `git clean -fd` fails. Since both commands run in a single try/catch, a clean failure after successful reset would leave tracked files reset but untracked files remaining. Verifying this explicitly would increase confidence.

- **Optimize discard test relies on mock ordering sensitivity** - `tests/unit/services/handlers/loop-handler.test.ts:1403-1432` (Confidence: 62%) -- The "should reset to best iteration gitCommitSha on optimize discard" test uses `mockResolvedValueOnce` chaining for two iterations. If internal call order changes, the `Once` mocks would be consumed prematurely. Consider using `mockImplementation` with call-count logic for more robust multi-iteration tests.

- **`isValidCommitSha` does not have an uppercase hex rejection test** - `src/utils/git-state.ts:373` (Confidence: 60%) -- The regex `/^[0-9a-f]+$/` correctly rejects uppercase, but there is no test asserting that `resetToCommit('/workspace', 'ABC1234')` fails. Adding this boundary test would document the expected case sensitivity.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Tests Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

**Rationale**: The new test coverage for v0.8.1 git integration is substantial and well-structured: 10 new tests in loop-handler, 4 in loop-manager, 3 in schedule-handler, and 14 in git-state.test.ts covering the new utility functions. Tests follow established project patterns (behavioral testing with real SQLite, Result-pattern assertions, proper vi.mock hoisting). The test-to-source mapping is solid across all layers (unit, handler integration, service entry points). The HIGH finding is a test-source contradiction where the test's comments and missing assertion actively hide a v0.8.1 feature (git reset on task failure) from verification. The two MEDIUM findings are coverage gaps for a new exported utility function and a pipeline-specific code path. Once the HIGH issue is addressed, the test suite would provide strong confidence in the commit-per-iteration design.
