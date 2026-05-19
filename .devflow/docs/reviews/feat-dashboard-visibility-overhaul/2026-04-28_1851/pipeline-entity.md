# Pipeline Entity — Plan Alignment Review

**Branch**: feat/dashboard-visibility-overhaul -> main
**Date**: 2026-04-28
**Scope**: Pipeline entity implementation checked against plan acceptance criteria

---

## Section 2.1: Domain Types (src/core/domain.ts)

| # | Requirement | Status | Notes |
|---|-------------|--------|-------|
| 1 | `PipelineId` branded type with factory function | PASS | `PipelineId = string & { __brand: 'PipelineId' }` + `PipelineId(id: string)` factory at line 14/21 |
| 2 | `PipelineStatus` enum: pending, running, completed, failed, cancelled | PASS | Enum at line 915 with all 5 values |
| 3 | `PipelineStepDefinition`: index, prompt, priority?, workingDirectory?, agent?, model?, systemPrompt? | PASS | Interface at line 927 with all fields, correct optionality |
| 4 | `Pipeline` interface: id, steps, stepTaskIds, status, scheduleId?, loopId?, loopIteration?, orchestratorId?, priority?, workingDirectory?, agent?, model?, systemPrompt?, createdAt, updatedAt, completedAt? | PASS | Interface at line 942. All fields present with correct types and optionality |
| 5 | `createPipeline()` factory function | PASS | Factory at line 984. Returns frozen immutable object with UUID-based ID, defaults status to PENDING, sets timestamps |

---

## Section 2.2: Migration v24 (src/implementations/database.ts)

| # | Requirement | Status | Notes |
|---|-------------|--------|-------|
| 1 | `pipelines` table with all columns | PASS | All 16 columns present: id, steps, step_task_ids, status, schedule_id, loop_id, loop_iteration, orchestrator_id, priority, working_directory, agent, model, system_prompt, created_at, updated_at, completed_at |
| 2 | Status CHECK constraint | PASS | `CHECK(status IN ('pending', 'running', 'completed', 'failed', 'cancelled'))` at line 966 |
| 3 | FK: schedules(id) ON DELETE SET NULL | PASS | `REFERENCES schedules(id) ON DELETE SET NULL` at line 967 |
| 4 | FK: loops(id) ON DELETE SET NULL | PASS | `REFERENCES loops(id) ON DELETE SET NULL` at line 968 |
| 5 | FK: orchestrations(id) ON DELETE SET NULL | PASS | `REFERENCES orchestrations(id) ON DELETE SET NULL` at line 970 |
| 6 | idx_pipelines_status | PASS | Line 981 |
| 7 | idx_pipelines_schedule_id | PASS | Line 982 |
| 8 | idx_pipelines_loop_id | PASS | Line 983 |
| 9 | idx_pipelines_orchestrator_id (WHERE NOT NULL) | PASS | Partial index at line 984-986 |
| 10 | idx_pipelines_updated_at | PASS | Line 987 |

---

## Section 2.3: Repository (src/implementations/pipeline-repository.ts)

| # | Requirement | Status | Notes |
|---|-------------|--------|-------|
| 1 | Implements PipelineRepository interface | PASS | `class SQLitePipelineRepository implements PipelineRepository` |
| 2 | Method: save | PASS | `async save(pipeline: Pipeline): Promise<Result<void>>` |
| 3 | Method: update | PASS | `async update(pipeline: Pipeline): Promise<Result<void>>` |
| 4 | Method: findById | PASS | `async findById(id: PipelineId): Promise<Result<Pipeline | null>>` |
| 5 | Method: findAll | PASS | `async findAll(limit?: number): Promise<Result<readonly Pipeline[]>>` |
| 6 | Method: findByStatus | PASS | `async findByStatus(status: PipelineStatus, limit?: number)` |
| 7 | Method: findByScheduleId | PASS | `async findByScheduleId(scheduleId: ScheduleId)` |
| 8 | Method: findByLoopId | PASS | `async findByLoopId(loopId: LoopId)` |
| 9 | Method: delete | PASS | `async delete(id: PipelineId): Promise<Result<void>>` |
| 10 | Method: countByStatus | PASS | `async countByStatus(): Promise<Result<Record<string, number>>>` |
| 11 | Method: findUpdatedSince | PASS | `async findUpdatedSince(sinceMs: number, limit: number)` |
| 12 | Zod schema at boundary | PASS | `PipelineRowSchema`, `StepDefinitionSchema`, `StepTaskIdsSchema` at module level |
| 13 | JSON serialization for steps and stepTaskIds | PASS | `pipelineToRow` serializes with `JSON.stringify`; `rowToPipeline` parses with `JSON.parse` + Zod |
| 14 | Result return types on all methods | PASS | All methods return `Promise<Result<T>>` |
| 15 | Extra: findActiveByTaskId | PASS | Not in plan but useful addition for PipelineHandler |

