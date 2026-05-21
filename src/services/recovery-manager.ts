/**
 * Event-driven recovery manager for startup task restoration.
 * Handles loading tasks from database and emits events for recovery actions.
 *
 * Recovery phases:
 *   Phase 0 — clean dead worker registrations + destroy orphan tmux sessions
 *   Phase 1 — delete expired tasks, loops, and orchestrations (7-day retention)
 *   Phase 2 — re-enqueue QUEUED tasks (skip dependency-blocked ones)
 *   Phase 3 — fail RUNNING tasks whose tmux session is no longer alive
 */

import {
  isTerminalState,
  OrchestratorStatus,
  Task,
  TaskStatus,
  updateOrchestration,
  WorkerRegistration,
} from '../core/domain.js';
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
import type { TmuxSessionManagerCorePort } from '../core/tmux-types.js';
import { isProcessAlive } from '../utils/process-liveness.js';
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
  /**
   * Required for full recovery — enables orphan session cleanup and session-based liveness.
   * When omitted, orphan cleanup and session liveness checks are skipped gracefully.
   */
  readonly tmuxSessionManager?: TmuxSessionManagerCorePort;
}

/** 7-day retention window for cleanup of terminal tasks, loops, and orchestrations */
const CLEANUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * DECISION: 90s staleness threshold for heartbeat warnings.
 * Why: 3x the 30s heartbeat interval gives 2 missed beats before alerting,
 * filtering transient delays. Tmux session check is authoritative.
 */
const HEARTBEAT_STALENESS_MS = 90_000;

/**
 * DECISION: 60s grace period for orphan session cleanup.
 * Sessions younger than this threshold are not destroyed during startup recovery.
 * This prevents a TOCTOU race: a worker that spawned a session between
 * listSessions() and findAll() would appear as an orphan without a DB record,
 * but the worker is still live and should not be killed.
 * 60 seconds comfortably exceeds the time it takes for a session spawn to
 * propagate from tmux into the DB, while still cleaning up genuine orphans promptly.
 */
const ORPHAN_GRACE_PERIOD_MS = 60_000;

/**
 * Summary of all recovery phases — emitted as a single structured log at the end of recover().
 */
interface CleanupSummary {
  readonly workersCleanedUp: number;
  readonly orphanSessionsDestroyed: number;
  readonly heartbeatWarnings: number;
  /**
   * The live tmux session names observed during Phase 0 cleanup.
   * Reused in Phase 3 (recoverRunningTasks) for O(1) set membership checks
   * instead of N sequential isAlive() calls.
   */
  readonly liveTmuxSessions: Set<string>;
}

export class RecoveryManager {
  private readonly taskRepo: TaskRepository;
  private readonly queue: TaskQueue;
  private readonly eventBus: EventBus;
  private readonly logger: Logger;
  private readonly workerRepo: WorkerRepository;
  private readonly dependencyRepo: DependencyRepository;
  private readonly loopRepo?: LoopRepository;
  private readonly orchestrationRepo?: OrchestrationRepository;
  private readonly tmuxSessionManager?: TmuxSessionManagerCorePort;

  constructor({
    taskRepo,
    queue,
    eventBus,
    logger,
    workerRepo,
    dependencyRepo,
    loopRepo,
    orchestrationRepo,
    tmuxSessionManager,
  }: RecoveryManagerDeps) {
    this.taskRepo = taskRepo;
    this.queue = queue;
    this.eventBus = eventBus;
    this.logger = logger;
    this.workerRepo = workerRepo;
    this.dependencyRepo = dependencyRepo;
    this.loopRepo = loopRepo;
    this.orchestrationRepo = orchestrationRepo;
    this.tmuxSessionManager = tmuxSessionManager;
  }

