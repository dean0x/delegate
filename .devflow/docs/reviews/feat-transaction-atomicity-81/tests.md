# Tests Review Report

**Branch**: feat/transaction-atomicity-81 -> main
**Date**: 2026-03-18
**PR**: #85

## Summary of Changes

This PR introduces transaction atomicity via `Database.runInTransaction()` and synchronous repository methods (`saveSync`, `updateSync`, `findByIdSync`, `recordExecutionSync`). The test changes include:

1. **database.test.ts** - 4 new tests for `runInTransaction` (success, generic error, AutobeatError preservation, rollback)
2. **task-repository.test.ts** - 7 new tests for sync methods + transaction integration
3. **schedule-repository.test.ts** - 8 new tests for sync methods + transaction integration
4. **schedule-handler.test.ts** - Updated existing tests to use sync methods + 3 new atomicity tests
5. **handler-setup.test.ts** - Added `database` dependency extraction test + registered missing services
6. **test-doubles.ts** - Removed `transaction()` method from TestTaskRepository
7. **test-factories.ts** - Removed `transaction` mock from MockFactory
8. **package.json** - Added handler-setup.test.ts to `test:services` group

## Issues in Your Changes (BLOCKING)

### No CRITICAL or HIGH issues found

All new tests follow good patterns. No blocking issues identified.

### MEDIUM

**Redundant error assertion in `updateSync` test** - `tests/unit/implementations/task-repository.test.ts:257-266`
- Problem: The test for `updateSync should throw AutobeatError for non-existent task` uses both `expect(...).toThrow(AutobeatError)` and a separate `try/catch` block to verify the error code. The try/catch duplicates the call to `updateSync` with the same arguments, meaning the throwing function is called twice.
- Impact: Minor redundancy and the second call could mask issues if the behavior changes between calls. The try/catch pattern also does not guarantee the catch block runs (no `fail()` guard), making the error code assertion technically optional.
- Fix: Combine into a single assertion pattern:
```typescript
it('updateSync should throw AutobeatError for non-existent task', () => {
  try {
    repo.updateSync(TaskId('no-such-task'), { status: TaskStatus.CANCELLED });
    expect.fail('Expected AutobeatError to be thrown');
  } catch (e) {
    expect(e).toBeInstanceOf(AutobeatError);
    expect((e as AutobeatError).code).toBe(ErrorCode.TASK_NOT_FOUND);
  }
});
```

### LOW

**Mock spy restoration via `.mockRestore()` after `vi.spyOn`** - `tests/unit/services/handlers/schedule-handler.test.ts:760,860,888,914`
- Problem: Several tests call `saveSpy.mockRestore()` or `spy.mockRestore()` after the act phase but outside a `finally` block. If the act phase throws unexpectedly, the spy would not be restored, potentially leaking into subsequent tests.
- Impact: Low risk because `afterEach` disposes the event bus and closes the database, creating a fresh environment. However, the pattern is fragile if test execution order changes.
- Fix: Wrap in try/finally or rely on Vitest's `vi.restoreAllMocks()` in `afterEach`.

## Issues in Code You Touched (Should Fix)

### No issues found

The existing tests that were modified (schedule-handler.test.ts updates from `save` to `saveSync` mocking, handler-setup.test.ts dependency additions) are clean and consistent.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Slow dependency-handler test** - `tests/unit/services/handlers/dependency-handler.test.ts`
- Problem: One test ("should proceed without enrichment when checkpoint is not available") takes ~5 seconds according to test output. This is not related to this PR but is visible in the handler test group.
- Impact: Slows down the test:handlers group. The test may have a real timeout or missing mock.
- Note: Pre-existing, not introduced by this PR.

### LOW

