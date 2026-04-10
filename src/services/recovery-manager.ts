/**
 * Event-driven recovery manager for startup task restoration
 * Handles loading tasks from database and emits events for recovery actions
 */

import { isTerminalState, OrchestratorStatus, Task, TaskStatus, updateOrchestration } from '../core/domain.js';
import { AutobeatError, ErrorCode } from '../core/errors.js';
import { EventBus } from '../core/events/event-bus.js';
import {
  DependencyRepository,
  Logger,
  LoopRepository,
  OrchestrationRepository,
  TaskQueue,
  TaskRepository,
  WorkerRepository,
} from '../core/interfaces.js';
import { ok, Result } from '../core/result.js';
import { checkOrchestrationLiveness, type Liveness } from './orchestration-liveness.js';

export interface RecoveryManagerDeps {
  readonly taskRepo: TaskRepository;
  readonly queue: TaskQueue;
  readonly eventBus: EventBus;
  readonly logger: Logger;
  readonly workerRepo: WorkerRepository;
  readonly dependencyRepo: DependencyRepository;
  readonly loopRepo?: LoopRepository;
  readonly orchestrationRepo?: OrchestrationRepository;
}

/** 7-day retention window for cleanup of terminal tasks, loops, and orchestrations */
const CLEANUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export class RecoveryManager {
  private readonly taskRepo: TaskRepository;
  private readonly queue: TaskQueue;
  private readonly eventBus: EventBus;
  private readonly logger: Logger;
  private readonly workerRepo: WorkerRepository;
  private readonly dependencyRepo: DependencyRepository;
  private readonly loopRepo?: LoopRepository;
  private readonly orchestrationRepo?: OrchestrationRepository;

  constructor(deps: RecoveryManagerDeps) {
    this.taskRepo = deps.taskRepo;
    this.queue = deps.queue;
    this.eventBus = deps.eventBus;
    this.logger = deps.logger;
    this.workerRepo = deps.workerRepo;
    this.dependencyRepo = deps.dependencyRepo;
    this.loopRepo = deps.loopRepo;
    this.orchestrationRepo = deps.orchestrationRepo;
  }

  /**
   * Check if a process is alive using signal 0 (existence check).
   * Returns true if the process exists, false if it doesn't.
   */
  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      // EPERM means the process exists but we lack permission to signal it
      if ((e as NodeJS.ErrnoException).code === 'EPERM') {
        return true;
      }
      // ESRCH means the process does not exist
      return false;
    }
  }

  async recover(): Promise<Result<void>> {
    this.logger.info('Starting recovery process');

    // Phase 0: Clean dead worker registrations (must run before Phase 3)
    await this.cleanDeadWorkerRegistrations();

    // Phase 1: Cleanup old completed tasks
    await this.cleanupOldCompletedTasks();

    // Phase 1b: Cleanup old completed loops (FK cascade handles iterations)
    await this.cleanupOldLoops();

    // Phase 1c: Cleanup old completed orchestrations (state files + DB rows)
    await this.cleanupOldOrchestrations();

    // Phase 1d: Detect zombie RUNNING orchestrations whose worker died silently.
    // DECISION (2026-04-10): Stuck PLANNING orchestrations are NOT auto-cleaned by design.
    // The user prefers visibility + manual control via dashboard keybindings (c/d)
    // over silent automated cleanup.
    await this.failZombieRunningOrchestrations();

    // Fetch non-terminal tasks for recovery
    const queuedResult = await this.taskRepo.findByStatus(TaskStatus.QUEUED);
    const runningResult = await this.taskRepo.findByStatus(TaskStatus.RUNNING);

    if (!queuedResult.ok) {
      this.logger.error('Failed to load queued tasks for recovery', queuedResult.error);
      return queuedResult;
    }

    if (!runningResult.ok) {
      this.logger.error('Failed to load running tasks for recovery', runningResult.error);
      return runningResult;
    }

    // Phase 2 & 3: Recover tasks
    const { queuedCount, blockedCount } = await this.recoverQueuedTasks(queuedResult.value);
    const failedCount = await this.recoverRunningTasks(runningResult.value);

    this.logger.info('Recovery complete', {
      queuedTasks: queuedResult.value.length,
      runningTasks: runningResult.value.length,
      requeued: queuedCount,
      blockedByDependencies: blockedCount,
      markedFailed: failedCount,
    });

    return ok(undefined);
  }

  private async cleanDeadWorkerRegistrations(): Promise<void> {
    const allWorkers = this.workerRepo.findAll();
    if (!allWorkers.ok) return;

    for (const reg of allWorkers.value) {
      if (!this.isProcessAlive(reg.ownerPid)) {
        const unregResult = this.workerRepo.unregister(reg.workerId);
        if (!unregResult.ok) {
          this.logger.error('Failed to unregister dead worker', unregResult.error, {
            workerId: reg.workerId,
          });
        }

        // Guard: only update non-terminal tasks
        const taskResult = await this.taskRepo.findById(reg.taskId);
        if (!taskResult.ok) {
          this.logger.error('Failed to look up task for dead worker', taskResult.error, {
            taskId: reg.taskId,
          });
          continue;
        }

        if (taskResult.value !== null && isTerminalState(taskResult.value.status)) {
          this.logger.info('Dead worker row cleaned, task already terminal', {
            workerId: reg.workerId,
            taskId: reg.taskId,
            currentStatus: taskResult.value.status,
            deadPid: reg.ownerPid,
          });
          continue;
        }

        // ARCHITECTURE EXCEPTION: Direct repository write + TaskFailed emit (double-write).
        // Recovery runs during startup before event handlers are guaranteed to be ready,
        // so we write status directly rather than relying on PersistenceHandler to handle
        // TaskFailed. The subsequent emit notifies DependencyHandler to unblock downstream tasks.
        const updateResult = await this.taskRepo.update(reg.taskId, {
          status: TaskStatus.FAILED,
          completedAt: Date.now(),
          exitCode: -1, // Crash indicator
        });
        if (updateResult.ok) {
          this.logger.info('Cleaned up dead worker and failed its task', {
            workerId: reg.workerId,
            taskId: reg.taskId,
            deadPid: reg.ownerPid,
          });

          // Emit TaskFailed so DependencyHandler resolves deps for downstream tasks
          const failedEmitResult = await this.eventBus.emit('TaskFailed', {
            taskId: reg.taskId,
            error: new AutobeatError(ErrorCode.SYSTEM_ERROR, 'Worker process died (dead PID detected)'),
            exitCode: -1,
          });
          if (!failedEmitResult.ok) {
            this.logger.error('Failed to emit TaskFailed event for dead worker task', failedEmitResult.error, {
              taskId: reg.taskId,
            });
          }
        } else {
          this.logger.error('Failed to mark dead worker task as failed', updateResult.error, {
            taskId: reg.taskId,
          });
        }
      }
    }
  }

  private async cleanupOldCompletedTasks(): Promise<void> {
    const cleanupResult = await this.taskRepo.cleanupOldTasks(CLEANUP_RETENTION_MS);

    if (cleanupResult.ok && cleanupResult.value > 0) {
      this.logger.info('Cleaned up old completed tasks', { count: cleanupResult.value });
    }
  }

  private async cleanupOldLoops(): Promise<void> {
    if (!this.loopRepo) return;

    const cleanupResult = await this.loopRepo.cleanupOldLoops(CLEANUP_RETENTION_MS);

    if (cleanupResult.ok && cleanupResult.value > 0) {
      this.logger.info('Cleaned up old completed loops', { count: cleanupResult.value });
    }
  }

  private async cleanupOldOrchestrations(): Promise<void> {
    if (!this.orchestrationRepo) return;

    const cleanupResult = await this.orchestrationRepo.cleanupOldOrchestrations(CLEANUP_RETENTION_MS);

    if (cleanupResult.ok && cleanupResult.value > 0) {
      this.logger.info('Cleaned up old completed orchestrations', { count: cleanupResult.value });
    }
  }

  /**
   * DECISION (2026-04-10): Detect zombies by tracing:
   * orchestration → loop → most-recent-iteration → task → worker.ownerPid → process.kill(pid, 0).
   * Conservative: 'unknown' results (broken chain) leave the row alone — false positives
   * marking live orchestrations as zombies would be far worse than false negatives
   * leaving zombies for the user to clean manually via the dashboard.
   */
  private async failZombieRunningOrchestrations(): Promise<void> {
    if (!this.orchestrationRepo || !this.loopRepo) return;

    const result = await this.orchestrationRepo.findByStatus(OrchestratorStatus.RUNNING);
    if (!result.ok) return;

    for (const o of result.value) {
      let liveness: Liveness;
      try {
        liveness = await checkOrchestrationLiveness(o, {
          loopRepo: this.loopRepo,
          taskRepo: this.taskRepo,
          workerRepo: this.workerRepo,
          isProcessAlive: this.isProcessAlive,
        });
      } catch {
        continue; // Defensive: skip this orchestration on unexpected error
      }

      if (liveness !== 'dead') continue;

      const failed = updateOrchestration(o, {
        status: OrchestratorStatus.FAILED,
        completedAt: Date.now(),
      });

      const updateResult = await this.orchestrationRepo.update(failed);
      if (updateResult.ok) {
        this.logger.warn('Marked zombie RUNNING orchestration as FAILED (worker PID dead)', {
          orchestratorId: o.id,
          loopId: o.loopId,
        });
      }
    }
  }

  private async recoverQueuedTasks(tasks: readonly Task[]): Promise<{ queuedCount: number; blockedCount: number }> {
    let queuedCount = 0;
    let blockedCount = 0;

    for (const task of tasks) {
      // Safety check: don't re-queue if already in queue
      if (this.queue.contains(task.id)) {
        this.logger.warn('Task already in queue, skipping re-queue', { taskId: task.id });
        continue;
      }

      // Check if task is blocked by unresolved dependencies
      const isBlockedResult = await this.dependencyRepo.isBlocked(task.id);
      if (!isBlockedResult.ok) {
        this.logger.warn('Failed to check task dependencies during recovery, re-queuing conservatively', {
          taskId: task.id,
          error: isBlockedResult.error.message,
        });
        // Fall through to enqueue — avoids stranding dependency-free tasks.
        // If task is actually blocked, premature execution fails and is retryable.
      }
      if (isBlockedResult.ok && isBlockedResult.value) {
        blockedCount++;
        this.logger.info('Task blocked by dependencies, skipping recovery enqueue', { taskId: task.id });
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

    return { queuedCount, blockedCount };
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
  private async recoverRunningTasks(tasks: readonly Task[]): Promise<number> {
    const now = Date.now();
    let failedCount = 0;

    for (const task of tasks) {
      const workerResult = this.workerRepo.findByTaskId(task.id);
      const workerRegistration = workerResult.ok ? workerResult.value : null;

      if (workerRegistration !== null && this.isProcessAlive(workerRegistration.ownerPid)) {
        // Worker is alive in another process — leave it alone
        this.logger.info('Running task has live worker in another process, skipping', {
          taskId: task.id,
          ownerPid: workerRegistration.ownerPid,
        });
        continue;
      }

      // Guard: verify task is still RUNNING (TOCTOU — another process may have completed it)
      const freshResult = await this.taskRepo.findById(task.id);
      if (freshResult.ok && freshResult.value !== null && isTerminalState(freshResult.value.status)) {
        this.logger.info('Running task already terminal, skipping recovery', {
          taskId: task.id,
          currentStatus: freshResult.value.status,
        });
        continue;
      }

      // ARCHITECTURE EXCEPTION: Direct repository write + TaskFailed emit (double-write).
      // Recovery runs during startup before event handlers are guaranteed to be ready,
      // so we write status directly rather than relying on PersistenceHandler to handle
      // TaskFailed. The subsequent emit notifies DependencyHandler to unblock downstream tasks.
      const updateResult = await this.taskRepo.update(task.id, {
        status: TaskStatus.FAILED,
        completedAt: now,
        exitCode: -1, // Indicates crash
      });

      if (updateResult.ok) {
        failedCount++;
        this.logger.info('Marked crashed task as failed (no live worker)', {
          taskId: task.id,
        });

        // Emit TaskFailed so DependencyHandler resolves deps for downstream tasks
        const failedEmitResult = await this.eventBus.emit('TaskFailed', {
          taskId: task.id,
          error: new AutobeatError(ErrorCode.SYSTEM_ERROR, 'Worker process crashed during execution'),
          exitCode: -1,
        });
        if (!failedEmitResult.ok) {
          this.logger.error('Failed to emit TaskFailed event for crashed task', failedEmitResult.error, {
            taskId: task.id,
          });
        }
      } else {
        this.logger.error('Failed to update crashed task', updateResult.error, {
          taskId: task.id,
        });
      }
    }

    return failedCount;
  }
}
