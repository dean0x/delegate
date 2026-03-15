/**
 * Database persistence event handler
 * Manages all task persistence operations through events
 */

import type { Task } from '../../core/domain.js';
import { TaskStatus } from '../../core/domain.js';
import { EventBus } from '../../core/events/event-bus.js';
import {
  TaskCancelledEvent,
  TaskCompletedEvent,
  TaskDelegatedEvent,
  TaskFailedEvent,
  TaskStartedEvent,
  TaskTimeoutEvent,
} from '../../core/events/events.js';
import { BaseEventHandler } from '../../core/events/handlers.js';
import { Logger, TaskRepository } from '../../core/interfaces.js';
import { ok, Result } from '../../core/result.js';
import { QueueHandler } from './queue-handler.js';

export class PersistenceHandler extends BaseEventHandler {
  constructor(
    private readonly repository: TaskRepository,
    private readonly queueHandler: QueueHandler,
    logger: Logger,
  ) {
    super(logger, 'PersistenceHandler');
  }

  /**
   * Set up event subscriptions
   */
  async setup(eventBus: EventBus): Promise<Result<void>> {
    // Subscribe to all task lifecycle events that need persistence
    const subscriptions = [
      eventBus.subscribe('TaskDelegated', this.handleTaskDelegated.bind(this)),
      eventBus.subscribe('TaskStarted', this.handleTaskStarted.bind(this)),
      eventBus.subscribe('TaskCompleted', this.handleTaskCompleted.bind(this)),
      eventBus.subscribe('TaskFailed', this.handleTaskFailed.bind(this)),
      eventBus.subscribe('TaskCancelled', this.handleTaskCancelled.bind(this)),
      eventBus.subscribe('TaskTimeout', this.handleTaskTimeout.bind(this)),
    ];

    // Check if any subscription failed
    for (const result of subscriptions) {
      if (!result.ok) {
        return result;
      }
    }

    this.logger.info('PersistenceHandler initialized');
    return ok(undefined);
  }

  /**
   * Handle task delegation - persist new task to database, then enqueue if ready
   */
  private async handleTaskDelegated(event: TaskDelegatedEvent): Promise<void> {
    await this.handleEvent(event, async (event) => {
      const result = await this.repository.save(event.task);

      if (!result.ok) {
        this.logger.error('Failed to persist delegated task', result.error, {
          taskId: event.task.id,
        });
        return result;
      }

      this.logger.debug('Task persisted to database', {
        taskId: event.task.id,
      });

      // Directly call QueueHandler to enqueue task if not blocked by dependencies
      await this.queueHandler.enqueueIfReady(event.task);

      return ok(undefined);
    });
  }

  /**
   * Handle task started - update task with running status and worker info
   */
  private async handleTaskStarted(event: TaskStartedEvent): Promise<void> {
    await this.handleEvent(event, async (event) => {
      const result = await this.repository.update(event.taskId, {
        status: TaskStatus.RUNNING,
        startedAt: Date.now(),
        workerId: event.workerId,
      } as Partial<Task>);

      if (!result.ok) {
        this.logger.error('Failed to persist task start', result.error, {
          taskId: event.taskId,
        });
        return result;
      }

      this.logger.debug('Task start persisted', {
        taskId: event.taskId,
        workerId: event.workerId,
      });

      return ok(undefined);
    });
  }

  /**
   * Handle task completion - update task with completed status and exit code
   */
  private async handleTaskCompleted(event: TaskCompletedEvent): Promise<void> {
    await this.handleEvent(event, async (event) => {
      const result = await this.repository.update(event.taskId, {
        status: TaskStatus.COMPLETED,
        completedAt: Date.now(),
        exitCode: event.exitCode,
        duration: event.duration,
      } as Partial<Task>);

      if (!result.ok) {
        this.logger.error('Failed to persist task completion', result.error, {
          taskId: event.taskId,
        });
        return result;
      }

      this.logger.debug('Task completion persisted', {
        taskId: event.taskId,
        exitCode: event.exitCode,
        duration: event.duration,
      });

      return ok(undefined);
    });
  }

  /**
   * Handle task failure - update task with failed status
   */
  private async handleTaskFailed(event: TaskFailedEvent): Promise<void> {
    await this.handleEvent(event, async (event) => {
      const result = await this.repository.update(event.taskId, {
        status: TaskStatus.FAILED,
        completedAt: Date.now(),
        exitCode: event.exitCode,
      } as Partial<Task>);

      if (!result.ok) {
        this.logger.error('Failed to persist task failure', result.error, {
          taskId: event.taskId,
        });
        return result;
      }

      this.logger.debug('Task failure persisted', {
        taskId: event.taskId,
        error: event.error.message,
      });

      return ok(undefined);
    });
  }

  /**
   * Handle task cancellation - update task with cancelled status
   */
  private async handleTaskCancelled(event: TaskCancelledEvent): Promise<void> {
    await this.handleEvent(event, async (event) => {
      const result = await this.repository.update(event.taskId, {
        status: TaskStatus.CANCELLED,
        completedAt: Date.now(),
      } as Partial<Task>);

      if (!result.ok) {
        this.logger.error('Failed to persist task cancellation', result.error, {
          taskId: event.taskId,
        });
        return result;
      }

      this.logger.debug('Task cancellation persisted', {
        taskId: event.taskId,
        reason: event.reason,
      });

      return ok(undefined);
    });
  }

  /**
   * Handle task timeout - update task with failed status
   */
  private async handleTaskTimeout(event: TaskTimeoutEvent): Promise<void> {
    await this.handleEvent(event, async (event) => {
      const result = await this.repository.update(event.taskId, {
        status: TaskStatus.FAILED,
        completedAt: Date.now(),
      } as Partial<Task>);

      if (!result.ok) {
        this.logger.error('Failed to persist task timeout', result.error, {
          taskId: event.taskId,
        });
        return result;
      }

      this.logger.debug('Task timeout persisted', {
        taskId: event.taskId,
        error: event.error.message,
      });

      return ok(undefined);
    });
  }
}
