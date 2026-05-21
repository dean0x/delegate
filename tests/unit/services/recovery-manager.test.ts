/**
 * Unit tests for RecoveryManager
 * ARCHITECTURE: Tests startup task recovery with pure mocks (no DB)
 * Pattern: Behavioral testing — focuses on recovery decisions:
 *   - Phase 0: Dead worker cleanup via tmux session liveness detection
 *   - Phase 0: Orphan tmux session cleanup (sessions with no DB record destroyed)
 *   - QUEUED tasks are re-queued
 *   - RUNNING tasks with no live session are marked FAILED
 *   - RUNNING tasks with live session are left alone (skipped)
 *   - Duplicate detection via queue.contains()
 *   - Error propagation from repository
 *   - Recovery summary log includes all counts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../../src/core/domain';
import { TaskId, TaskStatus, WorkerId } from '../../../src/core/domain';
import { AutobeatError, ErrorCode } from '../../../src/core/errors';
import type { EventBus } from '../../../src/core/events/event-bus';
import type {
  DependencyRepository,
  Logger,
  LoopRepository,
  OrchestrationRepository,
  TaskQueue,
  TaskRepository,
  WorkerRepository,
} from '../../../src/core/interfaces';
import { err, ok } from '../../../src/core/result';
import { RecoveryManager } from '../../../src/services/recovery-manager';
import { TaskFactory } from '../../fixtures/factories';
import { createMockLogger, createMockTmuxSessionManagerCore, createMockWorkerRepository } from '../../fixtures/mocks';

// --- Mock factories ---

const createMockRepo = () => ({
  save: vi.fn(),
  update: vi.fn().mockResolvedValue(ok(undefined)),
  findById: vi.fn().mockResolvedValue(ok(null)),
  findAll: vi.fn(),
  findAllUnbounded: vi.fn(),
  count: vi.fn(),
  findByStatus: vi.fn().mockResolvedValue(ok([])),
  delete: vi.fn(),
  cleanupOldTasks: vi.fn().mockResolvedValue(ok(0)),
  transaction: vi.fn(),
});

const createMockQueue = () => ({
  enqueue: vi.fn().mockReturnValue(ok(undefined)),
  dequeue: vi.fn(),
  peek: vi.fn(),
  remove: vi.fn(),
  getAll: vi.fn(),
  contains: vi.fn().mockReturnValue(false),
  size: vi.fn().mockReturnValue(0),
  clear: vi.fn(),
  isEmpty: vi.fn(),
});

const createTestEventBus = () => ({
  emit: vi.fn().mockResolvedValue(ok(undefined)),
  request: vi.fn(),
  subscribe: vi.fn().mockReturnValue(ok('sub-1')),
  unsubscribe: vi.fn(),
  subscribeAll: vi.fn(),
  unsubscribeAll: vi.fn(),
  dispose: vi.fn(),
});

const createMockDependencyRepo = () => ({
  isBlocked: vi.fn().mockResolvedValue(ok(false)),
  addDependency: vi.fn(),
  addDependencies: vi.fn(),
  getDependencies: vi.fn(),
  getDependents: vi.fn(),
  resolveDependency: vi.fn(),
  resolveDependenciesBatch: vi.fn(),
  getUnresolvedDependencies: vi.fn(),
  findAll: vi.fn(),
});

const createMockLoopRepository = () => ({
  cleanupOldLoops: vi.fn().mockResolvedValue(ok(0)),
  save: vi.fn(),
  update: vi.fn(),
  findById: vi.fn(),
  findAll: vi.fn(),
  findByStatus: vi.fn(),
  count: vi.fn(),
  delete: vi.fn(),
  recordIteration: vi.fn(),
  getIterations: vi.fn(),
  findIterationByTaskId: vi.fn(),
  findRunningIterations: vi.fn(),
  updateIteration: vi.fn(),
});

const createMockOrchestrationRepository = () => ({
  cleanupOldOrchestrations: vi.fn().mockResolvedValue(ok(0)),
  save: vi.fn(),
  update: vi.fn(),
  findById: vi.fn(),
  findAll: vi.fn(),
  findByStatus: vi.fn(),
  findByLoopId: vi.fn(),
  delete: vi.fn(),
});

describe('RecoveryManager', () => {
  let manager: RecoveryManager;
  let repo: ReturnType<typeof createMockRepo>;
  let queue: ReturnType<typeof createMockQueue>;
  let eventBus: ReturnType<typeof createTestEventBus>;
  let logger: ReturnType<typeof createMockLogger>;
  let workerRepo: ReturnType<typeof createMockWorkerRepository>;
  let dependencyRepo: ReturnType<typeof createMockDependencyRepo>;
  let tmuxSessionManager: ReturnType<typeof createMockTmuxSessionManagerCore>;

  beforeEach(() => {
    repo = createMockRepo();
    queue = createMockQueue();
    eventBus = createTestEventBus();
    logger = createMockLogger();
    workerRepo = createMockWorkerRepository();
    dependencyRepo = createMockDependencyRepo();
    tmuxSessionManager = createMockTmuxSessionManagerCore();

    manager = new RecoveryManager({
      taskRepo: repo as unknown as TaskRepository,
      queue: queue as unknown as TaskQueue,
      eventBus: eventBus as unknown as EventBus,
      logger: logger as unknown as Logger,
      workerRepo: workerRepo as unknown as WorkerRepository,
      dependencyRepo: dependencyRepo as unknown as DependencyRepository,
      tmuxSessionManager,
    });
  });

  // --- Helpers ---
  // NOTE: TaskFactory.withId() cannot be used because createTask() returns a frozen object.
  // Instead, we build via the factory and spread into a new (unfrozen) object with the desired id.

  const FIVE_MINUTES_AGO = Date.now() - 5 * 60 * 1000;

  function buildQueuedTask(id: string): Task {
    const base = new TaskFactory().withStatus(TaskStatus.QUEUED).build();
    return { ...base, id: TaskId(id) };
  }

  function buildRunningTask(id: string): Task {
    const base = new TaskFactory().withStatus(TaskStatus.RUNNING).withStartedAt(FIVE_MINUTES_AGO).build();
    return { ...base, id: TaskId(id) };
  }

  function setupFindByStatus(queuedTasks: readonly unknown[], runningTasks: readonly unknown[]): void {
    repo.findByStatus.mockResolvedValueOnce(ok(queuedTasks)).mockResolvedValueOnce(ok(runningTasks));
  }

  /**
   * Build a tmux-worker fixture with pid=0 (tmux sentinel).
   * @param sessionName - tmux session name; set to undefined to simulate legacy rows without sessionName
   */
  function buildTmuxWorker(workerId: string, taskId: string, sessionName: string | undefined = `beat-${taskId}`) {
    return {
      workerId: WorkerId(workerId),
      taskId: TaskId(taskId),
      pid: 0,
      ownerPid: process.pid,
      agent: 'claude',
      startedAt: Date.now(),
      sessionName,
    };
  }

  // --- Tests ---

  describe('Phase 0: Dead worker cleanup via tmux session liveness', () => {
    it('should unregister dead workers and fail their tasks when session is absent', async () => {
      const deadWorker = buildTmuxWorker('w-dead', 'task-dead', 'beat-task-dead');
      workerRepo.findAll.mockReturnValue(ok([deadWorker]));
      // listSessions returns empty — session is NOT present → dead
      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      repo.findById.mockResolvedValue(ok(buildRunningTask('task-dead')));
      setupFindByStatus([], []);

      await manager.recover();

      expect(workerRepo.unregister).toHaveBeenCalledWith(WorkerId('w-dead'));
      expect(repo.update).toHaveBeenCalledWith(
        TaskId('task-dead'),
        expect.objectContaining({
          status: TaskStatus.FAILED,
          completedAt: expect.any(Number),
          exitCode: -1,
        }),
      );
      expect(logger.info).toHaveBeenCalledWith('Cleaned up dead worker and failed its task', {
        workerId: WorkerId('w-dead'),
        taskId: TaskId('task-dead'),
        deadPid: process.pid,
        sessionName: 'beat-task-dead',
      });
    });

    it('should leave alive workers untouched when session is present', async () => {
      const aliveWorker = buildTmuxWorker('w-alive', 'task-alive', 'beat-task-alive');
      workerRepo.findAll.mockReturnValue(ok([aliveWorker]));
      // Session is present → alive
      tmuxSessionManager.listSessions.mockReturnValue(ok([{ name: 'beat-task-alive' }]));
      setupFindByStatus([], []);

      await manager.recover();

      expect(workerRepo.unregister).not.toHaveBeenCalled();
    });

    it('should handle mix of dead and alive workers', async () => {
      const deadWorker = buildTmuxWorker('w-dead', 'task-dead', 'beat-task-dead');
      const aliveWorker = buildTmuxWorker('w-alive', 'task-alive', 'beat-task-alive');
      workerRepo.findAll.mockReturnValue(ok([deadWorker, aliveWorker]));
      // Only the alive session appears in listSessions
      tmuxSessionManager.listSessions.mockReturnValue(ok([{ name: 'beat-task-alive' }]));
      repo.findById.mockResolvedValue(ok(buildRunningTask('task-dead')));
      setupFindByStatus([], []);

      await manager.recover();

      expect(workerRepo.unregister).toHaveBeenCalledTimes(1);
      expect(workerRepo.unregister).toHaveBeenCalledWith(WorkerId('w-dead'));
    });

    it('should treat legacy workers (NULL sessionName) as dead', async () => {
      // Workers without sessionName are pre-Phase 3 rows — treated as dead in Phase 4
      const legacyWorker = buildTmuxWorker('w-legacy', 'task-legacy', undefined);
      workerRepo.findAll.mockReturnValue(ok([legacyWorker]));
      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      repo.findById.mockResolvedValue(ok(buildRunningTask('task-legacy')));
      setupFindByStatus([], []);

      await manager.recover();

      expect(workerRepo.unregister).toHaveBeenCalledWith(WorkerId('w-legacy'));
      expect(repo.update).toHaveBeenCalledWith(
        TaskId('task-legacy'),
        expect.objectContaining({ status: TaskStatus.FAILED }),
      );
    });

    it('should skip status update when dead worker task is already COMPLETED', async () => {
      const deadWorker = buildTmuxWorker('w-dead-completed', 'task-completed', 'beat-task-completed');
      workerRepo.findAll.mockReturnValue(ok([deadWorker]));
      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      const completedTask = new TaskFactory().withStatus(TaskStatus.COMPLETED).build();
      repo.findById.mockResolvedValue(ok({ ...completedTask, id: TaskId('task-completed') }));
      setupFindByStatus([], []);

      await manager.recover();

      // Worker should be unregistered (dead session)
      expect(workerRepo.unregister).toHaveBeenCalledWith(WorkerId('w-dead-completed'));
      // But task should NOT be updated (already terminal)
      expect(repo.update).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith('Dead worker row cleaned, task already terminal', {
        workerId: WorkerId('w-dead-completed'),
        taskId: TaskId('task-completed'),
        currentStatus: TaskStatus.COMPLETED,
        deadPid: process.pid,
      });
    });

    it('should skip status update when dead worker task is already CANCELLED', async () => {
      const deadWorker = buildTmuxWorker('w-dead-cancelled', 'task-cancelled', 'beat-task-cancelled');
      workerRepo.findAll.mockReturnValue(ok([deadWorker]));
      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      const cancelledTask = new TaskFactory().withStatus(TaskStatus.CANCELLED).build();
      repo.findById.mockResolvedValue(ok({ ...cancelledTask, id: TaskId('task-cancelled') }));
      setupFindByStatus([], []);

      await manager.recover();

      expect(workerRepo.unregister).toHaveBeenCalledWith(WorkerId('w-dead-cancelled'));
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('should handle findById failure gracefully in Phase 0', async () => {
      const deadWorker = buildTmuxWorker('w-dead-err', 'task-err', 'beat-task-err');
      workerRepo.findAll.mockReturnValue(ok([deadWorker]));
      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      const findError = new AutobeatError(ErrorCode.SYSTEM_ERROR, 'DB read failed');
      repo.findById.mockResolvedValue(err(findError));
      setupFindByStatus([], []);

      await manager.recover();

      // Worker unregistered, but task update skipped due to findById failure
      expect(workerRepo.unregister).toHaveBeenCalledWith(WorkerId('w-dead-err'));
      expect(repo.update).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith('Failed to look up task for dead worker', findError, {
        taskId: TaskId('task-err'),
      });
    });
  });

  describe('Phase 0: Orphan tmux session cleanup', () => {
    it('should destroy orphan sessions that have no DB record', async () => {
      // No workers in DB
      workerRepo.findAll.mockReturnValue(ok([]));
      // But there is a live session with no record
      tmuxSessionManager.listSessions.mockReturnValue(ok([{ name: 'beat-orphan-abc' }]));
      setupFindByStatus([], []);

      await manager.recover();

      expect(tmuxSessionManager.destroySession).toHaveBeenCalledWith('beat-orphan-abc');
      expect(logger.info).toHaveBeenCalledWith('Destroyed orphan tmux session', {
        sessionName: 'beat-orphan-abc',
      });
    });

    it('should NOT destroy sessions that have a matching DB record', async () => {
      const registeredWorker = buildTmuxWorker('w-registered', 'task-registered', 'beat-task-registered');
      workerRepo.findAll.mockReturnValue(ok([registeredWorker]));
      // Session exists and matches a registered worker
      tmuxSessionManager.listSessions.mockReturnValue(ok([{ name: 'beat-task-registered' }]));
      setupFindByStatus([], []);

      await manager.recover();

      // Worker was alive — not destroyed
      expect(workerRepo.unregister).not.toHaveBeenCalled();
      expect(tmuxSessionManager.destroySession).not.toHaveBeenCalled();
    });

    it('should handle empty session list without error', async () => {
      workerRepo.findAll.mockReturnValue(ok([]));
      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      setupFindByStatus([], []);

      await manager.recover();

      expect(tmuxSessionManager.destroySession).not.toHaveBeenCalled();
    });

    it('should skip orphan cleanup when tmuxSessionManager is absent', async () => {
      // Create a manager without tmuxSessionManager
      const managerNoTmux = new RecoveryManager({
        taskRepo: repo as unknown as TaskRepository,
        queue: queue as unknown as TaskQueue,
        eventBus: eventBus as unknown as EventBus,
        logger: logger as unknown as Logger,
        workerRepo: workerRepo as unknown as WorkerRepository,
        dependencyRepo: dependencyRepo as unknown as DependencyRepository,
      });

      workerRepo.findAll.mockReturnValue(ok([]));
      setupFindByStatus([], []);

      // Should not crash
      await expect(managerNoTmux.recover()).resolves.toEqual({ ok: true, value: undefined });
    });

    it('should log error and continue when destroySession fails for an orphan', async () => {
      workerRepo.findAll.mockReturnValue(ok([]));
      tmuxSessionManager.listSessions.mockReturnValue(ok([{ name: 'beat-orphan-fail' }]));
      const destroyError = new AutobeatError(ErrorCode.SYSTEM_ERROR, 'tmux kill-session failed');
      tmuxSessionManager.destroySession.mockReturnValue(err(destroyError));
      setupFindByStatus([], []);

      // Should not throw — logged and continued
      const result = await manager.recover();

      expect(result.ok).toBe(true);
      expect(logger.error).toHaveBeenCalledWith('Failed to destroy orphan tmux session', destroyError, {
        sessionName: 'beat-orphan-fail',
      });
    });

    it('should destroy all orphan sessions even if one fails', async () => {
      workerRepo.findAll.mockReturnValue(ok([]));
      tmuxSessionManager.listSessions.mockReturnValue(
        ok([{ name: 'beat-orphan-1' }, { name: 'beat-orphan-2' }, { name: 'beat-orphan-3' }]),
      );
      const destroyError = new AutobeatError(ErrorCode.SYSTEM_ERROR, 'kill-session failed');
      tmuxSessionManager.destroySession
        .mockReturnValueOnce(err(destroyError)) // first fails
        .mockReturnValueOnce(ok(undefined)) // second succeeds
        .mockReturnValueOnce(ok(undefined)); // third succeeds
      setupFindByStatus([], []);

      const result = await manager.recover();

      expect(result.ok).toBe(true);
      expect(tmuxSessionManager.destroySession).toHaveBeenCalledTimes(3);
    });

    it('should not issue extra listSessions() or findAll() calls for orphan cleanup', async () => {
      // Orphan cleanup must reuse the already-fetched data from cleanDeadWorkerRegistrations
      const worker = buildTmuxWorker('w-1', 'task-1', 'beat-task-1');
      workerRepo.findAll.mockReturnValue(ok([worker]));
      tmuxSessionManager.listSessions.mockReturnValue(ok([{ name: 'beat-task-1' }]));
      setupFindByStatus([], []);

      await manager.recover();

      // findAll called once (in cleanDeadWorkerRegistrations), not twice
      expect(workerRepo.findAll).toHaveBeenCalledTimes(1);
      // listSessions called once (in buildLiveSessionSet), not twice
      expect(tmuxSessionManager.listSessions).toHaveBeenCalledTimes(1);
    });
  });

  describe('Empty recovery', () => {
    it('should succeed with no operations when no queued or running tasks exist', async () => {
      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      setupFindByStatus([], []);

      const result = await manager.recover();

      expect(result.ok).toBe(true);
      expect(queue.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('Cleanup of old tasks', () => {
    it('should call cleanupOldTasks with 7-day threshold in milliseconds', async () => {
      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      setupFindByStatus([], []);
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

      await manager.recover();

      expect(repo.cleanupOldTasks).toHaveBeenCalledWith(sevenDaysMs);
    });

    it('should log cleanup count when tasks are cleaned up', async () => {
      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      setupFindByStatus([], []);
      repo.cleanupOldTasks.mockResolvedValue(ok(5));

      await manager.recover();

      expect(logger.info).toHaveBeenCalledWith('Cleaned up old completed tasks', { count: 5 });
    });

    it('should not log cleanup when zero tasks are cleaned', async () => {
      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      setupFindByStatus([], []);
      repo.cleanupOldTasks.mockResolvedValue(ok(0));

      await manager.recover();

      const cleanupCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => call[0] === 'Cleaned up old completed tasks',
      );
      expect(cleanupCalls).toHaveLength(0);
    });
  });

  describe('QUEUED task recovery', () => {
    it('should re-queue QUEUED tasks and emit TaskQueued events', async () => {
      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      const task1 = buildQueuedTask('queued-1');
      const task2 = buildQueuedTask('queued-2');
      setupFindByStatus([task1, task2], []);

      const result = await manager.recover();

      expect(result.ok).toBe(true);
      expect(queue.enqueue).toHaveBeenCalledTimes(2);
      expect(queue.enqueue).toHaveBeenCalledWith(task1);
      expect(queue.enqueue).toHaveBeenCalledWith(task2);

      expect(eventBus.emit).toHaveBeenCalledWith('TaskQueued', { taskId: task1.id });
      expect(eventBus.emit).toHaveBeenCalledWith('TaskQueued', { taskId: task2.id });
    });

    it('should skip QUEUED tasks that are already in the queue', async () => {
      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      const task = buildQueuedTask('already-queued');
      setupFindByStatus([task], []);
      queue.contains.mockReturnValue(true);

      const result = await manager.recover();

      expect(result.ok).toBe(true);
      expect(queue.enqueue).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith('Task already in queue, skipping re-queue', { taskId: task.id });
    });

    it('should skip re-queuing QUEUED tasks that are blocked by dependencies', async () => {
      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      const task = buildQueuedTask('blocked-task');
      setupFindByStatus([task], []);
      dependencyRepo.isBlocked.mockResolvedValue(ok(true));

      const result = await manager.recover();

      expect(result.ok).toBe(true);
      expect(queue.enqueue).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith('Task blocked by dependencies, skipping recovery enqueue', {
        taskId: task.id,
      });
    });

    it('should enqueue conservatively on dependency check failure', async () => {
      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      const task = buildQueuedTask('dep-error');
      setupFindByStatus([task], []);
      const depError = new AutobeatError(ErrorCode.SYSTEM_ERROR, 'DB read failed');
      dependencyRepo.isBlocked.mockResolvedValue(err(depError));

      const result = await manager.recover();

      expect(result.ok).toBe(true);
      expect(queue.enqueue).toHaveBeenCalledWith(task);
      expect(logger.warn).toHaveBeenCalledWith(
        'Failed to check task dependencies during recovery, re-queuing conservatively',
        {
          taskId: task.id,
          error: 'DB read failed',
        },
      );
    });

    it('should handle mix of blocked and unblocked QUEUED tasks', async () => {
      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      const blockedTask = buildQueuedTask('blocked-1');
      const unblockedTask = buildQueuedTask('unblocked-1');
      setupFindByStatus([blockedTask, unblockedTask], []);
      dependencyRepo.isBlocked.mockResolvedValueOnce(ok(true)).mockResolvedValueOnce(ok(false));

      const result = await manager.recover();

      expect(result.ok).toBe(true);
      expect(queue.enqueue).toHaveBeenCalledTimes(1);
      expect(queue.enqueue).toHaveBeenCalledWith(unblockedTask);
      expect(queue.enqueue).not.toHaveBeenCalledWith(blockedTask);
    });

    it('should log enqueue failures but continue recovery', async () => {
      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      const task1 = buildQueuedTask('fail-enqueue');
      const task2 = buildQueuedTask('succeed-enqueue');
      setupFindByStatus([task1, task2], []);

      const enqueueError = new AutobeatError(ErrorCode.QUEUE_FULL, 'Queue is full');
      queue.enqueue.mockReturnValueOnce(err(enqueueError)).mockReturnValueOnce(ok(undefined));

      const result = await manager.recover();

      expect(result.ok).toBe(true);
      expect(logger.error).toHaveBeenCalledWith('Failed to re-queue task', enqueueError, { taskId: task1.id });
      expect(eventBus.emit).toHaveBeenCalledWith('TaskQueued', { taskId: task2.id });
    });
  });

  describe('RUNNING task recovery — tmux session-based detection', () => {
    it('should mark RUNNING task as FAILED when no worker row exists', async () => {
      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      const task = buildRunningTask('no-worker');
      setupFindByStatus([], [task]);
      // Default: findByTaskId returns ok(null) — no worker row

      const result = await manager.recover();

      expect(result.ok).toBe(true);
      expect(repo.update).toHaveBeenCalledWith(
        task.id,
        expect.objectContaining({
          status: TaskStatus.FAILED,
          exitCode: -1,
          completedAt: expect.any(Number),
        }),
      );
    });

    it('should mark RUNNING task as FAILED when worker has dead tmux session', async () => {
      const task = buildRunningTask('dead-worker');
      // Phase 3 uses isAlive() directly — mock it to return false (dead session)
      tmuxSessionManager.isAlive.mockReturnValue(ok(false));
      // Phase 0 uses listSessions() — empty so no workers cleaned there either
      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      setupFindByStatus([], [task]);

      workerRepo.findByTaskId.mockReturnValue(ok(buildTmuxWorker('w1', task.id, 'beat-dead-session')));

      const result = await manager.recover();

      expect(result.ok).toBe(true);
      expect(repo.update).toHaveBeenCalledWith(
        task.id,
        expect.objectContaining({ status: TaskStatus.FAILED, exitCode: -1 }),
      );
    });

    it('should skip RUNNING task when worker has alive tmux session', async () => {
      const task = buildRunningTask('alive-worker');
      // Session present → alive
      tmuxSessionManager.listSessions.mockReturnValue(ok([{ name: 'beat-alive-session' }]));
      setupFindByStatus([], [task]);

      workerRepo.findByTaskId.mockReturnValue(ok(buildTmuxWorker('w1', task.id, 'beat-alive-session')));

      const result = await manager.recover();

      expect(result.ok).toBe(true);
      expect(repo.update).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith('Running task has live tmux session, skipping', {
        taskId: task.id,
        ownerPid: process.pid,
        sessionName: 'beat-alive-session',
      });
    });

    it('should not re-queue RUNNING tasks with dead sessions', async () => {
      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      const task = buildRunningTask('dead-no-queue');
      setupFindByStatus([], [task]);

      await manager.recover();

      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it('should log crashed task failure', async () => {
      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      const task = buildRunningTask('crashed-logged');
      setupFindByStatus([], [task]);

      await manager.recover();

      expect(logger.info).toHaveBeenCalledWith(
        'Marked crashed task as failed (no live worker)',
        expect.objectContaining({ taskId: task.id }),
      );
    });

    it('should log error when update fails for crashed task', async () => {
      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      const task = buildRunningTask('crashed-update-fail');
      setupFindByStatus([], [task]);
      const updateError = new AutobeatError(ErrorCode.SYSTEM_ERROR, 'DB write failed');
      repo.update.mockResolvedValue(err(updateError));

      await manager.recover();

      expect(logger.error).toHaveBeenCalledWith('Failed to update crashed task', updateError, {
        taskId: task.id,
      });
    });

    it('should skip RUNNING task when it became terminal between fetch and update', async () => {
      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      const task = buildRunningTask('race-completed');
      setupFindByStatus([], [task]);
      workerRepo.findByTaskId.mockReturnValue(ok(null));
      const completedTask = new TaskFactory().withStatus(TaskStatus.COMPLETED).build();
      repo.findById.mockResolvedValue(ok({ ...completedTask, id: TaskId('race-completed') }));

      await manager.recover();

      expect(repo.update).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith('Running task already terminal, skipping recovery', {
        taskId: TaskId('race-completed'),
        currentStatus: TaskStatus.COMPLETED,
      });
    });
  });

  describe('TaskFailed event emission', () => {
    it('should emit TaskFailed event when marking crashed RUNNING task as failed', async () => {
      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      const task = buildRunningTask('crashed-emit');
      setupFindByStatus([], [task]);
      workerRepo.findByTaskId.mockReturnValue(ok(null));

      await manager.recover();

      expect(eventBus.emit).toHaveBeenCalledWith('TaskFailed', {
        taskId: task.id,
        error: expect.objectContaining({ message: 'Worker process crashed during execution' }),
        exitCode: -1,
      });
    });

    it('should log error and continue recovery when TaskFailed emit fails for dead worker task', async () => {
      const deadWorker = buildTmuxWorker('w-dead-fail', 'task-dead-fail', 'beat-task-dead-fail');
      workerRepo.findAll.mockReturnValue(ok([deadWorker]));
      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      repo.findById.mockResolvedValue(ok(buildRunningTask('task-dead-fail')));
      setupFindByStatus([], []);

      const emitError = new AutobeatError(ErrorCode.SYSTEM_ERROR, 'Event bus error');
      eventBus.emit.mockResolvedValueOnce(err(emitError));

      const result = await manager.recover();

      expect(result.ok).toBe(true);
      expect(logger.error).toHaveBeenCalledWith('Failed to emit TaskFailed event for dead worker task', emitError, {
        taskId: TaskId('task-dead-fail'),
      });
      expect(repo.update).toHaveBeenCalledWith(
        TaskId('task-dead-fail'),
        expect.objectContaining({ status: TaskStatus.FAILED }),
      );
    });

    it('should log error and continue recovery when TaskFailed emit fails for crashed running task', async () => {
      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      const task = buildRunningTask('crashed-emit-fail');
      setupFindByStatus([], [task]);
      workerRepo.findByTaskId.mockReturnValue(ok(null));

      const emitError = new AutobeatError(ErrorCode.SYSTEM_ERROR, 'Event bus error');
      eventBus.emit.mockResolvedValueOnce(err(emitError));

      const result = await manager.recover();

      expect(result.ok).toBe(true);
      expect(logger.error).toHaveBeenCalledWith('Failed to emit TaskFailed event for crashed task', emitError, {
        taskId: task.id,
      });
      expect(repo.update).toHaveBeenCalledWith(task.id, expect.objectContaining({ status: TaskStatus.FAILED }));
    });

    it('should emit TaskFailed with tmux session message when failing dead worker task', async () => {
      const deadWorker = buildTmuxWorker('w-dead-emit', 'task-dead-emit', 'beat-task-dead-emit');
      workerRepo.findAll.mockReturnValue(ok([deadWorker]));
      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      repo.findById.mockResolvedValue(ok(buildRunningTask('task-dead-emit')));
      setupFindByStatus([], []);

      await manager.recover();

      expect(eventBus.emit).toHaveBeenCalledWith('TaskFailed', {
        taskId: TaskId('task-dead-emit'),
        error: expect.objectContaining({ message: 'Tmux session died (dead session detected at startup)' }),
        exitCode: -1,
      });
    });
  });

  describe('Error propagation', () => {
    it('should return error when findByStatus for QUEUED tasks fails', async () => {
      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      const findError = new AutobeatError(ErrorCode.SYSTEM_ERROR, 'DB read failed');
      repo.findByStatus.mockResolvedValueOnce(err(findError));

      const result = await manager.recover();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(findError);
      }
    });

    it('should return error when findByStatus for RUNNING tasks fails', async () => {
      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      const findError = new AutobeatError(ErrorCode.SYSTEM_ERROR, 'DB read failed');
      repo.findByStatus.mockResolvedValueOnce(ok([])).mockResolvedValueOnce(err(findError));

      const result = await manager.recover();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(findError);
      }
    });
  });

  describe('Mixed scenario', () => {
    it('should handle a mix of queued, dead-session running, and alive-session running tasks', async () => {
      const queuedTask = buildQueuedTask('q-1');
      const deadWorkerTask = buildRunningTask('dead-1');
      const aliveWorkerTask = buildRunningTask('alive-1');
      // Session 'beat-alive-session' is alive, dead-1's session is absent
      tmuxSessionManager.listSessions.mockReturnValue(ok([{ name: 'beat-alive-session' }]));
      setupFindByStatus([queuedTask], [deadWorkerTask, aliveWorkerTask]);

      workerRepo.findByTaskId
        .mockReturnValueOnce(ok(null)) // dead-1: no worker row
        .mockReturnValueOnce(ok(buildTmuxWorker('w-alive', aliveWorkerTask.id, 'beat-alive-session')));

      const result = await manager.recover();

      expect(result.ok).toBe(true);
      expect(queue.enqueue).toHaveBeenCalledWith(queuedTask);
      expect(repo.update).toHaveBeenCalledWith(
        deadWorkerTask.id,
        expect.objectContaining({ status: TaskStatus.FAILED, exitCode: -1 }),
      );
      const updateCalls = repo.update.mock.calls.filter((call: unknown[]) => call[0] === aliveWorkerTask.id);
      expect(updateCalls).toHaveLength(0);
    });

    it('should handle multiple queued and multiple running tasks', async () => {
      const q1 = buildQueuedTask('q-1');
      const q2 = buildQueuedTask('q-2');
      const deadTask1 = buildRunningTask('dead-1');
      const deadTask2 = buildRunningTask('dead-2');
      const aliveTask = buildRunningTask('alive-1');
      tmuxSessionManager.listSessions.mockReturnValue(ok([{ name: 'beat-alive' }]));
      setupFindByStatus([q1, q2], [deadTask1, deadTask2, aliveTask]);

      queue.contains.mockReturnValueOnce(false).mockReturnValueOnce(true);

      workerRepo.findByTaskId
        .mockReturnValueOnce(ok(null))
        .mockReturnValueOnce(ok(null))
        .mockReturnValueOnce(ok(buildTmuxWorker('w-alive', aliveTask.id, 'beat-alive')));

      await manager.recover();

      expect(queue.enqueue).toHaveBeenCalledTimes(1);
      expect(queue.enqueue).toHaveBeenCalledWith(q1);

      const failedUpdateCalls = repo.update.mock.calls.filter((call: unknown[]) => {
        const update = call[1] as { status?: string };
        return update.status === TaskStatus.FAILED;
      });
      expect(failedUpdateCalls).toHaveLength(2);
    });
  });

  describe('TaskQueued event emit failure', () => {
    it('should log TaskQueued event emit failure but still count task as recovered', async () => {
      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      const task = buildQueuedTask('event-fail');
      setupFindByStatus([task], []);
      const emitError = new AutobeatError(ErrorCode.SYSTEM_ERROR, 'Event bus error');

      eventBus.emit.mockResolvedValueOnce(err(emitError));

      const result = await manager.recover();

      expect(result.ok).toBe(true);
      expect(logger.error).toHaveBeenCalledWith('Failed to emit TaskQueued event for recovered task', emitError, {
        taskId: task.id,
      });
    });
  });

  describe('Edge cases', () => {
    it('should mark RUNNING task with no worker as FAILED regardless of task age', async () => {
      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      const base = new TaskFactory()
        .withStatus(TaskStatus.RUNNING)
        .withStartedAt(Date.now() - 1000)
        .build();
      const task = { ...base, id: TaskId('recent-no-worker') };
      setupFindByStatus([], [task]);

      await manager.recover();

      expect(repo.update).toHaveBeenCalledWith(
        task.id,
        expect.objectContaining({ status: TaskStatus.FAILED, exitCode: -1 }),
      );
    });

    it('should call findByStatus with correct status values', async () => {
      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      setupFindByStatus([], []);

      await manager.recover();

      expect(repo.findByStatus).toHaveBeenCalledWith(TaskStatus.QUEUED);
      expect(repo.findByStatus).toHaveBeenCalledWith(TaskStatus.RUNNING);
    });

    it('should return ok result on successful recovery', async () => {
      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      setupFindByStatus([], []);

      const result = await manager.recover();

      expect(result).toEqual({ ok: true, value: undefined });
    });
  });

  describe('Recovery summary log', () => {
    it('should log recovery complete with all counts including cleanup metrics', async () => {
      const deadWorker = buildTmuxWorker('w-dead', 'task-dead', 'beat-task-dead');
      const orphanSession = 'beat-orphan-xyz';
      workerRepo.findAll.mockReturnValue(ok([deadWorker]));
      tmuxSessionManager.listSessions.mockReturnValue(ok([{ name: orphanSession }]));
      repo.findById.mockResolvedValue(ok(buildRunningTask('task-dead')));
      setupFindByStatus([], []);

      await manager.recover();

      expect(logger.info).toHaveBeenCalledWith(
        'Recovery complete',
        expect.objectContaining({
          workersCleanedUp: expect.any(Number),
          orphanSessionsDestroyed: expect.any(Number),
          heartbeatWarnings: expect.any(Number),
          queuedTasks: expect.any(Number),
          runningTasks: expect.any(Number),
          tasksRequeued: expect.any(Number),
          tasksFailed: expect.any(Number),
        }),
      );
    });

    it('should log recovery complete with all zeros in a clean state', async () => {
      workerRepo.findAll.mockReturnValue(ok([]));
      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      setupFindByStatus([], []);

      await manager.recover();

      expect(logger.info).toHaveBeenCalledWith(
        'Recovery complete',
        expect.objectContaining({
          workersCleanedUp: 0,
          orphanSessionsDestroyed: 0,
          heartbeatWarnings: 0,
          queuedTasks: 0,
          runningTasks: 0,
          tasksRequeued: 0,
          tasksFailed: 0,
        }),
      );
    });
  });

  describe('Stale heartbeat warning (observability)', () => {
    it('should log tmux warning when session is alive but heartbeat is older than 90s', async () => {
      const staleHeartbeat = Date.now() - 95_000; // 95s ago
      const aliveWorkerWithStaleHb = {
        ...buildTmuxWorker('w-stale-hb', 'task-stale-hb', 'beat-stale-hb'),
        lastHeartbeat: staleHeartbeat,
      };
      workerRepo.findAll.mockReturnValue(ok([aliveWorkerWithStaleHb]));
      // Session IS alive
      tmuxSessionManager.listSessions.mockReturnValue(ok([{ name: 'beat-stale-hb' }]));
      setupFindByStatus([], []);

      await manager.recover();

      // Worker should NOT be unregistered — session is alive
      expect(workerRepo.unregister).not.toHaveBeenCalled();

      // Warning logged for stale heartbeat
      expect(logger.warn).toHaveBeenCalledWith(
        'Tmux session alive but heartbeat stale',
        expect.objectContaining({
          workerId: WorkerId('w-stale-hb'),
          taskId: TaskId('task-stale-hb'),
          sessionName: 'beat-stale-hb',
        }),
      );
    });

    it('should NOT warn when heartbeat is fresh (< 90s)', async () => {
      const freshHeartbeat = Date.now() - 20_000;
      const aliveWorkerWithFreshHb = {
        ...buildTmuxWorker('w-fresh-hb', 'task-fresh-hb', 'beat-fresh-hb'),
        lastHeartbeat: freshHeartbeat,
      };
      workerRepo.findAll.mockReturnValue(ok([aliveWorkerWithFreshHb]));
      tmuxSessionManager.listSessions.mockReturnValue(ok([{ name: 'beat-fresh-hb' }]));
      setupFindByStatus([], []);

      await manager.recover();

      const staleWarnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => call[0] === 'Tmux session alive but heartbeat stale',
      );
      expect(staleWarnCalls).toHaveLength(0);
    });

    it('should NOT warn when lastHeartbeat is undefined (no heartbeat written yet)', async () => {
      const aliveWorkerNoHb = buildTmuxWorker('w-no-hb', 'task-no-hb', 'beat-no-hb');
      workerRepo.findAll.mockReturnValue(ok([aliveWorkerNoHb]));
      tmuxSessionManager.listSessions.mockReturnValue(ok([{ name: 'beat-no-hb' }]));
      setupFindByStatus([], []);

      await manager.recover();

      const staleWarnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => call[0] === 'Tmux session alive but heartbeat stale',
      );
      expect(staleWarnCalls).toHaveLength(0);
    });
  });

  describe('Loop cleanup', () => {
    it('should clean up old completed loops during recovery', async () => {
      const mockLoopRepo = createMockLoopRepository();
      mockLoopRepo.cleanupOldLoops.mockResolvedValue(ok(3));

      const managerWithLoops = new RecoveryManager({
        taskRepo: repo as unknown as TaskRepository,
        queue: queue as unknown as TaskQueue,
        eventBus: eventBus as unknown as EventBus,
        logger: logger as unknown as Logger,
        workerRepo: workerRepo as unknown as WorkerRepository,
        dependencyRepo: dependencyRepo as unknown as DependencyRepository,
        loopRepo: mockLoopRepo as unknown as LoopRepository,
        tmuxSessionManager,
      });

      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      setupFindByStatus([], []);

      await managerWithLoops.recover();

      expect(mockLoopRepo.cleanupOldLoops).toHaveBeenCalledWith(7 * 24 * 60 * 60 * 1000);
    });

    it('should log cleanup count when loops are cleaned up', async () => {
      const mockLoopRepo = createMockLoopRepository();
      mockLoopRepo.cleanupOldLoops.mockResolvedValue(ok(5));

      const managerWithLoops = new RecoveryManager({
        taskRepo: repo as unknown as TaskRepository,
        queue: queue as unknown as TaskQueue,
        eventBus: eventBus as unknown as EventBus,
        logger: logger as unknown as Logger,
        workerRepo: workerRepo as unknown as WorkerRepository,
        dependencyRepo: dependencyRepo as unknown as DependencyRepository,
        loopRepo: mockLoopRepo as unknown as LoopRepository,
        tmuxSessionManager,
      });

      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      setupFindByStatus([], []);

      await managerWithLoops.recover();

      expect(logger.info).toHaveBeenCalledWith('Cleaned up old completed loops', { count: 5 });
    });

    it('should skip loop cleanup when no LoopRepository is provided', async () => {
      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      setupFindByStatus([], []);

      await manager.recover();
    });
  });

  describe('Orchestration cleanup', () => {
    it('should clean up old completed orchestrations during recovery', async () => {
      const mockOrchRepo = createMockOrchestrationRepository();
      mockOrchRepo.cleanupOldOrchestrations.mockResolvedValue(ok(4));

      const managerWithOrch = new RecoveryManager({
        taskRepo: repo as unknown as TaskRepository,
        queue: queue as unknown as TaskQueue,
        eventBus: eventBus as unknown as EventBus,
        logger: logger as unknown as Logger,
        workerRepo: workerRepo as unknown as WorkerRepository,
        dependencyRepo: dependencyRepo as unknown as DependencyRepository,
        orchestrationRepo: mockOrchRepo as unknown as OrchestrationRepository,
        tmuxSessionManager,
      });

      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      setupFindByStatus([], []);

      await managerWithOrch.recover();

      expect(mockOrchRepo.cleanupOldOrchestrations).toHaveBeenCalledWith(7 * 24 * 60 * 60 * 1000);
    });

    it('should log cleanup count when orchestrations are cleaned up', async () => {
      const mockOrchRepo = createMockOrchestrationRepository();
      mockOrchRepo.cleanupOldOrchestrations.mockResolvedValue(ok(7));

      const managerWithOrch = new RecoveryManager({
        taskRepo: repo as unknown as TaskRepository,
        queue: queue as unknown as TaskQueue,
        eventBus: eventBus as unknown as EventBus,
        logger: logger as unknown as Logger,
        workerRepo: workerRepo as unknown as WorkerRepository,
        dependencyRepo: dependencyRepo as unknown as DependencyRepository,
        orchestrationRepo: mockOrchRepo as unknown as OrchestrationRepository,
        tmuxSessionManager,
      });

      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      setupFindByStatus([], []);

      await managerWithOrch.recover();

      expect(logger.info).toHaveBeenCalledWith('Cleaned up old completed orchestrations', { count: 7 });
    });

    it('should not log cleanup when zero orchestrations are cleaned', async () => {
      const mockOrchRepo = createMockOrchestrationRepository();
      mockOrchRepo.cleanupOldOrchestrations.mockResolvedValue(ok(0));

      const managerWithOrch = new RecoveryManager({
        taskRepo: repo as unknown as TaskRepository,
        queue: queue as unknown as TaskQueue,
        eventBus: eventBus as unknown as EventBus,
        logger: logger as unknown as Logger,
        workerRepo: workerRepo as unknown as WorkerRepository,
        dependencyRepo: dependencyRepo as unknown as DependencyRepository,
        orchestrationRepo: mockOrchRepo as unknown as OrchestrationRepository,
        tmuxSessionManager,
      });

      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      setupFindByStatus([], []);

      await managerWithOrch.recover();

      const orchCleanupCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => call[0] === 'Cleaned up old completed orchestrations',
      );
      expect(orchCleanupCalls).toHaveLength(0);
    });

    it('should skip orchestration cleanup when no OrchestrationRepository is provided', async () => {
      tmuxSessionManager.listSessions.mockReturnValue(ok([]));
      setupFindByStatus([], []);

      await manager.recover();
    });
  });
});
