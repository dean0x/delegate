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
import type { Task, TaskId, Worker } from '../core/domain.js';
import { WorkerId } from '../core/domain.js';
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
import type {
  OutputMessage,
  SpawnCallbacks,
  TmuxConnectorPort,
  TmuxHandle,
  TmuxSpawnCoreConfig,
} from '../core/tmux-types.js';

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * Options bundle for launchAndRegister — bundles the 6 spawn-time parameters
 * that were previously positional args to make call sites self-documenting.
 */
interface LaunchParams {
  readonly task: Task;
  readonly config: TmuxSpawnCoreConfig;
  readonly prompt: string;
  readonly callbacks: SpawnCallbacks;
  readonly agentProvider: string;
  readonly cleanupFn: ((taskId: string) => void) | undefined;
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

/**
 * Entry in the persistent session map.
 * DESIGN DECISION (Phase 5): WorkerId is stored so reuseSession can look up the
 * WorkerState and update its task reference when reusing for a new iteration.
 */
interface PersistentSessionEntry {
  readonly handle: TmuxHandle;
  readonly workerId: WorkerId;
}

export class EventDrivenWorkerPool implements WorkerPool {
  private readonly workers = new Map<WorkerId, WorkerState>();
  private readonly taskToWorker = new Map<TaskId, WorkerId>();
  private readonly flushingInProgress = new Set<TaskId>();

  /**
   * Persistent session map: key → { handle, workerId }.
   * Populated when spawn() is called for a task with persistentSessionKey set.
   * The entry lives for the lifetime of the loop; cleanupPersistentSession() removes it.
   *
   * DESIGN DECISION (Phase 5): Persistent sessions are stored separately from the
   * regular workers map so the reuse check is O(1) without scanning workers.
   */
  private readonly persistentSessions = new Map<string, PersistentSessionEntry>();

  /**
   * Per-key concurrency guard: prevents two simultaneous reuse attempts for the same key.
   * Set to true while reuseSession() is executing for that key; cleared when done.
   */
  private readonly reuseInProgress = new Set<string>();

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

    // Capture adapter cleanup at spawn time (P3: same pattern as old process-based pool)
    const cleanupFn = task.systemPrompt ? (taskId: string) => adapter.cleanup(taskId) : undefined;

    // Step 5b: Check for persistent session reuse (Phase 5)
    const psk = task.persistentSessionKey;
    if (psk) {
      // Check concurrent reuse guard
      if (this.reuseInProgress.has(psk)) {
        this.logger.warn('Concurrent reuse attempt for persistent session key — spawning fresh', {
          taskId: task.id,
          persistentSessionKey: psk,
        });
      } else {
        const existing = this.persistentSessions.get(psk);
        if (existing) {
          const aliveResult = this.tmuxConnector.isAlive(existing.handle);
          if (aliveResult.ok && aliveResult.value) {
            // Reuse the alive session
            return await this.reuseSession(task, psk, existing, prompt);
          }
          // Session is dead — clean up stale entry and fall through to fresh spawn
          this.logger.info('Persistent session dead — spawning fresh', {
            taskId: task.id,
            persistentSessionKey: psk,
            sessionName: existing.handle.sessionName,
          });
          this.persistentSessions.delete(psk);
        }
      }
    }

    // Steps 6-10: spawn session, register, wire timers, send prompt
    const result = this.launchAndRegister({ task, config, prompt, callbacks, agentProvider, cleanupFn });

    // After successful fresh spawn with a persistent key, register in persistentSessions map
    if (result.ok && psk) {
      const workerId = WorkerId(`worker-beat-${task.id}`);
      const worker = this.workers.get(workerId);
      if (worker) {
        this.persistentSessions.set(psk, { handle: worker.handle, workerId: worker.id });
      }
    }

    return result;
  }

