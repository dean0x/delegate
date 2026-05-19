# Tests Review Report

**Branch**: feat/v0.8.0-loop-enhancements -> main
**Date**: 2026-03-23
**PR**: #115

## Issues in Your Changes (BLOCKING)

### HIGH

**MCP adapter `CreateLoop with gitBranch` test does not actually test gitBranch passthrough** - `tests/unit/adapters/mcp-adapter.test.ts:2160`
**Confidence**: 92%
- Problem: The test is titled "should pass gitBranch field to service" but the test body calls `simulateCreateLoop` without passing `gitBranch` in the args. The inline comment even acknowledges this: "The simulate helper doesn't pass gitBranch, but we verify the service accepts it." The test only asserts `createLoopCalls` has length 1, which proves nothing about gitBranch. This is a false-positive test -- it passes but validates no gitBranch behavior.
- Fix: Either update `simulateCreateLoop` to accept and forward `gitBranch`, or call `mockLoopService.createLoop()` directly with a `gitBranch` field and assert it appears in the recorded call:
```typescript
it('should pass gitBranch field to service', async () => {
  const loop = mockLoopService.makeLoop({ prompt: 'Loop with git' });
  mockLoopService.setCreateLoopResult(ok(loop));

  // Call createLoop directly with gitBranch to verify it reaches the service
  await mockLoopService.createLoop({
    prompt: 'Loop with git',
    strategy: 'retry' as any,
    exitCondition: 'npm test',
    gitBranch: 'feat/loop-work',
  });

  expect(mockLoopService.createLoopCalls).toHaveLength(1);
  expect(mockLoopService.createLoopCalls[0].gitBranch).toBe('feat/loop-work');
});
```

---

**MCP adapter PauseLoop/ResumeLoop simulate helpers bypass the actual MCP adapter dispatch** - `tests/unit/adapters/mcp-adapter.test.ts:2183-2230`
**Confidence**: 85%
- Problem: The `simulatePauseLoop` and `simulateResumeLoop` helper functions call `loopService.pauseLoop()` / `loopService.resumeLoop()` directly and manually construct the MCPToolResponse JSON. They do not exercise the actual MCP adapter code paths (`handlePauseLoop`, `handleResumeLoop`) including Zod schema validation (`PauseLoopSchema`, `ResumeLoopSchema`), tool routing in the `switch` statement, or response formatting via `match()`. This means a bug in the adapter's `handlePauseLoop` method (e.g., wrong field name in Zod schema, incorrect JSON response shape) would not be caught by these tests. This is a pattern already present in some other MCP tests, but it is newly introduced here for pause/resume.
- Fix: Route calls through the adapter's `callTool` method to exercise the full stack:
```typescript
it('should pause a loop with graceful mode', async () => {
  const result = await adapter.callTool('PauseLoop', { loopId: 'loop-pause-1' });
  expect(result.isError).toBe(false);
  const response = JSON.parse(result.content[0].text);
  expect(response.success).toBe(true);
  expect(response.force).toBe(false);
});
```

---

**No unit tests for `ScheduleManagerService.createScheduledLoop()`** - `src/services/schedule-manager.ts:478`
**Confidence**: 95%
- Problem: The new `createScheduledLoop` method (59 lines of new business logic) has zero direct unit tests. It validates `loopConfig.exitCondition`, builds a schedule with loopConfig, computes nextRunAt, and emits `ScheduleCreated`. None of these paths are tested. The method is referenced in the MCP adapter's `handleScheduleLoop`, which also has no tests (the `simulateScheduleLoop` helper exists only as a comment label at line 2177 but is never defined or called).
- Fix: Add a `describe('createScheduledLoop()')` block to the schedule-manager test file (or a new file) covering:
  1. Happy path: cron schedule with valid loopConfig creates schedule with loopConfig field populated
  2. Validation: empty exitCondition returns error
  3. Validation: invalid cron expression returns error
  4. Event emission: ScheduleCreated event is emitted with the schedule containing loopConfig
  5. One-time schedule with scheduledAt

---

