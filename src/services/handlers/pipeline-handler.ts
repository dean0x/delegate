/**
 * Pipeline handler — subscribes to task lifecycle events and updates pipeline status.
 *
 * ARCHITECTURE: Event-driven, best-effort status aggregation.
 * - Subscribes to ScheduleExecuted to populate stepTaskIds as tasks are dispatched.
 * - Subscribes to TaskCompleted, TaskFailed, TaskCancelled for status aggregation.
 * - On each task event, looks up active pipelines containing the task ID.
 * - Aggregates step task statuses to determine new pipeline status.
 * - Emits PipelineStatusChanged for all transitions; PipelineCompleted / PipelineFailed / PipelineCancelled for terminal states.
 * - Emits PipelineStepCompleted when an individual step task completes.
 * Pattern: Factory pattern for async initialization (matches UsageCaptureHandler).
 */

import { type Pipeline, PipelineStatus, type TaskId } from '../../core/domain.js';
import { AutobeatError, ErrorCode } from '../../core/errors.js';
import type { EventBus } from '../../core/events/event-bus.js';
import type {
  ScheduleExecutedEvent,
  TaskCancelledEvent,
  TaskCompletedEvent,
  TaskFailedEvent,
} from '../../core/events/events.js';
import { BaseEventHandler } from '../../core/events/handlers.js';
import type { Logger, PipelineRepository, TaskRepository } from '../../core/interfaces.js';
import { err, ok, type Result } from '../../core/result.js';

export interface PipelineHandlerDeps {
  readonly pipelineRepository: PipelineRepository;
  readonly taskRepository: TaskRepository;
  readonly eventBus: EventBus;
  readonly logger: Logger;
}

export class PipelineHandler extends BaseEventHandler {
  private readonly pipelineRepository: PipelineRepository;
  private readonly taskRepository: TaskRepository;
  private readonly eventBus: EventBus;

  /**
   * Private constructor — use PipelineHandler.create() instead.
   * ARCHITECTURE: Factory pattern ensures handler is fully initialized before use.
   */
  private constructor(deps: PipelineHandlerDeps) {
    super(deps.logger, 'PipelineHandler');
    this.pipelineRepository = deps.pipelineRepository;
    this.taskRepository = deps.taskRepository;
    this.eventBus = deps.eventBus;
  }

  /**
   * Factory method — creates and subscribes the handler.
   * ARCHITECTURE: Guarantees handler is ready to use — no uninitialized state possible.
   */
  static async create(deps: PipelineHandlerDeps): Promise<Result<PipelineHandler, AutobeatError>> {
    const handlerLogger = deps.logger.child ? deps.logger.child({ module: 'PipelineHandler' }) : deps.logger;
    const handler = new PipelineHandler({ ...deps, logger: handlerLogger });

    const subscribeResult = handler.subscribeToEvents();
    if (!subscribeResult.ok) {
      return subscribeResult;
    }

    handlerLogger.info('PipelineHandler initialized');
    return ok(handler);
  }

  private subscribeToEvents(): Result<void, AutobeatError> {
    const subs = [
      // ScheduleExecuted: populate stepTaskIds as each step's schedule fires and creates a task
      this.eventBus.subscribe('ScheduleExecuted', this.handleScheduleExecuted.bind(this)),
      this.eventBus.subscribe('TaskCompleted', this.handleTaskCompleted.bind(this)),
      this.eventBus.subscribe('TaskFailed', this.handleTaskFailed.bind(this)),
      this.eventBus.subscribe('TaskCancelled', this.handleTaskCancelled.bind(this)),
    ];

    for (const result of subs) {
      if (!result.ok) {
        return err(
          new AutobeatError(
            ErrorCode.SYSTEM_ERROR,
            `PipelineHandler: failed to subscribe to event: ${result.error.message}`,
            { error: result.error },
          ),
        );
      }
    }

    return ok(undefined);
  }

