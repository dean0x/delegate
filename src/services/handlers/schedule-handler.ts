/**
 * Schedule handler for task scheduling management
 * ARCHITECTURE: Event-driven schedule lifecycle management
 * Pattern: Factory pattern for async initialization (matches DependencyHandler)
 * Rationale: Manages schedule creation, triggering, pausing, and execution tracking
 */

import type { Schedule, ScheduleId, Task } from '../../core/domain.js';
import { createTask, isTerminalState, ScheduleStatus, ScheduleType, TaskId, TaskStatus, updateSchedule } from '../../core/domain.js';
import { BackbeatError, ErrorCode } from '../../core/errors.js';
import { EventBus } from '../../core/events/event-bus.js';
import {
  ScheduleCancelledEvent,
  ScheduleCreatedEvent,
  SchedulePausedEvent,
  ScheduleQueryEvent,
  ScheduleResumedEvent,
  ScheduleTriggeredEvent,
  ScheduleUpdatedEvent,
} from '../../core/events/events.js';
import { BaseEventHandler } from '../../core/events/handlers.js';
import { Logger, ScheduleRepository, TaskRepository } from '../../core/interfaces.js';
import { err, ok, Result } from '../../core/result.js';
import { getNextRunTime, isValidTimezone, validateCronExpression } from '../../utils/cron.js';

/**
 * Options for ScheduleHandler configuration
 */
export interface ScheduleHandlerOptions {
  /** Default timezone for schedules without explicit timezone. Default: 'UTC' */
  readonly defaultTimezone?: string;
}

export class ScheduleHandler extends BaseEventHandler {
  private readonly defaultTimezone: string;

  /**
   * Private constructor - use ScheduleHandler.create() instead
   * ARCHITECTURE: Factory pattern ensures handler is fully initialized before use
   */
  private constructor(
    private readonly scheduleRepo: ScheduleRepository,
    private readonly taskRepo: TaskRepository,
    private readonly eventBus: EventBus,
    logger: Logger,
    options?: ScheduleHandlerOptions,
  ) {
    super(logger, 'ScheduleHandler');
    this.defaultTimezone = options?.defaultTimezone ?? 'UTC';
  }

  /**
   * Factory method to create a fully initialized ScheduleHandler
   * ARCHITECTURE: Guarantees handler is ready to use - no uninitialized state possible
   *
   * @param scheduleRepo - Repository for schedule persistence
   * @param taskRepo - Repository for task creation when schedule triggers
   * @param eventBus - Event bus for subscriptions
   * @param logger - Logger instance
   * @param options - Optional configuration
   * @returns Result containing initialized handler or error
   */
  static async create(
    scheduleRepo: ScheduleRepository,
    taskRepo: TaskRepository,
    eventBus: EventBus,
    logger: Logger,
    options?: ScheduleHandlerOptions,
  ): Promise<Result<ScheduleHandler, BackbeatError>> {
    const handlerLogger = logger.child ? logger.child({ module: 'ScheduleHandler' }) : logger;

    // Create handler
    const handler = new ScheduleHandler(scheduleRepo, taskRepo, eventBus, handlerLogger, options);

    // Subscribe to events
    const subscribeResult = handler.subscribeToEvents();
    if (!subscribeResult.ok) {
      return subscribeResult;
    }

    handlerLogger.info('ScheduleHandler initialized', {
      defaultTimezone: handler.defaultTimezone,
    });

    return ok(handler);
  }

  /**
   * Subscribe to all relevant events
   * ARCHITECTURE: Called by factory after initialization
   */
  private subscribeToEvents(): Result<void, BackbeatError> {
    const subscriptions = [
      // Schedule lifecycle events
      this.eventBus.subscribe('ScheduleCreated', this.handleScheduleCreated.bind(this)),
      this.eventBus.subscribe('ScheduleTriggered', this.handleScheduleTriggered.bind(this)),
      this.eventBus.subscribe('ScheduleCancelled', this.handleScheduleCancelled.bind(this)),
      this.eventBus.subscribe('SchedulePaused', this.handleSchedulePaused.bind(this)),
      this.eventBus.subscribe('ScheduleResumed', this.handleScheduleResumed.bind(this)),
      this.eventBus.subscribe('ScheduleUpdated', this.handleScheduleUpdated.bind(this)),
      // Query events
      this.eventBus.subscribe('ScheduleQuery', this.handleScheduleQuery.bind(this)),
    ];

    // Check if any subscription failed
    for (const result of subscriptions) {
      if (!result.ok) {
        return err(
          new BackbeatError(ErrorCode.SYSTEM_ERROR, `Failed to subscribe to events: ${result.error.message}`, {
            error: result.error,
          }),
        );
      }
    }

    return ok(undefined);
  }

