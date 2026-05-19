# Performance Review Report

**Branch**: feat/read-only-cli-90 -> main
**Date**: 2026-03-18

## Overview

This PR introduces a lightweight `ReadOnlyContext` for CLI query commands (`status`, `logs`, `schedule list`, `schedule get`), bypassing the full `bootstrap()` which initializes 15+ components (EventBus, 6 handlers, WorkerPool, AgentRegistry, ResourceMonitor, RecoveryManager, etc.). Additionally, `withServices()` now skips recovery for mutation CLI commands. This is fundamentally a **performance improvement** -- the core motivation is reducing CLI startup latency by ~200-500ms for read-only operations.

## Issues in Your Changes (BLOCKING)

### HIGH

**Database connection never closed in CLI read-only path** - `src/cli/commands/status.ts`, `src/cli/commands/logs.ts`, `src/cli/commands/schedule.ts`

- Problem: `withReadOnlyContext()` opens a SQLite database connection, but none of the CLI commands close it before calling `process.exit()`. The `ReadOnlyContext` exposes `database.close()` (and tests correctly call it), but the production CLI code never does.
- Impact: On short-lived CLI commands that immediately call `process.exit()`, Node.js handles cleanup via OS process termination, so this is not a leak in practice. However, it sets a bad precedent and violates the project's own "Resource cleanup - Always use try/finally or using pattern" principle from CLAUDE.md. If these functions were ever called without `process.exit()` (e.g., from tests or a REPL), the connection would remain open.
- Fix: Close the database in a `finally` block, or close before each `process.exit()` call. Example for `status.ts`:
  ```typescript
  export async function getTaskStatus(taskId?: string) {
    const s = ui.createSpinner();
    let ctx: ReadOnlyContext | undefined;
    try {
      s.start(taskId ? `Fetching status for ${taskId}...` : 'Fetching tasks...');
      ctx = withReadOnlyContext(s);
      // ... existing logic ...
    } catch (error) {
      s.stop('Failed');
      ui.error(errorMessage(error));
      process.exit(1);
    } finally {
      ctx?.database.close();
    }
  }
  ```
- Note: The old `withServices()` path had the same issue with the bootstrapped container (pre-existing), but this PR introduces a new lightweight path that makes database lifecycle explicitly visible via `ctx.database`, making the missing cleanup more glaring.

### MEDIUM

**`findAllUnbounded()` used for `beat status` (list all tasks) with no pagination** - `src/cli/commands/status.ts:62`

- Problem: `ctx.taskRepository.findAllUnbounded()` returns ALL tasks with no limit. The repository has a paginated `findAll(limit?, offset?)` with a default limit of 100, but the code uses the explicitly unbounded variant.
- Impact: For a user with thousands of accumulated tasks, this loads every task row into memory and renders them all to the terminal. With the old `taskManager.getStatus()` code path on main, the same `findAllUnbounded()` was called (pre-existing), but the change to direct repository access was an opportunity to switch to the paginated API.
- Fix: Use the paginated `findAll()` method which defaults to 100 rows:
  ```typescript
  // Instead of:
  const result = await ctx.taskRepository.findAllUnbounded();
  // Use:
  const result = await ctx.taskRepository.findAll(); // defaults to 100
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Sequential database queries in `logs.ts` when task validation is unnecessary** - `src/cli/commands/logs.ts:13-26`

- Problem: `getTaskLogs()` makes two sequential database queries: first `findById()` to validate the task exists, then `outputRepository.get()` to fetch output. These are sequential and independent -- the output query already returns `null` when no output exists for a given task ID.
- Impact: Adds one extra database round-trip per `beat logs <id>` invocation. With SQLite (synchronous under the hood via better-sqlite3), the overhead is small (~1-5ms), but the validation query is redundant since `outputRepository.get()` already handles the case where no data exists.
- Fix: Remove the task existence check and rely on the output result. If the output is null, display "No output captured" (current behavior). If you want to distinguish "task not found" from "task exists but no output", you could do a single query or use `Promise.all`:
  ```typescript
  const [taskResult, outputResult] = await Promise.all([
    ctx.taskRepository.findById(TaskId(taskId)),
    ctx.outputRepository.get(TaskId(taskId)),
  ]);
  ```

### LOW

**`loadConfiguration()` called redundantly in read-only context** - `src/cli/read-only-context.ts:36`

- Problem: `loadConfiguration()` is called inside `createReadOnlyContext()`. This involves reading environment variables, optionally reading a config file from disk (`loadConfigFile()`), and running Zod schema validation. For the read-only path, only the `OutputRepository` actually needs the config (for `maxOutputBuffer` / `fileStorageThresholdBytes`).
- Impact: Minimal (sub-millisecond for env vars, maybe 1-2ms for file I/O if config file exists). The configuration loading is lightweight compared to the Database constructor which runs migrations. Not worth optimizing unless profiling shows otherwise.
- Recommendation: No action needed. Noting for completeness.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`Database` constructor runs synchronous I/O (mkdirSync, readFileSync via SQLite)** - `src/implementations/database.ts:62-88`

- Problem: The `Database` constructor uses `fs.existsSync()` and `fs.mkdirSync()`, plus the SQLite native module opens the file synchronously, runs pragma commands, and applies migrations -- all blocking the event loop.
- Impact: For CLI commands this is fine (single-threaded, no concurrent requests). For the MCP server, the bootstrap happens once at startup, so it is also acceptable. This would only matter if `Database` were constructed in a hot path.
- Recommendation: No action needed. Pre-existing pattern, appropriate for startup-only use.

### LOW

**`findAllUnbounded()` in `TaskManagerService.getStatus()`** - `src/services/task-manager.ts:116`

- Problem: The task manager's `getStatus()` (no ID) uses `findAllUnbounded()` which loads all tasks with no limit. This PR moves away from `taskManager.getStatus()` to direct repo access, which is a net improvement, but the unbounded variant was carried over.
- Impact: Pre-existing. The old code path also used unbounded queries.
- Recommendation: Switch all list-all-tasks paths to paginated `findAll()` in a follow-up.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 1 |
| Pre-existing | 0 | 0 | 1 | 1 |

**Performance Score**: 8/10

The PR is a significant net performance win. Bypassing full bootstrap for read-only CLI commands eliminates ~200-500ms of unnecessary initialization (EventBus, 6 handlers, WorkerPool, AgentRegistry, ResourceMonitor, RecoveryManager). The `skipRecovery` flag for `withServices()` is also a smart optimization for mutation CLI commands. The main concerns are: (1) missing database cleanup which violates the project's resource cleanup principle, and (2) carrying forward the unbounded query pattern for listing all tasks.

**Recommendation**: APPROVED_WITH_CONDITIONS

Conditions:
1. Add `database.close()` cleanup (try/finally or before `process.exit`) in the read-only CLI commands, or document why it is intentionally omitted.
2. Consider switching `findAllUnbounded()` to `findAll()` in `status.ts` for the list-all-tasks path (can be a follow-up).
