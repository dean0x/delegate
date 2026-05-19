# Architecture Review Report

**Branch**: feat/scheduled-pipelines-78 -> main
**Date**: 2026-03-11
**Commits**: 011519e (feat: scheduled pipelines + dependency cascade fix), 0ec3f84 (style: fix Biome formatting)

---

## Issues in Your Changes (BLOCKING)

### HIGH

**Duplicated afterScheduleId resolution logic in handlePipelineTrigger** - `/Users/dean/Sandbox/claudine/src/services/handlers/schedule-handler.ts:355-374`
- Problem: `handlePipelineTrigger` re-implements afterScheduleId resolution inline (lines 355-374) instead of using the extracted `resolveAfterScheduleDependency` helper (lines 505-533). The single-task path correctly uses the helper, but the pipeline path duplicates the lookup logic with minor structural differences (returns `TaskId[]` vs modified template).
- Impact: Two places to maintain the same business logic. If afterScheduleId resolution rules change (e.g., checking multiple executions, different terminal state semantics), the pipeline path could drift out of sync.
- Fix: Extend `resolveAfterScheduleDependency` to also return the resolved dependency `TaskId[]` so `handlePipelineTrigger` can consume it without duplicating the history/task lookup logic:
  ```typescript
  // Option A: Return both the modified template AND the resolved TaskIds
  private async resolveAfterScheduleDependency(schedule: Schedule): Promise<{
    taskTemplate: typeof schedule.taskTemplate;
    resolvedDependencyIds: TaskId[];
  }> { ... }

  // Option B: Extract a lower-level helper that returns TaskId | undefined
  private async resolveAfterScheduleTaskId(afterScheduleId: ScheduleId): Promise<TaskId | undefined> { ... }
  ```

---

**Validation duplication between createSchedule and createScheduledPipeline** - `/Users/dean/Sandbox/claudine/src/services/schedule-manager.ts:322-429` and `/Users/dean/Sandbox/claudine/src/services/schedule-manager.ts:64-176`
- Problem: `createSchedule` (lines 64-176) contains inline timing validation (cron, timezone, scheduledAt, expiresAt) that is nearly identical to the new `validateScheduleTiming` private method (lines 484-573). The new method was correctly extracted for `createScheduledPipeline` but `createSchedule` was not refactored to use it.
- Impact: Two parallel validation code paths that must stay in sync. A bug fix or new validation rule applied to `validateScheduleTiming` would not propagate to `createSchedule`.
- Fix: Refactor `createSchedule` to call `validateScheduleTiming` for its timing validation:
  ```typescript
  async createSchedule(request: ScheduleCreateRequest): Promise<Result<Schedule>> {
    const timingResult = this.validateScheduleTiming(request);
    if (!timingResult.ok) return timingResult;
    const { scheduledAtMs, expiresAtMs, nextRunAt, timezone } = timingResult.value;
    // ... rest of createSchedule using extracted values
  }
  ```

---

### MEDIUM

**Pipeline cleanup in handlePipelineTrigger bypasses event system** - `/Users/dean/Sandbox/claudine/src/services/handlers/schedule-handler.ts:399-408`
- Problem: When a pipeline task save fails mid-pipeline, the cleanup loop directly calls `this.taskRepo.update(savedTask.id, { status: TaskStatus.CANCELLED })` instead of emitting `TaskCancellationRequested` events. This breaks the event-driven architecture contract: cancellations should flow through the event bus so that DependencyHandler, PersistenceHandler, and other subscribers react consistently.
- Impact: Direct DB mutation during cleanup skips dependency resolution, audit logging, and any other side effects attached to task cancellation events. However, since these tasks were just created (no workers assigned, no dependencies beyond the linear chain being constructed), the pragmatic impact is limited.
- Fix: Use `TaskCancellationRequested` events for consistency, or add an explicit code comment documenting why direct mutation is acceptable here (new tasks, no workers, no external dependencies):
  ```typescript
  // ARCHITECTURE EXCEPTION: Direct DB cancellation acceptable here because:
  // 1. Tasks were just created (no worker assigned, no external state)
  // 2. Event-based cancellation could fail mid-cleanup, leaving orphans
  // 3. This is rollback cleanup, not a user-facing cancellation
  ```

---

**SchedulePipelineSchema duplicates SchedulePipeline inputSchema** - `/Users/dean/Sandbox/claudine/src/adapters/mcp-adapter.ts:157-194` and `/Users/dean/Sandbox/claudine/src/adapters/mcp-adapter.ts:679-775`
- Problem: The Zod schema `SchedulePipelineSchema` (lines 157-194) and the JSON Schema `inputSchema` for the SchedulePipeline tool listing (lines 679-775) describe the same shape in two different formats. This is the same pattern used by all other tools in the adapter, so it is a pre-existing pattern, but this PR adds another instance of it.
- Impact: If one schema is updated but not the other, MCP clients receive stale tool descriptions while the server validates against different rules. This is a known tech debt pattern in the codebase.
- Fix: This is a pre-existing architectural pattern. No immediate action required, but worth noting as the adapter grows (now 1,776 lines). Consider a future refactor to derive JSON schemas from Zod schemas using `zod-to-json-schema`.

---