  // ============================================================================
  // SCHEDULE LIFECYCLE EVENT HANDLERS
  // ============================================================================

  /**
   * Handle schedule creation - validate, calculate nextRunAt, persist
   */
  private async handleScheduleCreated(event: ScheduleCreatedEvent): Promise<void> {
    await this.handleEvent(event, async (e) => {
      const schedule = e.schedule;

      this.logger.info('Processing new schedule', {
        scheduleId: schedule.id,
        type: schedule.scheduleType,
        timezone: schedule.timezone,
      });

      // Validate timezone
      if (!isValidTimezone(schedule.timezone)) {
        this.logger.error('Invalid timezone for schedule', undefined, {
          scheduleId: schedule.id,
          timezone: schedule.timezone,
        });
        return err(
          new BackbeatError(ErrorCode.INVALID_INPUT, `Invalid timezone: ${schedule.timezone}`, {
            scheduleId: schedule.id,
            timezone: schedule.timezone,
          }),
        );
      }

      // Validate and calculate nextRunAt based on schedule type
      let nextRunAt: number | undefined;

      if (schedule.scheduleType === ScheduleType.CRON) {
        // Validate cron expression
        if (!schedule.cronExpression) {
          return err(
            new BackbeatError(ErrorCode.INVALID_INPUT, 'CRON schedule requires cronExpression', {
              scheduleId: schedule.id,
            }),
          );
        }

        const cronValidation = validateCronExpression(schedule.cronExpression);
        if (!cronValidation.ok) {
          this.logger.error('Invalid cron expression', cronValidation.error, {
            scheduleId: schedule.id,
            cronExpression: schedule.cronExpression,
          });
          return cronValidation;
        }

        // Calculate first run time
        const nextResult = getNextRunTime(schedule.cronExpression, schedule.timezone);
        if (!nextResult.ok) {
          return nextResult;
        }
        nextRunAt = nextResult.value;
      } else if (schedule.scheduleType === ScheduleType.ONE_TIME) {
        // ONE_TIME uses scheduledAt directly
        if (!schedule.scheduledAt) {
          return err(
            new BackbeatError(ErrorCode.INVALID_INPUT, 'ONE_TIME schedule requires scheduledAt timestamp', {
              scheduleId: schedule.id,
            }),
          );
        }
        nextRunAt = schedule.scheduledAt;
      } else {
        const _exhaustive: never = schedule.scheduleType;
        return err(
          new BackbeatError(ErrorCode.INVALID_INPUT, `Unknown schedule type: ${schedule.scheduleType}`, {
            scheduleId: schedule.id,
          }),
        );
      }

      // Update schedule with calculated nextRunAt and save
      const updatedSchedule = updateSchedule(schedule, { nextRunAt });
      const saveResult = await this.scheduleRepo.save(updatedSchedule);
      if (!saveResult.ok) {
        this.logger.error('Failed to save schedule', saveResult.error, {
          scheduleId: schedule.id,
        });
        return saveResult;
      }

      this.logger.info('Schedule created and persisted', {
        scheduleId: schedule.id,
        nextRunAt,
        nextRunAtDate: nextRunAt ? new Date(nextRunAt).toISOString() : 'none',
      });

      return ok(undefined);
    });
  }

  /**
   * Handle schedule trigger - dispatch to single-task or pipeline path
   */
  private async handleScheduleTriggered(event: ScheduleTriggeredEvent): Promise<void> {
    await this.handleEvent(event, async (e) => {
      const { scheduleId, triggeredAt } = e;

      this.logger.info('Processing schedule trigger', {
        scheduleId,
        triggeredAt,
        triggeredAtDate: new Date(triggeredAt).toISOString(),
      });

      // Fetch schedule
      const scheduleResult = await this.scheduleRepo.findById(scheduleId);
      if (!scheduleResult.ok) {
        return scheduleResult;
      }

      const schedule = scheduleResult.value;
      if (!schedule) {
        return err(new BackbeatError(ErrorCode.TASK_NOT_FOUND, `Schedule ${scheduleId} not found`, { scheduleId }));
      }

      // Check if schedule is still active
      if (schedule.status !== ScheduleStatus.ACTIVE) {
        this.logger.warn('Schedule is not active, skipping trigger', {
          scheduleId,
          status: schedule.status,
        });
        return ok(undefined);
      }

      // Dispatch to appropriate trigger path
      if (schedule.pipelineSteps && schedule.pipelineSteps.length > 0) {
        return this.handlePipelineTrigger(schedule, triggeredAt);
      }
      return this.handleSingleTaskTrigger(schedule, triggeredAt);
    });
  }

