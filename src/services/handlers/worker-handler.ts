/**
 * Worker lifecycle management event handler
 * Manages worker spawning, monitoring, and cleanup through events
 */

import { Configuration } from '../../core/configuration.js';
import { Task, TaskId, TaskStatus, Worker } from '../../core/domain.js';
import { BackbeatError, ErrorCode, taskNotFound } from '../../core/errors.js';
import { EventBus } from '../../core/events/event-bus.js';
import {
  createEvent,
  NextTaskQueryEvent,
  TaskCancellationRequestedEvent,
  TaskCancelledEvent,
  TaskDelegatedEvent,
  TaskQueuedEvent,
  TaskStatusQueryEvent,
} from '../../core/events/events.js';
import { BaseEventHandler } from '../../core/events/handlers.js';
import { Logger, ResourceMonitor, WorkerPool } from '../../core/interfaces.js';
import { err, ok, Result } from '../../core/result.js';

export class WorkerHandler extends BaseEventHandler {
  /**
   * CRITICAL: Spawn burst protection via SERIALIZATION
   *
   * WHY THIS EXISTS:
   * Process creation (fork/exec) is expensive at the OS level. Spawning multiple
   * claude-code processes simultaneously causes:
   * 1. CPU spike from fork/exec system calls
   * 2. Memory spike from loading multiple Node.js runtimes
   * 3. I/O spike from loading code from disk
   *
   * PROTECTION LAYERS:
   * 1. SPAWN SERIALIZATION (spawnLock) - Only one spawn operation runs at a time
   *    This eliminates TOCTOU race conditions where multiple processNextTask() calls
   *    could pass the delay check before any updates lastSpawnTime.
   *
   * 2. SPAWN DELAY (minSpawnDelayMs) - Minimum 10s between spawns
   *    Defense in depth - even with serialization, we enforce a delay to let
   *    each process fully initialize before the next spawn.
   *
   * 3. RESOURCE MONITORING - CPU, memory, settling workers tracking
   *    Prevents spawning when system is already under load.
   *
   * INCIDENT REFERENCE: 2025-10-04
   * Without spawn delay, recovery re-queued 7 tasks → all spawned simultaneously → fork bomb
   *
   * INCIDENT REFERENCE: 2025-12-06
   * Spawn delay alone had TOCTOU race condition - multiple processNextTask() calls
   * could pass the delay check before lastSpawnTime was updated. Fixed by adding
   * spawn serialization via mutex.
   */
  private lastSpawnTime = 0;
  private readonly minSpawnDelayMs: number;
  private readonly SPAWN_BACKOFF_MS = 1000; // Backoff when resources are constrained

  /**
   * Spawn serialization lock - ensures only one spawn operation runs at a time
   * Uses promise chaining: each processNextTask() waits for the previous to complete
   */
  private spawnLock: Promise<void> = Promise.resolve();

  constructor(
    config: Configuration,
    private readonly workerPool: WorkerPool,
    private readonly resourceMonitor: ResourceMonitor,
    private readonly eventBus: EventBus,
    logger: Logger,
  ) {
    super(logger, 'WorkerHandler');
    // Config schema guarantees minSpawnDelayMs has a value (default: 10s)
    this.minSpawnDelayMs = config.minSpawnDelayMs;
  }

  /**
   * Set up event subscriptions - purely event-driven, no polling
   */
  async setup(eventBus: EventBus): Promise<Result<void>> {
    const subscriptions = [
      eventBus.subscribe('TaskQueued', this.handleTaskQueued.bind(this)),
      eventBus.subscribe('TaskCancellationRequested', this.handleTaskCancellation.bind(this)),
    ];

    // Check if any subscription failed
    for (const result of subscriptions) {
      if (!result.ok) {
        return result;
      }
    }

    this.logger.info('WorkerHandler initialized - event-driven processing');
    return ok(undefined);
  }

  /**
   * Clean shutdown - kill all workers
   */
  async teardown(): Promise<void> {
    // Kill all workers
    await this.workerPool.killAll();

    this.logger.info('WorkerHandler shutdown complete');
  }