  async recover(): Promise<Result<void>> {
    this.logger.info('Starting recovery process');

    // Phase 0: clean dead worker registrations + orphan sessions (must run before Phase 3)
    const cleanupSummary = await this.cleanDeadWorkerRegistrations();

    // Phase 1: delete expired tasks, loops, and orchestrations; fail zombie orchestrations
    await this.cleanupOldCompletedTasks();
    await this.cleanupOldLoops();
    await this.cleanupOldOrchestrations();
    // DECISION (2026-04-10): Stuck PLANNING orchestrations are NOT auto-cleaned.
    // User manages them manually via dashboard keybindings (c/d).
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
    // Pass liveTmuxSessions from Phase 0 to Phase 3 — avoids N sequential isAlive() execs.
    const { queuedCount, blockedCount } = await this.recoverQueuedTasks(queuedResult.value);
    const failedCount = await this.recoverRunningTasks(runningResult.value, cleanupSummary.liveTmuxSessions);

    this.logger.info('Recovery complete', {
      workersCleanedUp: cleanupSummary.workersCleanedUp,
      orphanSessionsDestroyed: cleanupSummary.orphanSessionsDestroyed,
      heartbeatWarnings: cleanupSummary.heartbeatWarnings,
      queuedTasks: queuedResult.value.length,
      runningTasks: runningResult.value.length,
      tasksRequeued: queuedCount,
      blockedByDependencies: blockedCount,
      tasksFailed: failedCount,
    });

    return ok(undefined);
  }

  /**
   * Build a Set of live tmux session names and the raw session info array in a single exec call.
   * Used by cleanDeadWorkerRegistrations to batch tmux liveness checks at startup
   * instead of issuing N sequential has-session calls (one per tmux worker).
   *
   * Returns both:
   *  - `names`: Set<string> for O(1) liveness lookups in the dead-worker loop
   *  - `sessions`: raw info array (with `created` timestamps) for orphan grace-period checks
   *
   * Returns empty values when no session manager is configured or listSessions fails.
   */
  private buildLiveSessionSet(): {
    names: Set<string>;
    sessions: ReadonlyArray<{ readonly name: string; readonly created: number }>;
  } {
    if (!this.tmuxSessionManager) return { names: new Set(), sessions: [] };
    const result = this.tmuxSessionManager.listSessions();
    if (!result.ok) return { names: new Set(), sessions: [] };
    return {
      names: new Set(result.value.map((s) => s.name)),
      sessions: result.value,
    };
  }

  /**
   * Clean dead workers and orphan tmux sessions.
   * Workers without sessionName (legacy/corrupted rows) are treated as dead.
   *
   * DESIGN DECISION: liveTmuxSessions and allWorkers are computed once here and passed
   * to cleanOrphanTmuxSessions — avoids a second listSessions() and findAll() call.
   * The same liveTmuxSessions set is returned in CleanupSummary for reuse in
   * recoverRunningTasks — avoids N sequential isAlive() calls in Phase 3.
   *
   * Returns a CleanupSummary for the structured 'Recovery complete' log.
   */
  private async cleanDeadWorkerRegistrations(): Promise<CleanupSummary> {
    let workersCleanedUp = 0;
    let heartbeatWarnings = 0;

    const allWorkers = this.workerRepo.findAll();
    if (!allWorkers.ok) {
      const orphanSessionsDestroyed = await this.cleanOrphanTmuxSessions(new Set(), [], []);
      return { workersCleanedUp, orphanSessionsDestroyed, heartbeatWarnings, liveTmuxSessions: new Set() };
    }

    // Batch liveness check — one listSessions() call instead of N sequential has-session calls.
    const { names: liveTmuxSessions, sessions: liveTmuxSessionInfos } = this.buildLiveSessionSet();

    for (const reg of allWorkers.value) {
      // Workers without sessionName (legacy/corrupted rows) are treated as dead.
      const alive = reg.sessionName !== undefined && liveTmuxSessions.has(reg.sessionName);

      if (!alive) {
        await this.handleDeadWorker(reg);
        workersCleanedUp++;
      } else {
        // Alive — observability only: warn if heartbeat is stale
        if (reg.lastHeartbeat !== undefined && Date.now() - reg.lastHeartbeat > HEARTBEAT_STALENESS_MS) {
          heartbeatWarnings++;
          this.logger.warn('Tmux session alive but heartbeat stale', {
            workerId: reg.workerId,
            taskId: reg.taskId,
            ownerPid: reg.ownerPid,
            sessionName: reg.sessionName,
            lastHeartbeatAgeMs: Date.now() - reg.lastHeartbeat,
          });
        }
      }
    }

    // Orphan cleanup reuses already-fetched liveTmuxSessions/infos and allWorkers — no extra queries
    const orphanSessionsDestroyed = await this.cleanOrphanTmuxSessions(
      liveTmuxSessions,
      allWorkers.value,
      liveTmuxSessionInfos,
    );

    return { workersCleanedUp, orphanSessionsDestroyed, heartbeatWarnings, liveTmuxSessions };
  }

