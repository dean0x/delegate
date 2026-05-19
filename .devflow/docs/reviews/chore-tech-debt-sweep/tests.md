# Tests Review Report

**Branch**: chore/tech-debt-sweep -> main
**Date**: 2026-03-20

## Issues in Your Changes (BLOCKING)

### HIGH

**New `exitOnError`/`exitOnNull` utility functions have zero unit tests** - `src/cli/services.ts:15-37`
**Confidence**: 95%
- Problem: Two new public functions (`exitOnError` and `exitOnNull`) were introduced in `src/cli/services.ts` and are now used across 4 CLI command files (`logs.ts`, `status.ts`, `schedule.ts`, `services.ts` itself). These are shared guard utilities that centralize error-to-exit behavior for the entire CLI layer, yet they have no dedicated unit tests. There are no tests anywhere in the test suite that reference `exitOnError` or `exitOnNull`. The existing `cli.test.ts` uses simulation functions that bypass the actual CLI command code (e.g., `simulateLogsCommand` calls the repository directly rather than exercising the real `getTaskLogs` function from `logs.ts`), so the helpers are not tested indirectly either.
- Impact: If either function has a regression (e.g., wrong exit code, missing spinner stop, broken type narrowing), it would silently break every CLI command that depends on it. These are boundary functions that call `process.exit(1)` -- getting them wrong means the CLI either crashes or silently succeeds when it should fail.
- Fix: Add a unit test file for the new helpers. Since they call `process.exit`, mock it with `vi.spyOn(process, 'exit').mockImplementation(...)`. Example test structure:

```typescript
// tests/unit/cli/services.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exitOnError, exitOnNull } from '../../../src/cli/services';
import { err, ok } from '../../../src/core/result';
import { AutobeatError, ErrorCode } from '../../../src/core/errors';

describe('exitOnError', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  it('returns unwrapped value on ok result', () => {
    const result = ok(42);
    expect(exitOnError(result)).toBe(42);
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('calls process.exit(1) on err result', () => {
    const result = err(new AutobeatError(ErrorCode.SYSTEM_ERROR, 'boom'));
    exitOnError(result, undefined, 'prefix');
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('stops spinner before exiting on error', () => {
    const spinner = { stop: vi.fn(), start: vi.fn(), message: vi.fn() };
    const result = err(new AutobeatError(ErrorCode.SYSTEM_ERROR, 'fail'));
    exitOnError(result, spinner as any, 'test');
    expect(spinner.stop).toHaveBeenCalledWith('Failed');
  });
});

describe('exitOnNull', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  it('returns value when non-null', () => {
    expect(exitOnNull('hello', undefined, 'msg')).toBe('hello');
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('calls process.exit(1) on null', () => {
    exitOnNull(null, undefined, 'not found');
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('stops spinner with custom stop message', () => {
    const spinner = { stop: vi.fn(), start: vi.fn(), message: vi.fn() };
    exitOnNull(undefined, spinner as any, 'msg', 'Custom stop');
    expect(spinner.stop).toHaveBeenCalledWith('Custom stop');
  });
});
```

### MEDIUM

**Extracted `registerWorker` private method lacks dedicated test coverage** - `src/implementations/event-driven-worker-pool.ts:211-248`
**Confidence**: 82%
- Problem: The `registerWorker` method was extracted from `spawn()` as a pure refactor. The existing tests cover this behavior indirectly -- there are tests for successful spawn (line 145), worker registration in the repository (line 648), and UNIQUE constraint failure rollback (line 691). Since the extract was purely structural (no logic change), the existing tests exercise all paths through the extracted method.
- Impact: Low in isolation -- the behavior is unchanged and existing tests pass. However, the method is now a named unit of logic that could evolve independently. If someone later modifies `registerWorker` without realizing it must roll back on failure, the current tests would catch it, but the failure message would be confusing (test name references `spawn` not `registerWorker`).
- Fix: Consider adding a comment to the existing test at line 691 noting it also validates the `registerWorker` rollback path. No new test file required since this is a private method and the behavior is already covered.

```typescript
// Line 691 - add clarifying comment:
it('should return error when workerRepository.register fails (UNIQUE constraint) — validates registerWorker rollback', async () => {
```

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

### MEDIUM

**CLI command tests use simulation functions instead of testing actual command code** - `tests/unit/cli.test.ts:2088-2162`
**Confidence**: 85%
- Problem: The CLI test file defines functions like `simulateStatusCommand`, `simulateLogsCommand`, `simulateScheduleListCommand`, and `simulateScheduleGetCommand` that duplicate the logic from the production CLI commands rather than exercising the real exported functions. These simulations may drift from the actual implementation, especially now that the production code has been refactored to use `exitOnError`/`exitOnNull`. For example, `simulateLogsCommand` still contains the old manual `if (!taskResult.ok)` pattern while the real `logs.ts` now uses `exitOnError`.
- Impact: The simulation functions test repository interactions but not the CLI guard behavior. If a bug were introduced in `exitOnError` (e.g., returning `undefined` instead of calling `process.exit`), the simulations would not detect it. The tests validate "what the code should do" rather than "what the code actually does."
- Fix: This is a pre-existing architectural decision (CLI commands call `process.exit` which makes direct testing difficult). No action required for this PR. Consider a future refactoring to separate exit logic from business logic, enabling direct testing of command functions.

## Suggestions (Lower Confidence)

- **`withReadOnlyContext` and `withServices` are now one-liners delegating to `exitOnError` but have no direct tests** - `src/cli/services.ts:50-77` (Confidence: 65%) -- These functions were refactored from inline error handling to `exitOnError` delegation. Their behavior is implicitly tested through the CLI simulation tests, but the `withServices` path (which involves async bootstrap) is only tested at the integration level.

- **Return type of `exitOnNull` relies on TypeScript's `never` type for `process.exit` narrowing** - `src/cli/services.ts:25-37` (Confidence: 62%) -- The function signature promises to return `T` but the null path calls `process.exit(1)`. TypeScript correctly infers this as `never` in the `@types/node` definition, so the narrowing works. However, if `process.exit` is mocked in tests (as it should be), the mock may not actually terminate execution, which means tests must account for continued execution after `exitOnNull` returns `undefined`. This is a subtle testing concern, not a bug.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Tests Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The primary concern is the absence of unit tests for the two new public utility functions `exitOnError` and `exitOnNull` in `src/cli/services.ts`. These functions are now the single point of error handling for the entire CLI layer (used in 4 command files, ~15 call sites). The `registerWorker` extract in the worker pool is adequately covered by existing behavioral tests. The refactoring itself is clean and behavior-preserving, but the new shared utilities warrant their own test coverage given their criticality.