  /**
   * Handle task queued - process immediately
   */
  private async handleTaskQueued(event: TaskQueuedEvent): Promise<void> {
    this.logger.debug('Received TaskQueued event', {
      taskId: event.taskId,
    });
    await this.handleEvent(event, async (event) => {
      this.logger.debug('Task queued, attempting to process', {
        taskId: event.taskId,
      });

      this.logger.debug('About to call processNextTask()');
      // Process task immediately when queued
      await this.processNextTask();
      this.logger.debug('Completed processNextTask()');

      return ok(undefined);
    });
  }

  /**
   * Handle task cancellation - validate and kill worker if running
   * ARCHITECTURE: Pure event-driven - uses TaskStatusQuery instead of direct repository access
   */
  private async handleTaskCancellation(event: TaskCancellationRequestedEvent): Promise<void> {
    await this.handleEvent(event, async (event) => {
      const { taskId, reason } = event;

      // First validate that task can be cancelled using event-driven query
      const taskResult = await this.eventBus.request<TaskStatusQueryEvent, Task | null>('TaskStatusQuery', { taskId });

      if (!taskResult.ok) {
        this.logger.error('Failed to find task for cancellation', taskResult.error, { taskId });
        return taskResult;
      }

      if (!taskResult.value) {
        this.logger.error('Task not found for cancellation', undefined, { taskId });
        return err(taskNotFound(taskId));
      }

      const task = taskResult.value;

      // Check if task can be cancelled (must be QUEUED or RUNNING)
      if (task.status !== 'queued' && task.status !== 'running') {
        this.logger.warn('Cannot cancel task in current state', {
          taskId,
          status: task.status,
          reason,
        });
        return err(
          new BackbeatError(
            ErrorCode.TASK_CANNOT_CANCEL,
            `Task ${taskId} cannot be cancelled in state ${task.status}`,
            { taskId, status: task.status, reason },
          ),
        );
      }

      // Check if we have a worker for this task
      const workerResult = this.workerPool.getWorkerForTask(taskId);

      if (workerResult.ok && workerResult.value) {
        const worker = workerResult.value;

        this.logger.info('Killing worker for cancelled task', {
          taskId,
          workerId: worker.id,
        });

        // Kill the worker
        const killResult = await this.workerPool.kill(worker.id);

        if (!killResult.ok) {
          this.logger.error('Failed to kill worker for cancelled task', killResult.error, {
            taskId,
            workerId: worker.id,
          });
          return killResult;
        }

        }

      // Emit TaskCancelled so subscribers (CLI wait, persistence) receive terminal state
      const cancelResult = await this.eventBus.emit<TaskCancelledEvent>('TaskCancelled', {
        taskId,
        reason,
      });

      if (!cancelResult.ok) {
        this.logger.error('Failed to emit TaskCancelled event', cancelResult.error, { taskId });
      }

      return ok(undefined);
    });
  }

  // ============================================================================
  // SPAWN SERIALIZATION
  // ============================================================================

  /**
   * Execute a function while holding the spawn lock
   * Ensures only one spawn operation runs at a time, eliminating TOCTOU race conditions
   *
   * HOW IT WORKS:
   * Uses promise chaining - each call waits for the previous to complete before executing.
   * This is a lightweight mutex pattern that doesn't require external dependencies.
   *
   * Example sequence with 3 concurrent calls:
   * T=0: Call1 starts, acquires lock, begins execution
   * T=0: Call2 starts, chains onto Call1's promise, waits
   * T=0: Call3 starts, chains onto Call2's promise, waits
   * T=100ms: Call1 completes, releases lock
   * T=100ms: Call2 executes (sees updated lastSpawnTime from Call1)
   * T=100ms: Call2 sees delay required, schedules retry, releases lock
   * T=100ms: Call3 executes, sees delay required, schedules retry, releases lock
   */
  private async withSpawnLock<T>(fn: () => Promise<T>): Promise<T> {
    // Capture the current lock promise (what we need to wait for)
    const previousLock = this.spawnLock;

    // Create a new promise that will resolve when we're done
    let releaseLock!: () => void;
    const ourLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    // Chain our lock onto the previous one
    this.spawnLock = ourLock;

    // Wait for the previous operation to complete
    await previousLock;

    try {
      // Execute the protected function
      return await fn();
    } finally {
      // Release the lock for the next operation
      releaseLock();
    }
  }

