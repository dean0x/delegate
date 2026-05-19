# Tests Review Report

**Branch**: feat/scheduled-pipelines-78 -> main
**Date**: 2026-03-11
**PR**: #80

## Issues in Your Changes (BLOCKING)

### HIGH

**MCP adapter tests use simulate helpers instead of exercising real adapter code path** - `tests/unit/adapters/mcp-adapter.test.ts:857-990`
- Problem: The new `describe('MCPAdapter - SchedulePipeline & Enhanced Schedule Tools')` block declares `adapter` and `mockScheduleService` in its `beforeEach`, but all four test groups call freestanding helper functions (`simulateSchedulePipeline`, `simulateCancelSchedule`, `simulateListSchedules`, `simulateGetSchedule`) that re-implement the adapter logic inline rather than calling `adapter.handleToolCall()`. This means the actual `handleSchedulePipeline()`, the updated `handleCancelSchedule()`, the enhanced `handleListSchedules()`, and the enhanced `handleGetSchedule()` adapter methods are never exercised by these tests. The helpers duplicate Zod validation, response formatting, and control flow -- if the real adapter diverges from the helpers, tests would still pass while the actual code is broken.
- Impact: Zero integration coverage of the new MCP adapter code paths. The `adapter` variable created in `beforeEach` is never used in any test within this describe block.
- Fix: Replace helper calls with actual adapter invocations. For example:
  ```typescript
  it('should create scheduled pipeline with cron expression', async () => {
    const result = await adapter.handleToolCall('SchedulePipeline', {
      steps: [{ prompt: 'Build project' }, { prompt: 'Run tests' }, { prompt: 'Deploy' }],
      scheduleType: 'cron',
      cronExpression: '0 9 * * 1-5',
    });

    expect(result.isError).toBe(false);
    const response = JSON.parse(result.content[0].text);
    expect(response.success).toBe(true);
    expect(response.scheduleId).toBeDefined();
    expect(response.stepCount).toBe(3);
  });
  ```
  If `handleToolCall` is not directly accessible (it routes through `handleRequest`), use the existing `simulateToolCall` pattern used elsewhere in the test file to exercise the real adapter.

**No test for `cancelSchedule` with `cancelTasks=true` at the service level** - `tests/unit/services/schedule-manager.test.ts:358-384`
- Problem: The `cancelSchedule()` describe block has only two existing tests (emit event, non-existent schedule). The new `cancelTasks` parameter -- which triggers `TaskCancellationRequested` events for in-flight pipeline tasks via execution history lookup -- has no service-level test. The CLI test (`tests/unit/cli.test.ts:1078`) and MCP adapter test only verify the flag is passed through to the mock, not that the actual service behavior works.
- Impact: The most complex new path in `cancelSchedule` (lines 259-282 of `schedule-manager.ts`) -- fetching execution history, extracting `pipelineTaskIds`, emitting cancellation events -- is untested at the service layer where the real logic lives.
- Fix: Add tests to `tests/unit/services/schedule-manager.test.ts` in the `cancelSchedule()` describe block:
  ```typescript
  it('should emit TaskCancellationRequested for pipeline tasks when cancelTasks is true', async () => {
    // Create schedule, trigger it to create execution history with pipelineTaskIds
    // Then call cancelSchedule with cancelTasks=true
    // Assert TaskCancellationRequested emitted for each task ID
  });

  it('should cancel single-task execution when cancelTasks is true and no pipelineTaskIds', async () => {
    // Verify fallback to latestExecution.taskId when pipelineTaskIds is absent
  });
  ```

### MEDIUM

