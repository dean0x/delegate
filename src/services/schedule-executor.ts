/**
 * Schedule executor service - timer-based scheduler tick loop
 * ARCHITECTURE: Periodically checks for due schedules and triggers execution
 * Pattern: Timer service with start/stop lifecycle, handles missed runs
 * Rationale: Decoupled from ScheduleHandler for testability and separation of concerns
 */

import type { Schedule } from '../core/domain.js';
import { MissedRunPolicy, ScheduleStatus, ScheduleType } from '../core/domain.js';
import { BackbeatError, ErrorCode } from '../core/errors.js';
import { EventBus } from '../core/events/event-bus.js';
import type {
  ScheduleExecutedEvent,
  TaskCancelledEvent,
  TaskCompletedEvent,
  TaskFailedEvent,
  TaskTimeoutEvent,
} from '../core/events/events.js';
import { Logger, ScheduleRepository, SyncScheduleOperations, TransactionRunner } from '../core/interfaces.js';
import { err, ok, Result } from '../core/result.js';
import { getNextRunTime } from '../utils/cron.js';

/**
 * Configuration options for ScheduleExecutor
 */
export interface ScheduleExecutorOptions {
  /** Check interval in milliseconds. Default: 60000 (60 seconds) */
  readonly checkIntervalMs?: number;
  /** Grace period for missed runs in milliseconds. Default: 300000 (5 minutes) */
  readonly missedRunGracePeriodMs?: number;
}

/**
 * ScheduleExecutor - Timer-based service that checks for due schedules
 *
 * ARCHITECTURE:
 * - Uses setInterval with .unref() to not block process exit
 * - Checks every 60 seconds (configurable) for due schedules
 * - Emits ScheduleTriggered events for ScheduleHandler to process
 * - Handles missed run policies (skip, catchup, fail)
 */
export class ScheduleExecutor {
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private readonly checkIntervalMs: number;
  private readonly missedRunGracePeriodMs: number;

  /**
   * Track subscriptions for cleanup on stop()
   * ARCHITECTURE: Prevents resource leaks on repeated start/stop cycles
   */
  private readonly subscriptionIds: string[] = [];

  /**
   * Track schedules with currently running tasks
   * ARCHITECTURE: Prevents concurrent execution of the same schedule
   * Key: scheduleId, Value: taskId of running task
   */
  private readonly runningSchedules = new Map<string, string>();

  /** Default check interval: 60 seconds */
  private static readonly DEFAULT_CHECK_INTERVAL_MS = 60_000;

  /** Default grace period before considering a run "missed": 5 minutes */
  private static readonly DEFAULT_MISSED_RUN_GRACE_PERIOD_MS = 300_000;

  /**
   * Private constructor - use ScheduleExecutor.create() instead
   * ARCHITECTURE: Factory pattern keeps constructor pure (no side effects),
   * matching ScheduleHandler's pattern
   */
  private constructor(
    private readonly scheduleRepo: ScheduleRepository & SyncScheduleOperations,
    private readonly eventBus: EventBus,
    private readonly database: TransactionRunner,
    private readonly logger: Logger,
    options?: ScheduleExecutorOptions,
  ) {
    this.checkIntervalMs = options?.checkIntervalMs ?? ScheduleExecutor.DEFAULT_CHECK_INTERVAL_MS;
    this.missedRunGracePeriodMs =
      options?.missedRunGracePeriodMs ?? ScheduleExecutor.DEFAULT_MISSED_RUN_GRACE_PERIOD_MS;
  }

  /**
   * Factory method to create a fully initialized ScheduleExecutor
   * ARCHITECTURE: Guarantees subscriptions are set up before use.
   * Matches ScheduleHandler's factory pattern.
   */
  static create(
    scheduleRepo: ScheduleRepository & SyncScheduleOperations,
    eventBus: EventBus,
    database: TransactionRunner,
    logger: Logger,
    options?: ScheduleExecutorOptions,
  ): Result<ScheduleExecutor, BackbeatError> {
    const executor = new ScheduleExecutor(scheduleRepo, eventBus, database, logger, options);

    const subscribeResult = executor.subscribeToTaskEvents();
    if (!subscribeResult.ok) {
      return subscribeResult;
    }

    return ok(executor);
  }

