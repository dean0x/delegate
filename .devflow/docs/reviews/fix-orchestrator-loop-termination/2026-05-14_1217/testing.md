# Testing Review Report

**Branch**: fix/orchestrator-loop-termination -> main
**Date**: 2026-05-14

## Issues in Your Changes (BLOCKING)

### HIGH

**Missing test coverage for binary search truncation in `enrichPromptWithGitContext`** - `src/services/handlers/loop-handler.ts:1701-1718`
**Confidence**: 92%
- Problem: The binary search truncation logic (lines 1701-1718) is a non-trivial algorithm that caps git context at `MAX_GIT_CONTEXT_BYTES` (4096 bytes). No test exercises this code path. The freshContext git context injection tests only verify that git context is prepended or skipped, but never trigger the truncation branch. This is a critical path untested — if the binary search has an off-by-one error, the prompt could be empty or exceed the budget.
- Fix: Add a test in the `freshContext git context injection` describe block that mocks `getRecentGitLog` to return a very long string (e.g., 5000+ bytes), then verifies the resulting task prompt's git context section is capped at or below 4096 bytes. Example:

```typescript
it('should truncate git context when it exceeds MAX_GIT_CONTEXT_BYTES (4096)', async () => {
  // Return a massive git log that exceeds 4KB
  const largeLo = Array.from({ length: 200 }, (_, i) =>
    `abc${i.toString().padStart(4, '0')} feat: very long commit message number ${i} with extra padding text`
  ).join('\n');
  vi.mocked(getRecentGitLog).mockResolvedValue({ ok: true, value: largeLo });
  vi.mocked(getRecentGitDiffStat).mockResolvedValue({ ok: true, value: null });
  mockEvaluator.evaluate.mockResolvedValue({ passed: false, exitCode: 1 });

  const loop = await createAndEmitLoop({
    freshContext: true,
    workingDirectory: '/workspace',
    maxIterations: 5,
    maxConsecutiveFailures: 5,
    prompt: 'Original prompt',
  });

  const task1Id = await getLatestTaskId(loop.id);
  await eventBus.emit('TaskCompleted', { taskId: task1Id!, exitCode: 0, duration: 100 });
  await flushEventLoop();

  const task2Id = await getLatestTaskId(loop.id);
  // Verify the git context portion was truncated
  const taskResult = await taskRepo.findById(task2Id!);
  expect(taskResult.ok).toBe(true);
  if (!taskResult.ok) return;
  // The entire prompt (git context + separator + original) exists
  expect(taskResult.value!.prompt).toContain('Original prompt');
  // Git context portion should be under 4096 bytes
  const gitContextEnd = taskResult.value!.prompt.indexOf('\n\n---\n\n');
  const gitContext = taskResult.value!.prompt.substring(0, gitContextEnd);
  expect(Buffer.byteLength(gitContext)).toBeLessThanOrEqual(4096);
});
```

**Missing convergence detection test for non-git loops (RETRY strategy without gitBranch)** - `tests/unit/services/handlers/loop-handler.test.ts:2598-2752`
**Confidence**: 85%
- Problem: The convergence detection `checkConvergence` method has an explicit `isGitLoop` guard (loop-handler.ts:1227) that skips the git diff convergence signal for non-git loops. No test verifies that convergence is correctly skipped when `gitBranch` is not set. The existing convergence tests all set `gitBranch: 'feat/convergence-test'`. Without this negative test, a refactor that accidentally removes the `isGitLoop` guard would not be caught.
- Fix: Add a test case in the `Convergence detection` describe block:

