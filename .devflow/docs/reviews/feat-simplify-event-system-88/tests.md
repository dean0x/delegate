# Tests Review Report

**Branch**: feat/simplify-event-system-88 -> main
**Date**: 2026-03-16
**PR**: #91

## Summary of Changes

This PR simplifies the event system by:
1. Removing 9 informational/dead events (WorkerSpawned, WorkerKilled, ResourceWarning, TaskPersisted, TaskResumed, RecoveryStarted, RecoveryCompleted, SystemResourcesUpdated, etc.)
2. Replacing query events (TaskStatusQuery, TaskLogsQuery, NextTaskQuery) with direct repository/service calls
3. Linearizing the TaskPersisted trigger chain (PersistenceHandler now calls QueueHandler.enqueueIfReady directly)
4. Removing AutoscalingManager, QueryHandler, and OutputHandler entirely

**Test file changes**: 638 insertions, 2993 deletions across 17 test files. 3 test files deleted entirely (autoscaling-manager.test.ts, query-handler.test.ts, output-handler.test.ts).

---

## Issues in Your Changes (BLOCKING)

### MEDIUM

**MockTaskRepo partial implementation uses `as unknown as TaskRepository` type assertion** - `tests/unit/services/handlers/worker-handler.test.ts:291`
- Problem: The `MockTaskRepo` class (lines 2028-2057 in the diff) does not implement the `TaskRepository` interface fully, requiring `as unknown as TaskRepository` casts at every construction site. This is repeated 5 times in the file.
- Impact: Type safety is bypassed. If the `TaskRepository` interface changes (e.g., new required methods), these tests will still compile but may fail at runtime in confusing ways.
- Fix: Have `MockTaskRepo` properly implement `TaskRepository` to avoid the `as unknown` cast:
  ```typescript
  class MockTaskRepo implements TaskRepository {
    // ... all methods
  }
  ```
  Alternatively, if there are optional methods, add stubs that throw `new Error('Not implemented')`.

**MockTaskQueue partial implementation uses `as unknown as TaskQueue` type assertion** - `tests/unit/services/handlers/worker-handler.test.ts:291`
- Problem: Same pattern as MockTaskRepo. `MockTaskQueue` does not fully implement `TaskQueue`, requiring `as unknown as TaskQueue` casts.
- Impact: Same type-safety concern. The mock has all required methods implemented but the cast masks it.
- Fix: Add `implements TaskQueue` to the class declaration.

---

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Removed test for TaskResumed event without replacement coverage for resume flow observable behavior** - `tests/integration/task-resumption.test.ts:135-159`
- Problem: The test "should emit TaskResumed event with correct metadata" was deleted because the `TaskResumed` event was removed. However, the resume flow's observable behavior (that a new task is created correctly with the right metadata linking back to the original) was partly covered by this test. The remaining resume tests in `task-manager.test.ts` do cover the core behavior, but the integration-level verification of the full resume pipeline (delegate -> complete -> resume -> verify new task persisted with correct fields) now has one fewer assertion.
- Impact: Low. The unit tests in `task-manager.test.ts` thoroughly cover resume behavior including retry chain tracking. This is more of a gap in integration-level end-to-end verification.
- Fix: Consider adding an integration test that verifies the full resume flow end-to-end, checking that the new task appears in the repository with correct `parentTaskId`, `retryOf`, and `retryCount` fields. Not blocking.

**Resource monitor tests now verify debug logs instead of event emission** - `tests/unit/implementations/system-resource-monitor.test.ts:477-493`
- Problem: Three tests in the monitoring section were updated to assert on debug log messages instead of `SystemResourcesUpdated` events. While this correctly tracks the source change (event emission removed), asserting on log message strings ("Resource status published") is a brittle coupling to implementation details.
- Impact: If the log message text changes, these tests break. Log messages are typically not part of the behavioral contract.
- Fix: Consider testing that monitoring is active by verifying a more stable observable outcome, such as that `getResources()` was called during the monitoring interval, or that the monitor can be started/stopped correctly. The current approach works but is slightly fragile.

### LOW

**Repetitive WorkerHandler construction boilerplate** - `tests/unit/services/handlers/worker-handler.test.ts:291-308`
- Problem: The `new WorkerHandler(config, workerPool, resourceMonitor, newEventBus, taskQueue as unknown as TaskQueue, taskRepo as unknown as TaskRepository, logger)` construction is repeated 4 times in Setup/Teardown tests where new handlers are created, each spanning 8 lines.
- Impact: Readability. If constructor signature changes again, 4+ call sites need updating.
- Fix: Extract a helper factory function:
  ```typescript
  function createWorkerHandler(overrides?: { eventBus?: TestEventBus }) {
    return new WorkerHandler(
      config, workerPool, resourceMonitor,
      overrides?.eventBus ?? eventBus,
      taskQueue, taskRepo, logger,
    );
  }
  ```

---

## Pre-existing Issues (Not Blocking)

### LOW

**test:worker-handler group not included in standard test groups** - `package.json`
- Problem: The `WorkerHandler` tests appear to be excluded from the standard `test:handlers` group (the handlers group only runs dependency-handler, schedule-handler, checkpoint-handler, persistence-handler, and queue-handler). Worker handler tests must be run via `npm run test:worker-handler` separately.
- Impact: Risk of worker handler regressions going unnoticed if developers only run `npm run test:handlers`.
- Fix: This is a pre-existing design decision documented in CLAUDE.md. No action needed for this PR.

---

## Deleted Tests Analysis

The PR deletes 3 entire test files and removes specific tests from other files. This analysis verifies that all deletions are justified by corresponding source code removals.

### Justified Deletions (Source Code Removed)

