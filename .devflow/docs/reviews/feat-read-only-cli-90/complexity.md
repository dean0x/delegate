# Complexity Review Report

**Branch**: feat/read-only-cli-90 -> main
**Date**: 2026-03-18
**PR**: #100

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Repeated error-handling boilerplate in `getTaskLogs`** - `src/cli/commands/logs.ts:14-31`
- Problem: The function now has 3 sequential Result-check-and-exit blocks (taskResult, outputResult, outputResult.value null check) each with the same `s.stop() -> ui.error() -> process.exit(1)` pattern. Previously the service method encapsulated this into a single call. While each block is simple, the repetition increases the visual noise and line count (56 -> 76 lines).
- Impact: The function went from 56 to 76 lines. The core logic (tail slicing, output display) is unchanged -- the growth is entirely from inline error handling. Still under the 85-line warning threshold, but the pattern is worth noting.
- Fix: Consider a small helper to reduce boilerplate. For example:
  ```typescript
  function exitOnError<T>(result: Result<T>, s: Spinner, msg: string): T {
    if (!result.ok) { s.stop('Failed'); ui.error(`${msg}: ${result.error.message}`); process.exit(1); }
    return result.value;
  }
  function exitOnNull<T>(value: T | null, s: Spinner, msg: string): T {
    if (!value) { s.stop('Not found'); ui.error(msg); process.exit(1); }
    return value;
  }
  ```
  This would reduce `getTaskLogs` back to ~40 lines. The same helper would benefit `getTaskStatus` and `scheduleGet`.

**Repeated error-handling boilerplate in `scheduleGet`** - `src/cli/commands/schedule.ts:315-335`
- Problem: Same pattern as above. The function gained separate null checks for `scheduleResult.ok`, `scheduleResult.value`, and `historyResult.ok`, each with the stop-error-exit dance. The previous implementation handled this in a single `service.getSchedule()` call with one success/failure branch.
- Impact: `scheduleGet` grew from ~55 lines to ~76 lines. Still under the warning threshold but trending upward.
- Fix: Same helper as above would consolidate the error paths.

### LOW

**`getTaskStatus` nesting depth unchanged but could benefit from early return** - `src/cli/commands/status.ts:13-78`
- Problem: The `if (taskId) { ... } else { ... }` block is 65 lines within the try block. The new code is actually *slightly less* nested than before (error checks use early returns instead of wrapping success in `if (result.ok)`), which is an improvement. However, the function remains a monolithic 85-line block that combines single-task-detail formatting and list-all formatting in one function.
- Impact: Readability -- the function does two distinct things depending on whether `taskId` is provided.
- Fix: Optional -- could split into `showTaskDetail(ctx, taskId, s)` and `showTaskList(ctx, s)` helper functions. This is not blocking since the current nesting depth is manageable (max 4 levels for dependency state display, which is pre-existing).

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`scheduleCreate` function is 199 lines with cyclomatic complexity ~20** - `src/cli/commands/schedule.ts:57-256`
- Problem: This function was not changed in this PR, but the `handleScheduleCommand` dispatcher that calls it was modified (lines 15-27 added the read-only branch). `scheduleCreate` itself has 15+ flag-parsing branches in a for-loop, pipeline mode vs single-task mode branching, and multiple validation checks. Its length (199 lines) exceeds the 50-line critical threshold.
- Impact: Any future contributor modifying schedule commands must navigate this function. The for-loop argument parser with positional index manipulation (`i++`) is particularly hard to follow.
- Fix: This is a pre-existing issue exacerbated by proximity. Could be addressed in a follow-up:
  1. Extract argument parsing into a `parseScheduleArgs(args): ParsedScheduleOptions` function
  2. Extract pipeline creation and single-task creation into separate functions
  3. This would bring `scheduleCreate` under 30 lines

## Pre-existing Issues (Not Blocking)

### HIGH

**`schedule.ts` file is 439 lines** - `src/cli/commands/schedule.ts`
- Problem: The file exceeds the 300-line warning threshold and approaches the 500-line critical threshold. It contains 7 functions (`handleScheduleCommand`, `scheduleCreate`, `scheduleList`, `scheduleGet`, `scheduleCancel`, `schedulePause`, `scheduleResume`) -- effectively the entire schedule CLI in one file.
- Impact: File length makes navigation harder and increases merge conflict risk.
- Fix: Consider splitting into `schedule/create.ts`, `schedule/list.ts`, `schedule/get.ts`, etc. in a future PR. Not blocking since the functions themselves are reasonably separated internally.

### MEDIUM

**`BootstrapOptions` interface is accumulating boolean flags** - `src/bootstrap.ts:33-43`
- Problem: The interface now has 3 `skip*` boolean flags (`skipResourceMonitoring`, `skipScheduleExecutor`, `skipRecovery`). While each flag is simple, the combinatorial space (8 possible configurations) makes it harder to reason about which components are active in a given mode.
- Impact: The next feature may add a 4th flag. This pattern tends to grow unbounded.
- Fix: Consider a `mode` enum (`'full' | 'cli-mutation' | 'cli-query'`) that maps to predefined skip sets, or a `BootstrapProfile` pattern. Not blocking -- the current 3 flags are still manageable and well-documented.

### LOW

**`handleScheduleCommand` has two code paths with separate spinner creation** - `src/cli/commands/schedule.ts:15-34`
- Problem: The read-only branch (lines 17-28) creates a spinner, initializes context, and calls sub-functions. The mutation branch (lines 31-54) creates a separate spinner and does the same with `withServices`. Two spinners, two `s.start()`/`s.stop()` patterns for what is essentially the same initialization flow.
- Impact: Minor -- the two paths are clearly separated and each is short. Just slightly redundant.
- Fix: Could unify with a common spinner, but the current separation is clear enough.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 1 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 1 | 1 | 1 |

**Complexity Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Rationale

The core change -- introducing `ReadOnlyContext` to bypass full bootstrap for query commands -- is a clear *reduction* in runtime complexity. The `createReadOnlyContext()` function is 10 lines, the `ReadOnlyContext` interface is 5 fields, and the concept is immediately understandable. The new `read-only-context.ts` module at 44 lines is well within all thresholds.

The trade-off is that moving from service-method calls to direct repository calls in the CLI commands expands the error-handling surface. Each command now handles Result unwrapping inline instead of delegating to the service layer. This is a reasonable architectural choice (CLI should not depend on heavy service layer for reads), but it introduces boilerplate that could be consolidated with a small helper function.

The pre-existing complexity in `scheduleCreate` (199 lines, cyclomatic complexity ~20) and `schedule.ts` overall (439 lines) are not caused by this PR but are worth tracking for a future cleanup pass.

### Conditions for Approval

1. **Consider** (not required) extracting the `exitOnError`/`exitOnNull` helper pattern to reduce the 3-block error boilerplate in `getTaskLogs` and `scheduleGet`. This is a stylistic improvement, not a blocking concern -- the current code is correct and readable, just verbose.
