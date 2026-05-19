# Tests Review Report

**Branch**: feat/read-only-cli-90 -> main
**Date**: 2026-03-18

## Issues in Your Changes (BLOCKING)

### HIGH

**Missing database cleanup in error paths** - `tests/unit/read-only-context.test.ts:74-78`
- Problem: The test `'returns error for invalid database path'` overwrites `AUTOBEAT_DATABASE_PATH` with `/nonexistent/deeply/nested/path/test.db` but does not verify what happens if `createReadOnlyContext()` partially initializes before failing. If a context was created in a prior test and not closed, that database handle leaks. While the current `afterEach` handles env var restoration, there is no guard against a partially-constructed `ReadOnlyContext` leaving a database open.
- Impact: In a larger test suite or if test ordering changes, leaked database handles could cause file-locking errors on Windows or resource exhaustion.
- Fix: This is low risk since each test creates its own context and the `tryCatch` in `createReadOnlyContext` means the error case never opens a database. However, consider using a `try/finally` pattern in tests that do successfully open a database, to guarantee `close()` even if an assertion fails mid-test. For example:

```typescript
it('round-trips task data through repository', async () => {
  const result = createReadOnlyContext();
  expect(result.ok).toBe(true);
  if (!result.ok) return;

  const ctx = result.value;
  try {
    const task = createTask({ prompt: 'test read-only context' });
    // ... assertions ...
  } finally {
    ctx.database.close();
  }
});
```

Currently, if any assertion between context creation and `ctx.database.close()` throws, the database is never closed. This applies to tests at lines 41, 62, 80, and 114.

### MEDIUM

**Unused import `ReadOnlyContext`** - `tests/unit/read-only-context.test.ts:5`
- Problem: The named import `ReadOnlyContext` (the type/interface) is imported but never used in the test file. Only `createReadOnlyContext` (the function) is used.
- Impact: Dead import clutters the file and will be flagged by lint rules. Minor, but a code cleanliness issue in new code.
- Fix:
```typescript
// Before
import { createReadOnlyContext, ReadOnlyContext } from '../../src/cli/read-only-context.js';

// After
import { createReadOnlyContext } from '../../src/cli/read-only-context.js';
```

**Tests write through a "read-only" context without acknowledging the naming contradiction** - `tests/unit/read-only-context.test.ts:49,90-91,122-129`
- Problem: The `ReadOnlyContext` is described as "lightweight read-only context for CLI query commands," but multiple tests call `taskRepository.save()` and `outputRepository.save()` through it. While the production comment acknowledges "read-only refers to the command's intent, not DB operations," the tests actively demonstrate that the context is fully read-write capable. This could be misleading for future developers.
- Impact: Naming confusion. A future contributor might assume `ReadOnlyContext` enforces read-only access and be surprised that write operations work.
- Fix: Consider adding a brief comment in the test file header clarifying that writes are used to set up test data, and that the "read-only" naming refers to CLI command intent.

### LOW

**Repetitive `createReadOnlyContext()` + guard pattern** - `tests/unit/read-only-context.test.ts`
- Problem: Every test repeats the same 4-line pattern:
```typescript
const result = createReadOnlyContext();
expect(result.ok).toBe(true);
if (!result.ok) return;
const ctx = result.value;
```
This appears 5 times (lines 28-32, 42-46, 63-67, 81-85, 115-119).
- Impact: Boilerplate. Not a functional issue but violates DRY. The pattern is a consequence of the Result type, which is an intentional design choice.
- Fix: Extract a helper function:
```typescript
function createContextOrFail(): ReadOnlyContext {
  const result = createReadOnlyContext();
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('unreachable');
  return result.value;
}
```

## Issues in Code You Touched (Should Fix)

### HIGH

**Existing CLI tests now test stale code paths** - `tests/unit/cli.test.ts:576-740, 1002-1048`
- Problem: The status, logs, schedule-list, and schedule-get CLI commands were refactored from `TaskManager`/`ScheduleService` to `ReadOnlyContext` with direct repository access. However, the existing CLI tests in `cli.test.ts` still test the old paths via `simulateStatusCommand(mockTaskManager)` and `mockScheduleService.listSchedules()` / `mockScheduleService.getSchedule()`. These tests now validate the mock interface behavior that is no longer exercised by the actual CLI commands.
- Impact: The existing tests provide false confidence. They pass, but they test code paths that are no longer used by `status.ts`, `logs.ts`, or `schedule.ts` (for list/get). The actual production code paths (`ctx.taskRepository.findById`, `ctx.outputRepository.get`, `ctx.scheduleRepository.findAll/findById`) have no CLI-level integration test coverage.
- Fix: Either (a) update the existing CLI tests to use `ReadOnlyContext` instead of `MockTaskManager`/`MockScheduleService` for the refactored commands, or (b) add new integration-style tests that exercise the actual `getTaskStatus()`, `getTaskLogs()`, and `handleScheduleCommand('list'/'get')` functions with mocked `process.exit` and `ui` calls. The new `read-only-context.test.ts` tests validate `createReadOnlyContext()` itself but do not test the CLI command functions that use it.

