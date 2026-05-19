# Consistency Review Report

**Branch**: feat/transaction-atomicity-81 -> main
**Date**: 2026-03-18
**PR**: #85

## Issues in Your Changes (BLOCKING)

### HIGH

**Inconsistent factory method parameter ordering** - `src/services/handlers/schedule-handler.ts:72-78`
- Problem: The `ScheduleHandler.create()` factory method places `database` after `logger`, breaking the established convention. All other handler factory methods in this codebase follow the pattern: `(repos..., logger, eventBus, options?)`. The existing `DependencyHandler.create()` uses `(dependencyRepo, taskRepo, logger, eventBus, options?)`. The constructor places `database` before `logger` (line 56-63), but the `create()` method places it after `logger` (line 72-78). The call site in `handler-setup.ts:263-268` passes `(scheduleRepo, taskRepo, eventBus, childLogger('ScheduleHandler'), deps.database)` which puts logger before database, while the constructor stores them as `(scheduleRepo, taskRepo, eventBus, database, logger)`. This means `create()` reorders the arguments between its own signature and the constructor call, which is confusing but functionally correct. However, the `create()` signature itself breaks the convention of other handlers by interleaving `database` between `logger` and `options`.
- Impact: Future developers adding new handler dependencies will be confused by the inconsistent parameter ordering. The convention of `(repos..., logger, eventBus, options?)` is followed by DependencyHandler and CheckpointHandler.
- Fix: Reorder `create()` parameters to match the convention: `(scheduleRepo, taskRepo, eventBus, database, logger, options?)` -- keeping infrastructure deps together before logger. The constructor already does this. Note: this is cosmetic and the current code works correctly.

**Dead code: `recordTriggeredExecution` method is unreachable** - `src/services/handlers/schedule-handler.ts:526-545`
- Problem: The private method `recordTriggeredExecution()` is no longer called anywhere. Both `handleSingleTaskTrigger` and `handlePipelineTrigger` were refactored to use `recordExecutionSync()` inside the transaction. The old async helper is now dead code. This is inconsistent with the project's clean code pattern -- unused private methods should be removed when the callers are refactored.
- Impact: Dead code adds maintenance burden and confuses readers about which code paths are actually active. The method signature uses async patterns while the replacement is sync, creating confusion about the active execution recording strategy.
- Fix: Remove the `recordTriggeredExecution` method (lines 526-545) entirely.

### MEDIUM

**`ErrorCode.TASK_NOT_FOUND` used for schedule "not found" errors** - `src/implementations/schedule-repository.ts:296,327`
- Problem: Both the async `update()` method (line 296) and the new sync `updateSync()` method (line 327) use `ErrorCode.TASK_NOT_FOUND` with message `"Schedule ${id} not found"`. This is a semantic mismatch -- the error code says "TASK" but the entity is a "SCHEDULE". This pattern pre-exists in the async path (line 296) but the PR propagates it to the new sync path (line 327) rather than fixing it. The same issue exists in `schedule-handler.ts:248,689` and `schedule-manager.ts:512`. No `SCHEDULE_NOT_FOUND` error code exists in `ErrorCode` enum.
- Impact: When debugging production issues, error codes will misleadingly refer to tasks when the actual problem is a missing schedule. The inconsistency between code and message makes log analysis harder.
- Fix: This is a pre-existing issue propagated into new code. Consider adding `SCHEDULE_NOT_FOUND` to the `ErrorCode` enum and using it in schedule-related code paths. At minimum, the new `updateSync` at line 327 should not continue propagating the wrong code.

