# Testing Review Report

**Branch**: feat/v1.4.0-reliability-eval-redesign -> main
**Date**: 2026-04-14

## Issues in Your Changes (BLOCKING)

### HIGH

**No dedicated tests for `waitForEvalTaskCompletion` (eval-task-waiter.ts)** - `src/services/eval-task-waiter.ts`
**Confidence**: 88%
- Problem: `eval-task-waiter.ts` is a brand-new 114-line module containing the shared event subscription, cleanup, and fallback timer logic used by all three evaluators. There are zero test files or test cases that import or reference `waitForEvalTaskCompletion`. The function has non-trivial behavior: event subscription/unsubscription, race-safe `resolveOnce`, a fallback timer with `.unref()`, and loop-cancellation propagation via `TaskCancellationRequested`. While the evaluator tests exercise it indirectly through `FeedforwardEvaluator` and `JudgeExitConditionEvaluator`, those tests only cover the happy path (completed) and simple failure path. The following behaviors are untested:
  - Fallback timer fires after `evalTimeout + 5000ms`
  - Loop cancellation triggers `TaskCancellationRequested` for the eval task
  - `TaskTimeout` event resolves the waiter
  - Multiple events arriving simultaneously (only first processed)
  - Subscription cleanup after resolution
- Fix: Add a dedicated `eval-task-waiter.test.ts` covering the fallback timer, loop cancellation propagation, timeout event, and idempotent resolution. Use `TestEventBus` and fake timers:
  ```typescript
  describe('waitForEvalTaskCompletion', () => {
    it('should resolve with timeout when fallback timer fires', async () => { ... });
    it('should emit TaskCancellationRequested when parent loop is cancelled', async () => { ... });
    it('should resolve only once when multiple events arrive', async () => { ... });
    it('should unsubscribe from all events after resolution', async () => { ... });
  });
  ```

**No tests for LoopHandler `decision` field branching** - `src/services/handlers/loop-handler.ts:829-870`
**Confidence**: 85%
- Problem: The loop handler added 167 new lines implementing two major decision branches: `decision === 'continue'` (lines 837-851) which skips `consecutiveFailures` increment, and `decision === 'stop'` (lines 852-870) which completes the loop with a transaction. The existing loop handler test file (`tests/unit/services/handlers/loop-handler.test.ts`) has zero changes in this PR -- no new test cases were added for the `decision` field. A grep for `decision.*continue`, `decision.*stop`, `evalResult.decision`, and `evalResponse` across that test file returns zero matches. This means the core behavioral change of v1.4.0 (feedforward/judge loops continue without penalty via `decision: 'continue'`) has no direct LoopHandler test coverage.
- Fix: Add test cases to `loop-handler.test.ts` that verify:
  1. When `exitConditionEvaluator.evaluate` returns `{ decision: 'continue' }`, `consecutiveFailures` is NOT incremented and the next iteration starts
  2. When `exitConditionEvaluator.evaluate` returns `{ decision: 'stop' }`, the loop is completed and iteration is recorded as `pass`
  3. When `decision` is undefined (backward compat), existing `passed` logic applies unchanged

### MEDIUM

**Feedback accumulation cap tests verify local logic, not production code** - `tests/unit/services/eval-batch3.test.ts:732-773`
**Confidence**: 82%
- Problem: The "Feedback accumulation cap" tests (Section 6) re-implement the capping logic locally in the test rather than exercising the actual production `LoopHandler.buildFeedbackContext` or equivalent method. The tests create arrays with `MAX_FEEDBACK_BYTES = 8192` and verify the local accumulation loop stays under the cap. This tests that the test's own loop works, not that the production code correctly caps feedback. If the production constant or algorithm changes, these tests will not catch the regression.
- Fix: Either (a) export the feedback accumulation function and test it directly, or (b) integration-test through the LoopHandler by providing accumulated iteration history and asserting the prompt passed to the next iteration is capped.

