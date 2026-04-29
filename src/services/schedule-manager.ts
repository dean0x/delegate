/**
 * Schedule management service
 * ARCHITECTURE: Extracted from MCP adapter for CLI reuse
 * Pattern: Service layer with DI, Result types, event emission
 * Rationale: Enables schedule operations from MCP, CLI, or any future adapter
 */

import { resolveDefaultAgent } from '../core/agents.js';
import { Configuration } from '../core/configuration.js';
import {
  createPipeline,
  createSchedule,
  EvalMode,
  PipelineCreateRequest,
  PipelineResult,
  PipelineStep,
  Priority,
  Schedule,
  ScheduleCreateRequest,
  ScheduledLoopCreateRequest,
  ScheduledPipelineCreateRequest,
  ScheduleId,
  ScheduleStatus,
  ScheduleType,
  TaskId,
} from '../core/domain.js';
import { AutobeatError, ErrorCode } from '../core/errors.js';
import { EventBus } from '../core/events/event-bus.js';
import {
  Logger,
  PipelineRepository,
  ScheduleExecution,
  ScheduleRepository,
  ScheduleService,
} from '../core/interfaces.js';
import { err, ok, Result } from '../core/result.js';
import { getNextRunTime, isValidTimezone, validateCronExpression } from '../utils/cron.js';
import { toMissedRunPolicy, truncatePrompt } from '../utils/format.js';
import { validatePath } from '../utils/validation.js';

export class ScheduleManagerService implements ScheduleService {
  constructor(
    private readonly eventBus: EventBus,
    private readonly logger: Logger,
    private readonly scheduleRepository: ScheduleRepository,
    private readonly config: Configuration,
    private readonly pipelineRepository?: PipelineRepository,
  ) {
    this.logger.debug('ScheduleManagerService initialized');
  }

  async createSchedule(request: ScheduleCreateRequest): Promise<Result<Schedule>> {
    const timingResult = this.validateScheduleTiming(request);
    if (!timingResult.ok) return timingResult;
    const { scheduledAtMs, expiresAtMs, nextRunAt, timezone } = timingResult.value;

    // Validate workingDirectory
    let validatedWorkingDirectory: string | undefined;
    if (request.workingDirectory) {
      const pathValidation = validatePath(request.workingDirectory);
      if (!pathValidation.ok) {
        return err(
          new AutobeatError(ErrorCode.INVALID_DIRECTORY, `Invalid working directory: ${pathValidation.error.message}`, {
            workingDirectory: request.workingDirectory,
          }),
        );
      }
      validatedWorkingDirectory = pathValidation.value;
    }

    // Resolve agent (same pattern as TaskManager.delegate)
    const agentResult = resolveDefaultAgent(request.agent, this.config.defaultAgent);
    if (!agentResult.ok) return agentResult;

    // Create schedule via domain factory
    const schedule = createSchedule({
      taskTemplate: {
        prompt: request.prompt,
        priority: request.priority,
        workingDirectory: validatedWorkingDirectory,
        agent: agentResult.value,
        model: request.model,
        systemPrompt: request.systemPrompt,
      },
      scheduleType: request.scheduleType,
      cronExpression: request.cronExpression,
      scheduledAt: scheduledAtMs,
      timezone,
      missedRunPolicy: toMissedRunPolicy(request.missedRunPolicy),
      maxRuns: request.maxRuns,
      expiresAt: expiresAtMs,
      afterScheduleId: request.afterScheduleId,
      nextRunAt,
    });

    this.logger.info('Creating schedule', {
      scheduleId: schedule.id,
      scheduleType: schedule.scheduleType,
      nextRunAt: new Date(nextRunAt).toISOString(),
    });

    // Emit event - ScheduleHandler persists
    const emitResult = await this.eventBus.emit('ScheduleCreated', { schedule });
    if (!emitResult.ok) {
      this.logger.error('Failed to emit ScheduleCreated event', emitResult.error, {
        scheduleId: schedule.id,
      });
      return err(emitResult.error);
    }

    return ok(schedule);
  }

  async listSchedules(status?: ScheduleStatus, limit?: number, offset?: number): Promise<Result<readonly Schedule[]>> {
    if (status) {
      return this.scheduleRepository.findByStatus(status, limit, offset);
    }
    return this.scheduleRepository.findAll(limit, offset);
  }

