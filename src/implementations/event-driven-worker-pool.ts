/**
 * Event-driven worker pool implementation
 * Eliminates race conditions through event-based coordination
 *
 * ARCHITECTURE (Phase 3): Uses TmuxConnectorPort for all worker lifecycle.
 * Workers are tmux sessions identified by sessionName, not PIDs.
 * No ChildProcess or ProcessConnector references — see AC-10.
 *
 * ARCHITECTURE (v0.5.0): Uses AgentRegistry to resolve the correct agent adapter
 * per task. Requires task.agent to be set (resolved by TaskManager before queueing).
 */

import type { AgentRegistry } from '../core/agents.js';
import type { Task, TaskId, Worker, WorkerId } from '../core/domain.js';
import { AutobeatError, ErrorCode, taskTimeout } from '../core/errors.js';
import type { EventBus } from '../core/events/event-bus.js';
import type {
  Logger,
  OutputCapture,
  OutputRepository,
  ResourceMonitor,
  WorkerPool,
  WorkerRepository,
} from '../core/interfaces.js';
import { err, ok, type Result } from '../core/result.js';
import type { OutputMessage, SpawnCallbacks, TmuxConnectorPort, TmuxHandle } from '../core/tmux-types.js';

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * WorkerState for tmux-backed workers.
 * DESIGN DECISION: process/pid removed — tmux sessions have no single meaningful PID.
 * Worker.pid is set to 0 as sentinel (per API-2); handle carries the session reference.
 */
interface WorkerState extends Worker {
  readonly handle: TmuxHandle;
  readonly task: Task;
  cleanupFn?: (taskId: string) => void;
  timeoutTimer?: NodeJS.Timeout;
  heartbeatTimer?: NodeJS.Timeout;
  flushInterval?: NodeJS.Timeout;
  /** G2: Guards against double completion (onExit fires after kill already cleaned up) */
  completionHandled: boolean;
}

export interface EventDrivenWorkerPoolDeps {
  readonly agentRegistry: AgentRegistry;
  readonly monitor: ResourceMonitor;
  readonly logger: Logger;
  readonly eventBus: EventBus;
  readonly outputCapture: OutputCapture;
  readonly workerRepository: WorkerRepository;
  readonly outputRepository: OutputRepository;
  readonly outputFlushIntervalMs?: number;
  /** Phase 3: Injected TmuxConnector — not constructed internally (DI) */
  readonly tmuxConnector: TmuxConnectorPort;
  /** Phase 3: Base directory for session data (sentinels, messages) */
  readonly sessionsDir: string;
}

export class EventDrivenWorkerPool implements WorkerPool {
  private readonly workers = new Map<WorkerId, WorkerState>();
  private readonly taskToWorker = new Map<TaskId, WorkerId>();
  private readonly flushingInProgress = new Set<TaskId>();

  private readonly agentRegistry: AgentRegistry;
  private readonly monitor: ResourceMonitor;
  private readonly logger: Logger;
  private readonly eventBus: EventBus;
  private readonly workerRepository: WorkerRepository;
  private readonly outputCapture: OutputCapture;
  private readonly outputRepository: OutputRepository;
  private readonly outputFlushIntervalMs: number;
  private readonly tmuxConnector: TmuxConnectorPort;
  private readonly sessionsDir: string;

  constructor(deps: EventDrivenWorkerPoolDeps) {
    this.agentRegistry = deps.agentRegistry;
    this.monitor = deps.monitor;
    this.logger = deps.logger;
    this.eventBus = deps.eventBus;
    this.workerRepository = deps.workerRepository;
    this.outputCapture = deps.outputCapture;
    this.outputRepository = deps.outputRepository;
    this.outputFlushIntervalMs = deps.outputFlushIntervalMs ?? 1000;
    this.tmuxConnector = deps.tmuxConnector;
    this.sessionsDir = deps.sessionsDir;
  }

