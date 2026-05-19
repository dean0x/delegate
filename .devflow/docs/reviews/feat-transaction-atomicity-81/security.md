# Security Review Report

**Branch**: feat/transaction-atomicity-81 -> main
**Date**: 2026-03-18
**PR**: #85

## Executive Summary

This PR replaces the old `TransactionTaskRepository` wrapper (which incorrectly mixed async operations with better-sqlite3's synchronous transaction API) with a proper `Database.runInTransaction()` method and synchronous `*Sync` repository methods. The change is fundamentally a **security improvement** -- it fixes a race condition category (TOCTOU / partial writes) by ensuring schedule triggers are truly atomic.

No critical or high security issues were found in the changed code. The PR follows established security patterns (parameterized queries, Zod boundary validation, typed errors) and introduces no new attack surface.

## Issues in Your Changes (BLOCKING)

### CRITICAL

None.

### HIGH

None.

### MEDIUM

**Error message propagation includes internal details** - `src/implementations/database.ts:555`
- Problem: The transaction error handler includes the raw error message in the `AutobeatError`: `Transaction failed: ${error instanceof Error ? error.message : String(error)}`. If SQLite throws an error containing internal details (e.g., table names, constraint violations, or file paths), these details propagate through the Result chain and could reach external callers via MCP tool responses.
- Impact: Moderate information disclosure risk. In the context of a local MCP server, the attack surface is limited since callers are already local Claude Code instances with system access. However, it is a defense-in-depth concern.
- Fix: This is consistent with the existing `operationErrorHandler` pattern used throughout the codebase (which also includes `error.message`), so this is not a regression. Consider sanitizing error messages at the MCP adapter boundary in a future PR rather than here.
- Category: Blocking (new code), but LOW actual risk given context.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`toDbFormat` uses `||` instead of `??` for numeric fields** - `src/implementations/task-repository.ts:180-181`
- Problem: The `toDbFormat` method uses `task.timeout || null` and `task.maxOutputBuffer || null`. The `||` operator treats `0` as falsy, meaning a timeout of `0` or maxOutputBuffer of `0` would be stored as `null`. While this is pre-existing logic (just refactored into `toDbFormat`), the refactoring is a good opportunity to fix it.
- Impact: A timeout of `0` could be silently discarded, potentially allowing a task to run indefinitely when the user intended it to be immediately timed out. This is a logic correctness issue with security implications (resource exhaustion).
- Fix:
  ```typescript
  timeout: task.timeout ?? null,
  maxOutputBuffer: task.maxOutputBuffer ?? null,
  ```
- Category: Should Fix -- pre-existing but consolidated into new `toDbFormat` method in this PR.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`getDatabase()` exposes raw SQLite handle** - `src/implementations/database.ts:188`
- Problem: The `getDatabase()` method returns the raw `SQLite.Database` object, which allows any consumer to bypass prepared statements, transactions, and validation. While this is used by repository constructors for prepared statement initialization (legitimate), it could be misused.
- Impact: If a new consumer calls `getDatabase()` and constructs raw SQL strings, it would bypass the existing parameterized query pattern. Currently all consumers use it correctly.
- Fix: No action needed for this PR. In a future refactoring, consider making this `internal` or providing a more restricted API.

### LOW

**`SyncTaskOperations.saveSync` does not validate task data** - `src/implementations/task-repository.ts:231-233`
- Problem: The `saveSync` method delegates directly to `this.saveStmt.run(this.toDbFormat(task))` without Zod validation of the input `Task` object. The async `save` method also lacks input validation (only `rowToTask` validates on read). This is consistent but worth noting.
- Impact: Minimal. The `Task` type is enforced at compile time, and the database has CHECK constraints on `status` and `priority` columns. Invalid data would be rejected by SQLite.
- Fix: No action needed. The validate-at-boundary pattern is applied on reads via `rowToTask` with Zod, and writes are protected by TypeScript types + SQLite CHECK constraints.

### LOW

**Schedule `updateSync` uses `TASK_NOT_FOUND` error code for missing schedules** - `src/implementations/schedule-repository.ts:327`
- Problem: When a schedule is not found in `updateSync`, the error uses `ErrorCode.TASK_NOT_FOUND` with message `Schedule ${id} not found`. This is semantically incorrect (it's a schedule, not a task) but is pre-existing behavior copied from the async `update` method.
- Impact: Minimal. Could cause confusion in error handling/logging but has no security impact.
- Fix: Consider adding a `SCHEDULE_NOT_FOUND` error code in a future PR.

## Security Strengths in This PR

1. **Race condition elimination**: The core purpose of this PR -- wrapping task save + execution record + schedule update in a single synchronous SQLite transaction -- eliminates the TOCTOU vulnerability where a partial failure could leave orphaned tasks or inconsistent schedule state.

2. **Events after commit**: The pattern of emitting `TaskDelegated` and `ScheduleExecuted` events only after the transaction commits (`schedule-handler.ts:311-318`, `schedule-handler.ts:419-435`) prevents event consumers from acting on data that might be rolled back.

3. **Parameterized queries preserved**: All new sync methods use the same prepared statements with named parameters as the async methods. No raw SQL string construction is introduced.

4. **Zod boundary validation preserved**: The `rowToTask` and `rowToSchedule` methods continue to validate data read from the database using Zod schemas. The new `findByIdSync` methods reuse these same validated conversion functions.

5. **Error type preservation**: The `runInTransaction` method correctly preserves `AutobeatError` types thrown inside the transaction callback, allowing callers to distinguish between domain errors (e.g., `TASK_NOT_FOUND`) and system errors.

6. **No new external input paths**: This PR does not introduce any new user-facing input surfaces. All changes are internal refactoring of the data access and handler layers.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 2 |

**Security Score**: 9/10
**Recommendation**: APPROVED

The PR is a net security improvement. It eliminates a class of race conditions (partial write failures in multi-step trigger flows) by introducing proper SQLite transaction atomicity. The one MEDIUM blocking issue (error message propagation) is consistent with existing patterns across the codebase and poses minimal risk in the local MCP server context. The should-fix item (`||` vs `??` for numeric fields) is pre-existing but worth addressing since the code was refactored. No critical or high severity issues were found.
