/**
 * Event-driven recovery manager for startup task restoration
 * Handles loading tasks from database and emits events for recovery actions
 */

import { TaskStatus } from '../core/domain.js';
import { EventBus } from '../core/events/event-bus.js';
import { Logger, TaskQueue, TaskRepository } from '../core/interfaces.js';
import { err, ok, Result } from '../core/result.js';

export class RecoveryManager {
  constructor(
    private readonly repository: TaskRepository,
    private readonly queue: TaskQueue,
    private readonly eventBus: EventBus,
    private readonly logger: Logger,
  ) {}

  /**
   * Recover tasks on startup
   * - Re-queue QUEUED tasks
   * - Mark RUNNING tasks as FAILED (crashed)
   */
  async recover(): Promise<Result<void>> {
    this.logger.info('Starting recovery process');

    // First, cleanup old completed tasks (older than 7 days)
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const cleanupResult = await this.repository.cleanupOldTasks(sevenDaysMs);

    if (cleanupResult.ok && cleanupResult.value > 0) {
      this.logger.info('Cleaned up old completed tasks', { count: cleanupResult.value });
    }

    // Get only QUEUED and RUNNING tasks (non-terminal states that need recovery)
    const queuedResult = await this.repository.findByStatus(TaskStatus.QUEUED);
    const runningResult = await this.repository.findByStatus(TaskStatus.RUNNING);

    if (!queuedResult.ok) {
      this.logger.error('Failed to load queued tasks for recovery', queuedResult.error);
      return queuedResult;
    }

    if (!runningResult.ok) {
      this.logger.error('Failed to load running tasks for recovery', runningResult.error);
      return runningResult;
    }

    let queuedCount = 0;
    let failedCount = 0;

    // Re-queue QUEUED tasks (check for duplicates first)
    for (const task of queuedResult.value) {
      // Safety check: don't re-queue if already in queue
      if (this.queue.contains(task.id)) {
        this.logger.warn('Task already in queue, skipping re-queue', { taskId: task.id });
        continue;
      }

      const enqueueResult = this.queue.enqueue(task);

      if (enqueueResult.ok) {
        queuedCount++;
        this.logger.debug('Re-queued task', { taskId: task.id });

        // CRITICAL: Emit TaskQueued event to trigger worker spawning
        const queuedEventResult = await this.eventBus.emit('TaskQueued', {
          taskId: task.id,
        });

        if (!queuedEventResult.ok) {
          this.logger.error('Failed to emit TaskQueued event for recovered task', queuedEventResult.error, {
            taskId: task.id,
          });
        }
      } else {
        this.logger.error('Failed to re-queue task', enqueueResult.error, { taskId: task.id });
      }
    }

    /**
     * CRITICAL: Stale task detection - DO NOT REMOVE without proper justification
     *
     * WHY THIS EXISTS:
     * Tasks stuck in RUNNING status are typically from crashed workers or server shutdowns.
     * Without this check, every server restart would re-queue ALL old running tasks,
     * causing a fork-bomb scenario where dozens of claude-code processes spawn simultaneously.
     *
     * WHAT IT DOES:
     * - Tasks older than 30 minutes are considered "stale" (definitely crashed)
     * - Recent tasks (< 30 min) might be legitimate restarts, so we re-queue them
     * - Stale tasks are marked as FAILED instead of being re-queued
     *
     * REMOVAL CRITERIA:
     * Only remove this if you have implemented one of these alternatives:
     * 1. Proper graceful shutdown that marks all RUNNING tasks as FAILED
     * 2. Worker heartbeat system that detects crashed workers in real-time
     * 3. Separate task recovery queue with spawn rate limiting
     *
     * INCIDENT REFERENCE: 2025-10-04
     * Removing spawn delay caused 7 stale tasks to spawn simultaneously → system crash
     */
    const STALE_TASK_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
    const now = Date.now();

    // Mark RUNNING tasks as FAILED (crashed during execution)
    for (const task of runningResult.value) {
      // CRITICAL: Use startedAt for RUNNING tasks (updatedAt not persisted to DB)
      // For RUNNING tasks, startedAt is the most accurate timestamp for staleness detection
      const taskAge = now - (task.startedAt || task.createdAt);
      const isStale = taskAge > STALE_TASK_THRESHOLD_MS;

      if (isStale) {
        // Stale task - definitely crashed, mark as failed
        const updateResult = await this.repository.update(task.id, {
          status: TaskStatus.FAILED,
          completedAt: now,
          exitCode: -1, // Indicates crash
        });

        if (updateResult.ok) {
          failedCount++;
          this.logger.info('Marked stale crashed task as failed', {
            taskId: task.id,
            ageMinutes: Math.round(taskAge / 60000),
          });
        } else {
          this.logger.error('Failed to update stale crashed task', updateResult.error, {
            taskId: task.id,
          });
        }
      } else {
        // Recent task - might be legitimate restart, re-queue for recovery
        // Safety check: don't re-queue if already in queue
        if (this.queue.contains(task.id)) {
          this.logger.warn('Task already in queue, skipping re-queue', { taskId: task.id });
          continue;
        }

        const enqueueResult = this.queue.enqueue(task);

        if (enqueueResult.ok) {
          queuedCount++;
          this.logger.info('Re-queued recent running task for recovery', {
            taskId: task.id,
            ageMinutes: Math.round(taskAge / 60000),
          });

          // Emit TaskQueued event to trigger worker spawning
          const queuedEventResult = await this.eventBus.emit('TaskQueued', {
            taskId: task.id,
          });

          if (!queuedEventResult.ok) {
            this.logger.error('Failed to emit TaskQueued event for recovered task', queuedEventResult.error, {
              taskId: task.id,
            });
          }
        } else {
          this.logger.error('Failed to re-queue recent running task', enqueueResult.error, {
            taskId: task.id,
          });
        }
      }
    }

    this.logger.info('Recovery complete', {
      queuedTasks: queuedResult.value.length,
      runningTasks: runningResult.value.length,
      requeued: queuedCount,
      markedFailed: failedCount,
    });

    return ok(undefined);
  }
}