---

## Section 2.4: Pipeline Lifecycle (src/services/schedule-manager.ts)

| # | Requirement | Status | Notes |
|---|-------------|--------|-------|
| 1 | createPipeline() creates Pipeline record | PASS | `createPipeline()` called at line 402, saved via `pipelineRepository.save()` at line 420 |
| 2 | stepTaskIds populated with actual task IDs | **FAIL** | stepTaskIds are initialized as all-null via `request.steps.map(() => null)` at line 989. The plan requires stepTaskIds to be populated with actual TaskIds from the created schedules. Currently they remain null because the pipeline entity is created with no task correlation. |
| 3 | PipelineCreated event emitted | **FAIL** | No `PipelineCreated` event is emitted anywhere. The event type is defined in events.ts but never emitted in schedule-manager.ts or pipeline-handler.ts. |

---

## Section 13.1: Pipeline Events (src/core/events/events.ts)

| # | Requirement | Status | Notes |
|---|-------------|--------|-------|
| 1 | PipelineCreated: pipelineId, steps count | PASS (type defined) | Interface defined with `pipelineId: PipelineId` and `steps: number` |
| 2 | PipelineStatusChanged: pipelineId, fromStatus, toStatus | PASS (type defined) / **FAIL (never emitted)** | Interface defined, but PipelineHandler never emits `PipelineStatusChanged`. It only emits terminal events (Completed/Failed/Cancelled). |
| 3 | PipelineStepCompleted: pipelineId, stepIndex, taskId | PASS (type defined) / **FAIL (never emitted)** | Interface defined, but PipelineHandler never emits `PipelineStepCompleted` when individual steps complete. |
| 4 | PipelineCompleted: pipelineId | PASS | Defined and emitted in `pipeline-handler.ts:245` |
| 5 | PipelineFailed: pipelineId, failedStepIndex, taskId | PASS | Defined and emitted in `pipeline-handler.ts:248` |
| 6 | PipelineCancelled: pipelineId | PASS | Defined and emitted in `pipeline-handler.ts:256` |

---

## Section 13.3: MCP Tools (src/adapters/mcp-adapter.ts)

| # | Requirement | Status | Notes |
|---|-------------|--------|-------|
| 1 | PipelineStatus tool: input pipelineId | PASS | Schema at line 341, handler at line 3645. Returns pipeline with step details. |
| 2 | PipelineStatus tool: returns resolved step tasks | **PARTIAL** | Returns step index, prompt, and taskId, but does NOT resolve the task objects (status, etc.). Only raw taskId is returned. Plan says "returns pipeline with resolved step tasks". |
| 3 | ListPipelines tool: input status?, limit? | PASS | Schema at line 345, handler at line 3701. |
| 4 | ListPipelines tool: returns pipeline array | PASS | Returns array with count, pipelineId, status, stepCount, priority, timestamps. |
| 5 | CancelPipeline tool: input pipelineId | PASS | Schema at line 350, handler at line 3749. |
| 6 | CancelPipeline tool: cancelTasks? cascade | **FAIL** | CancelPipelineSchema does NOT include `cancelTasks` parameter. Compare with CancelSchedule and CancelLoop schemas which both have `cancelTasks: z.boolean().optional()`. The cancel handler at line 3749 only updates the pipeline status to CANCELLED without cancelling the underlying tasks. |
| 7 | CreatePipeline response includes `pipeline_id` field | **PARTIAL** | Response at line 2522 includes `pipelineEntityId` (the Pipeline entity ID), not `pipeline_id` as the plan specifies. The field name is `pipelineEntityId` instead of `pipeline_id`. Whether this is intentional (camelCase consistency) or a deviation depends on the plan's intent. |