  /**
   * Destroy orphan tmux sessions: live sessions with no corresponding DB record.
   *
   * DESIGN DECISION: Takes liveTmuxSessions, registeredWorkers, AND liveTmuxSessionInfos
   * as parameters to avoid extra listSessions()/findAll() calls.
   * Called only from cleanDeadWorkerRegistrations() which has all three in scope.
   *
   * Grace period: sessions younger than ORPHAN_GRACE_PERIOD_MS are skipped to avoid
   * destroying sessions that were spawned between listSessions() and findAll() (TOCTOU).
   * The `created` field is sourced from TmuxSessionInfo (Unix epoch seconds from tmux).
   *
   * Returns the number of orphan sessions destroyed.
   * Failures per session are logged at error level and do not abort remaining cleanup.
   */
  private async cleanOrphanTmuxSessions(
    liveTmuxSessions: Set<string>,
    registeredWorkers: readonly WorkerRegistration[],
    liveTmuxSessionInfos: ReadonlyArray<{ readonly name: string; readonly created: number }>,
  ): Promise<number> {
    if (!this.tmuxSessionManager || liveTmuxSessions.size === 0) return 0;

    // Build set of registered session names for O(1) lookup
    const registeredSessionNames = new Set(
      registeredWorkers.flatMap((w) => (w.sessionName !== undefined ? [w.sessionName] : [])),
    );

    // Build map of session name → created timestamp for grace-period checks
    const sessionCreatedAt = new Map<string, number>(
      liveTmuxSessionInfos.map((s) => [s.name, s.created * 1_000]), // convert epoch seconds → ms
    );

    const now = Date.now();
    let destroyed = 0;
    for (const sessionName of liveTmuxSessions) {
      if (registeredSessionNames.has(sessionName)) continue;

      // Grace period: skip sessions that are too young to have a DB record yet.
      // This prevents destroying a session whose worker spawned between listSessions()
      // and findAll() — it will be cleaned up on the next startup if still orphaned.
      const createdAtMs = sessionCreatedAt.get(sessionName);
      if (createdAtMs !== undefined && now - createdAtMs < ORPHAN_GRACE_PERIOD_MS) {
        this.logger.info('Skipping young orphan tmux session (within grace period)', {
          sessionName,
          ageMs: now - createdAtMs,
          gracePeriodMs: ORPHAN_GRACE_PERIOD_MS,
        });
        continue;
      }

      // Orphan: live session with no DB record, past grace period — destroy it
      const result = this.tmuxSessionManager.destroySession(sessionName);
      if (result.ok) {
        destroyed++;
        this.logger.info('Destroyed orphan tmux session', { sessionName });
      } else {
        this.logger.error('Failed to destroy orphan tmux session', result.error, { sessionName });
        // Continue — don't abort on individual session failure
      }
    }

    return destroyed;
  }

  /**
   * Unregister a dead worker, look up its task, and mark the task FAILED if non-terminal.
   * Emits TaskFailed so DependencyHandler can unblock downstream tasks.
   */
  private async handleDeadWorker(reg: WorkerRegistration): Promise<void> {
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
      return;
    }