  /**
   * Reuse an existing persistent tmux session for a new loop iteration.
   *
   * Protocol:
   * 1. Acquire per-key reuse lock (prevents concurrent reuse races)
   * 2. Update AUTOBEAT_TASK_ID env var in the tmux session
   * 3. Send /clear to reset agent context
   * 4. Wait 300ms for /clear to settle
   * 5. Register the new task against the existing worker state
   * 6. Send new prompt via sendKeys
   * 7. Release reuse lock
   *
   * DESIGN DECISION (Phase 5): On any failure, fall through to fresh spawn by
   * destroying the stale session and removing it from persistentSessions. This
   * prevents the loop from stalling on a broken persistent session.
   */
  private async reuseSession(
    task: Task,
    key: string,
    entry: PersistentSessionEntry,
    prompt: string,
  ): Promise<Result<Worker>> {
    this.reuseInProgress.add(key);
    try {
      const { handle, workerId } = entry;

      this.logger.info('Reusing persistent tmux session for loop iteration', {
        taskId: task.id,
        persistentSessionKey: key,
        sessionName: handle.sessionName,
        existingWorkerId: workerId,
      });

      // Update AUTOBEAT_TASK_ID in the session so the Stop hook attributes output to
      // the new task ID.
      const setEnvResult = this.tmuxConnector.setEnvironment(handle, 'AUTOBEAT_TASK_ID', task.id);
      if (!setEnvResult.ok) {
        this.logger.warn('Failed to update AUTOBEAT_TASK_ID — destroying persistent session', {
          taskId: task.id,
          key,
          error: setEnvResult.error.message,
        });
        this.cleanupPersistentSession(key);
        return err(setEnvResult.error);
      }

      // Send /clear to reset agent context
      const clearResult = this.tmuxConnector.sendKeys(handle, '/clear\n');
      if (!clearResult.ok) {
        this.logger.warn('Failed to send /clear to persistent session — destroying', {
          taskId: task.id,
          key,
          error: clearResult.error.message,
        });
        this.cleanupPersistentSession(key);
        return err(clearResult.error);
      }

      // Wait for /clear to settle before registering new output handler
      await new Promise<void>((resolve) => setTimeout(resolve, 300));

      // Re-map the existing worker entry to the new task.
      // The existing WorkerState handle stays the same — only the task tracking changes.
      const existingWorker = this.workers.get(workerId);
      if (!existingWorker) {
        // Worker was cleaned up between liveness check and reuse — spawn fresh
        this.logger.warn('Persistent session worker state missing — spawning fresh', {
          taskId: task.id,
          key,
        });
        this.persistentSessions.delete(key);
        return err(new AutobeatError(ErrorCode.WORKER_SPAWN_FAILED, 'Persistent session worker state not found'));
      }

      // Update taskToWorker so future lookups find the worker via the new taskId.
      // Remove the old mapping (previous iteration's taskId → workerId).
      this.taskToWorker.delete(existingWorker.task.id);
      this.taskToWorker.set(task.id, workerId);

      // Send new prompt
      const sendResult = this.tmuxConnector.sendKeys(handle, prompt + '\n');
      if (!sendResult.ok) {
        this.logger.warn('Failed to send prompt to reused session — destroying', {
          taskId: task.id,
          key,
          error: sendResult.error.message,
        });
        this.cleanupPersistentSession(key);
        return err(sendResult.error);
      }

      this.logger.info('Persistent session reused successfully', {
        taskId: task.id,
        sessionName: handle.sessionName,
        key,
      });

      return ok(existingWorker);
    } finally {
      this.reuseInProgress.delete(key);
    }
  }