**No error-path test for `createScheduledPipeline` validation (invalid cron, timezone, workingDirectory)** - `tests/unit/services/schedule-manager.test.ts:598-694`
- Problem: The new `createScheduledPipeline()` describe block tests step count validation (< 2, > 20) and happy paths (cron, one_time), but does not test the `validateScheduleTiming` path (invalid cron expression, invalid timezone, invalid scheduledAt datetime, past scheduledAt) or the `validatePath` call for per-step `workingDirectory`. The existing `createSchedule()` tests cover these for single tasks, but `createScheduledPipeline` uses the newly extracted `validateScheduleTiming()` private method which could have a different code path.
- Impact: Validation errors in the scheduled pipeline path would go undetected. The `validateScheduleTiming` refactor consolidates logic from `createSchedule`, so a regression in the extraction would be missed.
- Fix: Add at least 2-3 error-path tests:
  ```typescript
  it('should reject cron schedule without cronExpression', async () => {
    const result = await service.createScheduledPipeline(
      scheduledPipelineRequest({ cronExpression: undefined })
    );
    expect(result.ok).toBe(false);
  });

  it('should reject invalid per-step workingDirectory', async () => {
    const result = await service.createScheduledPipeline(
      scheduledPipelineRequest({ steps: [{ prompt: 'a', workingDirectory: '../escape' }, { prompt: 'b' }] })
    );
    expect(result.ok).toBe(false);
  });
  ```

**Pipeline trigger partial failure test uses `vi.spyOn` with dynamic imports** - `tests/unit/services/handlers/schedule-handler.test.ts:724-770`
- Problem: The `should handle partial save failure by cancelling saved tasks` test uses `vi.spyOn(taskRepo, 'save')` with a custom implementation that dynamically imports `result` and `errors` modules (`await import('../../../../src/core/result')`). Dynamic imports in mocked implementations are fragile -- they introduce async overhead in what should be a synchronous mock, and couple the test to import paths. Additionally, the mock does not restore the original after each call correctly since `mockRestore()` is called after `triggerSchedule()` but the spy is declared inline.
- Impact: This is a minor fragility concern. The test works today but could break if module resolution changes. The dynamic import is unnecessary since `err` and `AutobeatError` are already imported at the top of the test file.
- Fix: Use the already-imported `err` and `AutobeatError`:
  ```typescript
  const saveSpy = vi.spyOn(taskRepo, 'save').mockImplementation(async (task) => {
    saveCallCount++;
    if (saveCallCount === 3) {
      return err(new AutobeatError(ErrorCode.SYSTEM_ERROR, 'Simulated DB failure on step 3'));
    }
    return originalSave(task);
  });
  ```
  Note: Check if `err` from `result.ts` and `AutobeatError`/`ErrorCode` from `errors.ts` are already in scope from the test file's imports. If not, add static imports.