    if (taskResult.value !== null && isTerminalState(taskResult.value.status)) {
      this.logger.info('Dead worker row cleaned, task already terminal', {
        workerId: reg.workerId,
        taskId: reg.taskId,
        currentStatus: taskResult.value.status,
        deadPid: reg.ownerPid,
      });
      return;
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
        sessionName: reg.sessionName,
      });

      // Emit TaskFailed so DependencyHandler resolves deps for downstream tasks
      const failedEmitResult = await this.eventBus.emit('TaskFailed', {
        taskId: reg.taskId,
        error: new AutobeatError(ErrorCode.SYSTEM_ERROR, 'Tmux session died (dead session detected at startup)'),
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
   * orchestration → loop → most-recent-iteration → task → worker → liveness check.
   * Conservative: 'unknown' results (broken chain) leave the row alone — false positives
   * marking live orchestrations as zombies would be far worse than false negatives
   * leaving zombies for the user to clean manually via the dashboard.
   *
   * Stuck PLANNING orchestrations are NOT auto-cleaned — the user manages them manually
   * via dashboard keybindings (c/d).
   */
  private async failZombieRunningOrchestrations(): Promise<void> {
    if (!this.orchestrationRepo || !this.loopRepo) return;

    const result = await this.orchestrationRepo.findByStatus(OrchestratorStatus.RUNNING);
    if (!result.ok) return;

    // Hoist closure deps outside the loop — captures stable this.tmuxSessionManager reference
    const livenessDeps = {
      loopRepo: this.loopRepo,
      taskRepo: this.taskRepo,
      workerRepo: this.workerRepo,
      isOrchestratorProcessAlive: isProcessAlive,
      isTmuxSessionAlive: (name: string) => {
        if (!this.tmuxSessionManager) return false;
        const r = this.tmuxSessionManager.isAlive(name);
        return r.ok ? r.value : false;
      },
    };

    for (const o of result.value) {
      let liveness: Liveness;
      try {
        liveness = await checkOrchestrationLiveness(o, livenessDeps);
      } catch (error) {
        // Defensive: skip this orchestration on unexpected error.
        // Log so an unseen bug in the liveness chain doesn't silently disable zombie detection.
        this.logger.warn('Liveness check threw unexpectedly — skipping orchestration', {
          orchestratorId: o.id,
          loopId: o.loopId,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      if (liveness !== 'dead') continue;

      const failed = updateOrchestration(o, {
        status: OrchestratorStatus.FAILED,
        completedAt: Date.now(),
      });

      const updateResult = await this.orchestrationRepo.update(failed);
      if (updateResult.ok) {
        this.logger.warn('Marked zombie RUNNING orchestration as FAILED (worker dead)', {
          orchestratorId: o.id,
          loopId: o.loopId,
        });
      } else {
        this.logger.error('Failed to mark zombie orchestration as FAILED', updateResult.error, {
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
   * Recover RUNNING tasks using tmux session liveness detection.
   *
   * WHY THIS EXISTS:
   * Tasks stuck in RUNNING are from crashed workers or server shutdowns.
   * Without this check, every restart would re-queue ALL stale running tasks,
   * spawning dozens of agent processes simultaneously (fork-bomb).
   *   INCIDENT REFERENCE: 2025-10-04 — 7 stale tasks spawned simultaneously → crash.
   *
   * WHAT IT DOES:
   * - Worker row + alive tmux session → leave alone (worker still running)
   * - No worker row, no sessionName, or dead session → mark FAILED immediately
   *
   * @param liveTmuxSessions - Set of live session names from Phase 0 cleanup.
   *   Reusing this set avoids N sequential isAlive() execs (one per RUNNING task).
   */
  private async recoverRunningTasks(tasks: readonly Task[], liveTmuxSessions: Set<string>): Promise<number> {
    const now = Date.now();
    let failedCount = 0;

    for (const task of tasks) {
      const workerResult = this.workerRepo.findByTaskId(task.id);
      const workerRegistration = workerResult.ok ? workerResult.value : null;

      if (workerRegistration !== null) {
        // Use the batch session set from Phase 0 — O(1) lookup instead of a per-task exec.
        const alive =
          workerRegistration.sessionName !== undefined && liveTmuxSessions.has(workerRegistration.sessionName);
        if (alive) {
          this.logger.info('Running task has live tmux session, skipping', {
            taskId: task.id,
            ownerPid: workerRegistration.ownerPid,
            sessionName: workerRegistration.sessionName,
          });
          continue;
        }
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
          error: new AutobeatError(ErrorCode.SYSTEM_ERROR, 'Tmux session died (no live session detected at startup)'),
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