  async getSchedule(
    scheduleId: ScheduleId,
    includeHistory?: boolean,
    historyLimit?: number,
  ): Promise<Result<{ schedule: Schedule; history?: readonly ScheduleExecution[] }>> {
    const lookupResult = await this.fetchScheduleOrError(scheduleId);
    if (!lookupResult.ok) {
      return lookupResult;
    }

    const schedule = lookupResult.value;
    let history: readonly ScheduleExecution[] | undefined;

    if (includeHistory) {
      const historyResult = await this.scheduleRepository.getExecutionHistory(scheduleId, historyLimit);
      if (historyResult.ok) {
        history = historyResult.value;
      } else {
        // Non-fatal: log warning but still return schedule data
        this.logger.warn('Failed to fetch execution history', {
          scheduleId,
          error: historyResult.error.message,
        });
      }
    }

    return ok({ schedule, history });
  }

  async cancelSchedule(scheduleId: ScheduleId, reason?: string, cancelTasks?: boolean): Promise<Result<void>> {
    const lookupResult = await this.fetchScheduleOrError(scheduleId);
    if (!lookupResult.ok) {
      return lookupResult;
    }

    this.logger.info('Cancelling schedule', { scheduleId, reason, cancelTasks });

    const emitResult = await this.eventBus.emit('ScheduleCancelled', {
      scheduleId,
      reason,
    });

    if (!emitResult.ok) {
      this.logger.error('Failed to emit ScheduleCancelled event', emitResult.error, {
        scheduleId,
      });
      return err(emitResult.error);
    }

    // Optionally cancel in-flight tasks from all active executions
    if (cancelTasks) {
      const historyResult = await this.scheduleRepository.getExecutionHistory(scheduleId);
      if (historyResult.ok) {
        const activeExecutions = historyResult.value.filter((e) => e.status === 'triggered');
        const allTaskIds: TaskId[] = activeExecutions.flatMap(
          (execution) => execution.pipelineTaskIds ?? (execution.taskId ? [execution.taskId] : []),
        );
        for (const taskId of allTaskIds) {
          const cancelResult = await this.eventBus.emit('TaskCancellationRequested', {
            taskId,
            reason: `Schedule ${scheduleId} cancelled`,
          });
          if (!cancelResult.ok) {
            this.logger.warn('Failed to cancel pipeline task', {
              taskId,
              scheduleId,
              error: cancelResult.error.message,
            });
          }
        }
        this.logger.info('Cancelled in-flight tasks from active schedule executions', {
          scheduleId,
          taskCount: allTaskIds.length,
          activeExecutions: activeExecutions.length,
        });
      }
    }

    return ok(undefined);
  }

  async pauseSchedule(scheduleId: ScheduleId): Promise<Result<void>> {
    const lookupResult = await this.fetchScheduleOrError(scheduleId, ScheduleStatus.ACTIVE);
    if (!lookupResult.ok) {
      return lookupResult;
    }

    this.logger.info('Pausing schedule', { scheduleId });

    const emitResult = await this.eventBus.emit('SchedulePaused', { scheduleId });
    if (!emitResult.ok) {
      this.logger.error('Failed to emit SchedulePaused event', emitResult.error, {
        scheduleId,
      });
      return err(emitResult.error);
    }

    return ok(undefined);
  }

  async resumeSchedule(scheduleId: ScheduleId): Promise<Result<void>> {
    const lookupResult = await this.fetchScheduleOrError(scheduleId, ScheduleStatus.PAUSED);
    if (!lookupResult.ok) {
      return lookupResult;
    }

    this.logger.info('Resuming schedule', { scheduleId });

    const emitResult = await this.eventBus.emit('ScheduleResumed', { scheduleId });
    if (!emitResult.ok) {
      this.logger.error('Failed to emit ScheduleResumed event', emitResult.error, {
        scheduleId,
      });
      return err(emitResult.error);
    }

    return ok(undefined);
  }