**`handleScheduleExecutor` has no test coverage** - `src/cli/commands/schedule-executor.ts:99-180`
**Confidence**: 80%
- Problem: The `handleScheduleExecutor` function (82 lines) bootstraps the server, writes a PID file, sets up signal handlers, and runs an idle check loop. The test file `schedule-executor-autostart.test.ts` tests the pure utility functions (`getExecutorPidPath`, `readExecutorPid`, `isProcessAlive`, and `ensureScheduleExecutorRunning` contract) but does not test `handleScheduleExecutor` itself. This function contains process lifecycle logic (PID write, signal handler registration, idle check interval, process.exit calls) that is inherently hard to unit test. However, the idle check logic (check active schedules every 5 min, exit if none) is a testable behavioral contract.
- Fix: Extract the idle-check logic into a testable function with injected dependencies (container, cleanup callback, exit callback). Test that it calls `scheduleRepo.findByStatus(ACTIVE)` and invokes exit when the result is empty. The signal handler and bootstrap integration can remain untested (E2E territory).

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Duplicated helper functions across test files** - `tests/unit/services/eval-batch3.test.ts`, `tests/unit/services/eval-domain-batch2.test.ts`, `tests/unit/services/judge-exit-condition-evaluator.test.ts`
**Confidence**: 85%
- Problem: Three new test files each define their own `createOutputRepo`, `createLoopRepo`, `createTestLoop`, `evaluateWithCompletions`, `simulateTaskComplete`, and `simulateTaskFailed` helpers. The implementations are nearly identical (minor variations in mock method sets). This violates DRY and makes maintenance harder -- if the `LoopRepository` interface adds a new method, three separate mock factories need updating. The existing `tests/fixtures/mocks.ts` already centralizes mock creation for other repositories.
- Fix: Extract the shared eval-test helpers into `tests/fixtures/eval-test-helpers.ts`:
  ```typescript
  export function createMockOutputRepo(lines: string[]): OutputRepository { ... }
  export function createMockLoopRepo(opts?: { preIterationCommitSha?: string }): LoopRepository { ... }
  export function createEvalTestLoop(overrides?: Partial<...>): Loop { ... }
  export function evaluateWithCompletions(...): Promise<EvalResult> { ... }
  export function simulateTaskComplete(eventBus: TestEventBus, taskId: string): Promise<void> { ... }
  export function simulateTaskFailed(eventBus: TestEventBus, taskId: string): Promise<void> { ... }
  ```

**Unsafe type casts in test helpers** - `tests/unit/services/eval-batch3.test.ts:131`, `tests/unit/services/judge-exit-condition-evaluator.test.ts:119-120`
**Confidence**: 82%
- Problem: Several test helpers use `as unknown as never` to cast event payloads:
  - `workerId: 'w1' as unknown as never` in `simulateTaskComplete` / `simulateTaskFailed`
  - `return origEmit(type as never, payload as never)` in spy implementations
  These unsafe casts bypass TypeScript's event type contracts. If the event payload shape changes (e.g., `TaskCompletedEvent` gains a required field), the tests will still compile and pass with incomplete payloads, hiding a real breakage.
- Fix: Import the actual branded type constructors (`WorkerId`) and construct valid event payloads:
  ```typescript
  async function simulateTaskComplete(eventBus: TestEventBus, taskId: string): Promise<void> {
    await eventBus.emit('TaskCompleted', {
      taskId: TaskId(taskId),
      workerId: WorkerId('worker-test'),
    });
  }
  ```

## Pre-existing Issues (Not Blocking)

_No critical pre-existing testing issues found in the reviewed files._

## Suggestions (Lower Confidence)

- **`ensureScheduleExecutorRunning` spawn path untested** - `src/cli/commands/schedule-executor.ts:65-87` (Confidence: 70%) -- The test file documents the spawn path is untestable via unit tests due to ESM dynamic import constraints. An integration test that validates the spawn+PID-write cycle in a child process would improve confidence.

- **Composite evaluator test does not cover unknown evalType fallback** - `tests/unit/services/eval-batch3.test.ts:318-329` (Confidence: 65%) -- Tests cover `undefined` evalType defaulting to feedforward, but do not test what happens if an invalid/unknown evalType string is passed (runtime safety net).

- **`evaluateWithCompletions` helper uses `setImmediate` for timing** - `tests/unit/services/eval-batch3.test.ts:116-117` (Confidence: 62%) -- The `await new Promise(r => setImmediate(r))` pattern creates timing-dependent behavior. If event subscription registration becomes async in a future refactor, these tests may become flaky. Consider using a more deterministic completion signal.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Testing Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The PR introduces substantial new functionality (~1300 lines of new source code) with good breadth of testing (~2200 lines of new tests) across evaluator routing, boundary validation, repository round-trips, and utility functions. The test quality follows good patterns: behavior-focused assertions, DI-based mocking (especially the FsAdapter injection for JudgeExitConditionEvaluator which avoids vi.mock contamination), and AAA structure. However, two high-severity gaps should be addressed before merge: (1) the shared `waitForEvalTaskCompletion` module has no dedicated tests for its timer and cancellation-propagation logic, and (2) the core behavioral change in LoopHandler (decision-based branching that bypasses consecutiveFailures) has zero direct test coverage in the handler test file.
