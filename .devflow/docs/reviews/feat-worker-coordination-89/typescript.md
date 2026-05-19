# TypeScript Review Report

**Branch**: feat/worker-coordination-89 -> main
**Date**: 2026-03-17
**Commits**: 7324e28, 0c496f3

## Issues in Your Changes (BLOCKING)

### HIGH

**Non-null assertion on `workerRegistration!.ownerPid`** - `src/services/recovery-manager.ts:153`
- Problem: The non-null assertion operator (`!`) is used on `workerRegistration` even though TypeScript can prove `hasLiveWorker` is true only when `workerRegistration !== null`. However, the narrowing happens across two separate variable assignments (line 146-147) and the `!` is needed because TS cannot narrow through a boolean derived from a compound condition. This is still an anti-pattern per TypeScript skill rules -- prefer a direct null check in the branch.
- Impact: If the logic of `hasLiveWorker` is ever refactored to decouple from `workerRegistration`, the `!` will silently hide a potential null dereference.
- Fix: Restructure to eliminate the assertion by using the narrowed variable directly:
```typescript
if (workerRegistration !== null && this.isProcessAlive(workerRegistration.ownerPid)) {
  this.logger.info('Running task has live worker in another process, skipping', {
    taskId: task.id,
    ownerPid: workerRegistration.ownerPid, // No `!` needed -- TS narrows here
  });
  continue;
}
```

**`OutputRepository` interface defined in implementation file, imported across layers** - `src/implementations/output-repository.ts:15-20`
- Problem: The `OutputRepository` interface is defined inside `src/implementations/output-repository.ts` (an implementation file), but is imported by core service files: `src/services/process-connector.ts:9`, `src/services/task-manager.ts:30`, and `src/implementations/event-driven-worker-pool.ts:18`. This creates a dependency inversion violation -- services depend on implementations for the interface contract. The new `WorkerRepository` interface was correctly placed in `src/core/interfaces.ts`, making this inconsistency more visible.
- Impact: Coupling direction is inverted. Services (higher layer) import from implementations (lower layer) just to get a type. This is architectural debt that becomes harder to fix as more consumers are added.
- Fix: Move the `OutputRepository` interface to `src/core/interfaces.ts` alongside the other repository interfaces (`TaskRepository`, `WorkerRepository`, `CheckpointRepository`, etc.), and re-export from `output-repository.ts` for backward compatibility if needed:
```typescript
// src/core/interfaces.ts
export interface OutputRepository {
  save(taskId: TaskId, output: TaskOutput): Promise<Result<void>>;
  append(taskId: TaskId, stream: 'stdout' | 'stderr', data: string): Promise<Result<void>>;
  get(taskId: TaskId): Promise<Result<TaskOutput | null>>;
  delete(taskId: TaskId): Promise<Result<void>>;
}
```

### MEDIUM

**Duplicate `startedAt` timestamps in worker registration** - `src/implementations/event-driven-worker-pool.ts:97,115`
- Problem: `Date.now()` is called twice -- once for `worker.startedAt` (line 97) and once for the registration's `startedAt` (line 115). These will differ by the time it takes to complete the `agentRegistry.get()` and `adapter.spawn()` calls, leading to two slightly different timestamps for the same worker.
- Impact: Minor data inconsistency. If anyone compares `worker.startedAt` with the DB registration's `startedAt`, they will not match.
- Fix: Capture `Date.now()` once and reuse:
```typescript
const startedAt = Date.now();
const worker: WorkerState = {
  // ...
  startedAt,
  // ...
};
// ...
const regResult = this.workerRepository.register({
  // ...
  startedAt,
});
```

**Mock factory duplication across 8+ test files** - Multiple test files
- Problem: `createMockWorkerRepository()` is copy-pasted identically into 7 files: `event-flow.test.ts`, `task-persistence.test.ts`, `worker-pool-management.test.ts`, `event-driven-worker-pool.test.ts`, `system-resource-monitor.test.ts`, `handler-setup.test.ts`, `recovery-manager.test.ts`. Similarly, `createMockOutputRepository()` is duplicated across 7 files. Meanwhile, `tests/fixtures/test-doubles.ts` already has a `TestWorkerRepository` class.
- Impact: When the `WorkerRepository` interface changes (e.g., adding a new method), all 7+ copies must be updated individually, increasing maintenance burden and risk of drift.
- Fix: Consolidate the vi.fn()-based mock factory into `tests/fixtures/test-doubles.ts` or a new `tests/fixtures/mock-factories.ts`:
```typescript
// tests/fixtures/mock-factories.ts
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
```

