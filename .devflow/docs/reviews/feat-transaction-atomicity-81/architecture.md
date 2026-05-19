# Architecture Review Report

**Branch**: feat/transaction-atomicity-81 -> main
**Date**: 2026-03-18
**PR**: #85

## Summary of Changes

This PR replaces the old `TaskRepository.transaction()` pattern (which wrapped async operations in a synchronous SQLite transaction -- an architectural mismatch) with a cleaner `Database.runInTransaction()` approach paired with explicit synchronous (`*Sync`) repository methods. The key changes:

1. **New `Database.runInTransaction()`** -- Centralized transaction wrapper on the `Database` class using `better-sqlite3`'s synchronous transaction API with `Result` return type.
2. **New `SyncTaskOperations` and `SyncScheduleOperations` interfaces** -- Narrow ISP-compliant interfaces for the subset of operations needed inside transactions.
3. **Repositories implement dual interfaces** -- `SQLiteTaskRepository` implements both `TaskRepository` (async) and `SyncTaskOperations` (sync). Same pattern for `SQLiteScheduleRepository`.
4. **ScheduleHandler refactored** -- Both `handleSingleTaskTrigger` and `handlePipelineTrigger` now wrap task save + execution record + schedule update in a single atomic transaction. Events are emitted only after commit.
5. **Removed old `TransactionTaskRepository`** -- Eliminated 50-line delegation wrapper that was architecturally incorrect (async inside synchronous transaction).
6. **Extracted `toDbFormat()` and `computeScheduleUpdates()`** -- DRY refactoring to share mapping logic between async and sync paths.

---

## Issues in Your Changes (BLOCKING)

### HIGH

**Concrete `Database` type in service layer** - `src/services/handlers/schedule-handler.ts:38`, `src/services/handler-setup.ts:26`

- Problem: The `ScheduleHandler` (a service-layer handler) now depends directly on the concrete `Database` class from `src/implementations/database.ts`, rather than an interface. This is a Dependency Inversion Principle (DIP) violation. The service layer imports a concrete implementation class.
- Impact: The handler cannot be tested with a different transaction implementation (e.g., an in-memory test double for transactions). It couples the service layer to SQLite/better-sqlite3. The `HandlerDependencies` interface in `handler-setup.ts:45` uses the concrete `Database` type rather than an abstraction.
- Fix: Extract a `TransactionRunner` interface in `src/core/interfaces.ts` and have `Database` implement it:
  ```typescript
  // src/core/interfaces.ts
  export interface TransactionRunner {
    runInTransaction<T>(fn: () => T): Result<T>;
  }
  ```
  Then change `ScheduleHandler` and `HandlerDependencies` to depend on `TransactionRunner` instead of `Database`. The `Database` class would implement this interface. This keeps the dependency arrow pointing inward (service -> interface <- implementation).
- Category: Blocking (introduced in this PR)

### MEDIUM

**Dead code: `updateScheduleAfterTrigger` and `recordTriggeredExecution`** - `src/services/handlers/schedule-handler.ts:602`, `src/services/handlers/schedule-handler.ts:526`

- Problem: Both private methods `updateScheduleAfterTrigger()` (async) and `recordTriggeredExecution()` have zero callers. They were replaced by the sync transaction path (`updateScheduleAfterTriggerSync`) and inline `recordExecutionSync` calls, but were not removed.
- Impact: Dead code increases cognitive load and maintenance burden. Future developers may be confused about which path is canonical.
- Fix: Remove both methods. The sync transaction paths fully replace their functionality.
- Category: Blocking (code introduced/modified in this PR)

---

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Intersection types in signatures reduce flexibility** - `src/services/handler-setup.ts:46-52`, `src/services/handlers/schedule-handler.ts:57-58`

- Problem: The `HandlerDependencies` interface uses intersection types like `TaskRepository & SyncTaskOperations`. While this correctly enforces that the implementation must satisfy both contracts, it means every consumer of `HandlerDependencies` sees the full combined surface area. A handler that only needs async operations still receives the sync methods.
- Impact: Minor -- the current design is workable and the ISP-compliant separate interfaces (`SyncTaskOperations`, `SyncScheduleOperations`) already provide the right granularity. The intersection is used at the composition root (handler-setup), which is an acceptable place for widening. This is more of a design observation than a defect.
- Fix: No immediate action required. The current design is acceptable because the intersection is confined to the composition root and the `ScheduleHandler` constructor. If additional handlers need transactions in the future, consider passing `TransactionRunner` + sync interfaces separately rather than widening the repository types.