**handler-setup.test.ts beforeEach setup exceeds 10 lines** - `tests/unit/services/handler-setup.test.ts:39-79`
- Problem: The `beforeEach` block is ~40 lines creating a real Container with all dependencies. This is noted as a test design red flag per patterns, but in this case it is justified because `extractHandlerDependencies` and `setupEventHandlers` are integration points that genuinely need a fully populated container.
- Impact: None - the complexity matches the function under test.
- Note: Pre-existing, not introduced by this PR. The PR added 5 lines (database, scheduleRepository, checkpointRepository registrations) which are necessary for the new dependency extraction.

## Test Quality Assessment

### Coverage Analysis

| New Source Code | Test Coverage | Verdict |
|----------------|---------------|---------|
| `Database.runInTransaction()` | 4 tests: success, generic error, AutobeatError preservation, rollback | Excellent |
| `SQLiteTaskRepository` sync methods | 7 tests: saveSync, findByIdSync, updateSync, error path, transaction commit, transaction rollback | Excellent |
| `SQLiteScheduleRepository` sync methods | 8 tests: findByIdSync, updateSync, recordExecutionSync, pipelineTaskIds, transaction commit, transaction rollback, not-found error | Excellent |
| `ScheduleHandler` transaction atomicity | 3 new tests + 3 updated tests: pipeline rollback, single-task rollback, atomicity success, error message formatting | Excellent |
| `handler-setup.ts` database dependency | 2 tests: missing database error, taskRepository with database present | Good |

### Behavior-Focused Testing

All new tests validate observable behavior (data committed/rolled back in the database, error types returned, error messages) rather than implementation details. The tests follow the project's established pattern of:
- Real in-memory SQLite for repository tests
- Event emission via InMemoryEventBus for handler tests
- Result pattern validation (`result.ok`, `result.error.code`)

### Test Structure Quality

- **AAA pattern**: All new tests follow clear Arrange-Act-Assert structure
- **Test names**: Descriptive and behavior-focused (e.g., "should rollback all tasks on partial save failure (transaction atomicity)")
- **Mock usage**: Spies are used judiciously only for error injection, not for verifying internal calls
- **Assertions**: Specific and meaningful - checking exact counts, statuses, and error messages

### Edge Cases Covered

| Edge Case | Tested | File |
|-----------|--------|------|
| Transaction success with return value | Yes | database.test.ts:299 |
| Generic Error wrapping | Yes | database.test.ts:316 |
| AutobeatError preservation (not double-wrapped) | Yes | database.test.ts:327 |
| Rollback after partial writes | Yes | database.test.ts:339 |
| Non-existent entity in sync update | Yes | task-repository.test.ts:257, schedule-repository.test.ts:681 |
| Pipeline partial save failure -> full rollback | Yes | schedule-handler.test.ts:741 |
| Single-task recordExecution failure -> rollback | Yes | schedule-handler.test.ts:901 |
| Pipeline success -> all tasks + execution committed | Yes | schedule-handler.test.ts:923 |
| Error message not double-wrapped | Yes | schedule-handler.test.ts:842 |
| Single-task error message includes prefix | Yes | schedule-handler.test.ts:875 |

### Cleanup Verification

- Removed `transaction()` from `TestTaskRepository` (test-doubles.ts:449-452) - correct, the old interface method was replaced by `Database.runInTransaction()`
- Removed `transaction` from `MockFactory` (test-factories.ts:240) - correct, keeps mock factory in sync

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 1 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 1 | 1 |

**Tests Score**: 9/10
**Recommendation**: APPROVED

### Rationale

The test changes in this PR are thorough and well-structured. Every new source-level method (`runInTransaction`, `saveSync`, `updateSync`, `findByIdSync`, `recordExecutionSync`) has corresponding tests covering both happy path and error scenarios. The transaction atomicity tests are particularly well done -- they verify actual database state after rollback (zero rows) rather than just checking return values. The existing pipeline tests were correctly updated from async mocking (return `err()`) to sync mocking (throw) to match the new transaction-based architecture. The two minor issues (redundant try/catch assertion, spy restoration outside finally) are LOW/MEDIUM severity and do not warrant blocking the merge.