  /**
   * Subscribe to task events to track completion of scheduled tasks
   * ARCHITECTURE: Returns Result so factory can detect subscription failures.
   * Stores subscription IDs for cleanup in stop().
   */
  private subscribeToTaskEvents(): Result<void, BackbeatError> {
    const subscriptions = [
      // When a schedule execution creates a task, track it
      this.eventBus.subscribe<ScheduleExecutedEvent>('ScheduleExecuted', async (event) => {
        this.markScheduleRunning(event.scheduleId, event.taskId);
        this.logger.debug('Marked schedule as running', {
          scheduleId: event.scheduleId,
          taskId: event.taskId,
        });
      }),

      // When a task completes, check if it was from a schedule and clear running state
      this.eventBus.subscribe<TaskCompletedEvent>('TaskCompleted', async (event) => {
        this.clearRunningScheduleByTask(event.taskId);
      }),

      this.eventBus.subscribe<TaskFailedEvent>('TaskFailed', async (event) => {
        this.clearRunningScheduleByTask(event.taskId);
      }),

      this.eventBus.subscribe<TaskCancelledEvent>('TaskCancelled', async (event) => {
        this.clearRunningScheduleByTask(event.taskId);
      }),

      this.eventBus.subscribe<TaskTimeoutEvent>('TaskTimeout', async (event) => {
        this.clearRunningScheduleByTask(event.taskId);
      }),
    ];

    // Verify all subscriptions succeeded and store IDs for cleanup
    for (const result of subscriptions) {
      if (!result.ok) {
        return err(
          new BackbeatError(ErrorCode.SYSTEM_ERROR, `Failed to subscribe to events: ${result.error.message}`, {
            error: result.error,
          }),
        );
      }
      this.subscriptionIds.push(result.value);
    }

    return ok(undefined);
  }

  /**
   * Clear running schedule state when a task completes
   */
  private clearRunningScheduleByTask(taskId: string): void {
    for (const [scheduleId, runningTaskId] of this.runningSchedules.entries()) {
      if (runningTaskId === taskId) {
        this.runningSchedules.delete(scheduleId);
        this.logger.debug('Cleared running state for schedule', { scheduleId, taskId });
        break;
      }
    }
  }

  /**
   * Mark a schedule as having a running task
   */
  markScheduleRunning(scheduleId: string, taskId: string): void {
    this.runningSchedules.set(scheduleId, taskId);
  }

  /**
   * Check if a schedule has a running task
   */
  isScheduleRunning(scheduleId: string): boolean {
    return this.runningSchedules.has(scheduleId);
  }

  /**
   * Get the running task ID for a schedule
   */
  getRunningTaskId(scheduleId: string): string | undefined {
    return this.runningSchedules.get(scheduleId);
  }

  /**
   * Start the scheduler tick loop
   *
   * @returns Result<void> - Error if already running
   */
  start(): Result<void, BackbeatError> {
    if (this.isRunning) {
      return err(new BackbeatError(ErrorCode.INVALID_OPERATION, 'ScheduleExecutor is already running'));
    }

    this.isRunning = true;
    this.timer = setInterval(() => void this.tick(), this.checkIntervalMs);

    // Don't block process exit - timer will be cleaned up naturally
    this.timer.unref();

    this.logger.info('ScheduleExecutor started', {
      intervalMs: this.checkIntervalMs,
      missedRunGracePeriodMs: this.missedRunGracePeriodMs,
    });

    // Run initial tick immediately
    void this.tick();

    return ok(undefined);
  }

  /**
   * Stop the scheduler and clean up all resources
   *
   * @returns Result<void> - Always succeeds
   */
  stop(): Result<void, BackbeatError> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;

