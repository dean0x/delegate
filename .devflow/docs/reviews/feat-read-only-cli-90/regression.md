# Regression Review Report

**Branch**: feat/read-only-cli-90 -> main
**Date**: 2026-03-18
**Commits**: d30998f (fix: address self-review issues), f1c4dfe (feat: add read-only context for lightweight query commands)

## Issues in Your Changes (BLOCKING)

### HIGH

**Database connection never closed in read-only CLI path** - `src/cli/services.ts:24-31`, `src/cli/commands/status.ts:11`, `src/cli/commands/logs.ts:10`, `src/cli/commands/schedule.ts:19`
- Problem: `withReadOnlyContext()` opens a `new Database()` connection but none of the CLI commands close it before calling `process.exit()`. The old `withServices()` path had the same issue (bootstrap opens DB but CLI never explicitly closes it), so this is behavioral parity. However, the test suite (`tests/unit/read-only-context.test.ts`) correctly calls `ctx.database.close()` in every test, suggesting the author is aware of cleanup needs. Since the CLI calls `process.exit()` immediately after, the OS reclaims the handle, so this is not a functional regression -- just a missed opportunity.
- Impact: Minor resource leak on exit. Not a functional regression since previous code also relied on `process.exit()` for cleanup.
- Fix: Not blocking. Consider adding `ctx.database.close()` before `process.exit()` calls for clean shutdown, but this is a pattern improvement, not a regression.

### MEDIUM

**`scheduleGet` history fetch error now shown to user instead of silently logged** - `src/cli/commands/schedule.ts:332-334`
- Problem: The old code path went through `ScheduleManagerService.getSchedule()` which treated history fetch errors as non-fatal (logged a warning with `this.logger.warn(...)` but still returned the schedule data). The new code calls `repo.getExecutionHistory()` directly and on failure displays `ui.error(...)` to the user. This is a behavior change: the error is now visible to the user where it was previously silent.
- Impact: The error is not fatal (the schedule still displays), so this is not a regression in functionality. The new behavior is arguably better (user sees the error) but it is a deviation from the previous behavior. The old code also returned the schedule without the history; the new code does the same.
- Fix: This is an intentional improvement. No action needed unless you want exact behavioral parity, in which case suppress the `ui.error()` call.

**`scheduleList` drops `offset` parameter support** - `src/cli/commands/schedule.ts:278-280`
- Problem: The old code called `service.listSchedules(status, limit)` which forwarded to `scheduleRepository.findByStatus(status, limit, offset)` / `findAll(limit, offset)`. However, the offset parameter was never exposed in the CLI arg parser (no `--offset` flag existed), so the old code always passed `undefined` for offset. The new code calls `repo.findByStatus(status, limit)` / `repo.findAll(limit)` directly, also omitting offset. Both paths resolve to `offset ?? 0` in the repository. No functional difference.
- Impact: None. The CLI never accepted `--offset`, so this is behavioral parity.
- Fix: No action needed.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Logs command skips in-memory OutputCapture fallback** - `src/cli/commands/logs.ts:25-31`
- Problem: The old code path used `TaskManager.getLogs()` which first checked the in-memory `OutputCapture` (for tasks actively running in the same process), then fell back to the database. The new read-only path goes directly to `outputRepository.get()`, skipping in-memory output entirely. The code comment on line 25 says "skip in-memory OutputCapture -- always empty for CLI" which is correct: the CLI is a separate process from the MCP server, so the `OutputCapture` buffer in the CLI process would always be empty. The in-memory check only matters when querying from the same process that spawned the worker (the MCP server daemon). This is intentional and correct.
- Impact: No functional regression. The in-memory buffer is always empty in a CLI context because the CLI is a separate process from the MCP daemon that runs workers. The output is flushed to SQLite by the daemon.
- Fix: No action needed. The comment correctly documents the rationale.

**`withServices()` now skips recovery for all CLI mutation commands** - `src/cli/services.ts:48`
- Problem: Previously, `withServices()` called `bootstrap({ skipScheduleExecutor: true })` which ran recovery on startup. Now it also passes `skipRecovery: true`, meaning CLI mutation commands (run, cancel, retry, resume, schedule create/cancel/pause/resume) no longer trigger recovery. Recovery requeues tasks that were in RUNNING state when a previous process crashed.
- Impact: This is intentional. Short-lived CLI commands exit quickly, so running recovery (which re-enqueues stale RUNNING tasks) would start background work that the CLI process can't follow through on. Only the MCP server daemon, which stays alive to process the queue, should run recovery. The comment on line 40 confirms this intent.
- Fix: No action needed. This is a correct architectural decision.

## Pre-existing Issues (Not Blocking)

### LOW

**`ReadOnlyContext` interface exposes `database` field** - `src/cli/read-only-context.ts:24`
- Problem: The `ReadOnlyContext` interface exposes the raw `Database` object. Only the test suite uses `ctx.database.close()`. The CLI commands never reference `ctx.database` directly. Exposing it creates a temptation for callers to perform arbitrary SQL operations, bypassing repository abstractions.
- Impact: Minimal. The interface is internal to the CLI module.
- Fix: Consider removing `database` from the public interface if CLI callers don't need it, or add a `close()` method directly on `ReadOnlyContext`.

**Unused import: `ReadOnlyContext` type** - `tests/unit/read-only-context.test.ts:5`
- Problem: `ReadOnlyContext` is imported but never used as a type annotation in the test file (it is only used via `createReadOnlyContext()` which returns `Result<ReadOnlyContext>`).
- Impact: No runtime effect. TypeScript will tree-shake it.
- Fix: Remove the unused import: `import { createReadOnlyContext } from '../../src/cli/read-only-context.js';`

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 2 |

**Regression Score**: 9/10

The changes are regression-safe. The core change -- replacing `withServices()` (full bootstrap) with `withReadOnlyContext()` (direct DB + repos) for read-only CLI commands -- maintains behavioral parity with the original `TaskManager.getStatus()`, `TaskManager.getLogs()`, `ScheduleManagerService.listSchedules()`, and `ScheduleManagerService.getSchedule()` implementations. Those service methods already delegated directly to the same repositories. The read-only context simply removes the unnecessary initialization of 15+ components (EventBus, handlers, WorkerPool, AgentRegistry, etc.) that query commands never used.

Key regression checks:
- No exports removed
- No files deleted
- No new TODOs introduced
- No return types changed
- All CLI commands preserved (status, logs, list/ls, schedule list, schedule get)
- Error handling parity maintained (task-not-found, DB errors)
- Output formatting identical (same `ui.step`, `ui.note`, `ui.error` calls)
- `process.exit()` codes unchanged (0 for success, 1 for failure)
- Mutation commands (run, cancel, retry, resume, schedule create/cancel/pause/resume) still use full `withServices()` bootstrap

The HIGH-rated database cleanup issue is a pattern improvement opportunity rather than a true regression, since the old code path had identical behavior (no explicit DB close before process.exit).

**Recommendation**: APPROVED
