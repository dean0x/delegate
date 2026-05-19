# Consistency Review Report

**Branch**: feat/worker-coordination-89 -> main
**Date**: 2026-03-17
**PR**: #94
**Commits**: 7324e28 (feat: SQLite worker coordination + output persistence), 0c496f3 (fix: address self-review issues)

---

## Issues in Your Changes (BLOCKING)

### HIGH

**Missing Zod row validation schema in SQLiteWorkerRepository** - `src/implementations/worker-repository.ts:19-27`
- Problem: Every other SQLite repository in the codebase uses a Zod schema to validate database rows at the system boundary (parse, don't validate). `SQLiteTaskRepository` has `TaskRowSchema`, `SQLiteDependencyRepository` has `DependencyRowSchema`, `SQLiteCheckpointRepository` has `CheckpointRowSchema`, `SQLiteScheduleRepository` has `ScheduleRowSchema`. The new `SQLiteWorkerRepository` skips this pattern entirely, using only a TypeScript interface (`WorkerRow`) with unchecked `as` casts.
- Impact: Data corruption or unexpected DB values will produce silent type mismatches rather than early, clear Zod parse errors. Breaks the "parse, don't validate" convention established in all 4 other repositories.
- Fix: Add a `WorkerRowSchema` using Zod and use `.parse(row)` in `rowToRegistration()`:
  ```typescript
  import { z } from 'zod';

  const WorkerRowSchema = z.object({
    worker_id: z.string().min(1),
    task_id: z.string().min(1),
    pid: z.number(),
    owner_pid: z.number(),
    agent: z.string(),
    started_at: z.number(),
  });

  // In rowToRegistration():
  private rowToRegistration(row: WorkerRow): WorkerRegistration {
    const data = WorkerRowSchema.parse(row);
    return {
      workerId: WorkerId(data.worker_id),
      taskId: TaskId(data.task_id),
      pid: data.pid,
      ownerPid: data.owner_pid,
      agent: data.agent,
      startedAt: data.started_at,
    };
  }
  ```

**Missing `operationErrorHandler` in SQLiteWorkerRepository** - `src/implementations/worker-repository.ts:77-190`
- Problem: All other repositories use `operationErrorHandler()` from `core/errors.js` as the error mapping function passed to `tryCatch`/`tryCatchAsync`. This provides a consistent error wrapping pattern across the codebase. The new worker repository instead manually constructs `AutobeatError` inline in every method, which is more verbose and inconsistent.
- Impact: Error messages and metadata structure will differ from other repositories. Maintenance burden increases because the error mapping logic is duplicated rather than centralized.
- Fix: Import and use `operationErrorHandler`:
  ```typescript
  import { operationErrorHandler } from '../core/errors.js';

  // Example for register():
  register(registration: WorkerRegistration): Result<void> {
    return tryCatch(
      () => { this.registerStmt.run({...}); },
      operationErrorHandler('register worker', { workerId: registration.workerId }),
    );
  }
  ```
  Note: The `register()` method has special UNIQUE constraint detection logic, which may justify keeping a custom error mapper for that one method. The other 6 methods should use `operationErrorHandler`.

### MEDIUM

**OutputRepository interface defined in implementation file, not core/interfaces.ts** - `src/implementations/output-repository.ts:15-20`
- Problem: The `WorkerRepository` interface is correctly defined in `src/core/interfaces.ts` (following the pattern of `TaskRepository`, `DependencyRepository`, `ScheduleRepository`, `CheckpointRepository`). However, `OutputRepository` is defined in `src/implementations/output-repository.ts` and this PR propagates that inconsistency by importing it from the implementation file in 3 new locations (`process-connector.ts`, `event-driven-worker-pool.ts`, `task-manager.ts`).
- Impact: Dependency inversion principle violation. Service-layer code (`process-connector.ts`, `task-manager.ts`) imports from the implementation layer instead of the core/interfaces layer. This is a pre-existing pattern issue, but this PR deepens it by adding 3 more import sites.
- Category note: This is partially pre-existing (the interface was already in the wrong place), but the new code actively imports from the implementation file, so marking it here.
- Fix: Move `OutputRepository` interface to `src/core/interfaces.ts` alongside the other repository interfaces, then update all imports. This can be done in a follow-up PR.

**Duplicated mock factory functions across 9 test files** - multiple test files
- Problem: The `createMockWorkerRepo`/`createMockWorkerRepository` factory is copy-pasted identically in 7 test files. The `createMockOutputRepo`/`createMockOutputRepository` factory is copy-pasted in 8 test files. Existing test doubles are centralized in `tests/fixtures/test-doubles.ts` (e.g., `TestOutputCapture`, `TestLogger`). A `TestWorkerRepository` class was added there, but the simpler `vi.fn()`-based mock factory was not.
- Impact: If `WorkerRepository` or `OutputRepository` interfaces change, 7-8 files need identical updates. The naming is also inconsistent -- some files use `createMockWorkerRepo` and others use `createMockWorkerRepository`.
- Fix: Add shared factory functions to `tests/fixtures/test-doubles.ts` or a new `tests/fixtures/mock-factories.ts`:
  ```typescript
  export function createMockWorkerRepository(): WorkerRepository {
    return {
      register: vi.fn().mockReturnValue(ok(undefined)),
      unregister: vi.fn().mockReturnValue(ok(undefined)),
      findByTaskId: vi.fn().mockReturnValue(ok(null)),
      findByOwnerPid: vi.fn().mockReturnValue(ok([])),
      findAll: vi.fn().mockReturnValue(ok([])),
      getGlobalCount: vi.fn().mockReturnValue(ok(0)),
      deleteByOwnerPid: vi.fn().mockReturnValue(ok(0)),
    };
  }

  export function createMockOutputRepository(): OutputRepository {
    return {
      save: vi.fn().mockResolvedValue(ok(undefined)),
      append: vi.fn().mockResolvedValue(ok(undefined)),
      get: vi.fn().mockResolvedValue(ok(null)),
      delete: vi.fn().mockResolvedValue(ok(undefined)),
    };
  }
  ```
  Then import from the shared file in all test files. Use one consistent name (`createMockWorkerRepository`, not abbreviated `createMockWorkerRepo`).

**Inconsistent mock factory naming** - multiple test files
- Problem: Some test files name the factory `createMockWorkerRepo` (abbreviated) and others use `createMockWorkerRepository` (full name). Within the same codebase, the existing test doubles use full names (`TestOutputCapture`, `TestProcessSpawner`, `TestWorkerRepository`).
- Files using abbreviated name: `event-flow.test.ts`, `task-persistence.test.ts`, `handler-setup.test.ts`, `system-resource-monitor.test.ts`, `retry-functionality.test.ts`
- Files using full name: `worker-pool-management.test.ts`, `event-driven-worker-pool.test.ts`, `recovery-manager.test.ts`, `process-connector.test.ts`, `task-manager.test.ts`
- Fix: Standardize on `createMockWorkerRepository` and `createMockOutputRepository` (full names, matching the interface names).

---

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`err` import removed but may be needed for future error returns** - `src/services/recovery-manager.ts:8`
- Problem: The import of `err` was removed from the result import (now only imports `ok, Result`). While the current code does not use `err` directly (it delegates error handling to repository calls), this was a deliberate change from the previous version which did return `err()` in some paths. The current implementation always returns `ok(undefined)` even when individual task recoveries fail -- it logs errors but never propagates them.
- Impact: Low. The current behavior is intentional (recovery is best-effort), but the removal of `err` makes it impossible to return errors without re-adding the import. This is a minor observation.
- Fix: No action needed unless error propagation is desired.

---

## Pre-existing Issues (Not Blocking)

### MEDIUM

**OutputRepository interface in implementation file** - `src/implementations/output-repository.ts:15-20`
- Problem: As noted above, the `OutputRepository` interface lives in the implementation layer rather than `src/core/interfaces.ts`. All other repository interfaces (`TaskRepository`, `DependencyRepository`, `ScheduleRepository`, `CheckpointRepository`, and now `WorkerRepository`) are in `src/core/interfaces.ts`.
- Fix: Move to `src/core/interfaces.ts` in a separate PR.

### LOW

**`database` field not stored on DependencyRepository but stored on other repos** - various
- Problem: `SQLiteDependencyRepository` stores a `private readonly database: Database` field in addition to the `private readonly db: SQLite.Database` field. Most other repositories (including the new `SQLiteWorkerRepository`) only store `db`. This is minor and does not affect behavior.
- Fix: No action needed.

---

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 1 |

**Consistency Score**: 6/10

The new code is well-structured and the `WorkerRepository` follows the general repository pattern (prepared statements, `Result<T>` returns, branded ID types, DB row mapping). The synchronous `tryCatch` usage is correctly chosen for the synchronous better-sqlite3 API. However, two established patterns are not followed: the Zod row validation schema (used by all 4 other repositories) and the `operationErrorHandler` centralized error mapper (used by all 4 other repositories). The mock factory duplication across 9 test files is a significant maintenance concern.

**Recommendation**: CHANGES_REQUESTED

The two HIGH-severity blocking issues (missing Zod schema, missing `operationErrorHandler`) represent deviations from patterns that every other repository in the codebase follows. These should be addressed before merge to maintain the codebase's strong consistency posture. The mock factory duplication (MEDIUM) should ideally be consolidated but is not merge-blocking.
