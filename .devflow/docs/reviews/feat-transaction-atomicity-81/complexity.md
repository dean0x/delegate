# Complexity Review Report

**Branch**: feat/transaction-atomicity-81 -> main
**Date**: 2026-03-18
**PR**: #85

## Issues in Your Changes (BLOCKING)

### MEDIUM

**`extractHandlerDependencies` repetitive fail-fast pattern (12 sequential checks)** - `src/services/handler-setup.ts:105-159`
- Problem: This function now has 12 sequential get-check-return blocks after adding `database`. Each block is identical in structure: call `getDependency<T>()`, check `!result.ok`, return early. This is not a cyclomatic complexity issue (the branches are trivial), but a readability concern as the function is 55 lines of near-identical boilerplate. The addition of `database` pushes it from "acceptable" to "should consider extraction."
- Impact: Every new dependency added to `HandlerDependencies` will add 3 more lines of identical code. The comment already updated from "11 dependencies" to "12 dependencies" suggesting awareness of growth.
- Fix: Consider a helper that extracts all dependencies in a batch, something like:
  ```typescript
  const keys = ['config', 'logger', 'eventBus', 'database', ...] as const;
  const deps: Record<string, unknown> = {};
  for (const key of keys) {
    const result = getDependency(container, key);
    if (!result.ok) return result;
    deps[key] = result.value;
  }
  return ok(deps as HandlerDependencies);
  ```
  This would reduce 55 lines to approximately 10 while preserving fail-fast semantics and specific error messages. However, the current approach is explicit and type-safe, so this is a judgment call rather than a hard blocker.