### MEDIUM

**`computeScheduleUpdates` has side effects (logging)** - `src/services/handlers/schedule-handler.ts:551-597`

- Problem: The JSDoc says "Pure computation -- no side effects" but the method calls `this.logger.error()` and `this.logger.info()` in three places (lines 562, 577, 588). Logging is a side effect. While this is not a correctness issue, the misleading documentation could confuse maintainers.
- Impact: Low -- logging side effects inside a synchronous transaction callback are safe (they do not affect the transaction state). But the "pure computation" claim is inaccurate.
- Fix: Either remove the "Pure computation -- no side effects" comment, or change it to "Computes schedule updates. Logs status changes but has no database side effects."

---

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`DependencyRepository.addDependencies` uses raw `this.db.transaction()` directly** - `src/implementations/dependency-repository.ts:215`

- Problem: The dependency repository uses `this.db.transaction()` directly (the raw better-sqlite3 API) rather than the new `Database.runInTransaction()` wrapper. This means there are now two transaction patterns in the codebase.
- Impact: Inconsistency -- new code uses `Database.runInTransaction()` with `Result` semantics, while existing code uses raw `this.db.transaction()` with try/catch. Not a correctness issue since both use the same underlying SQLite transaction mechanism.
- Fix: In a follow-up PR, migrate `dependency-repository.ts` to use `Database.runInTransaction()` for consistency.

### LOW

**`ScheduleExecutor` has direct repo writes (documented exception)** - per CLAUDE.md

- Problem: The `ScheduleExecutor` is documented as having "direct repo writes" as an architectural exception to the pure event-driven pattern. With the new transaction pattern, it would benefit from using `runInTransaction` as well.
- Impact: Pre-existing design decision, not introduced by this PR.
- Fix: Evaluate in a future PR whether `ScheduleExecutor` should adopt `runInTransaction`.

---

## Positive Architectural Observations

1. **Correct solution to async-in-sync-transaction problem**: The old `TransactionTaskRepository` was fundamentally broken -- it wrapped async calls inside `better-sqlite3`'s synchronous `db.transaction()`, which does not actually provide atomicity for awaited operations. The new pattern of explicit sync methods is the correct fix for this well-known `better-sqlite3` limitation.

2. **Interface Segregation Principle well applied**: The `SyncTaskOperations` and `SyncScheduleOperations` interfaces are narrow, containing only the operations needed inside transactions (3 methods each). This follows ISP -- callers that only need async operations do not see sync methods through the interface.

3. **Events emitted after commit**: Both trigger paths now correctly emit `TaskDelegated` and `ScheduleExecuted` events only after the transaction commits. This eliminates a class of bugs where event handlers could observe uncommitted data.

4. **DRY refactoring with `toDbFormat()`**: Extracting the field mapping into a shared private method eliminates duplication between async and sync paths without introducing unnecessary abstraction.

5. **Clean removal of `TransactionTaskRepository`**: The 50-line delegation wrapper that was architecturally unsound (pretending to provide transaction semantics without actually doing so) is properly removed along with its interface method `TaskRepository.transaction()`.

6. **Error preservation in `runInTransaction`**: The transaction wrapper correctly preserves `AutobeatError` types thrown inside the callback, avoiding double-wrapping of domain errors.

---

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 1 | 1 |

**Architecture Score**: 8/10

The core architectural change (sync transaction methods + `runInTransaction`) is sound and solves a real problem correctly. The main deduction is for the DIP violation where the service layer depends on the concrete `Database` class rather than an interface. This is a straightforward fix (extract a `TransactionRunner` interface) that would make the architecture fully clean.

**Recommendation**: CHANGES_REQUESTED

The HIGH-severity DIP violation (concrete `Database` dependency in the service layer) should be resolved before merge. The dead code cleanup is a quick win that should also be included. The "should fix" items are advisable but not blocking.