  async createScheduledPipeline(request: ScheduledPipelineCreateRequest): Promise<Result<Schedule>> {
    const { steps } = request;

    if (steps.length < 2) {
      return err(
        new AutobeatError(ErrorCode.INVALID_INPUT, 'Pipeline requires at least 2 steps', {
          stepCount: steps.length,
        }),
      );
    }

    if (steps.length > 20) {
      return err(
        new AutobeatError(ErrorCode.INVALID_INPUT, 'Pipeline cannot exceed 20 steps', {
          stepCount: steps.length,
        }),
      );
    }

    const timingResult = this.validateScheduleTiming(request);
    if (!timingResult.ok) return timingResult;
    const { scheduledAtMs, expiresAtMs, nextRunAt, timezone } = timingResult.value;

    // Validate shared workingDirectory
    let validatedWorkingDirectory: string | undefined;
    if (request.workingDirectory) {
      const pathValidation = validatePath(request.workingDirectory);
      if (!pathValidation.ok) {
        return err(
          new AutobeatError(ErrorCode.INVALID_DIRECTORY, `Invalid working directory: ${pathValidation.error.message}`, {
            workingDirectory: request.workingDirectory,
          }),
        );
      }
      validatedWorkingDirectory = pathValidation.value;
    }

    // Validate per-step workingDirectory and build normalized steps
    const normalizedSteps = [...steps];
    for (let i = 0; i < normalizedSteps.length; i++) {
      const step = normalizedSteps[i];
      if (step.workingDirectory) {
        const pathValidation = validatePath(step.workingDirectory);
        if (!pathValidation.ok) {
          return err(
            new AutobeatError(
              ErrorCode.INVALID_DIRECTORY,
              `Invalid working directory for step ${i + 1}: ${pathValidation.error.message}`,
              { step: i + 1, workingDirectory: step.workingDirectory },
            ),
          );
        }
        normalizedSteps[i] = { ...step, workingDirectory: pathValidation.value };
      }
    }

    // Resolve shared agent
    const agentResult = resolveDefaultAgent(request.agent, this.config.defaultAgent);
    if (!agentResult.ok) return agentResult;

    // Build synthetic prompt for display/taskTemplate
    const stepSummary = normalizedSteps.map((s, i) => `Step ${i + 1}: ${truncatePrompt(s.prompt, 40)}`).join(' → ');
    const syntheticPrompt = `Pipeline (${normalizedSteps.length} steps): ${stepSummary}`;

    // Create schedule with pipelineSteps (using normalized paths)
    const schedule = createSchedule({
      taskTemplate: {
        prompt: syntheticPrompt,
        priority: request.priority,
        workingDirectory: validatedWorkingDirectory,
        agent: agentResult.value,
        model: request.model,
        systemPrompt: request.systemPrompt,
      },
      pipelineSteps: normalizedSteps,
      scheduleType: request.scheduleType,
      cronExpression: request.cronExpression,
      scheduledAt: scheduledAtMs,
      timezone,
      missedRunPolicy: toMissedRunPolicy(request.missedRunPolicy),
      maxRuns: request.maxRuns,
      expiresAt: expiresAtMs,
      afterScheduleId: request.afterScheduleId,
      nextRunAt,
    });

    this.logger.info('Creating scheduled pipeline', {
      scheduleId: schedule.id,
      scheduleType: schedule.scheduleType,
      stepCount: steps.length,
      nextRunAt: new Date(nextRunAt).toISOString(),
    });

    // Emit event — ScheduleHandler persists
    const emitResult = await this.eventBus.emit('ScheduleCreated', { schedule });
    if (!emitResult.ok) {
      this.logger.error('Failed to emit ScheduleCreated event', emitResult.error, {
        scheduleId: schedule.id,
      });
      return err(emitResult.error);
    }

    return ok(schedule);
  }

  async createPipeline(request: PipelineCreateRequest): Promise<Result<PipelineResult>> {
    const { steps } = request;

    if (steps.length < 2) {
      return err(
        new AutobeatError(ErrorCode.INVALID_INPUT, 'Pipeline requires at least 2 steps', {
          stepCount: steps.length,
        }),
      );
    }

    if (steps.length > 20) {
      return err(
        new AutobeatError(ErrorCode.INVALID_INPUT, 'Pipeline cannot exceed 20 steps', {
          stepCount: steps.length,
        }),
      );
    }

    // +2s buffer so "now" doesn't become "past" during validation
    const scheduledAt = new Date(Date.now() + 2000).toISOString();
    const createdSteps: PipelineStep[] = [];
    let previousScheduleId: ScheduleId | undefined;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const result = await this.createSchedule({
        prompt: step.prompt,
        scheduleType: ScheduleType.ONE_TIME,
        scheduledAt,
        priority: step.priority ?? request.priority,
        workingDirectory: step.workingDirectory ?? request.workingDirectory,
        afterScheduleId: previousScheduleId,
        agent: step.agent ?? request.agent,
        model: step.model ?? request.model,
        systemPrompt: step.systemPrompt ?? request.systemPrompt,
      });

      if (!result.ok) {
        return err(
          new AutobeatError(ErrorCode.SYSTEM_ERROR, `Pipeline failed at step ${i + 1}: ${result.error.message}`, {
            failedAtStep: i + 1,
            createdSteps,
          }),
        );
      }

      previousScheduleId = result.value.id;
      createdSteps.push({
        index: i,
        scheduleId: result.value.id,
        prompt: truncatePrompt(step.prompt, 50),
      });
    }