| Deleted Test File | Lines Removed | Source Removed | Verdict |
|-------------------|---------------|----------------|---------|
| `autoscaling-manager.test.ts` | 688 | `src/services/autoscaling-manager.ts` (297 lines) fully deleted | Correct |
| `query-handler.test.ts` | 365 | `src/services/handlers/query-handler.ts` (179 lines) fully deleted | Correct |
| `output-handler.test.ts` | 91 | `src/services/handlers/output-handler.ts` (80 lines) fully deleted | Correct |

### Justified Individual Test Removals

| Removed Test | File | Reason |
|-------------|------|--------|
| "should emit WorkerKilled event" | event-driven-worker-pool.test.ts | `WorkerKilled` event removed from source |
| "should emit SystemResourcesUpdated events on interval" | system-resource-monitor.test.ts | Replaced with debug log assertion (event removed) |
| "should emit TaskResumed event with correct metadata" | task-resumption.test.ts | `TaskResumed` event removed from source |
| "should emit RecoveryStarted/RecoveryCompleted events" (4 tests) | recovery-manager.test.ts | Both events removed from source |
| "NextTaskQuery" describe block (2 tests) | queue-handler.test.ts | Query event replaced with direct `dequeue()` call |
| "should set checkpointUsed to true when checkpoint was available" | task-manager.test.ts | `TaskResumed` event removed; checkpoint behavior still tested elsewhere |

All deletions are justified. No behavioral coverage was lost without corresponding source removal.

### Modified Tests Analysis

Tests that were updated (not deleted) correctly reflect the new architecture:

| Changed Pattern | Count | Assessment |
|----------------|-------|------------|
| `eventBus.request('TaskStatusQuery', ...)` -> `taskRepo.findById(...)` | 18 | Correct: mirrors source change from event queries to direct repo |
| `eventBus.request('NextTaskQuery', ...)` -> `taskQueue.dequeue()` | 12 | Correct: mirrors source change from event query to direct call |
| `eventBus.request('TaskLogsQuery', ...)` -> `outputCapture.getOutput(...)` | 3 | Correct: mirrors source change in TaskManagerService |
| `WorkerSpawned` -> `TaskStarted` event assertions | 8 | Correct: WorkerSpawned removed, TaskStarted is the remaining lifecycle event |
| `TaskPersisted` event -> `enqueueIfReady()` direct call | 5 | Correct: linearized trigger chain |
| `PersistenceHandler(repo, logger)` -> `PersistenceHandler(repo, queueHandler, logger)` | 1 | Correct: new dependency for direct call pattern |
| `TaskManagerService(eventBus, logger, config)` -> `TaskManagerService(eventBus, logger, config, taskRepo, outputCapture)` | 12 | Correct: new dependencies for hybrid architecture |

---

## Coverage Verification

### New Source Code Paths - Coverage Status

| New/Modified Path | Tested? | Notes |
|-------------------|---------|-------|
| `TaskManagerService` direct `taskRepo.findById()` for getStatus | Yes | task-manager.test.ts covers single/all/null/error |
| `TaskManagerService` direct `taskRepo.findAllUnbounded()` for getStatus | Yes | task-manager.test.ts covers list return |
| `TaskManagerService` direct `outputCapture.getOutput()` for getLogs | Yes | task-manager.test.ts covers output/tail/error |
| `TaskManagerService` direct `taskRepo.findById()` for retry | Yes | task-manager.test.ts covers all retry paths |
| `TaskManagerService` direct `taskRepo.findById()` for resume | Yes | task-manager.test.ts covers all resume paths |
| `TaskManagerService` direct `taskRepo.findById()` for continueFrom | Yes | task-manager.test.ts covers exist/not-found/error |
| `PersistenceHandler` direct call to `queueHandler.enqueueIfReady()` | Yes | persistence-handler.test.ts tests success + failure paths |
| `QueueHandler.enqueueIfReady()` public method | Yes | queue-handler.test.ts tests no-deps/blocked/unblocked |
| `WorkerHandler` direct `taskQueue.dequeue()` | Yes | worker-handler.test.ts via MockTaskQueue |
| `WorkerHandler` direct `taskRepo.findById()` for cancellation | Yes | worker-handler.test.ts via MockTaskRepo |
| `WorkerHandler` direct `taskRepo.findById()` for completion duration | Yes | worker-handler.test.ts covers duration calculation |
| `ResourceMonitor` debug log instead of event emission | Yes | system-resource-monitor.test.ts checks log output |
| `RecoveryManager` without RecoveryStarted/Completed events | Yes | recovery-manager.test.ts still covers all recovery paths |

All new source code paths introduced by this PR have corresponding test coverage.

### getLogs task-not-found path - New Test Added

The PR adds a new test: `"should return taskNotFound when task does not exist"` in task-manager.test.ts for the `getLogs()` method. This is a new edge case that was previously uncoverable because the old event-based query pattern returned generic errors. The new direct-repo pattern makes this error path explicit and tested. Good addition.

---

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 1 |
| Pre-existing | 0 | 0 | 0 | 1 |

**Tests Score**: 8/10

The test changes are thorough and well-aligned with the source refactoring. All deleted tests correspond to deleted source code. All modified tests correctly reflect the new hybrid architecture (events for commands, direct calls for queries). New code paths have coverage. The two blocking MEDIUM issues (type assertion casts on mock classes) are style/safety concerns, not behavioral gaps.

**Recommendation**: APPROVED_WITH_CONDITIONS

Conditions:
1. Consider having `MockTaskRepo` and `MockTaskQueue` in worker-handler tests properly implement their interfaces to avoid `as unknown as` type casts. This is a minor improvement that would strengthen type safety but does not block merge.
