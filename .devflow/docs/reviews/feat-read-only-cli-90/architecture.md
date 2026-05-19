# Architecture Review Report

**Branch**: feat/read-only-cli-90 -> main
**Date**: 2026-03-18
**PR**: #100

## Overview

This PR introduces a `ReadOnlyContext` -- a lightweight alternative to full `bootstrap()` for CLI query commands (status, logs, schedule list/get). Instead of initializing 15+ components (EventBus, 6 handlers, WorkerPool, AgentRegistry, ResourceMonitor, RecoveryManager, etc.), read-only commands now open only Database + 3 repositories, saving ~200-500ms per query.

Additionally, `withServices()` now passes `skipRecovery: true` to `bootstrap()`, and `bootstrap()` gains a new `skipRecovery` option to skip RecoveryManager on startup for short-lived CLI commands.

---

## Issues in Your Changes (BLOCKING)

### HIGH

**DIP violation: `ReadOnlyContext` depends on concrete `Database` class** - `src/cli/read-only-context.ts:18,24`
- Problem: The `ReadOnlyContext` interface exposes the concrete `Database` class (`readonly database: Database`) rather than an abstraction. The rest of the codebase follows DIP via the `TransactionRunner` interface and repository interfaces defined in `src/core/interfaces.ts`. The `OutputRepository` interface is also imported from the implementation file (`src/implementations/output-repository.ts`) rather than from `src/core/interfaces.ts`.
- Impact: The `ReadOnlyContext` is tightly coupled to concrete SQLite implementations. This makes the context harder to test in isolation and breaks the DIP pattern established throughout the codebase. Callers who receive `ReadOnlyContext` cannot substitute test doubles without pulling in the concrete Database class.
- Fix: Consider whether `database` needs to be on the public interface at all -- callers only use `taskRepository`, `outputRepository`, and `scheduleRepository`. If database access is needed for cleanup, a narrower interface (e.g., `{ close(): void; isOpen(): boolean }`) would be sufficient. Also, `OutputRepository` should be defined in or re-exported from `src/core/interfaces.ts` like `TaskRepository` and `ScheduleRepository` already are.
```typescript
// Option A: Remove database from public interface, manage lifecycle internally
export interface ReadOnlyContext {
  readonly taskRepository: TaskRepository;
  readonly outputRepository: OutputRepository; // from core/interfaces.ts
  readonly scheduleRepository: ScheduleRepository;
  close(): void;
}

// Option B: Expose only the lifecycle methods via a narrow interface
interface Closeable { close(): void; isOpen(): boolean; }
export interface ReadOnlyContext {
  readonly database: Closeable;
  readonly taskRepository: TaskRepository;
  readonly outputRepository: OutputRepository;
  readonly scheduleRepository: ScheduleRepository;
}
```

### MEDIUM

**No database cleanup in CLI command paths** - `src/cli/commands/logs.ts`, `src/cli/commands/status.ts`, `src/cli/commands/schedule.ts`
- Problem: The `withReadOnlyContext()` creates a `Database` instance but none of the CLI command code paths call `ctx.database.close()`. All paths end with `process.exit()`, which will terminate the process and release the SQLite file lock -- but the resource cleanup pattern is inconsistent with the test code (which diligently calls `ctx.database.close()`). If `process.exit()` calls are ever removed (e.g., for embedding or testing), the database connection leaks.
- Impact: Currently benign due to `process.exit()`, but the missing cleanup establishes a pattern that could cause resource leaks if the CLI is ever refactored to be embeddable or if `process.exit()` is replaced with return values.
- Fix: Add database close in a `finally` block, or document the intentional reliance on `process.exit()` for cleanup.
```typescript
// In logs.ts, status.ts, etc.
try {
  const ctx = withReadOnlyContext(s);
  try {
    // ... command logic ...
  } finally {
    ctx.database.close();
  }
} catch (error) { ... }
```