    // Persist Pipeline entity for first-class tracking (Phase A)
    // DECISION: Pipeline entity created after all schedule steps succeed; stepTaskIds start as null (tasks not yet dispatched).
    // scheduleId per step is stored so PipelineHandler can correlate TaskDelegated events → tasks → pipeline.
    const pipelineEntity = createPipeline({
      steps: steps.map((s, i) => ({
        index: i,
        prompt: s.prompt,
        priority: s.priority ?? request.priority,
        workingDirectory: s.workingDirectory ?? request.workingDirectory,
        agent: s.agent ?? request.agent,
        model: s.model ?? request.model,
        systemPrompt: s.systemPrompt ?? request.systemPrompt,
        scheduleId: createdSteps[i].scheduleId,
      })),
      priority: request.priority,
      workingDirectory: request.workingDirectory,
      agent: request.agent,
      model: request.model,
      systemPrompt: request.systemPrompt,
    });

    if (this.pipelineRepository) {
      const saveResult = await this.pipelineRepository.save(pipelineEntity);
      if (!saveResult.ok) {
        // Non-fatal: log and continue — schedules were created successfully
        this.logger.warn('Failed to persist Pipeline entity', {
          pipelineEntityId: pipelineEntity.id,
          error: saveResult.error.message,
        });
      } else {
        // Emit PipelineCreated so subscribers can track pipeline lifecycle
        const emitResult = await this.eventBus.emit('PipelineCreated', {
          pipelineId: pipelineEntity.id,
          steps: steps.length,
        });
        if (!emitResult.ok) {
          this.logger.warn('Failed to emit PipelineCreated event', {
            pipelineEntityId: pipelineEntity.id,
            error: emitResult.error.message,
          });
        }
      }
    }