**No unit tests for `handleScheduleLoop` in MCP adapter** - `src/adapters/mcp-adapter.ts:2316`
**Confidence**: 90%
- Problem: The `ScheduleLoop` MCP tool handler (45+ lines) has no test coverage. The Zod `ScheduleLoopSchema` validation, the mapping from MCP args to `ScheduledLoopCreateRequest`, and the response formatting are all untested. A simulate helper comment label exists at line 2177 but the function is never implemented.
- Fix: Add a `describe('ScheduleLoop')` test block with at minimum: happy path (cron + retry), error propagation, and Zod validation rejection tests.

### MEDIUM

**LoopManager `createLoop` gitBranch validation is untested** - `src/services/loop-manager.ts:179-209`
**Confidence**: 88%
- Problem: The new code path in `createLoop` that calls `captureGitState` when `request.gitBranch` is set has no unit test coverage. Three branches exist: (1) captureGitState returns error, (2) captureGitState returns null/undefined value, (3) captureGitState succeeds and sets `gitBaseBranch`. None are tested. This is the service layer's most significant new validation logic.
- Fix: Add tests to `loop-manager.test.ts` mocking `captureGitState`:
```typescript
describe('createLoop() - gitBranch validation', () => {
  it('should return error when working directory is not a git repo', async () => { ... });
  it('should set gitBaseBranch from current branch', async () => { ... });
  it('should pass gitBranch through to emitted loop', async () => { ... });
});
```

---

**LoopHandler git branch iteration logic has zero test coverage** - `src/services/handlers/loop-handler.ts:518-553`
**Confidence**: 88%
- Problem: The `startNextIteration` method now includes 27 lines of new git branch logic: creating per-iteration branches via `createAndCheckoutBranch`, computing `previousBranch`, setting `iterationGitBranch`, and graceful degradation on failure. The `handleIterationResult` method also has 20 new lines for `captureGitDiff`. The loop-handler test file has zero references to gitBranch, createAndCheckoutBranch, or captureGitDiff. These are complex code paths with branching logic (first iteration vs subsequent, success vs failure degradation) that could easily regress.
- Fix: Add tests that create a loop with `gitBranch` set, mock `createAndCheckoutBranch` and `captureGitDiff`, and verify:
  1. Iteration 1 branches from `gitBaseBranch`
  2. Iteration N branches from iteration N-1
  3. Failed branch creation degrades gracefully (loop continues without git)
  4. Git diff summary is recorded on iteration completion

---

**Schedule-handler `ScheduleTriggered` loop test does not verify LoopCreated event payload** - `tests/unit/services/handlers/schedule-handler.test.ts:1022`
**Confidence**: 82%
- Problem: The test "should create a loop when schedule with loopConfig is triggered" only checks execution history length and status. It does not verify that the `LoopCreated` event was emitted with the correct loop payload (strategy, exitCondition, scheduleId, maxIterations, workingDirectory). Since `LoopHandler` is not wired in this test (as the comment notes), the test cannot verify loop persistence, but it should at least verify event emission with correct data.
- Fix: Use `eventBus.getAllEmittedEvents()` to assert the LoopCreated event payload:
```typescript
const loopCreatedEvents = eventBus.getAllEmittedEvents().filter(e => e.type === 'LoopCreated');
expect(loopCreatedEvents).toHaveLength(1);
const payload = loopCreatedEvents[0].payload as { loop: Loop };
expect(payload.loop.scheduleId).toBe(schedule.id);
expect(payload.loop.strategy).toBe(LoopStrategy.RETRY);
```

---