  /**
   * Handle single-task trigger - existing logic extracted verbatim
   */
  private async handleSingleTaskTrigger(schedule: Schedule, triggeredAt: number): Promise<Result<void>> {
    const scheduleId = schedule.id;

    // afterScheduleId enforcement: inject dependency on chained schedule's latest task
    const taskTemplate = await this.resolveAfterScheduleDependency(schedule);

    // Create task from template
    const task = createTask(taskTemplate);
    const taskSaveResult = await this.taskRepo.save(task);
    if (!taskSaveResult.ok) {
      await this.recordFailedExecution(scheduleId, schedule.nextRunAt ?? triggeredAt, triggeredAt, taskSaveResult.error.message);
      return taskSaveResult;
    }

    // Record successful execution
    await this.recordTriggeredExecution(scheduleId, task.id, schedule.nextRunAt ?? triggeredAt, triggeredAt);

    // Update schedule state
    const updateResult = await this.updateScheduleAfterTrigger(schedule, triggeredAt);
    if (!updateResult.ok) return updateResult;

    // Emit TaskDelegated event for the created task
    await this.eventBus.emit('TaskDelegated', { task });

    // Emit ScheduleExecuted with the task ID (for concurrency tracking)
    await this.eventBus.emit('ScheduleExecuted', {
      scheduleId,
      taskId: task.id,
      executedAt: triggeredAt,
    });

    this.logger.info('Schedule triggered successfully', {
      scheduleId,
      taskId: task.id,
      runCount: schedule.runCount + 1,
    });

    return ok(undefined);
  }

  /**
   * Handle pipeline trigger - create N tasks with linear dependencies
   */
  private async handlePipelineTrigger(schedule: Schedule, triggeredAt: number): Promise<Result<void>> {
    const scheduleId = schedule.id;
    const steps = schedule.pipelineSteps!;
    const defaults = schedule.taskTemplate;

    this.logger.info('Processing pipeline trigger', {
      scheduleId,
      stepCount: steps.length,
    });

    // afterScheduleId handling: resolve predecessor dependency for step 0
    let step0DependsOn: TaskId[] | undefined;
    if (schedule.afterScheduleId) {
      const historyResult = await this.scheduleRepo.getExecutionHistory(schedule.afterScheduleId, 1);
      if (historyResult.ok && historyResult.value.length > 0) {
        const latestExecution = historyResult.value[0];
        if (latestExecution.taskId) {
          const depTaskResult = await this.taskRepo.findById(latestExecution.taskId);
          if (depTaskResult.ok && depTaskResult.value && !isTerminalState(depTaskResult.value.status)) {
            step0DependsOn = [latestExecution.taskId];
            this.logger.info('Injected afterSchedule dependency on pipeline step 0', {
              scheduleId,
              afterScheduleId: schedule.afterScheduleId,
              dependsOnTaskId: latestExecution.taskId,
            });
          }
        }
      }
    }

    // Create tasks for each step with linear dependencies
    const savedTasks: Task[] = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const dependsOn: TaskId[] = [];

      // Step 0 gets afterScheduleId dependency if present
      if (i === 0 && step0DependsOn) {
        dependsOn.push(...step0DependsOn);
      }

      // Step i depends on step i-1
      if (i > 0) {
        dependsOn.push(savedTasks[i - 1].id);
      }

      const task = createTask({
        prompt: step.prompt,
        priority: step.priority ?? defaults.priority,
        workingDirectory: step.workingDirectory ?? defaults.workingDirectory,
        agent: step.agent ?? defaults.agent,
        dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
      });

      const saveResult = await this.taskRepo.save(task);
      if (!saveResult.ok) {
        // Partial save failure: cancel already-saved tasks directly via DB
        this.logger.error('Pipeline task save failed, cleaning up', saveResult.error, {
          scheduleId,
          failedStep: i,
          savedSteps: savedTasks.length,
        });

        for (const savedTask of savedTasks) {
          const cancelResult = await this.taskRepo.update(savedTask.id, { status: TaskStatus.CANCELLED });
          if (!cancelResult.ok) {
            this.logger.error('Failed to cancel pipeline task during cleanup', cancelResult.error, {
              taskId: savedTask.id,
            });
          }
        }

        await this.recordFailedExecution(
          scheduleId,
          schedule.nextRunAt ?? triggeredAt,
          triggeredAt,
          `Pipeline failed at step ${i + 1}: ${saveResult.error.message}`,
        );
        return saveResult;
      }

      savedTasks.push(task);
    }

