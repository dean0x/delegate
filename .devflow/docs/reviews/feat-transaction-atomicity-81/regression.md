# Regression Review Report

**Branch**: feat/transaction-atomicity-81 -> main
**Date**: 2026-03-18
**PR**: #85
**Commits**: 3 (7de406a refactor, d35de37 style fix, 5d73528 Greptile review fix)

## Summary of Changes

This PR replaces the old `TaskRepository.transaction()` pattern with a centralized `Database.runInTransaction()` approach for atomic multi-step DB operations. Key changes:

1. **Removed** `transaction()` method from `TaskRepository` interface and its `TransactionTaskRepository` wrapper class
2. **Added** `Database.runInTransaction<T>(fn: () => T): Result<T>` for synchronous SQLite transactions
3. **Added** `SyncTaskOperations` and `SyncScheduleOperations` interfaces for use inside transactions
4. **Added** `saveSync()`, `updateSync()`, `findByIdSync()` to `SQLiteTaskRepository`
5. **Added** `updateSync()`, `recordExecutionSync()`, `findByIdSync()` to `SQLiteScheduleRepository`
6. **Refactored** `ScheduleHandler` to use transaction-based atomicity for both single-task and pipeline triggers
7. **Changed** `ScheduleHandler.create()` signature to accept `Database` as a required parameter

## Issues in Your Changes (BLOCKING)

### MEDIUM
**Dead code: unused async helper methods** - `src/services/handlers/schedule-handler.ts:526-545`
- Problem: `recordTriggeredExecution()` (lines 526-545) and `updateScheduleAfterTrigger()` (lines 602-614) are private async methods that are never called. They were superseded by the sync transaction path (`recordExecutionSync()` and `updateScheduleAfterTriggerSync()`) but not removed.
- Impact: Dead code increases maintenance burden, can confuse future developers who may think these are still active code paths, and increases cognitive load when reading the module.
- Fix: Remove both methods. They are fully replaced by their sync counterparts used inside `runInTransaction()`.

```typescript
// DELETE lines 526-545 (recordTriggeredExecution)
// DELETE lines 602-614 (updateScheduleAfterTrigger)
```

## Issues in Code You Touched (Should Fix)

No issues found. All touched code is well-structured and consistent.

## Pre-existing Issues (Not Blocking)

### LOW
**`TestTaskRepository` does not implement `SyncTaskOperations`** - `tests/fixtures/test-doubles.ts:359`
- Problem: `TestTaskRepository` implements `TaskRepository` but not `SyncTaskOperations`. This means any test that needs the combined `TaskRepository & SyncTaskOperations` type (as required by the new `HandlerDependencies` and `ScheduleHandler.create()`) cannot use `TestTaskRepository` and must use `SQLiteTaskRepository` instead.
- Impact: Limits test flexibility. Currently not breaking because all ScheduleHandler tests already use real SQLite repos, but could cause issues if future tests need a test double with both interfaces.
- Fix: Consider adding `saveSync()`, `updateSync()`, `findByIdSync()` to `TestTaskRepository` in a follow-up PR.

## Regression Checklist

- [x] No exports removed without deprecation -- `TaskRepository.transaction()` removed but no external consumers (internal interface only)
- [x] Return types backward compatible -- No return type changes on public APIs
- [x] Default values unchanged -- No default value changes
- [x] Side effects preserved (events, logging) -- Events now emitted AFTER transaction commit (improved correctness)
- [x] All consumers of changed code updated -- All `ScheduleHandler.create()` call sites updated with `database` parameter
- [x] Migration complete across codebase -- No remaining calls to old `taskRepo.transaction()`, `TransactionTaskRepository` fully removed
- [x] CLI options preserved -- No CLI changes
- [x] API endpoints preserved -- No API changes
- [x] Commit message matches implementation -- Accurate description of transaction atomicity refactor
- [x] Breaking changes documented -- Interface change (`transaction` removal) is internal only

## Regression Analysis

### 1. Lost Functionality -- NONE
The removed `TaskRepository.transaction()` method and `TransactionTaskRepository` class are fully replaced by `Database.runInTransaction()`. Grep confirms zero remaining consumers of the old API. The replacement is strictly more capable:
- Old: Async wrapper that delegated to the same async repo methods (no actual atomicity guarantee for synchronous SQLite)
- New: True synchronous SQLite transaction with automatic rollback on error

### 2. Broken Behavior -- NONE
- **Event ordering improved**: Events are now emitted AFTER transaction commit, preventing consumers from seeing uncommitted data. This is a behavioral improvement, not a regression.
- **Error message format changed**: Pipeline failures now surface through `runInTransaction()` error wrapping. The test at line 872 (`schedule-handler.test.ts`) explicitly validates that error messages are NOT double-wrapped, confirming intentional design.
- **Pipeline partial failure cleanup**: Old code manually cancelled saved tasks on mid-pipeline failure. New code uses transaction rollback -- zero tasks persist on failure, eliminating the need for cleanup. This is strictly better.

### 3. Intent vs Reality Mismatch -- NONE
The commit messages accurately describe the changes:
- `refactor: add runInTransaction for atomic multi-step DB operations (#81)` -- matches implementation
- `style: fix Biome import ordering and formatting` -- accurate
- `fix: address Greptile review -- require database param, fix error prefix` -- matches the parameter and error message fixes

### 4. Incomplete Migrations -- NONE
- All consumers of `ScheduleHandler.create()` pass the new `database` parameter
- `HandlerDependencies` interface includes `database: Database`
- `extractHandlerDependencies()` extracts `database` from the container
- Bootstrap registers `database` in the container
- Test setup in `handler-setup.test.ts` registers `database` in the container
- `test-doubles.ts` and `test-factories.ts` updated to remove old `transaction()` method

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 1 |

**Regression Score**: 9/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Conditions
1. Remove the two dead private methods (`recordTriggeredExecution` and `updateScheduleAfterTrigger`) from `schedule-handler.ts`. These are unused remnants of the pre-transaction approach.

### Positive Observations
- The migration from async-wrapper transactions to true synchronous SQLite transactions is complete and correct
- All 1,006 tests pass across implementations (310), handlers (122), services (152), core (367), and adapters (55)
- Build compiles cleanly with no TypeScript errors
- Event emission moved to post-commit is an atomicity improvement that prevents ghost data
- Pipeline failure rollback (zero tasks on error) is strictly better than the old manual cleanup approach
- Test coverage for the new transaction behavior is thorough: success path, rollback path, AutobeatError preservation, and pipeline-specific edge cases (step 0 failure, mid-pipeline failure, execution record failure)