**Dependency cascade test relies on sequential event emission without verifying intermediate state** - `tests/unit/services/handlers/dependency-handler.test.ts:1217-1268`
- Problem: The `should cascade cancellation through multi-level chain` test creates A->B->C, fails A, then manually emits `TaskCancelled` for B to trigger cascade to C. The comment says "Simulate B being cancelled (downstream of the cancellation request)" but this manual emission means the test does not verify that B would actually be cancelled by the system. The test proves cascade works step-by-step but does not prove the full end-to-end chain resolves automatically.
- Impact: If the `TaskCancellationRequested` event fails to result in an actual `TaskCancelled` event (e.g., the worker handler or persistence handler doesn't process it), the cascade would break in production but this test would still pass.
- Fix: This is acceptable for a unit test of `DependencyHandler` in isolation -- the handler only emits `TaskCancellationRequested`, and another handler processes it. Document this boundary explicitly:
  ```typescript
  // NOTE: DependencyHandler emits TaskCancellationRequested; the actual cancellation
  // (TaskCancelled) is handled by WorkerHandler/PersistenceHandler. We simulate
  // that here to test the cascade chain within DependencyHandler's scope.
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`MockScheduleService` in MCP adapter test has growing complexity** - `tests/unit/adapters/mcp-adapter.test.ts:978-1100`
- Problem: The `MockScheduleService` class has grown to include 13 methods, 7 configurable failure flags, 4 call-tracking arrays, and 2 result override properties. This exceeds the 20-line mock setup guideline from the test patterns. As the service interface grows, maintaining this mock becomes error-prone.
- Impact: Test maintenance burden increases. New methods added to `ScheduleService` require updating this mock, and forgetting to do so would cause type errors or silent test gaps.
- Fix: Consider extracting a shared `createMockScheduleService()` factory into the test fixtures directory, or use a partial mock approach that only overrides the methods needed per test group.

**Stub `stubScheduleService` missing `createScheduledPipeline` initially requires `ok(null)` cast** - `tests/unit/adapters/mcp-adapter.test.ts:183`
- Problem: The stub returns `ok(null)` for `createScheduledPipeline`, but the `ScheduleService` interface declares the return type as `Promise<Result<Schedule>>`. Returning `ok(null)` where `Schedule` is expected is a type mismatch that could mask issues in tests that use the stub.
- Impact: If any test accidentally exercises the stub's `createScheduledPipeline`, it would get `null` instead of a valid `Schedule`, causing confusing failures.
- Fix: Return a proper mock `Schedule` object or make it throw an explicit error:
  ```typescript
  createScheduledPipeline: vi.fn().mockRejectedValue(new Error('Not configured for this test group')),
  ```

### LOW

**Queue handler fast-path test verifies log message string** - `tests/unit/services/handlers/queue-handler.test.ts:171`
- Problem: `expect(logger.hasLogContaining('fast-path')).toBe(true)` asserts on the presence of a specific substring in log output. If the log message wording changes, the test breaks even though behavior is correct.
- Impact: Minor brittleness. The important assertion is that the task was NOT enqueued (`queue.size() === 0`), which is already tested.
- Fix: Either remove the log assertion (the behavioral assertion is sufficient) or use a more stable pattern like checking log level + context fields rather than message text.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**No integration test for full pipeline trigger flow** - Across test files
- Problem: The pipeline trigger path (`ScheduleHandler.handlePipelineTrigger`) is tested in `schedule-handler.test.ts` with real SQLite, but there is no full integration test that exercises `ScheduleManagerService.createScheduledPipeline` -> event emission -> `ScheduleHandler` creation -> `DependencyHandler` cascade in a single flow. Each piece is tested in isolation.
- Impact: Integration gaps between the schedule manager, schedule handler, dependency handler, and queue handler could be missed.
- Fix: Consider adding an integration test in `tests/unit/services/` or `tests/integration/` that:
  1. Creates a scheduled pipeline via `ScheduleManagerService`
  2. Triggers the schedule
  3. Verifies all N tasks are created with correct dependencies
  4. Completes step 0 and verifies step 1 is unblocked

### LOW

**`simulateScheduleCreatePipeline` helper in CLI tests duplicates MissedRunPolicy mapping** - `tests/unit/cli.test.ts:2087-2130`
- Problem: The helper re-implements the `missedRunPolicy` string-to-enum mapping (catchup/fail/skip) that already exists in the source CLI code. If the mapping logic changes in the source, the test helper would need manual synchronization.
- Impact: Low -- the test helper is a convenience function and the mapping is simple.
- Fix: Consider importing the mapping utility from the source if one exists, or document that this mirrors the CLI logic.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | - | 0 | 2 | 1 |
| Pre-existing | - | - | 1 | 1 |

**Tests Score**: 6/10

The test suite adds solid coverage for the new pipeline trigger logic in `ScheduleHandler` (5 behavioral tests with real SQLite), `ScheduleManager` pipeline creation (5 tests), dependency failure cascade (3 tests), queue handler fast-path (2 tests), and repository pipeline_steps round-trip (4 tests). However, two significant gaps reduce confidence: (1) the MCP adapter tests for the new tools use simulate helpers that bypass the real adapter code entirely, providing zero coverage of the actual `handleSchedulePipeline`, enhanced `handleCancelSchedule`, `handleListSchedules`, and `handleGetSchedule` methods; and (2) the `cancelSchedule` with `cancelTasks=true` has no service-level test for the actual task cancellation logic.

**Recommendation**: CHANGES_REQUESTED

The two HIGH issues should be addressed before merge:
1. MCP adapter tests must exercise the real adapter, not duplicate its logic in helpers
2. Service-level test for `cancelSchedule` with `cancelTasks=true` is needed to cover the pipeline task cancellation flow