**Schedule-handler cancel cascade test has a weak assertion** - `tests/unit/services/handlers/schedule-handler.test.ts:1104`
**Confidence**: 80%
- Problem: The test "should cancel active loops when schedule with loopConfig is cancelled" only asserts `logger.hasLogContaining('Cancelling schedule')`. It does not verify that `LoopCancelled` event was emitted, nor does it check the event payload. The comment acknowledges "the loop state depends on LoopHandler subscription" but the test could still verify event emission. The current assertion would pass even if the cascade cancellation logic were entirely removed (the log message comes from the existing cancel handler, not the new cascade code).
- Fix: Assert the LoopCancelled event was emitted:
```typescript
const loopCancelledEvents = eventBus.getAllEmittedEvents().filter(e => e.type === 'LoopCancelled');
expect(loopCancelledEvents).toHaveLength(1);
expect((loopCancelledEvents[0].payload as any).loopId).toBe(existingLoop.id);
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Integration test directly mutates task repo to simulate WorkerHandler (2 occurrences)** - `tests/integration/task-loops.test.ts:540`, `tests/integration/task-loops.test.ts:544`
**Confidence**: 82%
- Problem: The "resume after mid-iteration completion" integration test manually calls `taskRepo.update()` to simulate task completion, then emits `TaskCompleted`. This couples the test to implementation details of how WorkerHandler updates task state. If the internal update sequence changes (e.g., WorkerHandler sets additional fields), this test would silently diverge from production behavior while still passing.
- Fix: This is an acceptable trade-off for integration tests that intentionally avoid spawning real workers. Add a comment documenting the coupling explicitly, or extract a `simulateTaskCompletion(taskId)` helper that mirrors WorkerHandler's exact update pattern to keep it maintainable.

## Pre-existing Issues (Not Blocking)

_No critical pre-existing issues identified in the reviewed test files._

## Suggestions (Lower Confidence)

- **Missing `resumeLoop` rejection of an already-PAUSED loop that was force-paused** - `tests/unit/services/loop-manager.test.ts:436` (Confidence: 65%) -- The resume tests verify rejection of RUNNING and COMPLETED loops, but do not test the scenario where force-pause left the iteration cancelled. This is handled by LoopHandler recovery, but a manager-level test documenting this expectation would improve confidence.

- **Schedule-handler `handleLoopTrigger` collision detection only tested for RUNNING and PAUSED** - `tests/unit/services/handlers/schedule-handler.test.ts:996` (Confidence: 70%) -- The collision detection checks for RUNNING or PAUSED active loops. There is no test for the edge case where the previous loop is in a terminal state (COMPLETED/FAILED) and a new trigger should proceed. While the code handles this by filter, an explicit test would document the expected behavior.

- **Integration test `tempDir` used for sentinel file approach may be flaky on slow CI** - `tests/integration/task-loops.test.ts:517` (Confidence: 60%) -- The sentinel file approach (`test -f ${sentinelFile}`) is used as exit condition but the file is never created in the test, relying on the condition failing. This is actually correct for the test's purpose (verifying resume behavior when exit condition fails), but the approach is fragile if someone later modifies the test without understanding the intent. A brief inline comment clarifying the intentional absence of the sentinel file would help.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 4 | 3 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Tests Score**: 5/10
**Recommendation**: CHANGES_REQUESTED

### Rationale

The v0.8.0 test changes demonstrate good patterns in several areas: the pause/resume lifecycle tests in loop-handler and loop-manager are thorough with proper state transition coverage, the repository tests cover new schema fields well, and the CLI parser tests are focused and behavior-driven.

However, there are significant coverage gaps that warrant changes before merge:

1. **Two entire new features lack test coverage**: `ScheduleManagerService.createScheduledLoop()` (59 lines) and `MCPAdapter.handleScheduleLoop()` (45+ lines) have zero tests between them. This is the most concerning gap.

2. **Git branch integration is untested at handler and manager layers**: The loop-handler's 47 new lines of git branch logic (branch creation per iteration, diff capture on completion, graceful degradation) and the loop-manager's git state validation have no test coverage. Only the low-level `git-state.ts` utilities and repository round-trip are tested.

3. **MCP adapter simulate helpers bypass the adapter layer**: The PauseLoop/ResumeLoop tests call the mock service directly rather than routing through the adapter, leaving Zod validation, tool routing, and response formatting untested.

4. **One test is a false positive**: The `CreateLoop with gitBranch` test explicitly acknowledges it does not test what its name claims.

The existing tests that are present follow good patterns (behavior-focused, proper AAA structure, good edge case coverage for state transitions), which makes the gaps more conspicuous by contrast.