  async spawn(task: Task): Promise<Result<Worker>> {
    this.logger.debug('Spawning tmux worker for task', {
      taskId: task.id,
      prompt: task.prompt.substring(0, 100),
      agent: task.agent ?? 'unknown',
    });

    // Step 1: Guard — task.agent must be set by TaskManager before reaching worker pool
    const agentProvider = task.agent;
    if (!agentProvider) {
      return err(
        new AutobeatError(
          ErrorCode.WORKER_SPAWN_FAILED,
          'Task has no agent assigned. This may be a task from before v0.5.0. Re-delegate with --agent.',
        ),
      );
    }

    // Step 2: Resource check
    const canSpawnResult = await this.monitor.canSpawnWorker();
    if (!canSpawnResult.ok) {
      return canSpawnResult;
    }
    if (!canSpawnResult.value) {
      return err(new AutobeatError(ErrorCode.INSUFFICIENT_RESOURCES, 'Insufficient resources to spawn worker'));
    }

    // Step 3: Resolve adapter
    const adapterResult = this.agentRegistry.get(agentProvider);
    if (!adapterResult.ok) {
      return err(adapterResult.error);
    }
    const adapter = adapterResult.value;

    // Step 4: Build tmux config
    const buildResult = adapter.buildTmuxCommand({
      prompt: task.prompt,
      workingDirectory: task.workingDirectory || process.cwd(),
      taskId: task.id,
      model: task.model,
      orchestratorId: task.orchestratorId,
      jsonSchema: task.jsonSchema,
      systemPrompt: task.systemPrompt,
      sessionsDir: this.sessionsDir,
    });
    if (!buildResult.ok) {
      return err(buildResult.error);
    }
    const { config, prompt } = buildResult.value;

    // Step 5: Create callbacks
    const callbacks = this.createCallbacks(task.id);

    // Step 6: Spawn tmux session
    const spawnResult = this.tmuxConnector.spawn(config, callbacks);
    if (!spawnResult.ok) {
      return err(spawnResult.error);
    }
    const handle = spawnResult.value;

    // Capture adapter cleanup at spawn time (P3: same pattern as old process-based pool)
    const cleanupFn = task.systemPrompt ? (taskId: string) => adapter.cleanup(taskId) : undefined;

    // Step 7: Register worker in maps + DB
    const registerResult = this.registerWorker(task, handle, agentProvider, cleanupFn);
    if (!registerResult.ok) {
      // Rollback: destroy the session we just created
      const destroyResult = this.tmuxConnector.destroy(handle);
      if (!destroyResult.ok) {
        this.logger.warn('Failed to destroy session after registration failure', {
          sessionName: handle.sessionName,
          destroyError: destroyResult.error.message,
        });
      }
      return err(registerResult.error);
    }
    const worker = registerResult.value;

    // Step 8: Setup timeout + heartbeat
    this.setupTimeoutForWorker(worker);
    this.setupHeartbeatForWorker(worker);

    // Step 9: Start periodic output flushing
    this.startFlushing(worker);

    // Step 10: Send prompt via sendKeys
    const sendResult = this.tmuxConnector.sendKeys(handle, prompt + '\n');
    if (!sendResult.ok) {
      // Rollback: cleanup the worker state + destroy session
      this.cleanupWorkerState(worker.id, task.id);
      const destroyResult = this.tmuxConnector.destroy(handle);
      if (!destroyResult.ok) {
        this.logger.warn('Failed to destroy session after sendKeys failure', {
          sessionName: handle.sessionName,
          destroyError: destroyResult.error.message,
        });
      }
      return err(
        new AutobeatError(
          ErrorCode.WORKER_SPAWN_FAILED,
          `Failed to send prompt to tmux session: ${sendResult.error.message}`,
        ),
      );
    }

    this.logger.info('Tmux worker spawned successfully', {
      taskId: task.id,
      workerId: worker.id,
      sessionName: handle.sessionName,
      agent: agentProvider,
    });

    return ok(worker);
  }

