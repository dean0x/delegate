# Consistency Review Report

**Branch**: feat/v0.8.0-loop-enhancements -> main
**Date**: 2026-03-23
**PR**: #115

## Issues in Your Changes (BLOCKING)

### HIGH

**Missing `toMissedRunPolicy()` call in `createScheduledLoop`** - `src/services/schedule-manager.ts:505`
**Confidence**: 95%
- Problem: `createSchedule` and `createScheduledPipeline` both use `toMissedRunPolicy(request.missedRunPolicy)` to normalize the missed run policy before passing it to `createSchedule()`. The new `createScheduledLoop` method passes `request.missedRunPolicy` directly without the conversion helper. This is a pattern deviation from the two existing schedule creation paths (lines 79 and 306) that could cause mismatched policy values if the input format differs from the domain enum.
- Fix:
  ```typescript
  // line 505 — change:
  missedRunPolicy: request.missedRunPolicy,
  // to:
  missedRunPolicy: toMissedRunPolicy(request.missedRunPolicy),
  ```

**Unsafe `as unknown as TaskId` type cast for loopId** - `src/services/handlers/schedule-handler.ts:560`
**Confidence**: 85%
- Problem: The code casts `loop.id` (a `LoopId` branded type) to `TaskId` via `as unknown as TaskId` to reuse the `ScheduleExecuted` event's `taskId` slot. This violates the codebase's strict typing conventions (branded types exist specifically to prevent cross-type confusion). The comment acknowledges it as an "ARCHITECTURE EXCEPTION" but it introduces a type-safety hole: `clearRunningScheduleByTask` accepts `string` and happens to work, but future type narrowing would break silently.
- Fix: Consider adding a `trackingId: string` field to `ScheduleExecutedEvent` or a parallel `ScheduleLoopExecuted` event, rather than abusing the `taskId` field. If this is intentionally deferred, add a TODO comment with a tracking reference.

**`nextRunAt` injection pattern differs from existing schedule creation paths** - `src/services/schedule-manager.ts:512`
**Confidence**: 82%
- Problem: `createSchedule` and `createScheduledPipeline` emit the schedule object directly and rely on `ScheduleHandler.handleScheduleCreated` to inject `nextRunAt` (per the comment "ScheduleHandler persists with calculated nextRunAt"). The new `createScheduledLoop` uses `updateSchedule(schedule, { nextRunAt })` to inject `nextRunAt` before emitting, creating a different flow. If `ScheduleHandler.handleScheduleCreated` also sets `nextRunAt`, it could be set twice or conflict.
- Fix: Either follow the existing pattern (let ScheduleHandler inject nextRunAt) or migrate all three paths to the new approach for consistency. The existing pattern is documented at lines 91 and 319 of schedule-manager.ts.

### MEDIUM

**Async `recordExecution` instead of sync transactional pattern for loop trigger** - `src/services/handlers/schedule-handler.ts:530`
**Confidence**: 85%
- Problem: The single-task trigger (line 293) and pipeline trigger (line 415) both use `this.database.runInTransaction()` with `recordExecutionSync` for atomic persistence. The new loop trigger path uses async `await this.scheduleRepo.recordExecution()` followed by `await this.scheduleRepo.update()` as separate operations. This means the execution record and schedule update are not atomic -- a crash between them would leave inconsistent state.
- Fix: Use the same `runInTransaction` + sync operations pattern:
  ```typescript
  const txResult = this.database.runInTransaction(() => {
    this.scheduleRepo.recordExecutionSync({
      scheduleId,
      loopId: loop.id,
      scheduledFor: schedule.nextRunAt ?? triggeredAt,
      executedAt: triggeredAt,
      status: 'triggered',
      createdAt: Date.now(),
    });
    this.scheduleRepo.updateSync(schedule.id, scheduleUpdates, schedule);
  });
  ```