```typescript
it('should NOT trigger git convergence for non-git loops (no gitBranch)', async () => {
  vi.mocked(captureGitDiff).mockResolvedValue({ ok: true, value: null }); // zero-change
  mockEvaluator.evaluate.mockResolvedValue({ passed: false, exitCode: 1 });

  const loop = await createAndEmitLoop({
    strategy: LoopStrategy.RETRY,
    maxIterations: 20,
    maxConsecutiveFailures: 10,
    // NO gitBranch — non-git loop
  });

  // Run 3 iterations
  for (let i = 0; i < 3; i++) {
    const taskId = await getLatestTaskId(loop.id);
    await eventBus.emit('TaskCompleted', { taskId: taskId!, exitCode: 0, duration: 100 });
    await flushEventLoop();
  }

  // Non-git loop should still be running (git convergence skipped)
  const updatedLoop = await getLoop(loop.id);
  expect(updatedLoop!.status).toBe(LoopStatus.RUNNING);
});
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`parseGitDiffChangedLines` tests do not cover singular "1 file changed" without "s"** - `tests/unit/services/handlers/loop-handler.test.ts:2396-2434`
**Confidence**: 82%
- Problem: The `parseGitDiffChangedLines` function uses regex `/(\d+) insertions?\(\+\)/` which handles both "insertions" and "insertion". The existing test at line 2431-2433 covers `1 insertion(+), 1 deletion(-)` but the test suite does not have a case for `1 file changed, 0 insertions(+), 0 deletions(-)` (the zero-change case that git actually outputs as just `1 file changed`). The function returns 0 for this, which is correct, but the test for "files changed" without insertions/deletions markers is implicit rather than explicit. This is a minor gap — the "no changes here" test covers unparseable strings, but a realistic git output of just `1 file changed` (no insertions/deletions) is not tested.
- Fix: Add a case:

```typescript
it('returns 0 when git reports files changed with no insertions or deletions', () => {
  expect(parseGitDiffChangedLines('1 file changed')).toBe(0);
});
```

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Compensation tests still assert `existsSync(failedOrch.stateFilePath)` for agent eval mode** - `tests/integration/orchestration-lifecycle.test.ts:207, 239`
**Confidence**: 85%
- Problem: After the switch to agent eval mode, `createOrchestration` no longer creates state files — `stateFilePath` is set to empty string `''`. The two compensation tests (lines 181 and 213) still call `expect(existsSync(failedOrch.stateFilePath)).toBe(false)`, which now asserts `existsSync('')` returns false. While `existsSync('')` does return `false` in Node.js, the assertion no longer tests what the comment says ("State file should NOT exist — compensation cleaned it up"). The state file was never created in the first place. These assertions are vacuous rather than wrong, but they are misleading.
- Fix: Update the assertions and comments to reflect the new behavior:

```typescript
// Agent eval mode: no state file was ever created (empty stateFilePath)
expect(failedOrch.stateFilePath).toBe('');
```

## Suggestions (Lower Confidence)

- **Missing test for convergence `reason` string in the completed loop** - `tests/unit/services/handlers/loop-handler.test.ts:2607-2635` (Confidence: 70%) — The convergence tests verify `status === COMPLETED` but do not assert the completion reason contains "Convergence detected". Verifying the reason string would catch regressions in the diagnostic message.

- **No test for `enrichPromptWithGitContext` when only one of `gitLog`/`gitDiffStat` is non-null** - `tests/unit/services/handlers/loop-handler.test.ts:2436-2596` (Confidence: 65%) — The tests cover both-null and both-non-null paths, but the partial-data path (e.g., `gitLog` is non-null, `gitDiffStat` is null) is only implicitly tested via the error-handling test at line 2530 where `getRecentGitLog` fails and `getRecentGitDiffStat` returns null. A dedicated positive test with one populated and one null would make the conditional sections more explicitly verified.

- **`orchestrator-prompt-snippets.test.ts` drift test for `buildStateManagementInstructions` without stateFilePath** - `tests/unit/services/orchestrator-prompt-snippets.test.ts:191-207` (Confidence: 62%) — The drift detection tests that compare snippet output to `buildOrchestratorPrompt` output all pass a `stateFilePath`. There is no drift test that verifies the no-state-file path produces consistent output between the snippet builder (`buildStateManagementInstructions({})`) and `buildOrchestratorPrompt({ stateFilePath: '' })`.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | - | 2 | - | - |
| Should Fix | - | - | 1 | - |
| Pre-existing | - | - | 1 | - |

**Testing Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The test suite for this PR is thorough in breadth — all four major feature areas (agent eval mode, git context injection, convergence detection, binary search optimization) have dedicated test coverage. The test design follows the project's behavioral testing pattern with real SQLite and TestEventBus, and the convergence mock isolation (bumping `captureGitDiff` default to 50 lines changed) is well-considered. The two blocking issues are the missing truncation path test and the missing non-git convergence guard test — both are non-trivial code paths with no coverage.