### MEDIUM

**No tests for `withReadOnlyContext()` error handling** - `src/cli/services.ts:24-31`
- Problem: The `withReadOnlyContext()` wrapper function (new code) calls `createReadOnlyContext()`, and on failure calls `s?.stop()`, `ui.error()`, and `process.exit(1)`. This error-handling path has no test coverage.
- Impact: If `createReadOnlyContext()` fails (e.g., corrupt database, permission denied), the user experience (spinner stop, error message, exit code) is untested.
- Fix: Add a test for `withReadOnlyContext()` that verifies the error path:
```typescript
it('exits with error when context creation fails', () => {
  process.env.AUTOBEAT_DATABASE_PATH = '/nonexistent/path/db';
  const mockSpinner = { stop: vi.fn(), start: vi.fn(), message: vi.fn() };
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

  expect(() => withReadOnlyContext(mockSpinner as any)).toThrow('exit');
  expect(mockSpinner.stop).toHaveBeenCalledWith('Initialization failed');
  exitSpy.mockRestore();
});
```

**No tests for `skipRecovery` bootstrap option** - `src/bootstrap.ts:416-428`
- Problem: The new `skipRecovery` option in `BootstrapOptions` changes bootstrap behavior (skips recovery manager invocation and logs a message), but there are no tests verifying this flag works correctly.
- Impact: If the flag is accidentally removed or the conditional logic breaks, short-lived CLI commands could trigger unnecessary recovery operations, adding latency.
- Fix: Add a bootstrap test that verifies `skipRecovery: true` prevents `recovery.recover()` from being called.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**CLI tests use mock-the-world pattern** - `tests/unit/cli.test.ts`
- Problem: The existing CLI test suite tests the mock, not the actual CLI commands. Functions like `simulateStatusCommand()` directly call `mockTaskManager.getStatus()` (line 1968) rather than invoking the actual `getTaskStatus()` function from `src/cli/commands/status.ts`. This is a classic "testing the mock" anti-pattern.
- Impact: Tests pass regardless of whether the actual CLI functions work correctly. The refactoring to `ReadOnlyContext` proved this: the CLI commands changed from `TaskManager` to direct repository access, but all existing tests still pass because they never called the real functions.
- Fix: Long-term, refactor CLI tests to invoke actual command functions with dependency injection or controlled process mocking. The new `read-only-context.test.ts` takes a better approach by testing the real `createReadOnlyContext()` function.

### LOW

**Test file placement inconsistency** - `tests/unit/read-only-context.test.ts`
- Problem: The test file is at the root of `tests/unit/` while the source file it tests is at `src/cli/read-only-context.ts`. Other CLI-related tests (e.g., `cli.test.ts`, `cli-init.test.ts`) follow this flat pattern, so this is consistent with the existing convention. Just noting it does not mirror the source directory structure.
- Impact: None functionally. Existing convention is followed.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 1 |
| Should Fix | 0 | 1 | 2 | 0 |
| Pre-existing | 0 | 0 | 1 | 1 |

**Tests Score**: 5/10

The new `read-only-context.test.ts` file is well-structured and validates the core `createReadOnlyContext()` function with good coverage of happy path, error path, and multi-repository queries. Tests follow AAA structure, use proper environment isolation with `beforeEach`/`afterEach`, and the setup is concise (3 lines).

However, the score reflects two significant gaps:

1. **Stale CLI tests**: The refactoring changed status, logs, and schedule-list/get from `TaskManager`/`ScheduleService` to direct repository access via `ReadOnlyContext`, but the existing CLI tests still validate the old mock-based paths. This creates false confidence -- the tests pass but do not exercise the actual production code paths.

2. **Missing coverage for new code**: The `withReadOnlyContext()` wrapper, the `skipRecovery` bootstrap option, and the refactored command functions themselves (`getTaskStatus`, `getTaskLogs`, `handleScheduleCommand` for list/get) have no test coverage at the integration level.

The new test file alone is solid (would score 7/10 in isolation), but in the context of the full PR, the test coverage delta is negative -- production code gained new paths that are not tested.

**Recommendation**: CHANGES_REQUESTED

The PR introduces meaningful production code changes (4 CLI commands refactored, new `ReadOnlyContext` module, new bootstrap option) but the test coverage does not match the scope of the change. The existing CLI tests now test dead code paths, and the new test file only covers the `createReadOnlyContext()` factory -- not the CLI commands that consume it. Address the stale CLI tests (HIGH should-fix) and the database cleanup in error paths (HIGH blocking) before merging.