**`LoopConfigSchema` uses string literals instead of referencing domain enums** - `src/implementations/schedule-repository.ts:114-128`
**Confidence**: 80%
- Problem: The existing `ScheduleRowSchema` (line 36) uses `z.enum(...)` with literal strings matching domain enums. The new `LoopConfigSchema` follows this same literal-string pattern, which is consistent. However, the `LoopConfigSchema` validates `strategy` as `z.enum(['retry', 'optimize'])` while the domain `LoopCreateRequest.strategy` is typed as `LoopStrategy` (an enum). The `as LoopCreateRequest` cast at line 598 masks any drift between the schema and the domain type. This is the same pattern used elsewhere (e.g., `PipelineStepsSchema`), but adding a comment documenting the cast rationale would improve maintainability.
- Fix: Add a comment at line 598:
  ```typescript
  // SAFETY: LoopStrategy enum values match schema string literals ('retry'/'optimize')
  loopConfig = LoopConfigSchema.parse(parsed) as LoopCreateRequest;
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`handleLoopPause` CLI function uses different argument parsing pattern** - `src/cli/commands/loop.ts:463-493`
**Confidence**: 82%
- Problem: The existing `handleLoopCancel` function (line 430) uses inline argument parsing with index-based access (`loopArgs[0]`, `loopArgs[1]`). The new `handleLoopPause` uses a filter loop to extract `--force` and then accesses `filteredArgs[0]`. While both work, they use different argument extraction patterns within the same file. The `handleLoopCancel` function directly checks `loopArgs[1]` for the reason flag.
- Fix: This is a minor style inconsistency within the same file. The filter approach in `handleLoopPause` is arguably cleaner -- consider adopting it uniformly if you refactor `handleLoopCancel` later.

**Inconsistent `exitOnError` spinner parameter** - `src/cli/commands/loop.ts:487,510`
**Confidence**: 80%
- Problem: `handleLoopCreate` (line 259) passes the spinner `s` to `exitOnError(result, s, ...)`. The new `handleLoopPause` and `handleLoopResume` functions pass `undefined` as the spinner parameter: `exitOnError(result, undefined, ...)`. This means if the operation fails, the spinner won't be stopped before exit in the new functions. However, looking at the call flow, the spinner is already stopped with `s.stop('Ready')` before the service call, so passing `undefined` is actually correct here. The pattern matches `handleLoopCancel` (line 452) which also passes `undefined`.
- Fix: No fix needed -- the pattern is correct. The `undefined` spinner is used when the spinner has already been stopped before the service call.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`clearRunningScheduleByTask` parameter typed as `string` instead of branded type** - `src/services/schedule-executor.ts:171`
**Confidence**: 80%
- Problem: The method signature is `private clearRunningScheduleByTask(taskId: string): void` but is now called with both `TaskId` and `LoopId` branded types (via `event.loopId`). The `string` parameter type accepts both silently but doesn't communicate intent. This is a pre-existing design choice that the new loop integration exposes.
- Fix: Could be typed as `TaskId | LoopId` or `string` with a renamed parameter like `trackingId` to communicate intent.

## Suggestions (Lower Confidence)

- **Missing `LoopPaused` subscription in `ScheduleExecutor`** - `src/services/schedule-executor.ts:140-150` (Confidence: 70%) -- The executor subscribes to `LoopCompleted` and `LoopCancelled` to clear running state, but not `LoopPaused`. If a loop is paused indefinitely, its parent schedule's `runningSchedules` entry would never be cleared, potentially blocking future scheduled runs. This may be intentional (paused loops are still "active"), but worth verifying the collision detection in `handleLoopTrigger` covers this case.

- **`handleLoopTrigger` does not use `afterScheduleId` chaining** - `src/services/handlers/schedule-handler.ts:490-571` (Confidence: 65%) -- The single-task and pipeline trigger paths both call `resolveAfterScheduleTaskId()` to enforce `afterScheduleId` chaining. The loop trigger path skips this entirely. If a scheduled loop is configured with `afterScheduleId`, the dependency would be silently ignored.

- **Comment says "31 event types" but count may be off** - `src/core/events/events.ts:5` (Confidence: 60%) -- The comment claims "31 event types after adding loop pause/resume events (v0.8.0)" but a manual count of the `AutobeatEvent` union members shows this should be verified.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 3 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Consistency Score**: 6/10
**Recommendation**: CHANGES_REQUESTED

The v0.8.0 changes generally follow existing patterns well (naming conventions, Result types, event-driven architecture, Zod validation at boundaries). The main consistency issues are:

1. The `missedRunPolicy` normalization is skipped in the new scheduled loop path (easy fix, likely a copy-paste omission).
2. The `nextRunAt` injection strategy differs from the two existing schedule creation paths, creating ambiguity about the intended flow.
3. The loop trigger handler uses async operations instead of the established synchronous transactional pattern, breaking the atomicity guarantee that the other two trigger paths maintain.
4. The `as unknown as TaskId` cast introduces a type-safety hole that should be addressed with a proper discriminated union or parallel event type.