---

## Section 13.9: Bootstrap/Container

| # | Requirement | Status | Notes |
|---|-------------|--------|-------|
| 1 | PipelineRepository registered in bootstrap.ts | PASS | `container.registerSingleton('pipelineRepository', ...)` at line 341 |
| 2 | PipelineHandler registered in handler-setup.ts | PASS | Created via `PipelineHandler.create()` at line 500, returned in `HandlerSetupResult` |
| 3 | ReadOnlyContext has pipelineRepository | PASS | Added to interface at line 49, created in `createReadOnlyContext()` at line 68 |
| 4 | ReadOnlyContext has dependencyRepository | **FAIL** | Not present in ReadOnlyContext interface. The plan requires it; the implementation only has taskRepository, outputRepository, scheduleRepository, loopRepository, orchestrationRepository, workerRepository, usageRepository, pipelineRepository. |
| 5 | DashboardMutationContext updated for pipeline mutations | PASS | `pipelineRepo?: PipelineRepository` added as optional at line 53 of types.ts |
| 6 | PipelineRepository passed to ScheduleManagerService | PASS | Fifth constructor param in bootstrap.ts line 354 |
| 7 | PipelineRepository passed to MCPAdapter | PASS | In MCPAdapter constructor deps at line 582 |

---

## Issues in Your Changes (BLOCKING)

### HIGH

**PipelineCreated event never emitted** - `src/services/schedule-manager.ts:400-428`
**Confidence**: 95%
- Problem: The `PipelineCreated` event type is defined in `events.ts` with `pipelineId` and `steps` fields, but no code emits it. When `createPipeline()` in ScheduleManagerService saves the pipeline entity, it should emit `PipelineCreated` so other handlers (e.g., activity feed, logging) can react to new pipelines.
- Fix: After the successful `pipelineRepository.save()` call, emit the event:
  ```typescript
  const emitResult = await this.eventBus.emit('PipelineCreated', {
    pipelineId: pipelineEntity.id,
    steps: pipelineEntity.steps.length,
  });
  ```

**PipelineStatusChanged event never emitted** - `src/services/handlers/pipeline-handler.ts:239-262`
**Confidence**: 92%
- Problem: The `PipelineStatusChanged` event is defined with `fromStatus` and `toStatus` fields, but `emitPipelineEvent()` only emits terminal events (Completed/Failed/Cancelled). The plan requires `PipelineStatusChanged` to be emitted on status transitions (e.g., PENDING -> RUNNING).
- Fix: In `emitPipelineEvent()`, emit `PipelineStatusChanged` before any terminal event:
  ```typescript
  // Always emit status change
  await this.emitEvent(this.eventBus, 'PipelineStatusChanged', {
    pipelineId: pipeline.id,
    fromStatus: previousStatus,
    toStatus: pipeline.status,
  });
  ```

**PipelineStepCompleted event never emitted** - `src/services/handlers/pipeline-handler.ts:83-98`
**Confidence**: 92%
- Problem: When an individual step task completes, the handler updates aggregate status but never emits `PipelineStepCompleted`. The plan specifies this event with `pipelineId`, `stepIndex`, and `taskId` for step-level progress tracking.
- Fix: In `updatePipelineStatus()`, when a step task has completed, emit per-step:
  ```typescript
  for (const step of stepStatuses) {
    if (step.status === 'completed') {
      await this.emitEvent(this.eventBus, 'PipelineStepCompleted', {
        pipelineId: pipeline.id,
        stepIndex: step.stepIndex,
        taskId: step.taskId,
      });
    }
  }
  ```
  Note: This needs deduplication logic to avoid re-emitting for already-completed steps.

