# Architecture Review Report

**Branch**: feat/v0.8.0-loop-enhancements -> main
**Date**: 2026-03-23
**Commits**: 5 commits (7bfdefd..eb1389d)
**Files reviewed**: 16 source files

## Issues in Your Changes (BLOCKING)

### HIGH

**Type-unsafe cast: LoopId forced into TaskId slot via `as unknown as TaskId`** - `src/services/handlers/schedule-handler.ts:560`
**Confidence**: 95%
- Problem: `handleLoopTrigger` emits `ScheduleExecutedEvent` with `taskId: loop.id as unknown as TaskId`. This double-cast (`as unknown as`) breaks the branded-type safety that `TaskId` and `LoopId` provide. Any downstream consumer of `ScheduleExecutedEvent` that calls a TaskRepository method with this value will silently pass a LoopId where a TaskId is expected, potentially corrupting lookups.
- Impact: Violates Dependency Inversion and type-safety principles. The branded types exist precisely to prevent cross-domain ID confusion. The `ARCHITECTURE EXCEPTION` comment acknowledges the issue but does not mitigate it.
- Fix: Widen `ScheduleExecutedEvent.taskId` to a union type `TaskId | LoopId`, or introduce a new field like `trackingId: string` on the event. Alternatively, add a dedicated `ScheduleLoopExecutedEvent` so loop triggers have their own event shape. The `clearRunningScheduleByTask` method already accepts `string`, so the underlying map (`runningSchedules: Map<string, string>`) needs no change -- only the event contract needs correction to avoid the unsafe cast.

```typescript
// Option A: Widen ScheduleExecutedEvent
export interface ScheduleExecutedEvent extends BaseEvent {
  type: 'ScheduleExecuted';
  scheduleId: ScheduleId;
  taskId?: TaskId;
  loopId?: LoopId;     // new field for loop triggers
  executedAt: number;
}

// Option B: Dedicated event (preserves ISP)
export interface ScheduleLoopExecutedEvent extends BaseEvent {
  type: 'ScheduleLoopExecuted';
  scheduleId: ScheduleId;
  loopId: LoopId;
  executedAt: number;
}
```

---

**Non-atomic execution recording in `handleLoopTrigger` vs atomic pattern in sibling methods** - `src/services/handlers/schedule-handler.ts:530-540`
**Confidence**: 88%
- Problem: `handleSingleTaskTrigger` (line 293) and `handlePipelineTrigger` both use `Database.runInTransaction()` to atomically save task + record execution + update schedule. However, `handleLoopTrigger` performs `recordExecution` (line 530) and `update` (line 540) as separate async calls with no transaction. If the `update` call fails after `recordExecution` succeeds, the schedule will have a stale `runCount`/`nextRunAt` while an execution record exists.
- Impact: Consistency violation -- the three trigger methods in the same handler follow different atomicity patterns. This breaks the architectural precedent set by the existing code and risks data inconsistency on partial failure.
- Fix: Wrap the execution recording and schedule update in a synchronous transaction, matching the pattern used by the other two trigger methods:

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
if (!txResult.ok) {
  await this.recordFailedExecution(scheduleId, schedule.nextRunAt ?? triggeredAt, triggeredAt, txResult.error.message);
  return txResult;
}
```

### MEDIUM

**`ScheduleHandler` now imports domain factory `createLoop` -- handler creating entities for another handler's domain** - `src/services/handlers/schedule-handler.ts:524`
**Confidence**: 82%
- Problem: `ScheduleHandler` directly calls `createLoop()` and emits `LoopCreated` with a fully constructed `Loop` object. This means the schedule handler is responsible for loop entity construction, which is the `LoopHandler`'s domain. In contrast, the existing pattern for task creation (`createTask` called in `ScheduleHandler`) is acceptable because `ScheduleHandler` owns task creation as part of schedule triggering. But loop lifecycle is owned by `LoopHandler` -- the schedule handler should delegate loop creation, not perform it.
- Impact: SRP boundary blur between ScheduleHandler and LoopHandler. If loop creation logic changes (e.g., additional validation, git state capture as done in `LoopManagerService.createLoop`), `handleLoopTrigger` will not pick up those changes. Note that `LoopManagerService.createLoop` already does git state validation and `gitBaseBranch` capture that `handleLoopTrigger` skips entirely.
- Fix: Consider having `handleLoopTrigger` delegate to `LoopManagerService.createLoop` (injected as `LoopService`) rather than calling `createLoop()` directly. This ensures all loop creation passes through the same validation path. This would require injecting `LoopService` into `ScheduleHandler`, which is a minor increase in coupling but centralizes loop creation logic.

---

**`LoopHandler` directly imports and calls `createAndCheckoutBranch` and `captureGitDiff` -- infrastructure in service handler** - `src/services/handlers/loop-handler.ts:45`
**Confidence**: 80%
- Problem: `LoopHandler` directly imports git utility functions (`createAndCheckoutBranch`, `captureGitDiff`) and calls them inline in the iteration engine (`startNextIteration` at ~line 532 and `handleIterationResult` at ~line 1003). This is a shell-out to `git` subprocess calls from within an event handler. The existing `captureGitState` usage in `LoopManagerService` and `CheckpointHandler` follows the same pattern, so there is a precedent, but expanding it further (branch creation, diff capture) deepens the coupling between the handler layer and infrastructure.
- Impact: This makes `LoopHandler` harder to test in isolation (must mock or stub `execFile` calls) and violates the principle that handlers should coordinate domain logic, not execute infrastructure operations.
- Fix: Extract a `GitOperations` interface into `core/interfaces.ts` and inject it. This follows the project's existing DI pattern and would make the git operations testable:

```typescript
export interface GitOperations {
  createAndCheckoutBranch(workDir: string, branch: string, fromRef?: string): Promise<Result<void>>;
  captureGitDiff(workDir: string, from: string, to: string): Promise<Result<string | null>>;
  captureGitState(workDir: string): Promise<Result<GitState | null>>;
}
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`ScheduleExecutor` does not track `LoopPaused` events -- paused loops keep schedule in "running" state** - `src/services/schedule-executor.ts:141-150`
**Confidence**: 85%
- Problem: `ScheduleExecutor` subscribes to `LoopCompleted` and `LoopCancelled` to clear the running schedule state, but does NOT subscribe to `LoopPaused`. When a loop is paused, the parent schedule's `runningSchedules` entry remains, which means `isScheduleRunning()` returns `true`. This may prevent the next cron trigger from firing if the schedule's collision detection checks `isScheduleRunning()`.
- Impact: Depends on whether `ScheduleExecutor.isScheduleRunning()` is used for collision detection during cron ticks. If it is, a paused loop will block all future triggers of its parent schedule until resumed and completed/cancelled. The `handleLoopTrigger` method has its own collision detection via `findByScheduleId`, so there may be redundancy, but the state inconsistency is still a concern.
- Fix: Evaluate whether a paused loop should clear the running state (allowing a new trigger) or keep it (blocking until resume). If the intent is that paused loops block new triggers (which the collision detection in `handleLoopTrigger` suggests), then this is consistent but the `runningSchedules` map is stale. If the intent is to allow new triggers while paused, subscribe to `LoopPaused` to clear the state.

