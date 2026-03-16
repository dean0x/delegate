/**
 * Event-driven worker pool implementation
 * Eliminates race conditions through event-based coordination
 *
 * ARCHITECTURE (v0.5.0): Uses AgentRegistry to resolve the correct agent adapter
 * per task. Requires task.agent to be set (resolved by TaskManager before queueing).
 */

import { ChildProcess } from 'child_process';

import { AgentRegistry } from '../core/agents.js';
import { Task, TaskId, Worker, WorkerId } from '../core/domain.js';
import { BackbeatError, ErrorCode, taskTimeout } from '../core/errors.js';
import { EventBus } from '../core/events/event-bus.js';
import { Logger, OutputCapture, ResourceMonitor, WorkerPool } from '../core/interfaces.js';
import { err, ok, Result } from '../core/result.js';
import { ProcessConnector } from '../services/process-connector.js';

interface WorkerState extends Worker {
  process: ChildProcess;
  task: Task;
  timeoutTimer?: NodeJS.Timeout;
}

export class EventDrivenWorkerPool implements WorkerPool {
  private readonly workers = new Map<WorkerId, WorkerState>();
  private readonly taskToWorker = new Map<TaskId, WorkerId>();
  private readonly processConnector: ProcessConnector;

  constructor(
    private readonly agentRegistry: AgentRegistry,
    private readonly monitor: ResourceMonitor,
    private readonly logger: Logger,
    private readonly eventBus: EventBus,
    outputCapture: OutputCapture,
  ) {
    this.processConnector = new ProcessConnector(outputCapture, logger);
  }

  async spawn(task: Task): Promise<Result<Worker>> {
    this.logger.debug('Spawning worker for task', {
      taskId: task.id,
      prompt: task.prompt.substring(0, 100),
      agent: task.agent ?? 'unknown',
    });

    // Guard: task.agent must be set by TaskManager before reaching worker pool
    const agentProvider = task.agent;
    if (!agentProvider) {
      return err(
        new BackbeatError(
          ErrorCode.WORKER_SPAWN_FAILED,
          'Task has no agent assigned. This may be a task from before v0.5.0. Re-delegate with --agent.',
        ),
      );
    }

    // Check if we can spawn based on resources
    const canSpawnResult = await this.monitor.canSpawnWorker();

    if (!canSpawnResult.ok) {
      return canSpawnResult;
    }

    if (!canSpawnResult.value) {
      return err(new BackbeatError(ErrorCode.INSUFFICIENT_RESOURCES, 'Insufficient resources to spawn worker'));
    }

    // Resolve the agent adapter for this task
    const adapterResult = this.agentRegistry.get(agentProvider);

    if (!adapterResult.ok) {
      return err(adapterResult.error);
    }

    const adapter = adapterResult.value;
    const finalWorkingDirectory = task.workingDirectory || process.cwd();

    // Spawn the process using the resolved adapter
    const spawnResult = adapter.spawn(task.prompt, finalWorkingDirectory, task.id);

    if (!spawnResult.ok) {
      return err(spawnResult.error);
    }

    const { process: childProcess, pid } = spawnResult.value;
    const workerId = WorkerId(`worker-${pid}`);

    // Create worker state
    const worker: WorkerState = {
      id: workerId,
      taskId: task.id,
      pid,
      startedAt: Date.now(),
      cpuUsage: 0,
      memoryUsage: 0,
      process: childProcess,
      task,
    };

    // Store worker
    this.workers.set(workerId, worker);
    this.taskToWorker.set(task.id, workerId);

    // Set up timeout if task has one
    this.setupTimeoutForWorker(worker);

    // Connect process output to OutputCapture
    this.processConnector.connect(childProcess, task.id, (exitCode) => {
      this.handleWorkerCompletion(task.id, exitCode ?? 0);
    });

    this.logger.info('Worker spawned successfully', {
      taskId: task.id,
      workerId: worker.id,
      pid: worker.pid,
      agent: agentProvider,
    });

    return ok(worker);
  }

  async kill(workerId: WorkerId): Promise<Result<void>> {
    const worker = this.workers.get(workerId);

    if (!worker) {
      return err(new BackbeatError(ErrorCode.WORKER_NOT_FOUND, `Worker ${workerId} not found`));
    }

    this.logger.info('Killing worker', {
      workerId,
      taskId: worker.taskId,
      pid: worker.pid,
    });

    try {
      // Clear timeout to prevent race condition
      this.clearTimeoutForWorker(worker);

      // Kill the process
      if (worker.process && !worker.process.killed) {
        worker.process.kill('SIGTERM');

        // Force kill after 5 seconds if still alive
        setTimeout(() => {
          if (!worker.process.killed) {
            worker.process.kill('SIGKILL');
          }
        }, 5000);
      }

      // Clean up worker state
      this.workers.delete(workerId);
      this.taskToWorker.delete(worker.taskId);

      // Decrement worker count
      this.monitor.decrementWorkerCount();

      return ok(undefined);
    } catch (error) {
      return err(new BackbeatError(ErrorCode.WORKER_KILL_FAILED, `Failed to kill worker: ${error}`));
    }
  }