**Missing type-only import for `OutputRepository`** - `src/implementations/event-driven-worker-pool.ts:18`, `src/services/process-connector.ts:9`
- Problem: `OutputRepository` is used only as a type in the constructor parameter list (the value is passed through to `ProcessConnector`), yet it is imported with a value import (`import { OutputRepository }`). The TypeScript skill checklist states: "Type-only imports for types."
- Impact: Minor. The value import works but is semantically incorrect -- it signals to readers that the import is used at runtime.
- Fix: Use `import type`:
```typescript
// src/implementations/event-driven-worker-pool.ts
import type { OutputRepository } from './output-repository.js';
```
Note: In `process-connector.ts`, `OutputRepository` IS used at runtime (the parameter is stored and its methods are called), so it correctly uses a value import there.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`settlingWorkers` variable declared but only used for resource projection, not max workers** - `src/implementations/resource-monitor.ts:85`
- Problem: After the refactoring, `settlingWorkers` is computed at line 85 but is no longer used in the max workers check (lines 89-100). It is still used for CPU/memory projection (lines 113-114). The variable name and its position right before the `getGlobalCount()` call suggest it should participate in the max workers check, but it does not. The comment on line 87-88 explains this is intentional ("DB count already includes just-spawned workers"), but the settling window still serves a purpose for resource metrics -- this could confuse future readers.
- Impact: Potential confusion. A reader might think settling workers are accidentally excluded from the max workers check.
- Fix: Move the `settlingWorkers` declaration closer to where it is actually used (the resource projection section around line 111), with a comment clarifying its scope:
```typescript
// SETTLING WORKERS: Only used for resource projection (CPU/memory metrics lag)
// Not needed for max workers check — DB count is the authoritative source
this.pruneExpiredTimestamps();
const settlingWorkers = this.recentSpawnTimestamps.length;
```

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`as` type assertions on better-sqlite3 query results** - `src/implementations/worker-repository.ts:123,138,153,167`
- Problem: All `.get()` and `.all()` calls use `as` type assertions (e.g., `as WorkerRow | undefined`). This is a pre-existing pattern across all repositories in the codebase (task-repository, dependency-repository, schedule-repository, checkpoint-repository all do the same). better-sqlite3 returns `unknown`, so some form of assertion is unavoidable without a wrapper.
- Impact: No runtime type validation. If the DB schema drifts from the TypeScript row types, errors will occur at property access time rather than at the query boundary.
- Fix: This is a codebase-wide concern. Consider a shared utility like `safeGet<T>(stmt, ...params): T | undefined` that validates the shape at runtime using Zod or a simple runtime check. Not blocking for this PR since it follows the established pattern.

### LOW

**`OutputRepository` interface defined in implementation file** - `src/implementations/output-repository.ts:15-20`
- Problem: Pre-existing. All other repository interfaces (`TaskRepository`, `WorkerRepository`, `DependencyRepository`, `ScheduleRepository`, `CheckpointRepository`) are in `src/core/interfaces.ts`. `OutputRepository` is the only one defined in its implementation file.
- Impact: Inconsistency in architecture layer boundaries. The new code in this PR makes the inconsistency more visible by adding more consumers that import from the implementation file.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 1 |

**TypeScript Score**: 8/10
**Recommendation**: CHANGES_REQUESTED

### Rationale

The TypeScript quality in this PR is strong overall:
- Zero `any` types across all changed files
- Proper use of `readonly` on all `WorkerRegistration` fields and `WorkerRow` interface
- Correct use of branded types (`WorkerId`, `TaskId`) throughout
- Consistent `Result<T>` pattern with proper error handling
- Well-typed `WorkerRepository` interface placed correctly in `src/core/interfaces.ts`
- Discriminated union patterns used correctly with `result.ok` narrowing
- `tryCatch` wrapping for all synchronous repository methods

The two HIGH issues are: (1) a non-null assertion that can be trivially eliminated with a restructured condition, and (2) the `OutputRepository` interface placement which this PR makes worse by adding more cross-layer imports. The mock duplication (MEDIUM) is a maintenance concern that will compound with each new feature.

None of these issues are critical or introduce runtime bugs. The recommendation is CHANGES_REQUESTED rather than BLOCK because the non-null assertion is guarded by correct logic and the interface placement is a pre-existing pattern that this PR only extends.