**try-catch inside transaction callback re-wraps errors** - `src/services/handlers/schedule-handler.ts:382-391`
- Problem: Inside `handlePipelineTrigger`, the `runInTransaction()` callback contains a `for` loop with a `try/catch` that catches errors from `saveSync()` and re-throws a new `AutobeatError`. This is unnecessary complexity because `Database.runInTransaction` already catches thrown errors and wraps non-`AutobeatError` instances. The re-wrapping adds a layer of indirection.
- Impact: The error message is enhanced with `Pipeline failed at step ${i + 1}:` prefix, which provides step-level context. This is the only justification for the try-catch. However, it adds nesting depth (transaction callback > for loop > try/catch > throw) reaching 4 levels.
- Fix: If the step-index context is important (it is, for debugging), this is acceptable. But consider extracting the loop body:
  ```typescript
  const txResult = this.database.runInTransaction(() => {
    this.savePipelineTasksSync(tasks);
    this.scheduleRepo.recordExecutionSync({ ... });
    this.updateScheduleAfterTriggerSync(schedule, triggeredAt);
  });

  // Extracted:
  private savePipelineTasksSync(tasks: Task[]): void {
    for (let i = 0; i < tasks.length; i++) {
      try {
        this.taskRepo.saveSync(tasks[i]);
      } catch (error) {
        throw new AutobeatError(
          ErrorCode.SYSTEM_ERROR,
          `Pipeline failed at step ${i + 1}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  ```
  This flattens the nesting inside the transaction callback from 4 levels to 2.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`handlePipelineTrigger` remains a long method (50+ lines of logic)** - `src/services/handlers/schedule-handler.ts:333-461`
- Problem: At 128 lines total (including comments and whitespace), `handlePipelineTrigger` is the most complex method in the changed files. While the refactoring improved it significantly (removing the manual cleanup loop and the TODO comment about transactions), it still contains distinct phases: (1) resolve predecessor dependency, (2) pre-create task objects, (3) execute transaction, (4) handle transaction failure, (5) emit events with step-0 fatal logic, (6) emit ScheduleExecuted, (7) log success. The core logic is approximately 50 lines excluding comments.
- Impact: The method is understandable but pushes the boundary of "explainable in 5 minutes." The transaction-then-events pattern is clear, but the post-commit event emission loop (lines 422-443) with its step-0-is-fatal branching adds cognitive load.
- Fix: The post-commit event emission loop (lines 422-443) could be extracted to a private method like `emitPipelineTaskEvents(tasks, scheduleId)` that returns the first fatal error or `ok(undefined)`. This would bring the main method down to approximately 35 lines of logic.

**`handleSingleTaskTrigger` and `handlePipelineTrigger` share structural duplication** - `src/services/handlers/schedule-handler.ts:271-461`
- Problem: Both methods follow the same pattern: (1) resolve afterScheduleId, (2) create task(s), (3) `runInTransaction()` with save + recordExecution + updateSchedule, (4) handle failure with `recordFailedExecution`, (5) emit events. The transaction bodies differ only in single-vs-multi task save and execution record shape. This duplication is acceptable for now but worth noting as the two paths grow.
- Impact: LOW. The methods are structurally similar but different enough in detail (loop logic, step-0 fatal handling) that forceful extraction would increase complexity rather than decrease it. Keep monitoring.
- Fix: No action needed now. If a third trigger path is added, extract the shared transaction-then-emit skeleton.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`handleScheduleCreated` has 6+ branches for validation** - `src/services/handlers/schedule-handler.ts:136-225`
- Problem: This method validates timezone, checks schedule type (cron vs one_time), validates cron expression, calculates next run, handles exhaustive type check, saves, and logs. It has approximately 8 decision points. This was not modified in this PR.
- Impact: The method is 90 lines with multiple nested if/else-if/else blocks. It is at the upper bound of acceptable complexity.
- Fix: Consider extracting validation to `validateScheduleForCreation(schedule): Result<number>` that returns the computed `nextRunAt` or an error. This would reduce `handleScheduleCreated` to validation + save + log.

### LOW

**`computeScheduleUpdates` uses mutable `let` variables** - `src/services/handlers/schedule-handler.ts:551-597`
- Problem: Uses `let newStatus` and `let newNextRunAt` that are conditionally assigned across 4 branches (cron, one_time, maxRuns, expired). While functionally correct, this conflicts with the "immutable by default" engineering principle.
- Impact: The method is marked as "pure computation" but uses mutation internally. The function is short enough (46 lines) that this is not a real maintainability risk.
- Fix: Could be restructured with early returns or a builder pattern, but the current approach is readable and contained. No action needed.

**`recordExecutionSync` parameter list** - `src/implementations/schedule-repository.ts:337-351`
- Problem: The `recordExecutionStmt.run()` call passes 8 positional parameters. While the method itself takes a typed object (good), the internal call relies on positional alignment with the SQL statement.
- Impact: If the SQL column order changes, the positional parameters silently mismatch. This is a pre-existing pattern from `recordExecution` (the async version at line 464-483 has the same issue).
- Fix: No action needed for this PR. If revisited, consider using named parameters (`@param` syntax) in the prepared statement to match the approach used for save/update statements.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 1 | 2 |

**Complexity Score**: 8/10

This PR is a net complexity **reduction**. The previous implementation had:
- A 49-line `TransactionTaskRepository` wrapper class (deleted)
- A `transaction()` method on `TaskRepository` interface (removed)
- Manual cleanup loops inside `handlePipelineTrigger` that cancelled partially-saved tasks on failure (replaced by atomic rollback)
- A `TODO` comment acknowledging the non-atomic nature of the pipeline save

The new approach replaces all of that with:
- A single 12-line `runInTransaction()` method on `Database`
- Two narrow sync interfaces (`SyncTaskOperations`, `SyncScheduleOperations`)
- Thin sync method implementations that delegate to existing prepared statements
- Transaction boundaries that eliminate manual cleanup entirely

The `toDbFormat()` extraction in both repositories is an excellent DRY improvement, removing two copies of 17-field object literals.

The only complexity concerns are the try-catch re-wrapping inside the pipeline transaction (justified by step-index context) and the growing `extractHandlerDependencies` function (12 sequential checks).

**Recommendation**: APPROVED