  // ============================================================================
  // EXTRACTED METHODS - processNextTask() decomposition
  // See docs/architecture/HANDLER-DECOMPOSITION-INVARIANTS.md for constraints
  // ============================================================================

  /**
   * Check if spawn should be delayed due to burst protection
   * PURE: No side effects, returns calculation result
   */
  private getSpawnDelayRequired(): { shouldDelay: boolean; delayMs: number } {
    const now = Date.now();
    const timeSinceLastSpawn = now - this.lastSpawnTime;

    if (timeSinceLastSpawn < this.minSpawnDelayMs) {
      return {
        shouldDelay: true,
        delayMs: this.minSpawnDelayMs - timeSinceLastSpawn,
      };
    }

    return { shouldDelay: false, delayMs: 0 };
  }

  /**
   * Handle spawn delay requirement - log and schedule retry
   * INVARIANT: Must schedule retry via setTimeout
   */
  private handleSpawnDelayRequired(delayMs: number, timeSinceLastSpawn: number): void {
    this.logger.debug('Delaying spawn to prevent burst overload', {
      delay: delayMs,
      timeSinceLastSpawn,
      reason: 'fork-bomb prevention',
    });

    setTimeout(() => this.processNextTask(), delayMs);
  }

  /**
   * Handle resource constraint - log and schedule retry with backoff
   * INVARIANT: Must apply SPAWN_BACKOFF_MS delay
   */
  private handleResourcesConstrained(): void {
    this.logger.debug('Resources constrained, applying backoff', {
      backoffMs: this.SPAWN_BACKOFF_MS,
    });

    setTimeout(() => this.processNextTask(), this.SPAWN_BACKOFF_MS);
  }

  /**
   * Handle TaskStarting emission failure
   * INVARIANT: Requeue task WITHOUT emitting TaskFailed
   */
  private async handleTaskStartingFailure(task: Task, error: Error): Promise<void> {
    this.logger.error('Failed to emit TaskStarting event', error, {
      taskId: task.id,
    });

    await this.eventBus.emit('RequeueTask', { task });
  }

  /**
   * Handle worker spawn failure
   * INVARIANT: Requeue task AND emit TaskFailed (both required)
   */
  private async handleSpawnFailure(task: Task, error: Error): Promise<void> {
    this.logger.error('Failed to spawn worker', error, {
      taskId: task.id,
    });

    // INVARIANT: Both RequeueTask AND TaskFailed must be emitted
    await this.eventBus.emit('RequeueTask', { task });
    await this.eventBus.emit('TaskFailed', {
      taskId: task.id,
      error,
      exitCode: 1,
    });
  }

  /**
   * Record successful spawn and emit events
   * INVARIANT: All updates must happen together (atomic success path)
   * - lastSpawnTime update
   * - resourceMonitor.incrementWorkerCount()
   * - resourceMonitor.recordSpawn()
   * - TaskStarted event
   */
  private async recordSpawnSuccessAndEmitEvents(worker: Worker, task: Task): Promise<void> {
    // Update spawn time for throttling
    this.lastSpawnTime = Date.now();

    // Update resource monitor (both calls together)
    this.resourceMonitor.incrementWorkerCount();
    this.resourceMonitor.recordSpawn();

    // Emit TaskStarted event
    await this.eventBus.emit('TaskStarted', {
      taskId: task.id,
      workerId: worker.id,
    });

    this.logger.info('Task started with worker', {
      taskId: task.id,
      workerId: worker.id,
      pid: worker.pid,
    });
  }

  // ============================================================================
  // MAIN ORCHESTRATION METHOD
  // ============================================================================

