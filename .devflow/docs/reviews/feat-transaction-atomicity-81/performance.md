# Performance Review Report

**Branch**: feat/transaction-atomicity-81 -> main
**Date**: 2026-03-18
**PR**: #85

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Redundant read-before-write inside transaction (`updateSync`)** - `src/implementations/schedule-repository.ts:324-334`
- Problem: `updateSync` calls `findByIdSync` to read the full schedule row, merges the partial update, then writes. When called via `updateScheduleAfterTriggerSync` inside `handleSingleTaskTrigger` or `handlePipelineTrigger`, the schedule was already fetched at the top of the trigger handler (passed in as the `schedule` parameter). Inside the transaction, `updateSync` performs another SELECT to re-read the same row that the caller already has in memory.
- Impact: Each trigger transaction performs one extra SELECT query. For single-task triggers this is 1 extra read; for pipelines it is 1 extra read. At typical schedule volumes (low hundreds per minute) this is negligible. The impact is LOW in production, but the pattern sets a precedent that could become meaningful if `updateSync` is called in tighter loops in the future.
- Fix: Consider an `updateFieldsSync(id, fields)` method that runs the UPDATE statement directly without the read, accepting the pre-merged domain object. This is an optimization opportunity, not blocking:
  ```typescript
  // Alternative: skip the read when caller already has the full object
  updateFieldsSync(id: ScheduleId, merged: Schedule): void {
    this.updateStmt.run(this.toDbFormat(merged));
  }
  ```
- Category: Should-Fix (same function/module as your changes)

**Same pattern in task-repository `updateSync`** - `src/implementations/task-repository.ts:241-248`
- Problem: `updateSync` performs `findByIdSync` + merge + write. Same read-before-write pattern. Currently only called with a partial update, so the read IS necessary. However, if callers ever have the full task in hand, this is an unnecessary round-trip.
- Impact: Minimal in current usage. The transaction contains N `saveSync` calls (writes only) plus one `updateSync` that reads. For pipelines with 3-10 steps this is bounded.
- Fix: Not actionable today -- the current callers do need the read. No change needed.
- Category: Should-Fix (informational)

### LOW

**`recordExecutionSync` reads back the inserted row** - `src/implementations/schedule-repository.ts:337-351`
- Problem: After `this.recordExecutionStmt.run(...)`, the method immediately does `this.getExecutionByIdStmt.get(result.lastInsertRowid)` to return the full `ScheduleExecution` object. Inside the transaction, the returned value is never used by the caller (`handleSingleTaskTrigger` and `handlePipelineTrigger` both call `recordExecutionSync` without capturing the return value).
- Impact: One unnecessary SELECT per trigger invocation. SQLite in-process reads are fast (sub-millisecond), so this is a micro-optimization. The return value is useful for the async `recordExecution` path, so the method signature is reasonable for the general API.
- Fix: Could add a `recordExecutionSyncVoid` variant that skips the read-back, or change the return type to `void` since no transaction caller uses it. Low priority.
  ```typescript
  // If return value is never used inside transactions:
  recordExecutionSync(execution: Omit<ScheduleExecution, 'id'>): void {
    this.recordExecutionStmt.run(/* ... */);
    // Skip the SELECT read-back
  }
  ```
- Category: Blocking (your new code)

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Sequential `await` for post-commit cancellation** - `src/services/handlers/schedule-handler.ts:432-434`
- Problem: When step-0 `TaskDelegated` emit fails, the cleanup loop cancels each task sequentially with `await this.taskRepo.update(savedTask.id, ...)`. For a pipeline with N steps, this is N sequential async operations.
- Impact: This is an error-recovery path (step-0 emit failure is rare), so it does not affect the happy path. The sequential pattern is acceptable for error handling, but could be batched for consistency.
- Fix: Could use `Promise.all` or wrap in a single transaction:
  ```typescript
  this.database.runInTransaction(() => {
    for (const savedTask of tasks) {
      this.taskRepo.updateSync(savedTask.id, { status: TaskStatus.CANCELLED });
    }
  });
  ```
- Category: Should-Fix (pre-existing code you modified)

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`SELECT *` in schedule repository prepared statements** - `src/implementations/schedule-repository.ts:201-239`
- Problem: Six prepared statements use `SELECT *` which fetches all columns even when only a subset is needed (e.g., `findByIdSync` during `updateSync` only needs the fields being merged).
- Impact: For SQLite with small row sizes and in-process access, `SELECT *` has negligible overhead. This becomes more relevant if column count or row data grows significantly.
- Fix: Not actionable for this PR. Consider column-specific SELECTs in a future optimization pass.
- Category: Pre-existing

### LOW

**`toDbFormat` creates a new object on every call** - `src/implementations/task-repository.ts:173-194`, `src/implementations/schedule-repository.ts:251-271`
- Problem: Each `save`, `update`, `saveSync`, `updateSync` call creates a new plain object via `toDbFormat()`. This is a per-operation allocation.
- Impact: Negligible. Object creation in V8 is extremely fast. The allocation is short-lived and GC-friendly. This is not an optimization target.
- Fix: None needed. This is idiomatic and correct.
- Category: Pre-existing

## Performance Wins in This PR

This PR delivers several notable performance improvements over the previous implementation:

1. **Eliminated `TransactionTaskRepository` wrapper class** -- The old approach created a full proxy class implementing `TaskRepository` for every transaction, adding an extra layer of indirection and async overhead. The new sync methods are direct calls with zero wrapper overhead.

2. **Synchronous transactions instead of async-in-transaction** -- The old `TaskRepository.transaction()` method used `this.db.transaction(async () => ...)` which is incorrect for better-sqlite3 (synchronous transaction API with async callbacks does not actually provide atomicity). The new `runInTransaction(() => ...)` correctly uses synchronous operations, which are both faster and actually atomic.

3. **Eliminated partial-save cleanup loops** -- The old pipeline trigger path required cancelling partially-saved tasks on failure (N sequential UPDATE operations). The new atomic transaction rolls back automatically, requiring zero cleanup writes on failure.

4. **Pure computation extracted outside transactions** -- Task creation (`createTask`) and dependency resolution (`resolveAfterScheduleTaskId`) are moved outside the transaction, minimizing the time the SQLite write lock is held. This improves concurrency for any concurrent readers.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 1 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 1 | 1 |

**Performance Score**: 8/10
**Recommendation**: APPROVED

Rationale: This PR is a net performance improvement. It replaces a fundamentally broken async-transaction pattern with correct synchronous transactions, eliminates unnecessary cleanup loops, and minimizes write-lock hold times. The identified issues are minor (extra reads inside transactions that are bounded and fast in SQLite) and do not warrant blocking the merge. The redundant `recordExecutionSync` read-back is the most actionable item but is a micro-optimization given SQLite's in-process nature.
