# Testing Review Report

**Branch**: feat/180-phase-5-bootstrap-usage-parsing-cleanup -> main
**Date**: 2026-05-23

## Issues in Your Changes (BLOCKING)

### HIGH

**Persistent session reuse test does not verify task re-mapping in worker state** - `tests/unit/implementations/event-driven-worker-pool.test.ts:868-889`
**Confidence**: 85%
- Problem: The "second spawn with same key reuses session" test (line 868) correctly verifies that `tmuxConnector.spawn` was called only once and that `setEnvironment` / `sendKeys` were called with the expected args. However, it does not verify the critical behavioral outcome: that `pool.getWorkerForTask(task2.id)` returns the worker (confirming taskToWorker re-mapping succeeded) and that `pool.getWorkerForTask(task1.id)` returns null (confirming the old mapping was removed). The re-mapping logic in `reuseSession` (lines 310-313 of the source) is the core behavior change -- verifying the observable contract (getWorkerForTask) rather than just verifying sendKeys was called would make this test more resilient.
- Fix: Add assertions after the reuse spawn:
```typescript
// Verify task re-mapping: task2 is now mapped, task1 is unmapped
const workerForTask2 = pool.getWorkerForTask(task2.id);
expect(workerForTask2.ok).toBe(true);
if (workerForTask2.ok) expect(workerForTask2.value).not.toBeNull();

const workerForTask1 = pool.getWorkerForTask(task1.id);
expect(workerForTask1.ok).toBe(true);
if (workerForTask1.ok) expect(workerForTask1.value).toBeNull();
```

**No test for concurrent reuse guard (reuseInProgress set)** - `tests/unit/implementations/event-driven-worker-pool.test.ts:860-957`
**Confidence**: 82%
- Problem: The PR description explicitly calls out "concurrent reuse guard (reuseInProgress set)" as an edge case handled by the implementation. The source code at line 258 (`this.reuseInProgress.add(key)`) prevents parallel reuseSession calls for the same key. However, there is no test that exercises this guard -- no test attempts to call `pool.spawn()` with the same persistentSessionKey concurrently while a reuse is in-progress. This is a documented edge case without test coverage.
- Fix: Add a test that calls `pool.spawn(task2)` and `pool.spawn(task3)` concurrently (both with the same persistent key), and verify that one falls through to a fresh spawn (returns WORKER_SPAWN_FAILED or similar) rather than both trying to re-map the same session.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**killAll persistent session test assertion counts destroy calls but not per-session identity** - `tests/unit/implementations/event-driven-worker-pool.test.ts:929-943`
**Confidence**: 83%
- Problem: The "killAll destroys all persistent sessions" test asserts `tmuxConnector.destroy` was called exactly 2 times. However, it does not verify that the destroy calls targeted the correct sessions. Two regular (non-persistent) tasks would also produce 2 destroy calls. The test would pass even if killAll destroyed regular workers' sessions instead of persistent sessions.
- Fix: Assert the specific session handles passed to `destroy`:
```typescript
const destroyCalls = (tmuxConnector.destroy as ReturnType<typeof vi.fn>).mock.calls;
const destroyedSessionNames = destroyCalls.map(([handle]: [TmuxHandle]) => handle.sessionName);
expect(destroyedSessionNames).toContain(`beat-${task1.id}`);
expect(destroyedSessionNames).toContain(`beat-${task2.id}`);
```

**Removed test coverage for spawn argument verification and env var stripping** - `tests/unit/implementations/agent-adapters.test.ts`
**Confidence**: 80%
- Problem: The agent-adapters test file went from ~1000 lines to ~196 lines, removing all tests for: spawn argument construction (--print, --dangerously-skip-permissions, --quiet, --full-auto), environment variable stripping (CLAUDECODE, CLAUDE_CODE_), AUTOBEAT_TASK_ID injection, orchestratorId env injection (security-critical validation), system prompt passthrough (--append-system-prompt), model passthrough (--model), baseUrl injection, and API key injection. The comment on line 5-7 says these moved to build-tmux-command.test.ts, but buildTmuxCommand tests only cover command construction -- they do not cover env var stripping, auth key injection, orchestratorId validation, or system prompt file management. These were responsibilities of the now-removed BaseAgentAdapter.spawn() that are presumably handled by TmuxHooks/TmuxConnector, but there is no replacement test coverage visible in this diff for: env var stripping, auth/baseUrl key injection from config, orchestratorId validation with control character rejection, and SIGTERM/SIGKILL kill escalation.
- Fix: Verify that equivalent behavioral coverage exists in tmux-hooks.test.ts or build-tmux-command.test.ts for all removed scenarios. If not, add tests to the setup-shim or hooks layer that verify env var stripping and security-critical orchestratorId validation survive the migration. (avoids PF-001 -- surfacing the coverage gap rather than deferring)

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Flaky packet loss test uses Math.random() directly** - `tests/unit/error-scenarios/network-failures.test.ts:189-216`
**Confidence**: 85%
- Problem: The "should handle packet loss simulation" test uses `Math.random()` directly with a wide tolerance band (0.15-0.50 for a 30% loss rate). This is a known flaky test pattern. The CLAUDE.md already documents this test as a known flaky CI test. While this was not introduced by this PR (the test existed before), this PR touched the file to remove ProcessSpawner-dependent tests, making this a good opportunity to fix.

## Suggestions (Lower Confidence)

- **Missing negative test for reuseSession when setEnvironment fails** - `tests/unit/implementations/event-driven-worker-pool.test.ts:860` (Confidence: 72%) -- The source code (line 272-280) handles setEnvironment failure by destroying the persistent session and returning an error. This failure path is not tested. A test mocking setEnvironment to return err would verify the graceful degradation to fresh spawn.

- **Bootstrap tmux validation test could verify error message content** - `tests/unit/services/bootstrap-tmux-validation.test.ts:73-85` (Confidence: 65%) -- The "tmux version too old" test verifies the error code is SYSTEM_ERROR but does not check that the message mentions version requirements. Since the error message includes user-facing install instructions, verifying it contains "3.0" would catch regressions in the UX.

- **Loop handler Phase 5 tests use mock workerPool without type assertion** - `tests/unit/services/handlers/loop-handler.test.ts:2945` (Confidence: 62%) -- The `as unknown as Parameters<typeof LoopHandler.create>[0]['workerPool']` cast bypasses type checking. If WorkerPool gains new required methods, this test will still compile but may silently miss broken contracts.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 0 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Testing Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

### Rationale

The test suite demonstrates strong structural coverage for the new persistent session reuse feature: 6 worker-pool tests, 4 loop-handler tests, 2 domain tests, new bootstrap validation tests, setup-shim tests, and setSessionEnvironment tests. Tests follow correct patterns (fake timers with advanceTimersByTimeAsync, AAA structure, behavior-focused assertions). The bootstrap tmux validation tests use proper DI injection (tmuxExec) rather than module-level mocks -- this is the correct pattern for non-isolated vitest.

The two HIGH blocking issues are: (1) the reuse test verifies implementation artifacts (sendKeys, setEnvironment calls) but not the observable behavioral outcome (task re-mapping via getWorkerForTask), and (2) the documented concurrent reuse guard has zero test coverage. Both are straightforward to add.

The removal of ~800 lines of agent-adapter tests deserves attention -- while the buildTmuxCommand tests replace the command-construction coverage, several security-critical test scenarios (orchestratorId validation, env var stripping, auth injection) appear to have no replacement coverage in this diff.