    const allTaskIds = savedTasks.map((t) => t.id);
    const firstTaskId = savedTasks[0].id;
    const lastTaskId = savedTasks[savedTasks.length - 1].id;

    // Record execution with all pipeline task IDs
    await this.recordTriggeredExecution(
      scheduleId,
      firstTaskId,
      schedule.nextRunAt ?? triggeredAt,
      triggeredAt,
      allTaskIds,
    );

    // Update schedule state
    const updateResult = await this.updateScheduleAfterTrigger(schedule, triggeredAt);
    if (!updateResult.ok) return updateResult;

    // Emit TaskDelegated for each task (best-effort)
    for (const task of savedTasks) {
      const emitResult = await this.eventBus.emit('TaskDelegated', { task });
      if (!emitResult.ok) {
        this.logger.error('Failed to emit TaskDelegated for pipeline task', emitResult.error, {
          taskId: task.id,
          scheduleId,
        });
        // Best-effort: continue with remaining tasks
      }
    }

    // Emit ScheduleExecuted with lastTaskId (tail task for concurrency tracking)
    await this.eventBus.emit('ScheduleExecuted', {
      scheduleId,
      taskId: lastTaskId,
      executedAt: triggeredAt,
    });

    this.logger.info('Pipeline triggered successfully', {
      scheduleId,
      stepCount: steps.length,
      firstTaskId,
      lastTaskId,
      runCount: schedule.runCount + 1,
    });

