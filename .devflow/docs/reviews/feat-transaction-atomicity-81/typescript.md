# TypeScript Review Report

**Branch**: feat/transaction-atomicity-81 -> main
**Date**: 2026-03-18
**PR**: #85

---

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Dead code: `recordTriggeredExecution` method is now unused** - `src/services/handlers/schedule-handler.ts:526`
- Problem: The `recordTriggeredExecution` private async method is no longer called anywhere. Both `handleSingleTaskTrigger` and `handlePipelineTrigger` now use the synchronous `recordExecutionSync` inside transactions instead. This method is dead code that will confuse future maintainers.
- Impact: Code clarity; dead code suggests incomplete refactoring.
- Fix: Remove the `recordTriggeredExecution` method (lines 526-545) entirely.

**Dead code: `updateScheduleAfterTrigger` async method is now unused** - `src/services/handlers/schedule-handler.ts:602`
- Problem: The `updateScheduleAfterTrigger` private async method is no longer called anywhere. Both trigger paths now use the synchronous `updateScheduleAfterTriggerSync` inside transactions instead. This method is dead code.
- Impact: Code clarity; suggests incomplete cleanup.
- Fix: Remove the `updateScheduleAfterTrigger` method (lines 602-614) entirely.

**`computeScheduleUpdates` doc claims "pure computation" but has side effects** - `src/services/handlers/schedule-handler.ts:548-549`
- Problem: The JSDoc comment says "Pure computation -- no side effects" but the method calls `this.logger.error(...)` and `this.logger.info(...)` in three places (lines 562, 577, 588). While logging is generally benign, calling it "pure computation" is misleading documentation, especially since this method is now called inside synchronous transactions where side-effect awareness matters.
- Impact: Misleading architecture documentation. A developer relying on the "pure" claim might not realize logging I/O occurs inside the transaction callback.
- Fix: Update the JSDoc to reflect reality:
  ```typescript
  /**
   * Compute schedule update fields after a trigger (runCount, lastRunAt, nextRunAt, status).
   * Shared by async and sync trigger paths. Performs logging but no database writes.
   */
  ```

### LOW

**`toDbFormat` return type is `Record<string, unknown>` -- could be more precise** - `src/implementations/task-repository.ts:173`, `src/implementations/schedule-repository.ts:251`
- Problem: Both `toDbFormat` methods return `Record<string, unknown>`, which erases the type information of the returned object. If a property name is misspelled or a new column is added without updating the format method, TypeScript will not catch the error. The current approach relies on runtime SQLite errors to detect mismatches.
- Impact: Low -- better-sqlite3 will fail at runtime on named parameter mismatches, so this is caught in tests. However, a typed interface would catch issues at compile time.
- Fix: Define explicit interfaces for the database parameter format:
  ```typescript
  interface TaskDbParams {
    readonly id: string;
    readonly prompt: string;
    readonly status: string;
    // ... etc
  }
  private toDbFormat(task: Task): TaskDbParams { ... }
  ```

**Unsafe type assertion on `getExecutionByIdStmt.get()` result** - `src/implementations/schedule-repository.ts:349`
- Problem: `this.getExecutionByIdStmt.get(result.lastInsertRowid) as ScheduleExecutionRow` assumes the row will always exist after a successful insert. While this is a safe assumption for a single-writer SQLite scenario (the row was just inserted in the same transaction), the `as` assertion bypasses null checking.
- Impact: Very low -- practically impossible to fail given the synchronous transaction context, but the pattern is slightly less safe than the `findByIdSync` methods which handle `undefined`.
- Fix: Add a defensive check:
  ```typescript
  const row = this.getExecutionByIdStmt.get(result.lastInsertRowid) as ScheduleExecutionRow | undefined;
  if (!row) {
    throw new AutobeatError(ErrorCode.SYSTEM_ERROR, 'Failed to read back execution record');
  }
  return this.rowToExecution(row);
  ```

---

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`getDependency<T>` uses unsafe `as T` assertion** - `src/services/handler-setup.ts:82`
- Problem: The container `get()` method returns `unknown`, and the `getDependency` function casts it with `as T`. This means the intersection types like `TaskRepository & SyncTaskOperations` and `ScheduleRepository & SyncScheduleOperations` are asserted but never verified at runtime. If a registration provides an object that implements `TaskRepository` but not `SyncTaskOperations`, the error would manifest as a runtime crash inside a transaction, not at startup.
- Impact: Medium -- the real implementations (`SQLiteTaskRepository`, `SQLiteScheduleRepository`) correctly implement both interfaces, so this is safe in production. However, the type assertion defeats TypeScript's guarantees for the intersection types specifically added in this PR.
- Fix: This is a pre-existing architectural pattern in the DI container. Fixing it properly would require a typed container or runtime interface checks, which is out of scope for this PR. Consider filing an issue to add runtime validation of sync operation support during bootstrap.

---

## Pre-existing Issues (Not Blocking)

### LOW

**`any` types in `TaskEventEmitter` interface** - `src/core/interfaces.ts:373,375`
- Problem: Two uses of `any` in the `emit` and `off` signatures. These have `biome-ignore` comments explaining the EventEmitter compatibility requirement.
- Impact: None -- these are correctly suppressed legacy patterns with documented justification.

**`Container` service map uses `any`** - `src/core/container.ts:11`
- Problem: The `Service` type uses `Factory<any>` and `instance?: any`.
- Impact: Pre-existing. The container's generic nature makes strong typing difficult without a major redesign.

---

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 3 | 2 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 2 |

**TypeScript Score**: 8/10

The PR demonstrates strong TypeScript practices overall:
- Well-designed narrow interfaces (`SyncTaskOperations`, `SyncScheduleOperations`) following Interface Segregation Principle
- Proper use of intersection types (`TaskRepository & SyncTaskOperations`) for composability
- Consistent use of discriminated unions via the `Result` type pattern
- Proper generic constraints on `runInTransaction<T>`
- `Record<string, unknown>` instead of `Record<string, any>` for db params
- Good Zod boundary validation preserved in sync paths via shared `rowToTask`/`rowToSchedule`
- No new `any` types introduced
- Strict tsconfig with `noImplicitReturns` enabled

The main concerns are dead code from incomplete cleanup (two now-unused async methods), a misleading "pure" doc comment, and minor type precision opportunities.

**Recommendation**: APPROVED_WITH_CONDITIONS

Conditions:
1. Remove dead code: `recordTriggeredExecution` and `updateScheduleAfterTrigger` (async version) methods
2. Fix the "pure computation" doc comment on `computeScheduleUpdates`
