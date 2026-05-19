# Complexity Review Report

**Branch**: fix/v060-correctness-bugs -> main
**Date**: 2026-03-19
**PR**: #106

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Duplicated `linesSize` helper across two files** - `src/implementations/output-capture.ts:13` and `src/services/task-manager.ts:33`
- Problem: The identical `linesSize` function (same signature, same body, same JSDoc) is defined in two separate files. This PR introduced the function in both locations to fix the totalSize recalculation bug.
- Impact: Future changes to the size calculation logic (e.g., accounting for newline characters or switching to byte-length) would need to be applied in two places. Divergence risk is real since both are in the hot path for output retrieval.
- Fix: Extract to a shared utility, for example `src/utils/output.ts`:
  ```typescript
  // src/utils/output.ts
  /** Sum the character lengths of all lines in an array */
  export function linesSize(lines: readonly string[]): number {
    return lines.reduce((sum, line) => sum + line.length, 0);
  }
  ```
  Then import from both `output-capture.ts` and `task-manager.ts`.
- Category: Blocking (code added in this branch)

---

**Duplicated TaskFailed emission block in RecoveryManager** - `src/services/recovery-manager.ts:124-133` and `src/services/recovery-manager.ts:266-275`
- Problem: Two nearly identical blocks emit `TaskFailed` with the same structure (`taskId`, `error: new AutobeatError(...)`, `exitCode: -1`), each followed by identical error-logging guards. The only difference is the error message string ("Worker process died (dead PID detected)" vs "Worker process crashed during execution").
- Impact: Six lines of emit-and-guard boilerplate duplicated. If the emission pattern changes (e.g., adding a `recoveredAt` field), both sites need updating. The `cleanDeadWorkerRegistrations` method is already at 63 lines (lines 78-140), pushing it toward the warning threshold.
- Fix: Extract a private helper:
  ```typescript
  private async emitTaskFailed(taskId: TaskId, reason: string): Promise<void> {
    const result = await this.eventBus.emit('TaskFailed', {
      taskId,
      error: new AutobeatError(ErrorCode.SYSTEM_ERROR, reason),
      exitCode: -1,
    });
    if (!result.ok) {
      this.logger.error('Failed to emit TaskFailed event', result.error, { taskId });
    }
  }
  ```
  Then call `await this.emitTaskFailed(reg.taskId, 'Worker process died (dead PID detected)')` and `await this.emitTaskFailed(task.id, 'Worker process crashed during execution')` in the respective locations.
- Category: Blocking (code added in this branch)

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`cleanDeadWorkerRegistrations` nesting depth reaches 4 levels** - `src/services/recovery-manager.ts:78-141`
- Problem: The method has a `for` loop containing `if (!isProcessAlive)` -> `if (updateResult.ok)` -> nested emit/log blocks. With the new `TaskFailed` emission code added in this PR, the method grew from ~40 lines to 63 lines and the deepest nesting reached 4 levels (for -> if -> if -> if).
- Impact: Approaching the warning threshold for both function length (>50 lines) and nesting depth (>3 levels). The method handles three concerns: unregistration, task status update, and event emission.
- Fix: Extracting the `emitTaskFailed` helper (suggested above) would reduce nesting by one level in the success branch and bring the method back under 50 lines.
- Category: Should-Fix (method existed, but changes expanded it)

---

**`recoverQueuedTasks` grew to 50 lines with 3 sequential guard clauses** - `src/services/recovery-manager.ts:152-201`
- Problem: The method now has three sequential `continue` guards (queue.contains, isBlocked error, isBlocked true) followed by the enqueue-and-emit logic. While each guard is simple, the method is exactly at the 50-line boundary.
- Impact: At the warning threshold for function length. The sequential guard pattern is readable, but the method handles dependency checking, queueing, and event emission.
- Fix: This is borderline -- the guards use early-return/continue style which is the recommended pattern. No immediate action needed, but worth watching if more guards are added in the future.
- Category: Should-Fix (method existed, but changes expanded it)

## Pre-existing Issues (Not Blocking)

### LOW

**`cancelSchedule` method handles three concerns** - `src/services/schedule-manager.ts:161-211`
- Problem: The method performs schedule lookup, event emission, and task cancellation in a single 50-line method. The task cancellation section (lines 182-208) could be a private helper.
- Impact: At the warning threshold for function length. Readable today, but adding more cancellation logic would push it over.
- Fix: Extract `private async cancelActiveExecutionTasks(scheduleId, reason)` for the task cancellation block.
- Category: Pre-existing (the method structure pre-dates this PR; the PR only changed `getExecutionHistory(scheduleId, 1)` to `getExecutionHistory(scheduleId)` and added the filter)

---

**RecoveryManager file at 285 lines** - `src/services/recovery-manager.ts`
- Problem: The file is approaching the 300-line warning threshold (was ~230 before this PR, now 285).
- Impact: If additional recovery phases or failure modes are added, this file will exceed the warning threshold.
- Fix: No immediate action. The file has a single class with clear method boundaries. Monitor for future growth.
- Category: Pre-existing (file was already substantial; this PR added ~55 lines)

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 2 |

**Complexity Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Conditions

1. **Extract `linesSize` to a shared utility** -- duplicating the same pure function across two files is a maintenance risk that should be resolved before merge.
2. **Extract `emitTaskFailed` helper in RecoveryManager** -- removes duplication and reduces nesting in `cleanDeadWorkerRegistrations` back below the warning threshold.

### What This PR Does Well

- The `linesSize` function itself is simple and well-named (single-line reducer).
- The dependency-check guards in `recoverQueuedTasks` use the recommended early-continue pattern with clear log messages.
- The schedule cancellation fix (filtering active executions via `.filter(e => e.status === 'triggered')`) is a clean, readable chain: `filter` -> `flatMap` -> `for`.
- The `wasTailSliced` conditional in `output-capture.ts` is a clear boolean that documents intent.
- All new code paths have corresponding tests with good edge-case coverage (blocked tasks, DB errors, mixed scenarios).