    return ok(undefined);
  }

  // ============================================================================
  // SHARED HELPERS (extracted from handleScheduleTriggered decomposition)
  // ============================================================================

  /**
   * Resolve afterScheduleId dependency and return (possibly modified) task template
   */
  private async resolveAfterScheduleDependency(schedule: Schedule): Promise<typeof schedule.taskTemplate> {
    if (!schedule.afterScheduleId) return schedule.taskTemplate;

    const historyResult = await this.scheduleRepo.getExecutionHistory(schedule.afterScheduleId, 1);
    if (!historyResult.ok || historyResult.value.length === 0) return schedule.taskTemplate;

    const latestExecution = historyResult.value[0];
    if (!latestExecution.taskId) return schedule.taskTemplate;

    const depTaskResult = await this.taskRepo.findById(latestExecution.taskId);
    if (!depTaskResult.ok || !depTaskResult.value || isTerminalState(depTaskResult.value.status)) {
      this.logger.info('afterSchedule dependency already resolved, skipping', {
        scheduleId: schedule.id,
        afterScheduleId: schedule.afterScheduleId,
        taskId: latestExecution.taskId,
        taskStatus: depTaskResult.ok ? (depTaskResult.value?.status ?? 'not-found') : 'lookup-failed',
      });
      return schedule.taskTemplate;
    }

    this.logger.info('Injected afterSchedule dependency', {
      scheduleId: schedule.id,
      afterScheduleId: schedule.afterScheduleId,
      dependsOnTaskId: latestExecution.taskId,
    });

    return {
      ...schedule.taskTemplate,
      dependsOn: [...(schedule.taskTemplate.dependsOn ?? []), latestExecution.taskId],
    };
  }

  /**
   * Record a failed execution in the audit trail
   */
  private async recordFailedExecution(
    scheduleId: ScheduleId,
    scheduledFor: number,
    triggeredAt: number,
    errorMessage: string,
  ): Promise<void> {
    const result = await this.scheduleRepo.recordExecution({
      scheduleId,
      scheduledFor,
      executedAt: triggeredAt,
      status: 'failed',
      errorMessage: `Failed to create task: ${errorMessage}`,
      createdAt: Date.now(),
    });
    if (!result.ok) {
      this.logger.error('Failed to record failed execution', result.error, { scheduleId });
    }
  }

  /**
   * Record a triggered execution in the audit trail
   */
  private async recordTriggeredExecution(
    scheduleId: ScheduleId,
    taskId: TaskId,
    scheduledFor: number,
    triggeredAt: number,
    pipelineTaskIds?: readonly TaskId[],
  ): Promise<void> {
    const result = await this.scheduleRepo.recordExecution({
      scheduleId,
      taskId,
      scheduledFor,
      executedAt: triggeredAt,
      status: 'triggered',
      pipelineTaskIds,
      createdAt: Date.now(),
    });
    if (!result.ok) {
      this.logger.error('Failed to record triggered execution', result.error, { scheduleId });
    }
  }

  /**
   * Update schedule state after a trigger (runCount, lastRunAt, nextRunAt, status)
   */
  private async updateScheduleAfterTrigger(schedule: Schedule, triggeredAt: number): Promise<Result<void>> {
    const scheduleId = schedule.id;
    const newRunCount = schedule.runCount + 1;

    let newStatus: ScheduleStatus | undefined;
    let newNextRunAt: number | undefined;

    // Calculate next run time for CRON schedules
    if (schedule.scheduleType === ScheduleType.CRON && schedule.cronExpression) {
      const nextResult = getNextRunTime(schedule.cronExpression, schedule.timezone);
      if (nextResult.ok) {
        newNextRunAt = nextResult.value;
      } else {
        this.logger.error('Failed to calculate next run, pausing schedule', nextResult.error, {
          scheduleId,
          cronExpression: schedule.cronExpression,
        });
        newStatus = ScheduleStatus.PAUSED;
      }
    } else if (schedule.scheduleType === ScheduleType.ONE_TIME) {
      newStatus = ScheduleStatus.COMPLETED;
      newNextRunAt = undefined;
    }

    // Check if maxRuns reached
    if (schedule.maxRuns && newRunCount >= schedule.maxRuns) {
      newStatus = ScheduleStatus.COMPLETED;
      newNextRunAt = undefined;
      this.logger.info('Schedule reached maxRuns, marking completed', {
        scheduleId,
        runCount: newRunCount,
        maxRuns: schedule.maxRuns,
      });
    }

    // Check expiration
    if (schedule.expiresAt && Date.now() >= schedule.expiresAt) {
      newStatus = ScheduleStatus.EXPIRED;
      newNextRunAt = undefined;
      this.logger.info('Schedule expired', { scheduleId, expiresAt: schedule.expiresAt });
    }

    const updates: Partial<Schedule> = {
      runCount: newRunCount,
      lastRunAt: triggeredAt,
      nextRunAt: newNextRunAt,
      ...(newStatus !== undefined ? { status: newStatus } : {}),
    };

    const updateResult = await this.scheduleRepo.update(scheduleId, updates);
    if (!updateResult.ok) {
      this.logger.error('Failed to update schedule after trigger', updateResult.error, {
        scheduleId,
      });
      return updateResult;
    }

    return ok(undefined);
  }

  /**
   * Handle schedule cancellation - update status to CANCELLED
   */
  private async handleScheduleCancelled(event: ScheduleCancelledEvent): Promise<void> {
    await this.handleEvent(event, async (e) => {
      const { scheduleId, reason } = e;

      this.logger.info('Cancelling schedule', { scheduleId, reason });

      const updateResult = await this.scheduleRepo.update(scheduleId, {
        status: ScheduleStatus.CANCELLED,
        nextRunAt: undefined,
      });

      if (!updateResult.ok) {
        this.logger.error('Failed to cancel schedule', updateResult.error, { scheduleId });
        return updateResult;
      }

      this.logger.info('Schedule cancelled', { scheduleId, reason });
      return ok(undefined);
    });
  }

  /**
   * Handle schedule pause - update status to PAUSED
   */
  private async handleSchedulePaused(event: SchedulePausedEvent): Promise<void> {
    await this.handleEvent(event, async (e) => {
      const { scheduleId } = e;

      this.logger.info('Pausing schedule', { scheduleId });

      const updateResult = await this.scheduleRepo.update(scheduleId, {
        status: ScheduleStatus.PAUSED,
      });

      if (!updateResult.ok) {
        this.logger.error('Failed to pause schedule', updateResult.error, { scheduleId });
        return updateResult;
      }

      this.logger.info('Schedule paused', { scheduleId });
      return ok(undefined);
    });
  }

  /**
   * Handle schedule resume - update status to ACTIVE, recalculate nextRunAt
   */
  private async handleScheduleResumed(event: ScheduleResumedEvent): Promise<void> {
    await this.handleEvent(event, async (e) => {
      const { scheduleId } = e;

      this.logger.info('Resuming schedule', { scheduleId });

      // Fetch current schedule to recalculate nextRunAt
      const scheduleResult = await this.scheduleRepo.findById(scheduleId);
      if (!scheduleResult.ok) {
        return scheduleResult;
      }

      const schedule = scheduleResult.value;
      if (!schedule) {
        return err(new BackbeatError(ErrorCode.TASK_NOT_FOUND, `Schedule ${scheduleId} not found`, { scheduleId }));
      }

      // Recalculate nextRunAt for CRON schedules
      let nextRunAt = schedule.nextRunAt;
      if (schedule.scheduleType === ScheduleType.CRON && schedule.cronExpression) {
        const nextResult = getNextRunTime(schedule.cronExpression, schedule.timezone);
        if (nextResult.ok) {
          nextRunAt = nextResult.value;
        }
      }

      const updateResult = await this.scheduleRepo.update(scheduleId, {
        status: ScheduleStatus.ACTIVE,
        nextRunAt,
      });

      if (!updateResult.ok) {
        this.logger.error('Failed to resume schedule', updateResult.error, { scheduleId });
        return updateResult;
      }

      this.logger.info('Schedule resumed', {
        scheduleId,
        nextRunAt,
        nextRunAtDate: nextRunAt ? new Date(nextRunAt).toISOString() : 'none',
      });
      return ok(undefined);
    });
  }

  /**
   * Handle schedule update - apply partial updates
   */
  private async handleScheduleUpdated(event: ScheduleUpdatedEvent): Promise<void> {
    await this.handleEvent(event, async (e) => {
      const { scheduleId, update } = e;

      this.logger.info('Updating schedule', { scheduleId, updateFields: Object.keys(update) });

      const updateResult = await this.scheduleRepo.update(scheduleId, update);

      if (!updateResult.ok) {
        this.logger.error('Failed to update schedule', updateResult.error, { scheduleId });
        return updateResult;
      }

      this.logger.info('Schedule updated', { scheduleId });
      return ok(undefined);
    });
  }

  // ============================================================================
  // QUERY EVENT HANDLERS
  // ============================================================================

  /**
   * Handle schedule query - respond with schedule(s)
   */
  private async handleScheduleQuery(event: ScheduleQueryEvent): Promise<void> {
    await this.handleEvent(event, async (e) => {
      const { scheduleId, status } = e;
      const correlationId = (e as unknown as { __correlationId?: string }).__correlationId;

      this.logger.debug('Processing schedule query', { scheduleId, status, correlationId });

      let schedules: readonly Schedule[];

      if (scheduleId) {
        const result = await this.scheduleRepo.findById(scheduleId);
        if (!result.ok) {
          this.respondWithError(correlationId, result.error);
          return result;
        }
        schedules = result.value ? [result.value] : [];
      } else if (status) {
        const result = await this.scheduleRepo.findByStatus(status);
        if (!result.ok) {
          this.respondWithError(correlationId, result.error);
          return result;
        }
        schedules = result.value;
      } else {
        const result = await this.scheduleRepo.findAll();
        if (!result.ok) {
          this.respondWithError(correlationId, result.error);
          return result;
        }
        schedules = result.value;
      }

      // Respond to request-reply if correlation ID present
      if (correlationId) {
        (this.eventBus as { respond?: <T>(id: string, value: T) => void }).respond?.(correlationId, schedules);
      }

      // Also emit response event for pub/sub consumers
      await this.eventBus.emit('ScheduleQueryResponse', { schedules });

      return ok(undefined);
    });
  }

  /**
   * Send error response via request-reply correlation if available
   */
  private respondWithError(correlationId: string | undefined, error: Error): void {
    if (correlationId) {
      (this.eventBus as { respondError?: (id: string, err: Error) => void }).respondError?.(correlationId, error);
    }
  }
}