  async killAll(): Promise<Result<void>> {
    const workerIds = Array.from(this.workers.keys());

    this.logger.info('Killing all workers', {
      workerCount: workerIds.length,
    });

    const results = await Promise.allSettled(workerIds.map((workerId) => this.kill(workerId)));

    const failures = results.filter((result) => result.status === 'rejected') as PromiseRejectedResult[];

    if (failures.length > 0) {
      this.logger.error('Some workers failed to kill', undefined, {
        failures: failures.length,
        total: workerIds.length,
      });
    }

    return ok(undefined);
  }

  getWorker(workerId: WorkerId): Result<Worker | null> {
    const worker = this.workers.get(workerId);
    return ok(worker || null);
  }

  getWorkers(): Result<readonly Worker[]> {
    return ok(Object.freeze(Array.from(this.workers.values())));
  }

  getWorkerCount(): number {
    return this.workers.size;
  }

  getWorkerForTask(taskId: TaskId): Result<Worker | null> {
    const workerId = this.taskToWorker.get(taskId);

    if (!workerId) {
      return ok(null);
    }

    const worker = this.workers.get(workerId);
    return ok(worker || null);
  }

  /**
   * Set up timeout for a worker - no race conditions
   */
  private setupTimeoutForWorker(worker: WorkerState): void {
    const timeoutMs = worker.task.timeout;

    // CRITICAL FIX: setTimeout(fn, undefined) executes immediately!
    if (!timeoutMs || timeoutMs <= 0) {
      return; // No timeout configured
    }

    // Create timeout timer
    worker.timeoutTimer = setTimeout(() => {
      this.handleWorkerTimeout(worker.taskId, timeoutMs);
    }, timeoutMs);

    this.logger.debug('Worker timeout set', {
      taskId: worker.taskId,
      workerId: worker.id,
      timeoutMs,
    });
  }

  /**
   * Clear timeout for worker - prevents race conditions
   */
  private clearTimeoutForWorker(worker: WorkerState): void {
    if (worker.timeoutTimer) {
      clearTimeout(worker.timeoutTimer);
      worker.timeoutTimer = undefined;

      this.logger.debug('Worker timeout cleared', {
        taskId: worker.taskId,
        workerId: worker.id,
      });
    }
  }

  /**
   * Handle worker completion - event-driven, no race conditions
   */
  private async handleWorkerCompletion(taskId: TaskId, exitCode: number): Promise<void> {
    const workerId = this.taskToWorker.get(taskId);

    if (!workerId) {
      this.logger.warn('Worker completion for unknown task', { taskId, exitCode });
      return;
    }

    const worker = this.workers.get(workerId);

    if (!worker) {
      this.logger.warn('Worker completion for unknown worker', { taskId, workerId, exitCode });
      return;
    }

    // Clear timeout to prevent race condition
    this.clearTimeoutForWorker(worker);

    // Calculate duration
    const duration = Date.now() - worker.startedAt;

    // Clean up worker state
    this.workers.delete(workerId);
    this.taskToWorker.delete(taskId);
    this.monitor.decrementWorkerCount();

    // Emit appropriate events
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
        error: new BackbeatError(ErrorCode.TASK_EXECUTION_FAILED, `Task failed with exit code ${exitCode}`),
      });
    }

    this.logger.info('Worker completion handled', {
      taskId,
      workerId,
      exitCode,
      duration,
    });
  }

  /**
   * Handle worker timeout - event-driven
   */
  private async handleWorkerTimeout(taskId: TaskId, timeoutMs: number): Promise<void> {
    const workerId = this.taskToWorker.get(taskId);

    if (!workerId) {
      this.logger.warn('Worker timeout for unknown task', { taskId, timeoutMs });
      return;
    }

    const worker = this.workers.get(workerId);

    if (!worker) {
      this.logger.warn('Worker timeout for unknown worker', { taskId, workerId, timeoutMs });
      return;
    }

    this.logger.warn('Worker timed out, killing process', {
      taskId,
      workerId,
      timeoutMs,
      pid: worker.pid,
    });

    // Kill the worker (this will clean up state)
    await this.kill(workerId);

    // Emit timeout event
    await this.eventBus.emit('TaskTimeout', {
      taskId,
      error: taskTimeout(taskId, timeoutMs),
    });
  }
}
