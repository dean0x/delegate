/**
 * Event-driven recovery manager for startup task restoration
 * Handles loading tasks from database and emits events for recovery actions
 */

import { TaskStatus } from '../core/domain.js';
import { EventBus } from '../core/events/event-bus.js';
import { Logger, TaskQueue, TaskRepository, WorkerRepository } from '../core/interfaces.js';
import { ok, Result } from '../core/result.js';

export class RecoveryManager {
  constructor(
    private readonly repository: TaskRepository,
    private readonly queue: TaskQueue,
    private readonly eventBus: EventBus,
    private readonly logger: Logger,
    private readonly workerRepository: WorkerRepository,
  ) {}

  /**
   * Check if a process is alive using signal 0 (existence check).
   * Returns true if the process exists, false if it doesn't.
   */
  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async recover(): Promise<Result<void>> {
    this.logger.info('Starting recovery process');

    // Phase 0: Clean dead worker registrations (PID-based crash detection)
    const allWorkers = this.workerRepository.findAll();
    if (allWorkers.ok) {
      for (const reg of allWorkers.value) {
        if (!this.isProcessAlive(reg.ownerPid)) {
          const unregResult = this.workerRepository.unregister(reg.workerId);
          if (!unregResult.ok) {
            this.logger.error('Failed to unregister dead worker', unregResult.error, {
              workerId: reg.workerId,
            });
          }
          const updateResult = await this.repository.update(reg.taskId, {
            status: TaskStatus.FAILED,
            completedAt: Date.now(),
            exitCode: -1, // Crash indicator
          });
          if (!updateResult.ok) {
            this.logger.error('Failed to mark dead worker task as failed', updateResult.error, {
              taskId: reg.taskId,
            });
          }
          this.logger.info('Cleaned up dead worker and failed its task', {
            workerId: reg.workerId,
            taskId: reg.taskId,
            deadPid: reg.ownerPid,
          });
        }
      }
    }

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
     * PID-BASED RECOVERY for RUNNING tasks
     *
     * WHY THIS EXISTS:
     * Tasks stuck in RUNNING status are typically from crashed workers or server shutdowns.
     * Without this check, every server restart would re-queue ALL old running tasks,
     * causing a fork-bomb scenario where dozens of claude-code processes spawn simultaneously.
     *
     * WHAT IT DOES:
     * - Checks if the task has a worker row in the workers table
     * - If worker row exists and ownerPid is alive → leave it alone (running in another process)
     * - If no worker row, or ownerPid is dead → mark FAILED immediately (definitively crashed)
     *
     * REPLACES: 30-minute staleness heuristic (pre-v1.0).
     * PID-based detection is definitive — no false positives from short tasks,
     * no 30-minute wait for long-crashed tasks.
     *
     * INCIDENT REFERENCE: 2025-10-04
     * Removing spawn delay caused 7 stale tasks to spawn simultaneously → system crash
     * PID-based detection prevents this by marking crashed tasks immediately.
     */
    const now = Date.now();

    // Mark RUNNING tasks as FAILED if their worker is dead
    for (const task of runningResult.value) {
      const workerResult = this.workerRepository.findByTaskId(task.id);
      const workerRegistration = workerResult.ok ? workerResult.value : null;
      const hasLiveWorker = workerRegistration !== null && this.isProcessAlive(workerRegistration.ownerPid);

      if (hasLiveWorker) {
        // Worker is alive in another process — leave it alone
        this.logger.info('Running task has live worker in another process, skipping', {
          taskId: task.id,
          ownerPid: workerRegistration!.ownerPid,
        });
        continue;
      }

      // No live worker — definitively crashed, mark as failed
      const updateResult = await this.repository.update(task.id, {
        status: TaskStatus.FAILED,
        completedAt: now,
        exitCode: -1, // Indicates crash
      });

      if (updateResult.ok) {
        failedCount++;
        this.logger.info('Marked crashed task as failed (no live worker)', {
          taskId: task.id,
        });
      } else {
        this.logger.error('Failed to update crashed task', updateResult.error, {
          taskId: task.id,
        });
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