  /**
   * Steps 6-10 of spawn(): spawn tmux session, register worker in maps + DB, wire timers,
   * and send prompt. Extracted to keep spawn() readable and rollback logic co-located.
   */
  private launchAndRegister(params: LaunchParams): Result<Worker> {
    const { task, config, prompt, callbacks, agentProvider, cleanupFn } = params;

    // Step 6: Spawn tmux session
    const spawnResult = this.tmuxConnector.spawn(config, callbacks);
    if (!spawnResult.ok) {
      return err(spawnResult.error);
    }
    const handle = spawnResult.value;

    // Step 7: Register worker in maps + DB
    const registerResult = this.registerWorker(task, handle, agentProvider, cleanupFn);
    if (!registerResult.ok) {
      // Rollback: destroy the session we just created
      this.destroySessionWithWarning(handle, 'registration failure');
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
      this.destroySessionWithWarning(handle, 'sendKeys failure');
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

  /**
   * Destroy and remove the persistent session registered under the given key.
   * Called by LoopHandler when a loop completes, fails terminally, or is cancelled.
   * No-op if no session is registered for the key.
   *
   * DESIGN DECISION (Phase 5): destroy() is called on the tmux connector so that
   * TmuxConnector's cleanup path (watchers, cleanup fn, session directory) runs
   * uniformly whether the session exits naturally or is explicitly torn down.
   */
  cleanupPersistentSession(key: string): void {
    const entry = this.persistentSessions.get(key);
    if (!entry) return;

    this.persistentSessions.delete(key);

    const destroyResult = this.tmuxConnector.destroy(entry.handle);
    if (!destroyResult.ok) {
      this.logger.warn('Failed to destroy persistent session during cleanup', {
        persistentSessionKey: key,
        sessionName: entry.handle.sessionName,
        error: destroyResult.error.message,
      });
    } else {
      this.logger.info('Persistent session cleaned up', {
        persistentSessionKey: key,
        sessionName: entry.handle.sessionName,
      });
    }
  }

  /**
   * Attempt to destroy a tmux session, logging a warning on failure.
   * Used for rollback paths in launchAndRegister() where a session was created
   * but a subsequent step failed and the session must be torn down.
   */
  private destroySessionWithWarning(handle: TmuxHandle, context: string): void {
    const destroyResult = this.tmuxConnector.destroy(handle);
    if (!destroyResult.ok) {
      this.logger.warn(`Failed to destroy session after ${context}`, {
        sessionName: handle.sessionName,
        destroyError: destroyResult.error.message,
      });
    }
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

      // Steps 2-5: graceful shutdown (C-c → wait → force-destroy if needed)
      const didExit = await this.gracefulShutdownSession(worker, workerId);
      if (!didExit) {
        // Session was already dead before we started — cleanup and return
        this.cleanupWorkerState(workerId, worker.taskId);
        return ok(undefined);
      }

      // Step 6: Cleanup worker state
      this.cleanupWorkerState(workerId, worker.taskId);

      return ok(undefined);
    } catch (error) {
      return err(new AutobeatError(ErrorCode.WORKER_KILL_FAILED, `Failed to kill worker: ${error}`));
    }
  }

  /**
   * Steps 2-5 of kill(): check liveness, send C-c, wait, force-destroy if needed.
   * Returns false if the session was already dead (caller should skip to cleanup).
   */
  private async gracefulShutdownSession(worker: WorkerState, workerId: WorkerId): Promise<boolean> {
    // Step 2: Check if session is still alive
    const aliveResult = this.tmuxConnector.isAlive(worker.handle);
    const isAlive = aliveResult.ok ? aliveResult.value : false;

    if (!isAlive) {
      return false;
    }

    // Step 3: Send Ctrl+C (graceful interrupt)
    const ctrlCResult = this.tmuxConnector.sendControlKeys(worker.handle, 'C-c');
    if (!ctrlCResult.ok) {
      this.logger.warn('sendControlKeys C-c failed, proceeding to force-destroy', {
        workerId,
        error: ctrlCResult.error.message,
      });
    }

    // Step 4: Wait 3s grace period for session to exit after C-c, then check once.
    // DECISION: single wait + single check instead of 20-iteration poll. Each isAlive()
    // call is a blocking spawnSync; 20 sequential calls block the event loop for up to 5s.
    // With killAll(), the original approach serialises N workers × 20 syscalls. A single
    // 3s await followed by one isAlive() check achieves the same result with 1 syscall.
    await new Promise<void>((resolve) => setTimeout(resolve, 3_000));

    const checkResult = this.tmuxConnector.isAlive(worker.handle);
    const sessionDied = checkResult.ok && !checkResult.value;

    // Step 5: Force-destroy if still alive after grace period
    if (!sessionDied) {
      this.logger.warn('Session still alive after grace period, force-destroying', {
        workerId,
        sessionName: worker.handle.sessionName,
      });
      const destroyResult = this.tmuxConnector.destroy(worker.handle);
      if (!destroyResult.ok) {
        this.logger.warn('Force-destroy failed', {
          workerId,
          error: destroyResult.error.message,
        });
      }
    }

    return true;
  }

  async killAll(): Promise<Result<void>> {
    const workerIds = Array.from(this.workers.keys());

    this.logger.info('Killing all tmux workers', {
      workerCount: workerIds.length,
    });

    // DECISION: Promise.all (not allSettled) — kill() returns Result<void>, never rejects
    // (all errors are caught internally and returned as err(...)). Promise.all cannot
    // short-circuit on rejection here. Using all() over allSettled() keeps the types simpler
    // while providing the same semantics. Failures are surfaced via failureCount below.
    const results = await Promise.all(workerIds.map((workerId) => this.kill(workerId)));

    const failureCount = results.filter((r) => !r.ok).length;

    if (failureCount > 0) {
      this.logger.error('Some workers failed to kill', undefined, {
        failures: failureCount,
        total: workerIds.length,
      });
    }

    // Destroy all persistent sessions that were not already cleaned up by kill()
    // above (persistent sessions may still be alive after all regular workers are gone).
    for (const key of Array.from(this.persistentSessions.keys())) {
      this.cleanupPersistentSession(key);
    }

    // Safety net: dispose catches orphaned sessions
    this.tmuxConnector.dispose();

    if (failureCount > 0) {
      return err(
        new AutobeatError(
          ErrorCode.WORKER_KILL_FAILED,
          `${failureCount} of ${workerIds.length} workers failed to kill — tmux sessions may be orphaned`,
        ),
      );
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

        // Stop the flush interval and heartbeat timer BEFORE the async flush gap.
        // The heartbeat timer (if it fired during the flush) could enter handleWorkerCompletion
        // concurrently and emit a duplicate event. Clearing it here is defense-in-depth:
        // completionHandled in handleWorkerCompletion remains the canonical de-duplication gate.
        const workerId = this.taskToWorker.get(taskId);
        if (workerId) {
          const worker = this.workers.get(workerId);
          if (worker) {
            this.stopFlushing(worker);
            if (worker.heartbeatTimer) {
              clearInterval(worker.heartbeatTimer);
              worker.heartbeatTimer = undefined;
            }
          }
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
    const workerId = WorkerId(`worker-beat-${task.id}`);
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
    // IDEMPOTENCY GUARD: return early if already cleaned up.
    // kill() and onExit/handleWorkerCompletion both call this; without the guard
    // monitor.decrementWorkerCount() would fire twice causing double-decrement.
    const worker = this.workers.get(workerId);
    if (!worker) return;

    // Clear all timers before removing from maps
    if (worker.heartbeatTimer) {
      clearInterval(worker.heartbeatTimer);
      worker.heartbeatTimer = undefined;
    }
    if (worker.timeoutTimer) {
      clearTimeout(worker.timeoutTimer);
      worker.timeoutTimer = undefined;
    }
    this.stopFlushing(worker);

    this.workers.delete(workerId);
    this.taskToWorker.delete(taskId);
    this.monitor.decrementWorkerCount();

    // Unregister from DB (log and continue on error)
    const unregResult = this.workerRepository.unregister(workerId);
    if (!unregResult.ok) {
      this.logger.error('Failed to unregister worker from DB', unregResult.error, { workerId });
    }

    // Best-effort cleanup of task-scoped resources (e.g. system prompt temp files)
    if (worker.cleanupFn) {
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
   *
   * DECISION: 30s heartbeat interval writes to DB for crash detection by recovery manager.
   * Dead session detection is handled by TmuxConnector's shared staleness timer (listSessions
   * every 30s), which calls onExit when a session disappears. Calling isAlive() here would add
   * N blocking spawnSync calls per heartbeat tick (one per worker), redundant with the connector.
   * timer.unref() prevents the timer from keeping the Node.js process alive.
   */
  private setupHeartbeatForWorker(worker: WorkerState): void {
    const timer = setInterval(() => {
      // DB heartbeat update — recovery manager uses this to detect crashed server processes
      const result = this.workerRepository.updateHeartbeat(worker.id);
      if (!result.ok) {
        this.logger.warn('Heartbeat update failed', {
          workerId: worker.id,
          error: result.error.message,
        });
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

    // DECISION: Fire-and-forget emit — this method is called from the .finally() of the
    // onExit callback chain, which is itself a synchronous callback. Awaiting emit() here
    // would require making the entire callback chain async, introducing re-ordering risks
    // between cleanup (synchronous) and event emission (async). Errors are logged; task
    // completion is not lost — PersistenceHandler independently persists state from events.
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

    // Set completionHandled BEFORE kill() so that the onExit callback fired by the
    // session teardown does not race to emit TaskFailed. Only TaskTimeout is emitted.
    worker.completionHandled = true;

    await this.kill(workerId);

    await this.eventBus.emit('TaskTimeout', {
      taskId,
      error: taskTimeout(taskId, timeoutMs),
    });
  }
}