**cancelSchedule ordering: schedule cancelled before tasks** - `/Users/dean/Sandbox/claudine/src/services/schedule-manager.ts:255-285`
- Problem: `cancelSchedule` emits `ScheduleCancelled` (which persists the CANCELLED status) before cancelling in-flight pipeline tasks. If the task cancellation loop fails midway, the schedule is already marked cancelled but some tasks remain running with no mechanism to retry.
- Impact: In practice this is unlikely to cause issues since `TaskCancellationRequested` is best-effort and individual task cancellation failures are already logged. However, the ordering means there is no way to "retry" the task cancellation if it fails.
- Fix: This is acceptable for v0.6.0. Consider adding a comment documenting the ordering decision and the best-effort nature of task cancellation:
  ```typescript
  // ARCHITECTURE NOTE: Schedule cancellation is committed first to prevent retriggering.
  // Task cancellation is best-effort — failures are logged but don't block the operation.
  ```

---

## Issues in Code You Touched (Should Fix)

### MEDIUM

**MCP Adapter growing toward god class territory** - `/Users/dean/Sandbox/claudine/src/adapters/mcp-adapter.ts`
- Problem: The MCP adapter has grown from 1,559 to 1,776 lines (+217 lines in this PR). It combines tool registration, schema definitions, request parsing, response formatting, and handler dispatch in a single class. This PR adds `SchedulePipelineSchema`, `handleSchedulePipeline`, and expanded `handleGetSchedule`/`handleCancelSchedule` logic.
- Impact: Maintainability decreases as the file grows. Finding and modifying specific tool handlers requires scrolling through a 1,776-line file. The risk of merge conflicts increases as multiple features target this file.
- Fix: No immediate refactor needed, but consider splitting in a future PR:
  - Extract tool schemas into `src/adapters/schemas/`
  - Extract handler methods into per-domain files (schedule-handlers.ts, agent-handlers.ts, etc.)
  - Keep MCPAdapter as a thin dispatcher

---

**QueueHandler fast-path couples to domain state** - `/Users/dean/Sandbox/claudine/src/services/handlers/queue-handler.ts:65-72`
- Problem: The new fast-path check `if (event.task.dependencyState === 'blocked')` in QueueHandler is a smart optimization that eliminates a race condition. However, it introduces coupling between QueueHandler and the task domain model's `dependencyState` field. If `dependencyState` semantics change, QueueHandler must be updated.
- Impact: Minimal — this is a reasonable trade-off for eliminating the TOCTOU race. The coupling is on a stable domain concept (blocked/unblocked). The comment clearly explains the rationale.
- Fix: No change needed. The optimization is well-documented and the coupling is acceptable.

---

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Schedule handler and manager both contain scheduling domain logic** - `/Users/dean/Sandbox/claudine/src/services/handlers/schedule-handler.ts` and `/Users/dean/Sandbox/claudine/src/services/schedule-manager.ts`
- Problem: Scheduling business logic is split between `ScheduleHandler` (event-driven handler: trigger execution, task creation, state transitions) and `ScheduleManagerService` (service layer: validation, schedule creation, list/get). Both files now contain substantial domain logic (~770 and ~606 lines respectively). The handler creates tasks and manages execution flow; the manager validates inputs and orchestrates creation.
- Impact: New developers must understand the split to know where to add logic. The boundary is reasonably clear (manager = user-facing operations, handler = internal event reactions), but the growing complexity makes it worth monitoring.

### LOW

**ErrorCode.TASK_NOT_FOUND used for Schedule not found** - `/Users/dean/Sandbox/claudine/src/services/handlers/schedule-handler.ts:250` and `/Users/dean/Sandbox/claudine/src/services/schedule-manager.ts:591`
- Problem: When a schedule is not found, the code returns `ErrorCode.TASK_NOT_FOUND` rather than a dedicated `SCHEDULE_NOT_FOUND` error code.
- Impact: Error messages are still descriptive (e.g., `Schedule ${scheduleId} not found`), so this is cosmetic. Client-side error handling that switches on error codes would misidentify this as a task issue.

---

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 3 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 1 | 1 |

**Architecture Score**: 7/10

The feature is well-structured overall. The decomposition of `handleScheduleTriggered` into `handleSingleTaskTrigger`, `handlePipelineTrigger`, and shared helpers (`recordFailedExecution`, `recordTriggeredExecution`, `updateScheduleAfterTrigger`, `resolveAfterScheduleDependency`) demonstrates strong SRP awareness. The domain model extension (`pipelineSteps` on Schedule, `pipelineTaskIds` on ScheduleExecution) is clean and additive. The dependency cascade fix in DependencyHandler is a targeted, well-placed enhancement.

The two HIGH-severity issues are both DRY violations: duplicated afterScheduleId resolution and duplicated timing validation. Both are straightforward refactors that would consolidate business logic into single code paths.

**Recommendation**: **CHANGES_REQUESTED**

The two HIGH-severity DRY violations should be addressed before merge to prevent maintenance drift. Specifically:
1. Refactor `createSchedule` to use `validateScheduleTiming` (the helper is already written and tested)
2. Consolidate `afterScheduleId` resolution so `handlePipelineTrigger` reuses the extracted helper rather than duplicating the lookup logic