    return ok({
      pipelineEntityId: pipelineEntity.id,
      pipelineId: createdSteps[0].scheduleId,
      steps: createdSteps,
    });
  }

  /**
   * Validate schedule timing fields shared between createSchedule and createScheduledPipeline
   * Returns parsed timestamps and computed nextRunAt
   */
  private validateScheduleTiming(
    request: Pick<ScheduleCreateRequest, 'scheduleType' | 'cronExpression' | 'scheduledAt' | 'expiresAt' | 'timezone'>,
  ): Result<{ scheduledAtMs?: number; expiresAtMs?: number; nextRunAt: number; timezone: string }> {
    // Validate schedule type requirements
    if (request.scheduleType === ScheduleType.CRON && !request.cronExpression) {
      return err(
        new AutobeatError(ErrorCode.INVALID_INPUT, 'cronExpression is required for cron schedules', {
          scheduleType: request.scheduleType,
        }),
      );
    }
    if (request.scheduleType === ScheduleType.ONE_TIME && !request.scheduledAt) {
      return err(
        new AutobeatError(ErrorCode.INVALID_INPUT, 'scheduledAt is required for one-time schedules', {
          scheduleType: request.scheduleType,
        }),
      );
    }

    // Validate cron expression
    if (request.cronExpression) {
      const cronResult = validateCronExpression(request.cronExpression);
      if (!cronResult.ok) return cronResult;
    }

    // Validate timezone
    const tz = request.timezone ?? 'UTC';
    if (!isValidTimezone(tz)) {
      return err(new AutobeatError(ErrorCode.INVALID_INPUT, `Invalid timezone: ${tz}`, { timezone: tz }));
    }

    // Parse scheduledAt
    let scheduledAtMs: number | undefined;
    if (request.scheduledAt) {
      scheduledAtMs = Date.parse(request.scheduledAt);
      if (isNaN(scheduledAtMs)) {
        return err(
          new AutobeatError(ErrorCode.INVALID_INPUT, `Invalid scheduledAt datetime: ${request.scheduledAt}`, {
            scheduledAt: request.scheduledAt,
          }),
        );
      }
      if (scheduledAtMs <= Date.now()) {
        return err(
          new AutobeatError(ErrorCode.INVALID_INPUT, 'scheduledAt must be in the future', {
            scheduledAt: request.scheduledAt,
          }),
        );
      }
    }

    // Parse expiresAt
    let expiresAtMs: number | undefined;
    if (request.expiresAt) {
      expiresAtMs = Date.parse(request.expiresAt);
      if (isNaN(expiresAtMs)) {
        return err(
          new AutobeatError(ErrorCode.INVALID_INPUT, `Invalid expiresAt datetime: ${request.expiresAt}`, {
            expiresAt: request.expiresAt,
          }),
        );
      }
    }

    // Calculate nextRunAt
    let nextRunAt: number;
    if (request.scheduleType === ScheduleType.CRON && request.cronExpression) {
      const nextResult = getNextRunTime(request.cronExpression, tz);
      if (!nextResult.ok) return nextResult;
      nextRunAt = nextResult.value;
    } else {
      if (scheduledAtMs === undefined) {
        return err(
          new AutobeatError(ErrorCode.INVALID_INPUT, 'scheduledAt must be provided for one-time schedules', {
            scheduleType: request.scheduleType,
          }),
        );
      }
      nextRunAt = scheduledAtMs;
    }

    return ok({ scheduledAtMs, expiresAtMs, nextRunAt, timezone: tz });
  }

  async createScheduledLoop(request: ScheduledLoopCreateRequest): Promise<Result<Schedule>> {
    // Validate timing (reuse shared method)
    const timingResult = this.validateScheduleTiming(request);
    if (!timingResult.ok) return timingResult;
    const { scheduledAtMs, expiresAtMs, nextRunAt, timezone } = timingResult.value;

    // Validate loopConfig basics
    // exitCondition is only required for shell eval mode; agent mode evaluates via LLM review
    const evalMode = request.loopConfig.evalMode ?? EvalMode.SHELL;
    if (
      evalMode === EvalMode.SHELL &&
      (!request.loopConfig.exitCondition || request.loopConfig.exitCondition.trim().length === 0)
    ) {
      return err(
        new AutobeatError(ErrorCode.INVALID_INPUT, 'loopConfig.exitCondition is required for shell eval mode', {
          field: 'loopConfig.exitCondition',
        }),
      );
    }

    // Build the schedule with loopConfig (authoritative source) and a taskTemplate derived from it
    // (Schedule type requires taskTemplate; used as fallback for workingDirectory in handleLoopTrigger)
    const schedule = createSchedule({
      taskTemplate: {
        prompt: request.loopConfig.prompt ?? '',
        priority: request.loopConfig.priority,
        workingDirectory: request.loopConfig.workingDirectory,
        agent: request.loopConfig.agent,
        model: request.loopConfig.model,
        systemPrompt: request.loopConfig.systemPrompt,
      },
      scheduleType: request.scheduleType,
      cronExpression: request.cronExpression,
      scheduledAt: scheduledAtMs,
      timezone,
      missedRunPolicy: toMissedRunPolicy(request.missedRunPolicy),
      maxRuns: request.maxRuns,
      expiresAt: expiresAtMs,
      loopConfig: request.loopConfig,
      nextRunAt,
    });

    const promptSummary = request.loopConfig.prompt
      ? truncatePrompt(request.loopConfig.prompt, 50)
      : `Loop (${request.loopConfig.strategy})`;

    this.logger.info('Creating scheduled loop', {
      scheduleId: schedule.id,
      scheduleType: schedule.scheduleType,
      nextRunAt: new Date(nextRunAt).toISOString(),
      prompt: promptSummary,
    });

    // Emit event — ScheduleHandler persists
    const emitResult = await this.eventBus.emit('ScheduleCreated', { schedule });
    if (!emitResult.ok) {
      this.logger.error('Failed to emit ScheduleCreated event', emitResult.error, {
        scheduleId: schedule.id,
      });
      return err(emitResult.error);
    }

    return ok(schedule);
  }

  /**
   * Fetch a schedule by ID and optionally validate its status
   * Returns Result with the schedule or a typed error
   */
  private async fetchScheduleOrError(
    scheduleId: ScheduleId,
    expectedStatus?: ScheduleStatus,
  ): Promise<Result<Schedule>> {
    const result = await this.scheduleRepository.findById(scheduleId);
    if (!result.ok) {
      return err(
        new AutobeatError(ErrorCode.SYSTEM_ERROR, `Failed to get schedule: ${result.error.message}`, { scheduleId }),
      );
    }

    if (!result.value) {
      return err(new AutobeatError(ErrorCode.TASK_NOT_FOUND, `Schedule ${scheduleId} not found`, { scheduleId }));
    }

    if (expectedStatus !== undefined && result.value.status !== expectedStatus) {
      return err(
        new AutobeatError(
          ErrorCode.INVALID_OPERATION,
          `Schedule ${scheduleId} is not ${expectedStatus} (status: ${result.value.status})`,
          { scheduleId, expectedStatus, actualStatus: result.value.status },
        ),
      );
    }

    return ok(result.value);
  }
}