**CancelPipeline missing cancelTasks cascade** - `src/adapters/mcp-adapter.ts:350-353, 3749-3831`
**Confidence**: 95%
- Problem: The CancelPipelineSchema has no `cancelTasks` parameter. The handler only sets the pipeline status to CANCELLED without cancelling underlying step tasks. The plan specifies `cancelTasks?` input that cascades cancellation to in-flight tasks, matching the CancelSchedule and CancelLoop patterns.
- Fix: Add `cancelTasks` to the schema and implement cascade:
  ```typescript
  const CancelPipelineSchema = z.object({
    pipelineId: z.string().describe('Pipeline entity ID to cancel'),
    cancelTasks: z.boolean().optional().default(true).describe('Also cancel in-flight tasks'),
    reason: z.string().optional().describe('Reason for cancellation'),
  });
  ```
  Then in the handler, iterate `pipeline.stepTaskIds` and emit `TaskCancellationRequested` for each non-null task ID.

### MEDIUM

**stepTaskIds never populated with actual task IDs** - `src/services/schedule-manager.ts:402-428`
**Confidence**: 85%
- Problem: The pipeline entity is created with `stepTaskIds` defaulting to all-null. The plan requires `stepTaskIds populated with actual task IDs`. In the current flow, `createPipeline()` creates schedule chains (each step becomes a ScheduleId), but the Pipeline entity's `stepTaskIds` are never backfilled when the tasks are actually dispatched by the schedule executor.
- Impact: The PipelineHandler's `findActiveByTaskId()` will never match any pipelines because `step_task_ids` is all nulls. Pipeline status tracking is effectively inert until something populates these IDs.
- Fix: There needs to be a mechanism (either in ScheduleHandler or PipelineHandler) that, when a scheduled task is dispatched, updates the corresponding Pipeline entity's `stepTaskIds` with the actual TaskId. This likely requires subscribing to `ScheduleExecuted` events and correlating via schedule_id.

**PipelineStatus tool does not resolve step tasks** - `src/adapters/mcp-adapter.ts:3674-3678`
**Confidence**: 82%
- Problem: The plan says PipelineStatus "returns pipeline with resolved step tasks." The current implementation returns raw `taskId` per step but does not fetch each task to include its status, duration, or other fields.
- Fix: For each non-null taskId in `pipeline.stepTaskIds`, call `taskRepository.findById()` and include task status in the response.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**ReadOnlyContext missing dependencyRepository** - `src/cli/read-only-context.ts:41-51`
**Confidence**: 88%
- Problem: The plan (Section 13.9) specifies `ReadOnlyContext has pipelineRepository + dependencyRepository`. The `pipelineRepository` was added, but `dependencyRepository` is missing. If dashboard features need dependency data (e.g., showing task dependency chains in pipeline detail), this will require a follow-up change.
- Fix: Add `dependencyRepository` to the ReadOnlyContext interface and `createReadOnlyContext()` factory.

## Pre-existing Issues (Not Blocking)

None identified.

## Suggestions (Lower Confidence)

- **CreatePipeline response field naming** - `src/adapters/mcp-adapter.ts:2522` (Confidence: 65%) -- Plan says `pipeline_id` (snake_case); implementation uses `pipelineEntityId` (camelCase). Other fields in the same response use camelCase, so this may be an intentional deviation from the plan for API consistency. Confirm which naming convention is intended.

---

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 4 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Overall Alignment**: 28 of 35 plan acceptance criteria PASS (80%). The domain types, migration, repository, and bootstrap wiring are solid. The gaps are in event lifecycle (3 events defined but never emitted), cascade cancellation, and stepTaskIds population -- all behavioral/runtime concerns that affect pipeline tracking correctness.

**Plan Alignment Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The core infrastructure (types, migration, repository, bootstrap) is well-implemented and follows project patterns. The blocking issues are all in the behavioral layer: events that are defined but never emitted, and the stepTaskIds population gap that renders pipeline status tracking effectively inert for schedule-triggered pipelines.