  /**
   * Populate stepTaskIds when a step schedule executes and creates its task.
   * ARCHITECTURE: Only populates steps for immediate pipelines (createPipeline path) where
   * step.scheduleId is set. Scheduled-pipeline triggers populate stepTaskIds via the
   * schedule-handler path directly.
   *
   * ARCHITECTURE: No transaction needed for the read-modify-write on stepTaskIds.
   * Each pipeline step has a unique scheduleId, and steps are chained via afterScheduleId
   * (step N's schedule only triggers after step N-1's task completes). This guarantees that
   * ScheduleExecuted events for different steps of the same pipeline always fire sequentially,
   * making concurrent updates to the same stepTaskIds slot architecturally impossible.
   */
  private async handleScheduleExecuted(event: ScheduleExecutedEvent): Promise<void> {
    await this.handleEvent(event, async (e) => {
      // Only act when the event carries a taskId (pipeline/single-task trigger, not loop)
      if (!e.taskId) {
        return ok(undefined);
      }

      const pipelinesResult = await this.pipelineRepository.findActiveByStepScheduleId(e.scheduleId);
      if (!pipelinesResult.ok) {
        this.logger.warn('PipelineHandler: failed to look up pipelines by step schedule ID', {
          scheduleId: e.scheduleId,
          error: pipelinesResult.error.message,
        });
        return ok(undefined); // best-effort
      }

      for (const pipeline of pipelinesResult.value) {
        const stepIndex = pipeline.steps.findIndex((s) => s.scheduleId === e.scheduleId);
        if (stepIndex === -1) continue;

        // Update the stepTaskIds array at the matching step index
        const newStepTaskIds = [...pipeline.stepTaskIds] as (TaskId | null)[];
        newStepTaskIds[stepIndex] = e.taskId;

        const updated: Pipeline = { ...pipeline, stepTaskIds: newStepTaskIds, updatedAt: Date.now() };
        const saveResult = await this.pipelineRepository.update(updated);
        if (!saveResult.ok) {
          this.logger.warn('PipelineHandler: failed to update stepTaskIds', {
            pipelineId: pipeline.id,
            stepIndex,
            taskId: e.taskId,
            error: saveResult.error.message,
          });
        } else {
          this.logger.debug('PipelineHandler: populated stepTaskId', {
            pipelineId: pipeline.id,
            stepIndex,
            taskId: e.taskId,
          });
        }
      }

      return ok(undefined);
    });
  }

  private async handleTaskCompleted(event: TaskCompletedEvent): Promise<void> {
    await this.handleEvent(event, (e) => this.onTaskTerminated(e.taskId, true));
  }

  private async handleTaskFailed(event: TaskFailedEvent): Promise<void> {
    await this.handleEvent(event, (e) => this.onTaskTerminated(e.taskId, false));
  }

  private async handleTaskCancelled(event: TaskCancelledEvent): Promise<void> {
    await this.handleEvent(event, (e) => this.onTaskTerminated(e.taskId, false));
  }

  /**
   * Core pipeline status aggregation logic.
   * Called when any step task terminates (completed, failed, cancelled).
   * Finds associated active pipelines and recomputes their aggregate status.
   * @param taskId - The task that terminated.
   * @param isCompletion - True when triggered by TaskCompleted; used to emit PipelineStepCompleted.
   */
  private async onTaskTerminated(taskId: TaskId, isCompletion: boolean): Promise<Result<void>> {
    // Find active pipelines that contain this task ID
    const pipelinesResult = await this.pipelineRepository.findActiveByTaskId(taskId);
    if (!pipelinesResult.ok) {
      this.logger.warn('PipelineHandler: failed to look up pipelines for task', {
        taskId,
        error: pipelinesResult.error.message,
      });
      return ok(undefined); // best-effort — don't propagate
    }

    const pipelines = pipelinesResult.value;
    if (pipelines.length === 0) {
      // Task is not part of any active pipeline — nothing to do
      return ok(undefined);
    }

    // Process each associated pipeline
    for (const pipeline of pipelines) {
      // Emit PipelineStepCompleted when a step task successfully completes
      if (isCompletion) {
        const stepIndex = pipeline.stepTaskIds.indexOf(taskId);
        if (stepIndex !== -1) {
          await this.emitEvent(this.eventBus, 'PipelineStepCompleted', {
            pipelineId: pipeline.id,
            stepIndex,
            taskId,
          });
        }
      }

      const updateResult = await this.updatePipelineStatus(pipeline);
      if (!updateResult.ok) {
        this.logger.warn('PipelineHandler: failed to update pipeline status', {
          pipelineId: pipeline.id,
          taskId,
          error: updateResult.error.message,
        });
        // Continue processing other pipelines even if one fails
      }
    }

    return ok(undefined);
  }