**`ReadOnlyContext` creates concrete instances directly -- bypasses DI container** - `src/cli/read-only-context.ts:34-43`
- Problem: `createReadOnlyContext()` instantiates `new Database()`, `new SQLiteTaskRepository(database)`, etc. directly. While this is the explicit purpose of the module (skip the DI container for performance), it creates a parallel construction path that must be kept in sync with `bootstrap()` whenever repository constructors change.
- Impact: If `SQLiteTaskRepository`, `SQLiteOutputRepository`, or `SQLiteScheduleRepository` constructors gain new required parameters (e.g., a Logger), `createReadOnlyContext()` will break silently at runtime rather than at compile time (since the change would be in `bootstrap()` but not here). This is a maintenance coupling risk.
- Fix: This is an acceptable architectural trade-off given the stated ~200-500ms performance benefit. Mitigate by adding a comment documenting which `bootstrap()` registrations must stay in sync, and consider a compile-time check (e.g., a shared factory or type assertion) to catch drift.

---

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`findAllUnbounded()` used in status list without pagination** - `src/cli/commands/status.ts:62`
- Problem: `status.ts` calls `ctx.taskRepository.findAllUnbounded()` to list all tasks. The `findAllUnbounded` method explicitly skips pagination safeguards. The original code used `taskManager.getStatus()` which eventually called the same method, so this is not a regression -- but now that the CLI directly calls the repository, it is worth noting that a user with thousands of tasks will get all of them dumped to the terminal.
- Impact: Poor UX and potential memory/performance issue for heavy users. Not a regression from the previous code path.
- Fix: Consider using `findAll(limit)` with a default limit (e.g., 100) and adding a `--limit` flag, similar to how `schedule list` already supports `--limit`.

### LOW

**Schedule command creates spinner/context twice for mutation path** - `src/cli/commands/schedule.ts:17-33`
- Problem: The schedule command creates a spinner and calls `withReadOnlyContext()` for list/get subcommands, then creates a *second* spinner and calls `withServices()` for mutation subcommands. While this is correct (only one path executes), the code structure has two independent initialization blocks in sequence.
- Impact: Minor readability issue. A reader must understand that the first block exits via `process.exit(0)` before reaching the second.
- Fix: The current structure with early return via `process.exit(0)` is clear enough. No change needed, but an `else` or early `return` (instead of `process.exit`) would make the control flow more explicit.

---

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`OutputRepository` interface defined in implementation file** - `src/implementations/output-repository.ts:15`
- Problem: `OutputRepository` is the only repository interface defined in an implementation file rather than in `src/core/interfaces.ts`. `TaskRepository`, `ScheduleRepository`, `DependencyRepository`, `WorkerRepository`, and `CheckpointRepository` are all defined in `src/core/interfaces.ts`. This inconsistency means `ReadOnlyContext` must import from the implementation layer.
- Impact: Violates the project's own layering convention. Any module that needs to reference the `OutputRepository` type must depend on the implementation package.

### LOW

**`run.ts` command does not use `withServices()`** - `src/cli/commands/run.ts`
- Problem: The `run.ts` command has its own bootstrap path rather than using the shared `withServices()` utility. This is likely intentional (run may need different bootstrap options), but it means there are now three CLI initialization patterns: `withReadOnlyContext()`, `withServices()`, and direct `bootstrap()` in `run.ts`.
- Impact: Three patterns for similar operations increases cognitive load. Not introduced by this PR.

---

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 1 |
| Pre-existing | 0 | 0 | 1 | 1 |

**Architecture Score**: 7/10

The core concept is architecturally sound -- separating read-only query paths from full mutation bootstrap is a well-established pattern (CQRS-lite). The implementation correctly identifies which commands are read-only and routes them through the lightweight path. The main concern is the DIP violation where the `ReadOnlyContext` interface depends on the concrete `Database` class and imports `OutputRepository` from the implementation layer rather than from core interfaces. The parallel construction path (manual instantiation vs. DI container) is an acceptable trade-off for the performance gain, but should be documented to prevent drift.

**Recommendation**: CHANGES_REQUESTED

The HIGH-severity DIP violation (concrete `Database` on the `ReadOnlyContext` interface) should be addressed before merge. The `OutputRepository` interface should ideally be moved to `src/core/interfaces.ts` for consistency, though this could be done in a follow-up PR since it is a pre-existing issue.