  /**
   * Process next task if resources available
   * ARCHITECTURE: Uses spawn serialization + delay to prevent burst fork-bomb scenarios
   * See class-level documentation for justification
   *
   * SERIALIZATION: All spawn logic runs inside withSpawnLock() to eliminate TOCTOU races
   * DECOMPOSITION: This method orchestrates extracted methods while
   * preserving all invariants documented in HANDLER-DECOMPOSITION-INVARIANTS.md
   */
  private async processNextTask(): Promise<void> {
    // CRITICAL: All spawn logic must run inside the lock to prevent race conditions
    await this.withSpawnLock(async () => {
      try {
        // Step 1: Check spawn delay (fork-bomb prevention)
        const delayCheck = this.getSpawnDelayRequired();
        if (delayCheck.shouldDelay) {
          const timeSinceLastSpawn = Date.now() - this.lastSpawnTime;
          this.handleSpawnDelayRequired(delayCheck.delayMs, timeSinceLastSpawn);
          return;
        }

        // Step 2: Check resource availability
        const canSpawnResult = await this.resourceMonitor.canSpawnWorker();
        if (!canSpawnResult.ok || !canSpawnResult.value) {
          this.handleResourcesConstrained();
          return;
        }

        // Step 3: Get next task from queue
        const taskResult = await this.eventBus.request<NextTaskQueryEvent, Task | null>('NextTaskQuery', {});
        if (!taskResult.ok || !taskResult.value) {
          return; // No tasks or error
        }

        const task = taskResult.value;
        this.logger.info('Starting task processing', {
          taskId: task.id,
          priority: task.priority,
        });

        // Step 4: Emit TaskStarting event
        const startingResult = await this.eventBus.emit('TaskStarting', {
          taskId: task.id,
        });
        if (!startingResult.ok) {
          await this.handleTaskStartingFailure(task, startingResult.error);
          return;
        }

        // Step 5: Spawn worker
        const workerResult = await this.workerPool.spawn(task);
        if (!workerResult.ok) {
          await this.handleSpawnFailure(task, workerResult.error);
          return;
        }

        // Step 6: Record success and emit events (atomic success path)
        await this.recordSpawnSuccessAndEmitEvents(workerResult.value, task);
      } catch (error) {
        // Normalize unknown error to Error object for type safety
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        this.logger.error('Error in task processing', normalizedError);
      }
    });
  }

  /**
   * Handle worker completion (called by WorkerPool)
   */
  async onWorkerComplete(taskId: TaskId, exitCode: number): Promise<void> {
    try {
      // Update resource monitor
      this.resourceMonitor.decrementWorkerCount();

      // Calculate duration using task startedAt timestamp via event query
      let duration = 0;
      const taskResult = await this.eventBus.request<TaskStatusQueryEvent, Task | null>('TaskStatusQuery', { taskId });
      if (taskResult.ok && taskResult.value?.startedAt) {
        duration = Date.now() - taskResult.value.startedAt;
      }

      if (exitCode === 0) {
        await this.eventBus.emit('TaskCompleted', {
          taskId,
          exitCode,
          duration,
        });
      } else {
        await this.eventBus.emit('TaskFailed', {
          taskId,
          exitCode,
          error: new Error(`Task failed with exit code ${exitCode}`),
        });
      }

      this.logger.info('Worker completed', {
        taskId,
        exitCode,
        duration,
      });
    } catch (error) {
      this.logger.error('Error handling worker completion', error as Error, {
        taskId,
        exitCode,
      });
    }
  }

  /**
   * Handle worker timeout (called by WorkerPool)
   */
  async onWorkerTimeout(taskId: TaskId, error: BackbeatError): Promise<void> {
    try {
      // Update resource monitor
      this.resourceMonitor.decrementWorkerCount();

      await this.eventBus.emit('TaskTimeout', {
        taskId,
        error,
      });

      this.logger.warn('Worker timed out', {
        taskId,
        error: error.message,
      });
    } catch (err) {
      this.logger.error('Error handling worker timeout', err as Error, {
        taskId,
      });
    }
  }

  /**
   * Get worker statistics
   */
  getWorkerStats(): {
    workerCount: number;
    workers: readonly Worker[];
    canSpawn: boolean;
  } {
    const workersResult = this.workerPool.getWorkers();

    return {
      workerCount: this.workerPool.getWorkerCount(),
      workers: workersResult.ok ? workersResult.value : [],
      canSpawn: false, // Would need async call to determine
    };
  }
}
