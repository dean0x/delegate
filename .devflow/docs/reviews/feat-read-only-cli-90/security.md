# Security Review Report

**Branch**: feat/read-only-cli-90 -> main
**Date**: 2026-03-18

## Overview

This PR introduces a lightweight `ReadOnlyContext` that bypasses the full `bootstrap()` pipeline for CLI query commands (`status`, `logs`, `schedule list`, `schedule get`). Instead of initializing 15+ components (EventBus, handlers, WorkerPool, RecoveryManager, etc.), these commands now directly instantiate `Database` + repositories. Mutation commands continue using the full bootstrap path.

Files changed:
- `src/cli/read-only-context.ts` (NEW)
- `src/cli/services.ts`
- `src/cli/commands/logs.ts`
- `src/cli/commands/status.ts`
- `src/cli/commands/schedule.ts`
- `src/bootstrap.ts`
- `tests/unit/read-only-context.test.ts` (NEW)
- `package.json`

---

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Database connection not closed on error or exit paths** - `src/cli/commands/logs.ts`, `src/cli/commands/status.ts`, `src/cli/commands/schedule.ts`

- Problem: The `ReadOnlyContext` creates a `Database` (SQLite connection) via `createReadOnlyContext()`, but none of the CLI commands close the database before calling `process.exit()`. The database connection is opened but never explicitly released.
- Impact: In practice this is **low risk** because `process.exit()` immediately terminates the process and the OS reclaims all file handles. SQLite in WAL mode handles ungraceful disconnects safely. However, this violates the project's own "Resource cleanup - Always use try/finally or using pattern" principle from `CLAUDE.md`.
- Fix: Since all paths end in `process.exit()`, the OS handles cleanup. No blocking fix needed -- but for principle adherence, consider adding `ctx.database.close()` before exit calls or using a cleanup wrapper. This is cosmetic for a CLI that exits immediately.

---

**No input validation on `statusEnum` cast in `scheduleList`** - `src/cli/commands/schedule.ts:278-279`

- Problem: User-supplied `--status` value is cast to `ScheduleStatus` enum key via `ScheduleStatus[statusEnum.toUpperCase() as keyof typeof ScheduleStatus]` without validating that the value is actually a valid enum member. If the user passes `--status constructor` or `--status __proto__`, the lookup hits inherited `Object` properties rather than enum values.
- Impact: LOW -- the result would be `undefined` being passed to `findByStatus()` which uses a parameterized prepared statement (`WHERE status = ?`), so no SQL injection occurs. The query would simply return no results. However, passing prototype-chain property names like `constructor` or `toString` would yield unexpected runtime values (e.g., `[Function: ScheduleStatus]`) passed as the status parameter.
- Fix: Validate the status value before using it:
  ```typescript
  const validStatuses = Object.values(ScheduleStatus);
  const statusValue = statusEnum
    ? ScheduleStatus[statusEnum.toUpperCase() as keyof typeof ScheduleStatus]
    : undefined;
  if (statusEnum && (!statusValue || !validStatuses.includes(statusValue))) {
    ui.error(`Invalid status: ${status}. Valid values: ${validStatuses.join(', ')}`);
    process.exit(1);
  }
  ```
- Note: This same pattern existed in the previous code using `service.listSchedules()`, so this is technically a **pre-existing issue** being carried forward. Re-categorizing below.

---

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Pre-existing unvalidated status cast carried forward** - `src/cli/commands/schedule.ts:276-279`

- Problem: The `statusEnum` cast from user input was present in the original code (via `service.listSchedules()`). The refactor preserves this pattern. While the parameterized query prevents SQL injection, passing prototype-chain property names produces confusing behavior.
- Impact: User confusion only. No data corruption or injection risk due to prepared statements.
- Fix: Add validation as shown above before the `repo.findByStatus()` call. This is a good opportunity to fix it while refactoring the function.

---

## Pre-existing Issues (Not Blocking)

### LOW

**`TaskId()` and `ScheduleId()` branded types perform no validation** - `src/core/domain.ts:13-15`

- Problem: `TaskId`, `WorkerId`, and `ScheduleId` are branded types that perform only a type cast (`id as TaskId`). No validation of format, length, or content. Any arbitrary string becomes a valid ID.
- Impact: Minimal in this context -- IDs are used in parameterized SQL queries, so injection is not possible. The branded types provide TypeScript-level type safety but no runtime safety. This is standard for internal-use CLI tools.
- Fix: Not needed for this PR. Consider adding format validation if the tool is ever exposed to external/network input.

### LOW

**Error messages may leak internal paths** - `src/cli/services.ts:28`, `src/cli/commands/logs.ts:16`, `src/cli/commands/status.ts:17`

- Problem: Error messages from database operations (e.g., `result.error.message`) are displayed directly to the user via `ui.error()`. These may contain internal file paths or SQLite error details.
- Impact: Minimal for a local CLI tool. There is no network exposure. This would only matter if the CLI were ever wrapped in a web service.
- Fix: Not needed for this context.

---

## Security Analysis: Authorization Bypass Assessment

The key security question for this PR is: **does bypassing `bootstrap()` skip any authorization or access control checks?**

**Finding: No authorization bypass.**

The `TaskManager.getStatus()` method (used by the old path) directly calls `this.taskRepo.findById(taskId)` and `this.taskRepo.findAllUnbounded()` -- the exact same repository methods the new `ReadOnlyContext` calls. Similarly, `TaskManager.getLogs()` calls `this.taskRepo.findById()` followed by `this.outputRepository.get()`, identical to the new `logs.ts` flow.

The `ScheduleService.listSchedules()` and `ScheduleService.getSchedule()` also delegate directly to repository calls without any authorization layer.

The full bootstrap path provides EventBus, handlers, and WorkerPool -- none of which perform authorization. These are operational services for task execution, not access control. The read-only context correctly identifies that query commands need only data access.

## Security Analysis: Database Access

- All SQL queries use **prepared statements** with parameterized inputs (confirmed in `task-repository.ts`, `schedule-repository.ts`, `output-repository.ts`). No injection risk.
- The `Database` constructor validates `AUTOBEAT_DATABASE_PATH` and `AUTOBEAT_DATA_DIR` environment variables for absolute paths and path traversal (`..`). This validation is shared by both the read-only and full bootstrap paths.
- Foreign key constraints are enabled (`PRAGMA foreign_keys = ON`).

## Security Analysis: `skipRecovery` Option

The new `skipRecovery` option in `bootstrap.ts` skips `RecoveryManager.recover()` for short-lived CLI commands. This is safe because:
1. Recovery handles stale tasks from crashed workers -- irrelevant for query-only CLI usage.
2. The MCP server daemon still runs recovery on startup (default behavior unchanged).
3. The option is only set internally by `withServices()`, not exposed to external callers.

---

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 2 |

**Security Score**: 9/10

The PR maintains the existing security posture. All database access uses parameterized queries. No authorization checks are bypassed (none existed to bypass). The database path validation is inherited from the shared `Database` constructor. The one medium-severity item (unvalidated status enum cast) is a pre-existing pattern carried forward during refactor, and its impact is limited to user confusion due to prepared statement protection.

**Recommendation**: APPROVED

No blocking security issues found. The unvalidated `statusEnum` cast is worth fixing as a follow-up but does not pose a security risk due to parameterized query protection.
