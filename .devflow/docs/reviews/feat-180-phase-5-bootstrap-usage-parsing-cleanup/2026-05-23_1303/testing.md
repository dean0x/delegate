# Testing Review Report

**Branch**: feat/180-phase-5-bootstrap-usage-parsing-cleanup -> main
**Date**: 2026-05-23T13:03

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

### MEDIUM

**B1-4 and B1-5 fixes in reuseSession() in-place path have no dedicated test coverage** - `src/implementations/event-driven-worker-pool.ts:445-492`
**Confidence**: 85%
- Problem: The `reuseSession()` method has two code paths: (1) the B1-1 path where `WorkerState` was removed by `cleanupWorkerState` and must be re-registered, and (2) the in-place remap path where `WorkerState` still exists. Path (1) has thorough regression tests (B1-1, B1-2, B1-3). Path (2) — the in-place remap with the new B1-4 (flushingInProgress cleanup) and B1-5 (DB re-registration) fixes — has no dedicated regression tests. The existing Phase 5 tests that exercise reuse (e.g., "second spawn with same key reuses session") hit this path, but they do not assert the B1-4 or B1-5 behaviors specifically (no assertion that `flushingInProgress` is cleared for the old task, no assertion that `workerRepository.unregister` + `register` are called during reuse).
- Fix: Add two focused regression tests:
  - **B1-4**: Spawn persistent task, trigger a flush-in-progress state for task1, then reuse for task2. Assert that the first flush tick for task2 is not skipped.
  - **B1-5**: Spawn persistent task, reuse for task2 (while WorkerState is still present — i.e., before onExit fires). Assert `workerRepository.unregister` and `workerRepository.register` were called with the new task ID during the reuse.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**No unit tests for the extracted `attachAndFinalize` function** - `src/cli/commands/orchestrate-interactive.ts:300-382`
**Confidence**: 82%
- Problem: `attachAndFinalize` was extracted from `handleOrchestrateInteractive` as a standalone function with non-trivial branching logic: SIGINT handling (first Ctrl+C sends C-c, second force-destroys), detach vs. exit detection via `isAlive`, an event-driven exit callback deadline via `Promise.race`, and multi-path finalization (cancelled/completed/failed). This function has zero test coverage. The prior version had the same code inline with the same coverage gap, so this is not a regression — but the extraction into a named function with a typed context interface is a good opportunity to add testability.
- Fix: The function calls `process.exit` directly and spawns a child process (`tmux attach-session`), making direct unit testing impractical without significant mocking. Two options:
  1. **Accept as-is**: This is a CLI-layer function that follows the established pattern of `process.exit` on all paths (documented as DECISION). Integration testing would require a real tmux session. Given the PR scope (refactoring, not new behavior), this is a reasonable position.
  2. **Future improvement**: Extract the decision logic (exit code determination, finalization outcome) into a pure function that can be unit tested independently of `process.exit` and tmux.

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Mock `_simulateOutput` calls omitted `sequence` and `timestamp` in some older tests** - `tests/unit/implementations/event-driven-worker-pool.test.ts:383-388` (Confidence: 65%) — The AC-7 output routing tests pass `OutputMessage` objects with only `type` and `content` fields. This worked because the mock connector's `_simulateOutput` passes the message through to the callback without validation. The newly added test at line 1005 correctly includes `sequence` and `timestamp` fields. The older tests still work but rely on the callback ignoring missing fields. Harmless but inconsistent.

- **Removed `updateInteractiveOrchestrationPid` test suite drops PID validation edge-case coverage** - `tests/unit/interactive-orchestrator.test.ts` (deleted lines 589-707) (Confidence: 72%) — The deleted suite covered PID validation rules (zero, negative, float, persist-to-DB, race-with-cancel). Since `updateInteractiveOrchestrationPid` was removed from both the interface and implementation, these tests are correctly removed. However, PID validation still exists implicitly in `cancelOrchestration` (line 603: `Number.isInteger(orchestration.pid) && orchestration.pid > 0`). The ESRCH test at line 378 covers the happy path but does not cover edge cases like float or negative PIDs being stored in the DB from older migrations. This is pre-existing and informational only.

- **B1-2 regression test relies on sendKeys call counting** - `tests/unit/implementations/event-driven-worker-pool.test.ts:1185-1215` (Confidence: 68%) — The test uses a manual `sendKeysCallCount` variable to fail on the second `sendKeys` call. This was already identified and corrected in Cycle 2 (commit 7206076). The current implementation is correct, but the pattern of counting calls is fragile if the internal call order changes. A more robust approach would be to match on the prompt content rather than call index.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Testing Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Rationale

The test changes in this PR are well-structured and behavior-focused. Key strengths:

1. **Excellent regression coverage for B1-1/B1-2/B1-3**: The three new regression tests in the worker pool accurately model the real-world loop lifecycle (spawn -> complete -> reuse) and verify the critical fixes. Test names reference bug IDs for traceability.

2. **Proper test adaptation for removed API**: The `updateInteractiveOrchestrationPid` tests were correctly removed alongside the API deletion. Tests that still needed the ESRCH path were adapted to seed PID directly via `orchestrationRepo.update(withPid)` — a clean approach that documents why the bypass exists.

3. **Clarifying comments on `_simulateOutput`/`_simulateExit` usage**: The added comments explaining why `task1.id` is used as the callback key (because the mock stores callbacks by the original spawn task ID) improve test readability and prevent future confusion. This was a prior resolution item (B5-3) carried forward properly.

4. **All 122 tests pass** (62 worker pool + 60 interactive orchestrator) with fast execution times.

The one blocking condition is adding test coverage for the B1-4 and B1-5 fixes in the in-place remap path. These are new code paths with no dedicated assertions.