**Missing `findAllUnbounded` and `count` in `MockFactory.taskRepository()`** - `tests/helpers/test-factories.ts:231-240`
- Problem: The `MockFactory.taskRepository()` creates a mock that is cast as `TaskRepository` but is missing `findAllUnbounded` and `count` methods that are part of the `TaskRepository` interface. While the `transaction` removal in this PR is correct (it was removed from the interface), the mock was already incomplete before. The PR properly removed `transaction` but did not address the other missing methods. The `as TaskRepository` cast hides this.
- Impact: Tests using this mock factory will crash at runtime if they exercise `findAllUnbounded()` or `count()`, producing confusing "not a function" errors rather than clear type errors.
- Fix: Add the missing mocks: `findAllUnbounded: vi.fn().mockResolvedValue(ok([])), count: vi.fn().mockResolvedValue(ok(0))`.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**JSDoc parameter annotations removed inconsistently** - `src/implementations/schedule-repository.ts:273-275` vs `src/implementations/schedule-repository.ts:353-358`
- Problem: The PR removed `@param` / `@returns` JSDoc annotations from `save()` (line 273-275) and `update()` (line 287) in the schedule repository, but left them intact on `findById()` (lines 353-358), `findAll()` (lines 374-379), `findByStatus()` (lines 392-396), `delete()` (lines 432-435), `count()` (lines 447-449), `recordExecution()` (lines 458-462), and `getExecutionHistory()` (lines 486-490). Either JSDoc params should be kept on all public methods or removed from all.
- Impact: Inconsistent documentation style within the same file. Minor readability concern.
- Fix: This appears intentional (the removed JSDoc was redundant given interface docs), but the inconsistency of "some methods have JSDoc, some don't" within the same class is a style issue. Either strip JSDoc from all methods that merely implement the interface, or keep them everywhere.

**Inline comments removed inconsistently from repository methods** - `src/implementations/task-repository.ts:205` and `src/implementations/schedule-repository.ts:288`
- Problem: The PR removed inline comments like `// First get the existing task`, `// Merge updates with existing task`, `// Use UPDATE (not INSERT OR REPLACE) to preserve child rows` from the async `update()` methods in both repositories. These comments existed in the pre-PR code and were removed as part of the refactoring. However, the `toDbFormat()` methods retain their documentation comments. The removal is acceptable, but the inconsistency between "documented private helpers" and "undocumented public methods" is worth noting.
- Impact: Minor readability concern. The removed comments were arguably redundant given the self-documenting method names.
- Fix: No action needed -- the removed comments were redundant. The code is clear without them.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`ErrorCode.TASK_NOT_FOUND` reused for schedules across the codebase** - `src/services/handlers/schedule-handler.ts:248,689`, `src/services/schedule-manager.ts:512`
- Problem: Multiple files use `TASK_NOT_FOUND` when a schedule is not found. This is a systemic issue predating this PR.
- Fix: Add `SCHEDULE_NOT_FOUND` to `ErrorCode` enum and update all schedule-related lookups. Track as a separate issue.

### LOW

**`TestTaskRepository` does not implement `SyncTaskOperations`** - `tests/fixtures/test-doubles.ts:359`
- Problem: `TestTaskRepository` implements `TaskRepository` but not `SyncTaskOperations`. Since the `HandlerDependencies` interface now requires `TaskRepository & SyncTaskOperations`, the test double cannot be used where `HandlerDependencies` is needed. This is not currently a problem because the schedule handler tests use real `SQLiteTaskRepository`, but it creates an inconsistency between the test doubles and the production interfaces.
- Fix: This is acceptable for now since the test double is used in other contexts (not handler setup). If test doubles are later needed for handler integration tests, add `saveSync`, `updateSync`, and `findByIdSync` to `TestTaskRepository`.

**Nullish coalescing vs OR operator inconsistency in `toDbFormat`** - `src/implementations/task-repository.ts:173-193`
- Problem: `toDbFormat` uses `||` for most nullable fields (`task.workingDirectory || null`) but uses `??` for `exitCode` (`task.exitCode ?? null`). The `??` is correct for `exitCode` because `0` is a valid exit code that `||` would falsely convert to `null`. However, similar concerns exist for `timeout` and `maxOutputBuffer` where `0` might be valid but `||` would convert it to `null`. This is pre-existing code that was extracted into `toDbFormat` by this PR.
- Fix: Consider using `??` consistently for all numeric fields (`timeout`, `maxOutputBuffer`, `retryCount`) in a follow-up PR.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 1 | 2 |

**Consistency Score**: 7/10

The PR introduces a well-designed synchronous transaction pattern (`Database.runInTransaction` + `*Sync` methods) that is applied consistently across both task and schedule repositories. The sync/async duality is clearly documented and the interface segregation (`SyncTaskOperations`, `SyncScheduleOperations`) is a sound approach. The primary consistency concerns are: (1) dead code left behind from the refactoring (`recordTriggeredExecution`), (2) the factory method parameter ordering breaking convention, and (3) propagating the pre-existing `TASK_NOT_FOUND` misuse for schedules into new code.

**Recommendation**: CHANGES_REQUESTED

The dead `recordTriggeredExecution` method should be removed before merge. The factory parameter ordering is a style concern that could be addressed now or deferred. All other issues are minor or pre-existing.
