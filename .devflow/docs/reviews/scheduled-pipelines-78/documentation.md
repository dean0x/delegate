# Documentation Review Report

**Branch**: feat/scheduled-pipelines-78 -> main
**Date**: 2026-03-18
**Commits**: 011519e feat: scheduled pipelines + dependency cascade fix (#78), 0ec3f84 style: fix Biome formatting issues

## Issues in Your Changes (BLOCKING)

### CRITICAL

**TASK-DEPENDENCIES.md contradicts new dependency cascade behavior** - `/Users/dean/Sandbox/claudine/docs/TASK-DEPENDENCIES.md:468-524`
- Problem: The "Handle Dependency Failures" section (lines 468-524) explicitly documents that failed/cancelled dependencies **unblock** dependent tasks and let them execute. This PR introduces the opposite behavior: failed/cancelled dependencies now **cascade cancellation** to dependents (via `DependencyHandler` at `src/services/handlers/dependency-handler.ts:582-595`). The documentation says "Task B is enqueued and can execute" after Task A fails, but the code now cancels Task B instead.
- Impact: Users relying on the documented behavior (check resolution states manually, proceed despite failures) will be blindsided by automatic cascade cancellation. The "Error Handling" section under "Usage Examples" (line 377-403) also shows the old behavior. The FEATURES.md correctly calls this a "breaking change" but TASK-DEPENDENCIES.md still documents the pre-v0.6.0 semantics.
- Fix: Update the following sections in `docs/TASK-DEPENDENCIES.md`:
  - Section "3. Handle Dependency Failures" (line 466+): Replace "Current Behavior (v0.3.0)" with new v0.6.0 cascade semantics
  - "Error Handling" example (line 377-403): Update to show cascade cancellation
  - "Cancelled Dependency Propagation" section (line 554-585): Remove "does NOT automatically cancel its dependents" claim and "Workaround for Cascading Cancellation" (it is now built-in)
  - "Design Rationale" section (line 526-538): Update advantages/disadvantages since behavior changed
  - "Future Consideration (v0.4.0)" section (line 539-552): Remove or mark as implemented, since cascade is now the default

### HIGH

**Missing release notes for v0.6.0** - `/Users/dean/Sandbox/claudine/docs/releases/`
- Problem: The project's release process (documented in CLAUDE.md) requires a `docs/releases/RELEASE_NOTES_v0.6.0.md` file. No such file exists on this branch. The ROADMAP.md marks v0.6.0 as "RELEASED (2026-03-18)" and FEATURES.md has a "What's New in v0.6.0" section, but the formal release notes file is missing.
- Impact: The GitHub Release workflow validates that release notes exist before publishing. Without this file, the release will fail or bypass the documented release process.
- Fix: Create `docs/releases/RELEASE_NOTES_v0.6.0.md` covering: SchedulePipeline MCP tool, CLI `--pipeline --step` flags, dependency failure cascade fix, queue handler race condition fix, `cancelTasks` on CancelSchedule, migration 8 schema changes, and the breaking change in dependency behavior.

**No JSDoc on `cancelSchedule` updated signature** - `/Users/dean/Sandbox/claudine/src/services/schedule-manager.ts:238`
- Problem: The `cancelSchedule` method signature changed to accept a third `cancelTasks?: boolean` parameter, but there is no JSDoc documenting this parameter or its behavior (cancels in-flight pipeline tasks from the latest execution). The interface definition in `src/core/interfaces.ts:408` also lacks JSDoc for the new parameter.
- Impact: Callers do not know what `cancelTasks` does without reading the implementation. The MCP schema has a description, but the TypeScript API surface is undocumented.
- Fix: Add JSDoc to both the interface and implementation:
  ```typescript
  /**
   * Cancel an active schedule.
   * @param scheduleId - Schedule to cancel
   * @param reason - Optional cancellation reason
   * @param cancelTasks - If true, also cancel in-flight tasks from the latest execution
   */
  cancelSchedule(scheduleId: ScheduleId, reason?: string, cancelTasks?: boolean): Promise<Result<void>>;
  ```

**No JSDoc on `createScheduledPipeline` in schedule-manager** - `/Users/dean/Sandbox/claudine/src/services/schedule-manager.ts:325`
- Problem: The `createScheduledPipeline` method is a new public API with no JSDoc. The interface in `src/core/interfaces.ts:410` also lacks JSDoc. The domain type `ScheduledPipelineCreateRequest` at `src/core/domain.ts:394` has a good architectural comment, but the method implementing it does not document its behavior, validation rules, or error conditions.
- Impact: Consumers of `ScheduleService` cannot understand what this method does, its validation constraints (2-20 steps, path validation, agent resolution), or its error modes without reading 90+ lines of implementation.
- Fix: Add JSDoc to interface and implementation:
  ```typescript
  /**
   * Create a scheduled pipeline that triggers N tasks with linear dependencies on each run.
   * @param request - Pipeline configuration (2-20 steps, schedule type, timing, etc.)
   * @returns The created Schedule with pipelineSteps populated
   * @throws INVALID_INPUT if steps < 2 or > 20, or schedule timing is invalid
   * @throws INVALID_DIRECTORY if any working directory path is invalid
   */
  createScheduledPipeline(request: ScheduledPipelineCreateRequest): Promise<Result<Schedule>>;
  ```

### MEDIUM

**EVENT_FLOW.md does not document pipeline trigger flow** - `/Users/dean/Sandbox/claudine/docs/architecture/EVENT_FLOW.md`
- Problem: The Event Flow Architecture document covers single-task delegation, completion, cancellation, and recovery flows, but does not document the new pipeline trigger flow introduced in this PR. The `ScheduleHandler.handlePipelineTrigger()` creates N tasks, emits N `TaskDelegated` events, and uses the tail task for `ScheduleExecuted` concurrency tracking. This is a distinct and complex event flow.
- Impact: Developers reading the architecture docs will not understand how scheduled pipelines interact with the event system, particularly the tail-task concurrency tracking pattern.
- Fix: Add a "5. Pipeline Trigger Flow" section to EVENT_FLOW.md showing the ScheduleTriggered -> handlePipelineTrigger -> N x TaskDelegated -> ScheduleExecuted(lastTaskId) flow.

**Event Flow doc missing `ScheduleHandler` in handler diagram** - `/Users/dean/Sandbox/claudine/docs/architecture/EVENT_FLOW.md:8-26`
- Problem: The architecture overview diagram at the top of EVENT_FLOW.md shows PersistenceHandler, QueueHandler, WorkerHandler, and OutputHandler. It does not include ScheduleHandler or DependencyHandler, both of which are core event handlers. This was pre-existing but is now more relevant with the expanded ScheduleHandler pipeline logic.
- Impact: The diagram gives an incomplete picture of the event-driven architecture.
- Fix: Add ScheduleHandler and DependencyHandler to the overview diagram.

**CLAUDE.md file locations table missing `schedule-manager.ts`** - Fixed in this PR, but the description column could be more specific.
- Problem: The newly added row `| Schedule manager | src/services/schedule-manager.ts |` is correct but could indicate the manager also handles pipelines now (v0.6.0).
- Impact: Minor. The entry is present and accurate enough.
- Fix: No action required; this is informational.

## Issues in Code You Touched (Should Fix)

### HIGH

**Stale "Future Consideration (v0.4.0)" section in TASK-DEPENDENCIES.md** - `/Users/dean/Sandbox/claudine/docs/TASK-DEPENDENCIES.md:539-552`
- Problem: This section proposes a future `onDependencyFailure` API for configurable dependency failure strategies. Since v0.6.0 now implements cascade cancellation as the default behavior, this "future" section is misleading. It references v0.4.0 (already released) and proposes an API that was never implemented. The behavior it describes (`auto-fail`, `auto-cancel`, `continue`) is partially superseded by the cascade cancellation in this PR.
- Impact: Developers may expect this API exists or is planned, when the direction has changed.
- Fix: Either remove the section entirely, or update it to note that v0.6.0 implemented cascade cancellation as the default, and the configurable strategy API remains a potential future enhancement.

### MEDIUM

**Dependency handler event flow diagram in TASK-DEPENDENCIES.md is now incorrect** - `/Users/dean/Sandbox/claudine/docs/TASK-DEPENDENCIES.md:95-103`
- Problem: The event flow diagram shows `TaskCompleted/Failed/Cancelled -> DependencyHandler -> If unblocked: Emits TaskUnblocked`. In v0.6.0, the DependencyHandler now checks for failed/cancelled resolutions and emits `TaskCancellationRequested` instead of `TaskUnblocked` when a dependency resolved as failed/cancelled. The diagram does not reflect this branch in the flow.
- Impact: The diagram will mislead developers about the actual event flow when dependencies fail.
- Fix: Update the diagram to show the cascade cancellation path:
  ```
  TaskCompleted/Failed/Cancelled
    |
    --> DependencyHandler.handleTaskCompleted()
          --> Resolves dependencies
          --> Checks dependent tasks
                --> If unblocked AND all deps completed: Emits TaskUnblocked
                --> If unblocked BUT dep failed/cancelled: Emits TaskCancellationRequested
  ```

**Queue handler fast-path not documented in TASK-DEPENDENCIES.md** - `/Users/dean/Sandbox/claudine/docs/TASK-DEPENDENCIES.md:46-71`
- Problem: The "Dependency-Aware Queueing" section shows a flow diagram where `QueueHandler.handleTaskPersisted()` always checks `isBlocked()` in the database. The new fast-path in `queue-handler.ts:65-72` skips the DB check entirely when `dependencyState === 'blocked'`. This optimization is important for the race condition fix documented in FEATURES.md but not reflected in the architecture documentation.
- Impact: Developers debugging task queueing issues will not know about the fast-path skip.
- Fix: Update the "Dependency-Aware Queueing" diagram to include the fast-path:
  ```
  Task Created -> Has Dependencies?
    -> Yes -> dependencyState === 'blocked'? -> Yes -> Skip (fast-path)
    -> Yes -> dependencyState !== 'blocked' -> Check if Blocked in DB -> ...
  ```

## Pre-existing Issues (Not Blocking)

### MEDIUM

**EVENT_FLOW.md does not document schedule-related events** - `/Users/dean/Sandbox/claudine/docs/architecture/EVENT_FLOW.md:30-42`
- Problem: The "Event Types" section lists command events (TaskDelegated, TaskQueued, etc.) but omits all schedule events: ScheduleCreated, ScheduleTriggered, ScheduleExecuted, ScheduleCancelled, SchedulePaused, ScheduleResumed. These have been present since v0.4.0.
- Impact: Incomplete reference for developers working with the event system.
- Fix: Add schedule events to the Event Types section in a future PR.

**TASK-DEPENDENCIES.md references non-existent GitHub issue** - `/Users/dean/Sandbox/claudine/docs/TASK-DEPENDENCIES.md:552`
- Problem: `**Track this in**: [GitHub Issue #TBD - Dependency Failure Strategies]` was never replaced with an actual issue number.
- Impact: Dead reference.
- Fix: Either create the issue and link it, or remove the line since cascade cancellation is now implemented.

### LOW

**FEATURES.md uses emoji headers inconsistently** - `/Users/dean/Sandbox/claudine/docs/FEATURES.md`
- Problem: Some section headers use emoji (checkmark, cross, "new" badge) and others do not. The new v0.6.0 section follows the existing pattern, so this is consistent with the file, but the emoji style is inconsistent across the document as a whole.
- Impact: Minor readability/style concern.
- Fix: No action needed for this PR.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 1 | 3 | 1 | - |
| Should Fix | - | 1 | 2 | - |
| Pre-existing | - | - | 2 | 1 |

**Documentation Score**: 4/10
**Recommendation**: CHANGES_REQUESTED

### Rationale

The CRITICAL issue is a direct contradiction between documented behavior and actual code. The TASK-DEPENDENCIES.md extensively documents that failed dependencies **unblock** dependent tasks (with code examples, design rationale, and workaround patterns). The v0.6.0 change reverses this to cascade cancellation. This is called out as a "breaking change" in FEATURES.md, but the primary reference documentation (TASK-DEPENDENCIES.md) still describes the old behavior across multiple sections. A user reading TASK-DEPENDENCIES.md will be actively misled.

The missing release notes file will block the release workflow. The missing JSDoc on the two new public API methods (`cancelSchedule` new parameter, `createScheduledPipeline`) leaves the TypeScript API surface undocumented for a significant feature addition.

The documentation additions in FEATURES.md, ROADMAP.md, CLAUDE.md, and README.md are thorough and accurate. The code-level inline comments (schedule-handler.ts helper methods, repository schemas, domain types) are well-written. The gap is in the reference documentation that developers use to understand behavior.