  async kill(workerId: WorkerId): Promise<Result<void>> {
    const worker = this.workers.get(workerId);

    if (!worker) {
      return err(new AutobeatError(ErrorCode.WORKER_NOT_FOUND, `Worker ${workerId} not found`));
    }

    this.logger.info('Killing tmux worker', {
      workerId,
      taskId: worker.taskId,
      sessionName: worker.handle.sessionName,
    });

    try {
      // Step 1: Clear timeout, stop flushing, final flush (Edge Case I)
      this.clearTimeoutForWorker(worker);
      this.stopFlushing(worker);
      await this.flushOutput(worker.taskId);

      // Step 2: Check if session is still alive
      const aliveResult = this.tmuxConnector.isAlive(worker.handle);
      const isAlive = aliveResult.ok ? aliveResult.value : false;

      if (!isAlive) {
        // Session already dead — skip to cleanup
        this.cleanupWorkerState(workerId, worker.taskId);
        return ok(undefined);
      }

      // Step 3: Send Ctrl+C (graceful interrupt)
      const ctrlCResult = this.tmuxConnector.sendControlKeys(worker.handle, 'C-c');
      if (!ctrlCResult.ok) {
        this.logger.warn('sendControlKeys C-c failed, proceeding to force-destroy', {
          workerId,
          error: ctrlCResult.error.message,
        });
      }

      // Step 4: Poll isAlive every 250ms for up to 5s (max 20 iterations — bounded loop)
      const POLL_INTERVAL_MS = 250;
      const MAX_ITERATIONS = 20;
      let iteration = 0;
      let sessionDied = false;

      while (iteration < MAX_ITERATIONS) {
        await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        iteration++;

        const checkResult = this.tmuxConnector.isAlive(worker.handle);
        if (checkResult.ok && !checkResult.value) {
          sessionDied = true;
          break;
        }
      }

      // Step 5: Force-destroy if still alive after grace period
      if (!sessionDied) {
        this.logger.warn('Session still alive after grace period, force-destroying', {
          workerId,
          sessionName: worker.handle.sessionName,
          iterations: iteration,
        });
        const destroyResult = this.tmuxConnector.destroy(worker.handle);
        if (!destroyResult.ok) {
          this.logger.warn('Force-destroy failed', {
            workerId,
            error: destroyResult.error.message,
          });
        }
      }

      // Step 6: Cleanup worker state
      this.cleanupWorkerState(workerId, worker.taskId);

      return ok(undefined);
    } catch (error) {
      return err(new AutobeatError(ErrorCode.WORKER_KILL_FAILED, `Failed to kill worker: ${error}`));
    }
  }