  /**
   * Recompute and persist pipeline status from the current state of its step tasks.
   * Aggregation rules:
   *   - Any step cancelled → pipeline CANCELLED
   *   - Any step failed → pipeline FAILED
   *   - All steps completed → pipeline COMPLETED
   *   - Otherwise → pipeline RUNNING (progress made but not finished)
   */
  private async updatePipelineStatus(pipeline: Pipeline): Promise<Result<void>> {
    const taskIds = pipeline.stepTaskIds.filter((id): id is TaskId => id !== null);

    if (taskIds.length === 0) {
      // Degenerate pipeline with no assigned tasks yet — skip
      return ok(undefined);
    }

    // Fetch all step task statuses in parallel — each lookup is independent.
    // PERFORMANCE: Promise.all eliminates the N+1 serial query pattern for pipelines with many steps.
    const assignedSteps = pipeline.stepTaskIds
      .map((tid, stepIdx) => (tid !== null ? { tid, stepIdx } : null))
      .filter((entry): entry is { tid: TaskId; stepIdx: number } => entry !== null);

    const lookupResults = await Promise.all(assignedSteps.map(({ tid }) => this.taskRepository.findById(tid)));

    const stepStatuses: Array<{ taskId: TaskId; status: string; stepIndex: number }> = [];
    for (let i = 0; i < assignedSteps.length; i++) {
      const { tid, stepIdx } = assignedSteps[i];
      const taskResult = lookupResults[i];
      if (!taskResult.ok) {
        this.logger.warn('PipelineHandler: failed to fetch step task', {
          taskId: tid,
          pipelineId: pipeline.id,
          error: taskResult.error.message,
        });
        return ok(undefined); // best-effort — skip this pipeline update
      }
      if (taskResult.value) {
        stepStatuses.push({ taskId: tid, status: taskResult.value.status, stepIndex: stepIdx });
      }
    }

    const statuses = stepStatuses.map((s) => s.status);

    // Aggregate: cancelled takes priority, then failed, then check completion
    const newStatus = this.aggregateStatus(statuses, taskIds.length);

    // Only update if status actually changed
    if (newStatus === pipeline.status) {
      return ok(undefined);
    }

    const now = Date.now();
    const updated: Pipeline = {
      ...pipeline,
      status: newStatus,
      updatedAt: now,
      completedAt:
        newStatus === PipelineStatus.COMPLETED ||
        newStatus === PipelineStatus.FAILED ||
        newStatus === PipelineStatus.CANCELLED
          ? now
          : pipeline.completedAt,
    };

    const saveResult = await this.pipelineRepository.update(updated);
    if (!saveResult.ok) {
      return saveResult;
    }

    // Emit PipelineStatusChanged for every status transition (including PENDING → RUNNING)
    await this.emitEvent(this.eventBus, 'PipelineStatusChanged', {
      pipelineId: pipeline.id,
      fromStatus: pipeline.status,
      toStatus: newStatus,
    });

    // Find the first failed/cancelled step for event payload
    const failedStep = stepStatuses.find((s) => s.status === 'failed' || s.status === 'cancelled');

    // Emit terminal pipeline lifecycle event (Completed / Failed / Cancelled)
    await this.emitPipelineEvent(updated, failedStep);

    this.logger.info('PipelineHandler: pipeline status updated', {
      pipelineId: pipeline.id,
      fromStatus: pipeline.status,
      toStatus: newStatus,
    });

    return ok(undefined);
  }

  /**
   * Determine the aggregate pipeline status from the statuses of its step tasks.
   * @param statuses - Array of task status strings for all assigned steps
   * @param totalSteps - Number of assigned (non-null) step tasks
   */
  private aggregateStatus(statuses: string[], totalSteps: number): PipelineStatus {
    if (statuses.some((s) => s === 'cancelled')) {
      return PipelineStatus.CANCELLED;
    }
    if (statuses.some((s) => s === 'failed')) {
      return PipelineStatus.FAILED;
    }
    if (statuses.length >= totalSteps && statuses.every((s) => s === 'completed')) {
      return PipelineStatus.COMPLETED;
    }
    return PipelineStatus.RUNNING;
  }

  /**
   * Emit the appropriate pipeline lifecycle event based on the new status.
   * @param failedStep - The first failed/cancelled step details (only used for PipelineFailed).
   */
  private async emitPipelineEvent(
    pipeline: Pipeline,
    failedStep?: { taskId: TaskId; status: string; stepIndex: number },
  ): Promise<void> {
    switch (pipeline.status) {
      case PipelineStatus.COMPLETED:
        await this.emitEvent(this.eventBus, 'PipelineCompleted', { pipelineId: pipeline.id });
        break;
      case PipelineStatus.FAILED: {
        await this.emitEvent(this.eventBus, 'PipelineFailed', {
          pipelineId: pipeline.id,
          failedStepIndex: failedStep?.stepIndex ?? 0,
          taskId: failedStep?.taskId ?? (pipeline.stepTaskIds[0] as TaskId) ?? ('' as TaskId),
        });
        break;
      }
      case PipelineStatus.CANCELLED:
        await this.emitEvent(this.eventBus, 'PipelineCancelled', { pipelineId: pipeline.id });
        break;
      default:
        // RUNNING / PENDING — no terminal event
        break;
    }
  }
}