    // Unsubscribe all event handlers to prevent resource leaks
    for (const id of this.subscriptionIds) {
      this.eventBus.unsubscribe(id);
    }
    this.subscriptionIds.length = 0;

    this.runningSchedules.clear();

    this.logger.info('ScheduleExecutor stopped');
    return ok(undefined);
  }

  /**
   * Check if executor is currently running
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Single scheduler tick - check and execute due schedules
   *
   * ARCHITECTURE: This runs every checkIntervalMs (default 60s)
   * Finds all active schedules where nextRunAt <= now
   * Processes each due schedule with missed run handling
   */
  private async tick(): Promise<void> {
    const now = Date.now();
    this.logger.debug('Scheduler tick', {
      now,
      nowDate: new Date(now).toISOString(),
    });

    try {
      // Find schedules due for execution
      const dueResult = await this.scheduleRepo.findDue(now);
      if (!dueResult.ok) {
        this.logger.error('Failed to find due schedules', dueResult.error);
        return;
      }

      const dueSchedules = dueResult.value;
      if (dueSchedules.length === 0) {
        this.logger.debug('No due schedules found');
        return;
      }

      this.logger.info('Found due schedules', {
        count: dueSchedules.length,
        scheduleIds: dueSchedules.map((s) => s.id),
      });

      // Process each due schedule
      for (const schedule of dueSchedules) {
        await this.executeSchedule(schedule, now);
      }
    } catch (error) {
      this.logger.error('Scheduler tick failed', error as Error);
    }
  }

  /**
   * Execute a single due schedule
   *
   * ARCHITECTURE: Prevents concurrent execution of the same schedule.
   * If a previous task from this schedule is still running, skip this run.
   * Determines if the run was missed (based on grace period) and applies
   * the appropriate missed run policy.
   */
  private async executeSchedule(schedule: Schedule, now: number): Promise<void> {
    try {
      // Check for concurrent execution - skip if previous task is still running
      if (this.isScheduleRunning(schedule.id)) {
        const runningTaskId = this.getRunningTaskId(schedule.id);
        this.logger.info('Skipping schedule - previous task still running', {
          scheduleId: schedule.id,
          runningTaskId,
        });
        // Don't update nextRunAt - let it trigger again on next tick
        return;
      }

      // Calculate how late we are
      const scheduledTime = schedule.nextRunAt ?? now;
      const delayMs = now - scheduledTime;
      const isMissed = delayMs > this.missedRunGracePeriodMs;

      if (isMissed) {
        await this.handleMissedRun(schedule, now);
        return;
      }

      // Normal execution - emit trigger event
      // ScheduleHandler will create the task and update the schedule
      await this.eventBus.emit('ScheduleTriggered', {
        scheduleId: schedule.id,
        triggeredAt: now,
      });

      this.logger.info('Schedule triggered', {
        scheduleId: schedule.id,
        scheduledFor: scheduledTime,
        actualTime: now,
        delayMs,
        type: schedule.scheduleType,
      });
    } catch (error) {
      this.logger.error('Failed to execute schedule', error as Error, {
        scheduleId: schedule.id,
      });
    }
  }

  /**
   * Handle missed run based on policy
   *
   * Policies:
   * - SKIP: Calculate next run time, don't execute the missed run
   * - CATCHUP: Execute the missed run immediately (one time only)
   * - FAIL: Mark the schedule as cancelled/failed
   */
  private async handleMissedRun(schedule: Schedule, now: number): Promise<void> {
    const missedAt = schedule.nextRunAt ?? now;

    this.logger.warn('Missed schedule run', {
      scheduleId: schedule.id,
      policy: schedule.missedRunPolicy,
      scheduledFor: missedAt,
      scheduledForDate: new Date(missedAt).toISOString(),
      currentTime: now,
      delayMs: now - missedAt,
      gracePeriodMs: this.missedRunGracePeriodMs,
    });

    switch (schedule.missedRunPolicy) {
      case MissedRunPolicy.SKIP:
        // Skip this run, calculate next run time
        await this.eventBus.emit('ScheduleMissed', {
          scheduleId: schedule.id,
          missedAt,
          policy: MissedRunPolicy.SKIP,
        });

        // Update nextRunAt to skip this run
        await this.updateNextRun(schedule);

        this.logger.info('Skipped missed schedule run', { scheduleId: schedule.id });
        break;

      case MissedRunPolicy.CATCHUP:
        // Execute the missed run immediately (catch up)
        await this.eventBus.emit('ScheduleTriggered', {
          scheduleId: schedule.id,
          triggeredAt: now,
        });

        this.logger.info('Catching up missed schedule run', { scheduleId: schedule.id });
        break;

      case MissedRunPolicy.FAIL: {
        // Cancel schedule + record audit trail atomically
        // Without transaction: if update() succeeds but recordExecution() fails,
        // schedule is cancelled with no audit trail
        const txResult = this.database.runInTransaction(() => {
          this.scheduleRepo.updateSync(schedule.id, {
            status: ScheduleStatus.CANCELLED,
            nextRunAt: undefined,
          });
          this.scheduleRepo.recordExecutionSync({
            scheduleId: schedule.id,
            scheduledFor: missedAt,
            status: 'missed',
            errorMessage: `Schedule missed by ${now - missedAt}ms, policy: FAIL`,
            createdAt: now,
          });
        });

        if (!txResult.ok) {
          this.logger.error('Failed to cancel schedule on missed run', txResult.error, {
            scheduleId: schedule.id,
          });
          break;
        }

        await this.eventBus.emit('ScheduleMissed', {
          scheduleId: schedule.id,
          missedAt,
          policy: MissedRunPolicy.FAIL,
        });

        this.logger.info('Schedule failed due to missed run', { scheduleId: schedule.id });
        break;
      }
    }
  }

  /**
   * Calculate and update next run time for a schedule
   *
   * For CRON schedules: Calculate next occurrence from now
   * For ONE_TIME schedules: Mark as completed (they don't repeat)
   */
  private async updateNextRun(schedule: Schedule): Promise<void> {
    if (schedule.scheduleType === ScheduleType.ONE_TIME) {
      // One-time schedules don't repeat - mark as completed
      const completeResult = await this.scheduleRepo.update(schedule.id, {
        status: ScheduleStatus.COMPLETED,
        nextRunAt: undefined,
      });
      if (!completeResult.ok) {
        this.logger.error('Failed to mark one-time schedule as completed', completeResult.error, {
          scheduleId: schedule.id,
        });
      }

      this.logger.info('One-time schedule completed', { scheduleId: schedule.id });
      return;
    }

    // Calculate next cron run from now
    if (schedule.cronExpression) {
      const nextResult = getNextRunTime(schedule.cronExpression, schedule.timezone, new Date());

      if (nextResult.ok) {
        const updateResult = await this.scheduleRepo.update(schedule.id, {
          nextRunAt: nextResult.value,
        });
        if (!updateResult.ok) {
          this.logger.error('Failed to update nextRunAt', updateResult.error, {
            scheduleId: schedule.id,
            nextRunAt: nextResult.value,
          });
        }

        this.logger.debug('Updated nextRunAt for schedule', {
          scheduleId: schedule.id,
          nextRunAt: nextResult.value,
          nextRunAtDate: new Date(nextResult.value).toISOString(),
        });
      } else {
        this.logger.error('Failed to calculate next run time', nextResult.error, {
          scheduleId: schedule.id,
          cronExpression: schedule.cronExpression,
        });
      }
    }
  }

  /**
   * Manually trigger a tick (useful for testing)
   * ARCHITECTURE: Exposed for testing, normally called by internal timer
   */
  async triggerTick(): Promise<void> {
    await this.tick();
  }
}