---

**`createLoop` factory function signature growing -- optional `scheduleId` parameter** - `src/core/domain.ts:598`
**Confidence**: 80%
- Problem: `createLoop(request, workingDirectory, scheduleId?)` now takes a third optional parameter. The `workingDirectory` was already extracted from the request in v0.7.0, and now `scheduleId` is added as another positional optional. If more contextual parameters are needed in the future (e.g., `gitBaseBranch`), this signature will continue growing.
- Impact: Minor API design concern. Positional optional parameters are harder to read at call sites than a single options/context object.
- Fix: Consider using a context/options object for the non-request parameters:

```typescript
interface LoopCreateContext {
  workingDirectory: string;
  scheduleId?: ScheduleId;
  gitBaseBranch?: string;
}
export const createLoop = (request: LoopCreateRequest, context: LoopCreateContext): Loop => { ... }
```

This would also eliminate the post-creation `updateLoop(loop, { gitBaseBranch })` workaround in `LoopManagerService` (line 233).

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`ScheduleService` interface accumulating methods -- ISP concern** - `src/core/interfaces.ts:394-408`
**Confidence**: 75% (below threshold -- moved to Suggestions)

## Suggestions (Lower Confidence)

- **`ScheduleService` interface growing toward ISP violation** - `src/core/interfaces.ts:394-408` (Confidence: 75%) -- The interface now has 8 methods spanning schedule CRUD, pipeline creation, and loop scheduling. Consider splitting into `ScheduleService` (CRUD) and `ScheduledWorkflowService` (pipeline/loop creation).

- **`MCPAdapter` tool definitions duplicated as both Zod schemas and JSON Schema objects** - `src/adapters/mcp-adapter.ts` (Confidence: 70%) -- `ScheduleLoopSchema` (Zod) at line 45 and the JSON Schema `inputSchema` object at line 1063 define the same validation. This is a pre-existing pattern, but the v0.8.0 additions increase the surface area where they can drift.

- **`parseScheduleCreateArgs` in `schedule.ts` growing complex with loop flags** - `src/cli/commands/schedule.ts:72-200` (Confidence: 65%) -- The function now handles 3 modes (task, pipeline, loop) with ~15 loop-specific flags. Consider extracting loop flag parsing into a separate function.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Architecture Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The v0.8.0 feature set (loop pause/resume, scheduled loops, git integration) is architecturally well-structured overall -- it follows the established event-driven patterns, uses Result types consistently, and injects dependencies properly. The two HIGH-severity findings (unsafe `TaskId` cast and non-atomic loop trigger) are the primary concerns. The unsafe cast undermines the branded-type system that is a strength of this codebase, and the non-atomic trigger breaks consistency with the other two trigger paths in the same handler. The MEDIUM findings around SRP boundaries (ScheduleHandler creating loop entities, LoopHandler calling git utilities directly) are worth addressing but are not blocking.