  async killAll(): Promise<Result<void>> {
    const workerIds = Array.from(this.workers.keys());

    this.logger.info('Killing all tmux workers', {
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

    // Safety net: dispose catches orphaned sessions
    this.tmuxConnector.dispose();

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

  // ─── Private: callbacks ────────────────────────────────────────────────────

  /**
   * Build SpawnCallbacks for a task — wires output capture + exit handling.
   * DESIGN DECISION: callbacks are closures over taskId; no circular state reference.
   */
  private createCallbacks(taskId: TaskId): SpawnCallbacks {
    return {
      onOutput: (msg: OutputMessage) => {
        // AC-7: route output to OutputCapture with correct type mapping
        // EC-7: 'result' type maps to 'stdout'
        const captureType: 'stdout' | 'stderr' = msg.type === 'stderr' ? 'stderr' : 'stdout';
        const captureResult = this.outputCapture.capture(taskId, captureType, msg.content);
        if (!captureResult.ok) {
          this.logger.error('Failed to capture output', captureResult.error, { taskId });
        }
      },
      onExit: (code: number | null, _signal?: string) => {
        // AC-8: stop flushing, final flush, clear, then handle completion
        // EC-8: null code maps to 0

        // Find worker by taskId to stop its flush interval
        const workerId = this.taskToWorker.get(taskId);
        if (workerId) {
          const worker = this.workers.get(workerId);
          if (worker) this.stopFlushing(worker);
        }

        this.flushOutput(taskId)
          .catch((e) => this.logger.error('Final flush failed', toError(e), { taskId }))
          .finally(() => {
            this.outputCapture.clear(taskId);
            this.handleWorkerCompletion(taskId, code ?? 0);
          });
      },
    };
  }

  // ─── Private: flushing ────────────────────────────────────────────────────

  /**
   * Start periodic output flushing for a worker.
   * G3: backpressure guard prevents concurrent flushes for the same task.
   */
  private startFlushing(worker: WorkerState): void {
    const interval = setInterval(() => {
      if (this.flushingInProgress.has(worker.taskId)) {
        this.logger.debug('Skipping flush — previous flush still in-flight', { taskId: worker.taskId });
        return;
      }
      this.flushingInProgress.add(worker.taskId);
      this.flushOutput(worker.taskId)
        .catch((e) => this.logger.error('Periodic flush failed', toError(e), { taskId: worker.taskId }))
        .finally(() => this.flushingInProgress.delete(worker.taskId));
    }, this.outputFlushIntervalMs);
    interval.unref();
    worker.flushInterval = interval;
  }

  /**
   * Stop periodic flushing for a worker.
   */
  private stopFlushing(worker: WorkerState): void {
    if (worker.flushInterval) {
      clearInterval(worker.flushInterval);
      worker.flushInterval = undefined;
    }
    this.flushingInProgress.delete(worker.taskId);
  }

  /**
   * Flush accumulated in-memory output to DB.
   */
  private async flushOutput(taskId: TaskId): Promise<void> {
    const outputResult = this.outputCapture.getOutput(taskId);
    if (!outputResult.ok || outputResult.value.totalSize === 0) return;

    const saveResult = await this.outputRepository.save(taskId, outputResult.value);
    if (!saveResult.ok) {
      this.logger.error('Failed to persist output', saveResult.error, { taskId });
    }
  }

  // ─── Private: worker registration ─────────────────────────────────────────

  /**
   * Create worker state, store in maps, and register in DB.
   * Returns the worker or rolls back on UNIQUE violation.
   *
   * AC-3: WorkerId format is `worker-beat-{taskId}`
   * API-2: Worker.pid = 0 (tmux sessions have no single meaningful PID)
   * API-3: WorkerRegistration.sessionName populated with tmux session name
   */
  private registerWorker(
    task: Task,
    handle: TmuxHandle,
    agentProvider: string,
    cleanupFn?: (taskId: string) => void,
  ): Result<WorkerState> {
    const workerId: WorkerId = `worker-beat-${task.id}` as WorkerId;
    const worker: WorkerState = {
      id: workerId,
      taskId: task.id,
      pid: 0, // Sentinel: tmux sessions have no single meaningful PID (API-2)
      startedAt: Date.now(),
      cpuUsage: 0,
      memoryUsage: 0,
      handle,
      task,
      cleanupFn,
      completionHandled: false,
    };

    this.workers.set(workerId, worker);
    this.taskToWorker.set(task.id, workerId);

    const regResult = this.workerRepository.register({
      workerId,
      taskId: task.id,
      pid: 0, // No PID for tmux workers
      ownerPid: process.pid,
      agent: agentProvider,
      startedAt: Date.now(),
      sessionName: handle.sessionName, // API-3: session name for tmux liveness checks
    });
    if (!regResult.ok) {
      // Rollback in-memory state (session destruction is caller's responsibility)
      this.workers.delete(workerId);
      this.taskToWorker.delete(task.id);
      return err(regResult.error);
    }

    return ok(worker);
  }

  // ─── Private: cleanup ─────────────────────────────────────────────────────

  /**
   * Remove worker from in-memory maps, decrement monitor, unregister from DB.
   * Shared by kill() and handleWorkerCompletion().
   */
  private cleanupWorkerState(workerId: WorkerId, taskId: TaskId): void {
    const worker = this.workers.get(workerId);

    // Clear all timers before removing from maps
    if (worker) {
      if (worker.heartbeatTimer) {
        clearInterval(worker.heartbeatTimer);
        worker.heartbeatTimer = undefined;
      }
      if (worker.timeoutTimer) {
        clearTimeout(worker.timeoutTimer);
        worker.timeoutTimer = undefined;
      }
      this.stopFlushing(worker);
    }

    this.workers.delete(workerId);
    this.taskToWorker.delete(taskId);
    this.monitor.decrementWorkerCount();

    // Unregister from DB (log and continue on error)
    const unregResult = this.workerRepository.unregister(workerId);
    if (!unregResult.ok) {
      this.logger.error('Failed to unregister worker from DB', unregResult.error, { workerId });
    }

    // Best-effort cleanup of task-scoped resources (e.g. system prompt temp files)
    if (worker?.cleanupFn) {
      try {
        worker.cleanupFn(taskId);
      } catch (cleanupErr) {
        this.logger.warn('Adapter cleanup() threw — task-scoped resources may not be freed', {
          taskId,
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        });
      }
    }
  }

  // ─── Private: timeout ─────────────────────────────────────────────────────

  private setupTimeoutForWorker(worker: WorkerState): void {
    const timeoutMs = worker.task.timeout;

    // CRITICAL FIX: setTimeout(fn, undefined) executes immediately!
    if (!timeoutMs || timeoutMs <= 0) {
      return;
    }

    worker.timeoutTimer = setTimeout(() => {
      this.handleWorkerTimeout(worker.taskId, timeoutMs);
    }, timeoutMs);

    this.logger.debug('Worker timeout set', {
      taskId: worker.taskId,
      workerId: worker.id,
      timeoutMs,
    });
  }

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

  // ─── Private: heartbeat ───────────────────────────────────────────────────

  /**
   * Set up a periodic heartbeat timer.
   * Phase 3 enhancement: calls isAlive() to detect dead tmux sessions.
   *
   * DECISION: 30s heartbeat interval, 90s staleness threshold.
   * Why: balance between write load and detection speed. Session check is additional safety.
   * timer.unref() prevents the timer from keeping the Node.js process alive.
   */
  private setupHeartbeatForWorker(worker: WorkerState): void {
    const timer = setInterval(() => {
      // DB heartbeat update
      const result = this.workerRepository.updateHeartbeat(worker.id);
      if (!result.ok) {
        this.logger.warn('Heartbeat update failed', {
          workerId: worker.id,
          error: result.error.message,
        });
      }

      // AC-5: session liveness check
      const aliveResult = this.tmuxConnector.isAlive(worker.handle);
      if (aliveResult.ok && !aliveResult.value) {
        this.logger.warn('Heartbeat detected dead tmux session', {
          workerId: worker.id,
          taskId: worker.taskId,
          sessionName: worker.handle.sessionName,
        });
        // Trigger completion with exit code 1 (crashed)
        this.handleWorkerCompletion(worker.taskId, 1);
      }
    }, 30_000);
    timer.unref();
    worker.heartbeatTimer = timer;
  }

  // ─── Private: completion ──────────────────────────────────────────────────

  /**
   * Handle worker completion — event-driven, no race conditions.
   *
   * G2: Double-completion guard — completionHandled flag prevents duplicate events
   * when both onExit callback and explicit kill() call this concurrently.
   */
  private handleWorkerCompletion(taskId: TaskId, exitCode: number): void {
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

    // G2: Double-completion guard
    if (worker.completionHandled) {
      this.logger.debug('Worker completion already handled — ignoring duplicate', { taskId, workerId, exitCode });
      return;
    }
    worker.completionHandled = true;

    const duration = Date.now() - worker.startedAt;

    // Clear timeout before cleanup to prevent race condition
    this.clearTimeoutForWorker(worker);
    this.cleanupWorkerState(workerId, taskId);

    // Emit appropriate events (fire-and-forget — matches existing pattern)
    if (exitCode === 0) {
      this.eventBus
        .emit('TaskCompleted', { taskId, exitCode, duration })
        .catch((e) => this.logger.error('Failed to emit TaskCompleted', toError(e), { taskId }));
    } else {
      this.eventBus
        .emit('TaskFailed', {
          taskId,
          exitCode,
          error: new AutobeatError(ErrorCode.TASK_EXECUTION_FAILED, `Task failed with exit code ${exitCode}`),
        })
        .catch((e) => this.logger.error('Failed to emit TaskFailed', toError(e), { taskId }));
    }

    this.logger.info('Worker completion handled', {
      taskId,
      workerId,
      exitCode,
      duration,
    });
  }

  /**
   * Handle worker timeout — kill the worker and emit TaskTimeout event.
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

    this.logger.warn('Worker timed out, killing session', {
      taskId,
      workerId,
      timeoutMs,
      sessionName: worker.handle.sessionName,
    });

    await this.kill(workerId);

    await this.eventBus.emit('TaskTimeout', {
      taskId,
      error: taskTimeout(taskId, timeoutMs),
    });
  }
}
