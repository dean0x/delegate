/**
 * Unit tests for RecoveryManager
 * ARCHITECTURE: Tests startup task recovery with pure mocks (no DB)
 * Pattern: Behavioral testing - focuses on recovery decisions:
 *   - Phase 0: Dead worker cleanup via PID-based detection
 *   - QUEUED tasks are re-queued
 *   - RUNNING tasks with no live worker (PID-based) are marked FAILED
 *   - RUNNING tasks with live worker are left alone (skipped)
 *   - Duplicate detection via queue.contains()
 *   - Error propagation from repository
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../../src/core/domain';
import { TaskId, TaskStatus, WorkerId } from '../../../src/core/domain';
import { BackbeatError, ErrorCode } from '../../../src/core/errors';
import type { EventBus } from '../../../src/core/events/event-bus';
import type {
  DependencyRepository,
  Logger,
  TaskQueue,
  TaskRepository,
  WorkerRepository,
} from '../../../src/core/interfaces';
import { err, ok } from '../../../src/core/result';
import { RecoveryManager } from '../../../src/services/recovery-manager';
import { TaskFactory } from '../../fixtures/factories';
import { createMockLogger, createMockWorkerRepository } from '../../fixtures/mocks';

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

describe('RecoveryManager', () => {
  let manager: RecoveryManager;
  let repo: ReturnType<typeof createMockRepo>;
  let queue: ReturnType<typeof createMockQueue>;
  let eventBus: ReturnType<typeof createTestEventBus>;
  let logger: ReturnType<typeof createMockLogger>;
  let workerRepo: ReturnType<typeof createMockWorkerRepository>;
  let dependencyRepo: ReturnType<typeof createMockDependencyRepo>;

  beforeEach(() => {
    repo = createMockRepo();
    queue = createMockQueue();
    eventBus = createTestEventBus();
    logger = createMockLogger();
    workerRepo = createMockWorkerRepository();
    dependencyRepo = createMockDependencyRepo();

    manager = new RecoveryManager(
      repo as unknown as TaskRepository,
      queue as unknown as TaskQueue,
      eventBus as unknown as EventBus,
      logger as unknown as Logger,
      workerRepo as unknown as WorkerRepository,
      dependencyRepo as unknown as DependencyRepository,
    );
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

  // Use current process PID for "alive" checks and a known-dead PID for "dead" checks
  const ALIVE_PID = process.pid;
  const DEAD_PID = 999999;

  // --- Tests ---

  describe('Phase 0: Dead worker cleanup on startup', () => {
    it('should unregister dead workers and fail their tasks', async () => {
      const deadWorker = {
        workerId: WorkerId('w-dead'),
        taskId: TaskId('task-dead'),
        pid: DEAD_PID,
        ownerPid: DEAD_PID,
        agent: 'claude',
        startedAt: Date.now(),
      };
      workerRepo.findAll.mockReturnValue(ok([deadWorker]));
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
        deadPid: DEAD_PID,
      });
    });

    it('should leave alive workers untouched', async () => {
      const aliveWorker = {
        workerId: WorkerId('w-alive'),
        taskId: TaskId('task-alive'),
        pid: ALIVE_PID,
        ownerPid: ALIVE_PID,
        agent: 'claude',
        startedAt: Date.now(),
      };
      workerRepo.findAll.mockReturnValue(ok([aliveWorker]));
      setupFindByStatus([], []);

      await manager.recover();

      expect(workerRepo.unregister).not.toHaveBeenCalled();
    });

    it('should handle mix of dead and alive workers', async () => {
      const deadWorker = {
        workerId: WorkerId('w-dead'),
        taskId: TaskId('task-dead'),
        pid: DEAD_PID,
        ownerPid: DEAD_PID,
        agent: 'claude',
        startedAt: Date.now(),
      };
      const aliveWorker = {
        workerId: WorkerId('w-alive'),
        taskId: TaskId('task-alive'),
        pid: ALIVE_PID,
        ownerPid: ALIVE_PID,
        agent: 'claude',
        startedAt: Date.now(),
      };
      workerRepo.findAll.mockReturnValue(ok([deadWorker, aliveWorker]));
      repo.findById.mockResolvedValue(ok(buildRunningTask('task-dead')));
      setupFindByStatus([], []);

      await manager.recover();

      expect(workerRepo.unregister).toHaveBeenCalledTimes(1);
      expect(workerRepo.unregister).toHaveBeenCalledWith(WorkerId('w-dead'));
    });

    it('should treat EPERM as process-alive (no permission to signal)', async () => {
      const epermWorker = {
        workerId: WorkerId('w-eperm'),
        taskId: TaskId('task-eperm'),
        pid: 42,
        ownerPid: 42,
        agent: 'claude',
        startedAt: Date.now(),
      };
      workerRepo.findAll.mockReturnValue(ok([epermWorker]));
      setupFindByStatus([], []);

      const killSpy = vi.spyOn(process, 'kill');
      try {
        const epermError = Object.assign(new Error('EPERM'), { code: 'EPERM' });
        killSpy.mockImplementation((pid: number) => {
          if (pid === 42) throw epermError;
          return true;
        });

        await manager.recover();

        // Worker should NOT be unregistered — EPERM means process is alive
        expect(workerRepo.unregister).not.toHaveBeenCalled();
      } finally {
        killSpy.mockRestore();
      }
    });

    it('should skip status update when dead worker task is already COMPLETED', async () => {
      const deadWorker = {
        workerId: WorkerId('w-dead-completed'),
        taskId: TaskId('task-completed'),
        pid: DEAD_PID,
        ownerPid: DEAD_PID,
        agent: 'claude',
        startedAt: Date.now(),
      };
      workerRepo.findAll.mockReturnValue(ok([deadWorker]));
      const completedTask = new TaskFactory().withStatus(TaskStatus.COMPLETED).build();
      repo.findById.mockResolvedValue(ok({ ...completedTask, id: TaskId('task-completed') }));
      setupFindByStatus([], []);

      await manager.recover();

      // Worker should be unregistered (dead PID)
      expect(workerRepo.unregister).toHaveBeenCalledWith(WorkerId('w-dead-completed'));
      // But task should NOT be updated (already terminal)
      expect(repo.update).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith('Dead worker row cleaned, task already terminal', {
        workerId: WorkerId('w-dead-completed'),
        taskId: TaskId('task-completed'),
        currentStatus: TaskStatus.COMPLETED,
        deadPid: DEAD_PID,
      });
    });

    it('should skip status update when dead worker task is already CANCELLED', async () => {
      const deadWorker = {
        workerId: WorkerId('w-dead-cancelled'),
        taskId: TaskId('task-cancelled'),
        pid: DEAD_PID,
        ownerPid: DEAD_PID,
        agent: 'claude',
        startedAt: Date.now(),
      };
      workerRepo.findAll.mockReturnValue(ok([deadWorker]));
      const cancelledTask = new TaskFactory().withStatus(TaskStatus.CANCELLED).build();
      repo.findById.mockResolvedValue(ok({ ...cancelledTask, id: TaskId('task-cancelled') }));
      setupFindByStatus([], []);

      await manager.recover();

      expect(workerRepo.unregister).toHaveBeenCalledWith(WorkerId('w-dead-cancelled'));
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('should handle findById failure gracefully in Phase 0', async () => {
      const deadWorker = {
        workerId: WorkerId('w-dead-err'),
        taskId: TaskId('task-err'),
        pid: DEAD_PID,
        ownerPid: DEAD_PID,
        agent: 'claude',
        startedAt: Date.now(),
      };
      workerRepo.findAll.mockReturnValue(ok([deadWorker]));
      const findError = new BackbeatError(ErrorCode.SYSTEM_ERROR, 'DB read failed');
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

  describe('Empty recovery', () => {
    it('should succeed with no operations when no queued or running tasks exist', async () => {
      setupFindByStatus([], []);

      const result = await manager.recover();

      expect(result.ok).toBe(true);
      expect(queue.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('Cleanup of old tasks', () => {
    it('should call cleanupOldTasks with 7-day threshold in milliseconds', async () => {
      setupFindByStatus([], []);
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

      await manager.recover();

      expect(repo.cleanupOldTasks).toHaveBeenCalledWith(sevenDaysMs);
    });

    it('should log cleanup count when tasks are cleaned up', async () => {
      setupFindByStatus([], []);
      repo.cleanupOldTasks.mockResolvedValue(ok(5));

      await manager.recover();

      expect(logger.info).toHaveBeenCalledWith('Cleaned up old completed tasks', { count: 5 });
    });

    it('should not log cleanup when zero tasks are cleaned', async () => {
      setupFindByStatus([], []);
      repo.cleanupOldTasks.mockResolvedValue(ok(0));

      await manager.recover();

      // info is called for other messages, but not for cleanup
      const cleanupCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => call[0] === 'Cleaned up old completed tasks',
      );
      expect(cleanupCalls).toHaveLength(0);
    });
  });

  describe('QUEUED task recovery', () => {
    it('should re-queue QUEUED tasks and emit TaskQueued events', async () => {
      const task1 = buildQueuedTask('queued-1');
      const task2 = buildQueuedTask('queued-2');
      setupFindByStatus([task1, task2], []);

      const result = await manager.recover();

      expect(result.ok).toBe(true);
      expect(queue.enqueue).toHaveBeenCalledTimes(2);
      expect(queue.enqueue).toHaveBeenCalledWith(task1);
      expect(queue.enqueue).toHaveBeenCalledWith(task2);

      // TaskQueued events emitted for each
      expect(eventBus.emit).toHaveBeenCalledWith('TaskQueued', {
        taskId: task1.id,
      });
      expect(eventBus.emit).toHaveBeenCalledWith('TaskQueued', {
        taskId: task2.id,
      });
    });

    it('should skip QUEUED tasks that are already in the queue', async () => {
      const task = buildQueuedTask('already-queued');
      setupFindByStatus([task], []);
      queue.contains.mockReturnValue(true);

      const result = await manager.recover();

      expect(result.ok).toBe(true);
      expect(queue.enqueue).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith('Task already in queue, skipping re-queue', { taskId: task.id });
    });

    it('should skip re-queuing QUEUED tasks that are blocked by dependencies', async () => {
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
      const task = buildQueuedTask('dep-error');
      setupFindByStatus([task], []);
      const depError = new BackbeatError(ErrorCode.SYSTEM_ERROR, 'DB read failed');
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
      const blockedTask = buildQueuedTask('blocked-1');
      const unblockedTask = buildQueuedTask('unblocked-1');
      setupFindByStatus([blockedTask, unblockedTask], []);
      dependencyRepo.isBlocked
        .mockResolvedValueOnce(ok(true)) // blocked-1 is blocked
        .mockResolvedValueOnce(ok(false)); // unblocked-1 is not

      const result = await manager.recover();

      expect(result.ok).toBe(true);
      expect(queue.enqueue).toHaveBeenCalledTimes(1);
      expect(queue.enqueue).toHaveBeenCalledWith(unblockedTask);
      expect(queue.enqueue).not.toHaveBeenCalledWith(blockedTask);
    });

    it('should log enqueue failures but continue recovery', async () => {
      const task1 = buildQueuedTask('fail-enqueue');
      const task2 = buildQueuedTask('succeed-enqueue');
      setupFindByStatus([task1, task2], []);

      const enqueueError = new BackbeatError(ErrorCode.QUEUE_FULL, 'Queue is full');
      queue.enqueue.mockReturnValueOnce(err(enqueueError)).mockReturnValueOnce(ok(undefined));

      const result = await manager.recover();

      // Recovery should succeed overall despite individual enqueue failure
      expect(result.ok).toBe(true);
      expect(logger.error).toHaveBeenCalledWith('Failed to re-queue task', enqueueError, { taskId: task1.id });
      // Second task should still be enqueued
      expect(eventBus.emit).toHaveBeenCalledWith('TaskQueued', {
        taskId: task2.id,
      });
    });
  });

  describe('RUNNING task recovery - PID-based detection', () => {
    it('should mark RUNNING task as FAILED when no worker row exists', async () => {
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

    it('should mark RUNNING task as FAILED when worker has dead ownerPid', async () => {
      const task = buildRunningTask('dead-worker');
      setupFindByStatus([], [task]);

      workerRepo.findByTaskId.mockReturnValue(
        ok({
          workerId: WorkerId('w1'),
          taskId: task.id,
          pid: DEAD_PID,
          ownerPid: DEAD_PID,
          agent: 'claude',
          startedAt: Date.now(),
        }),
      );

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

    it('should skip RUNNING task when worker has alive ownerPid', async () => {
      const task = buildRunningTask('alive-worker');
      setupFindByStatus([], [task]);

      workerRepo.findByTaskId.mockReturnValue(
        ok({
          workerId: WorkerId('w1'),
          taskId: task.id,
          pid: ALIVE_PID,
          ownerPid: ALIVE_PID,
          agent: 'claude',
          startedAt: Date.now(),
        }),
      );

      const result = await manager.recover();

      expect(result.ok).toBe(true);
      // Task should NOT be updated (it's alive)
      expect(repo.update).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith('Running task has live worker in another process, skipping', {
        taskId: task.id,
        ownerPid: ALIVE_PID,
      });
    });

    it('should not re-queue RUNNING tasks with dead workers', async () => {
      const task = buildRunningTask('dead-no-queue');
      setupFindByStatus([], [task]);
      // Default: findByTaskId returns ok(null) — no worker

      await manager.recover();

      // Enqueue should not be called for crashed tasks
      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it('should log crashed task failure', async () => {
      const task = buildRunningTask('crashed-logged');
      setupFindByStatus([], [task]);
      // Default: findByTaskId returns ok(null) — no worker

      await manager.recover();

      expect(logger.info).toHaveBeenCalledWith(
        'Marked crashed task as failed (no live worker)',
        expect.objectContaining({
          taskId: task.id,
        }),
      );
    });

    it('should log error when update fails for crashed task', async () => {
      const task = buildRunningTask('crashed-update-fail');
      setupFindByStatus([], [task]);
      // Default: findByTaskId returns ok(null) — no worker
      const updateError = new BackbeatError(ErrorCode.SYSTEM_ERROR, 'DB write failed');
      repo.update.mockResolvedValue(err(updateError));

      await manager.recover();

      expect(logger.error).toHaveBeenCalledWith('Failed to update crashed task', updateError, {
        taskId: task.id,
      });
    });

    it('should skip RUNNING task when it became terminal between fetch and update', async () => {
      const task = buildRunningTask('race-completed');
      setupFindByStatus([], [task]);
      // No worker row → would normally mark as FAILED
      workerRepo.findByTaskId.mockReturnValue(ok(null));
      // But task has since been completed by another process (TOCTOU)
      const completedTask = new TaskFactory().withStatus(TaskStatus.COMPLETED).build();
      repo.findById.mockResolvedValue(ok({ ...completedTask, id: TaskId('race-completed') }));

      await manager.recover();

      // Task should NOT be updated — it's already terminal
      expect(repo.update).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith('Running task already terminal, skipping recovery', {
        taskId: TaskId('race-completed'),
        currentStatus: TaskStatus.COMPLETED,
      });
    });
  });

  describe('TaskFailed event emission', () => {
    it('should emit TaskFailed event when marking crashed RUNNING task as failed', async () => {
      const task = buildRunningTask('crashed-emit');
      setupFindByStatus([], [task]);
      // No worker row → crash
      workerRepo.findByTaskId.mockReturnValue(ok(null));

      await manager.recover();

      expect(eventBus.emit).toHaveBeenCalledWith('TaskFailed', {
        taskId: task.id,
        error: expect.objectContaining({ message: 'Worker process crashed during execution' }),
        exitCode: -1,
      });
    });

    it('should log error and continue recovery when TaskFailed emit fails for dead worker task', async () => {
      const deadWorker = {
        workerId: WorkerId('w-dead-fail'),
        taskId: TaskId('task-dead-fail'),
        pid: DEAD_PID,
        ownerPid: DEAD_PID,
        agent: 'claude',
        startedAt: Date.now(),
      };
      workerRepo.findAll.mockReturnValue(ok([deadWorker]));
      repo.findById.mockResolvedValue(ok(buildRunningTask('task-dead-fail')));
      setupFindByStatus([], []);

      const emitError = new BackbeatError(ErrorCode.SYSTEM_ERROR, 'Event bus error');
      // First emit call is TaskFailed for dead worker — make it fail
      eventBus.emit.mockResolvedValueOnce(err(emitError));

      const result = await manager.recover();

      // Recovery should succeed despite emit failure
      expect(result.ok).toBe(true);
      expect(logger.error).toHaveBeenCalledWith('Failed to emit TaskFailed event for dead worker task', emitError, {
        taskId: TaskId('task-dead-fail'),
      });
      // Task was still marked as FAILED in the repository
      expect(repo.update).toHaveBeenCalledWith(
        TaskId('task-dead-fail'),
        expect.objectContaining({ status: TaskStatus.FAILED }),
      );
    });

    it('should log error and continue recovery when TaskFailed emit fails for crashed running task', async () => {
      const task = buildRunningTask('crashed-emit-fail');
      setupFindByStatus([], [task]);
      workerRepo.findByTaskId.mockReturnValue(ok(null));

      const emitError = new BackbeatError(ErrorCode.SYSTEM_ERROR, 'Event bus error');
      // TaskFailed emit for crashed running task — make it fail
      eventBus.emit.mockResolvedValueOnce(err(emitError));

      const result = await manager.recover();

      // Recovery should succeed despite emit failure
      expect(result.ok).toBe(true);
      expect(logger.error).toHaveBeenCalledWith('Failed to emit TaskFailed event for crashed task', emitError, {
        taskId: task.id,
      });
      // Task was still marked as FAILED in the repository
      expect(repo.update).toHaveBeenCalledWith(task.id, expect.objectContaining({ status: TaskStatus.FAILED }));
    });

    it('should emit TaskFailed event when failing dead worker task', async () => {
      const deadWorker = {
        workerId: WorkerId('w-dead-emit'),
        taskId: TaskId('task-dead-emit'),
        pid: DEAD_PID,
        ownerPid: DEAD_PID,
        agent: 'claude',
        startedAt: Date.now(),
      };
      workerRepo.findAll.mockReturnValue(ok([deadWorker]));
      repo.findById.mockResolvedValue(ok(buildRunningTask('task-dead-emit')));
      setupFindByStatus([], []);

      await manager.recover();

      expect(eventBus.emit).toHaveBeenCalledWith('TaskFailed', {
        taskId: TaskId('task-dead-emit'),
        error: expect.objectContaining({ message: 'Worker process died (dead PID detected)' }),
        exitCode: -1,
      });
    });
  });

  describe('Error propagation', () => {
    it('should return error when findByStatus for QUEUED tasks fails', async () => {
      const findError = new BackbeatError(ErrorCode.SYSTEM_ERROR, 'DB read failed');
      repo.findByStatus.mockResolvedValueOnce(err(findError));

      const result = await manager.recover();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(findError);
      }
    });

    it('should return error when findByStatus for RUNNING tasks fails', async () => {
      const findError = new BackbeatError(ErrorCode.SYSTEM_ERROR, 'DB read failed');
      repo.findByStatus
        .mockResolvedValueOnce(ok([])) // QUEUED succeeds
        .mockResolvedValueOnce(err(findError)); // RUNNING fails

      const result = await manager.recover();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(findError);
      }
    });
  });

  describe('Mixed scenario', () => {
    it('should handle a mix of queued, dead-worker running, and alive-worker running tasks', async () => {
      const queuedTask = buildQueuedTask('q-1');
      const deadWorkerTask = buildRunningTask('dead-1');
      const aliveWorkerTask = buildRunningTask('alive-1');
      setupFindByStatus([queuedTask], [deadWorkerTask, aliveWorkerTask]);

      // Dead worker for first task, alive worker for second
      workerRepo.findByTaskId
        .mockReturnValueOnce(ok(null)) // dead-1: no worker row
        .mockReturnValueOnce(
          ok({
            workerId: WorkerId('w-alive'),
            taskId: aliveWorkerTask.id,
            pid: ALIVE_PID,
            ownerPid: ALIVE_PID,
            agent: 'claude',
            startedAt: Date.now(),
          }),
        );

      const result = await manager.recover();

      expect(result.ok).toBe(true);

      // Queued task re-queued
      expect(queue.enqueue).toHaveBeenCalledWith(queuedTask);

      // Dead-worker task marked FAILED
      expect(repo.update).toHaveBeenCalledWith(
        deadWorkerTask.id,
        expect.objectContaining({
          status: TaskStatus.FAILED,
          exitCode: -1,
        }),
      );

      // Alive-worker task left alone (not updated)
      const updateCalls = repo.update.mock.calls.filter((call: unknown[]) => call[0] === aliveWorkerTask.id);
      expect(updateCalls).toHaveLength(0);
    });

    it('should handle multiple queued and multiple running tasks', async () => {
      const q1 = buildQueuedTask('q-1');
      const q2 = buildQueuedTask('q-2');
      const deadTask1 = buildRunningTask('dead-1');
      const deadTask2 = buildRunningTask('dead-2');
      const aliveTask = buildRunningTask('alive-1');
      setupFindByStatus([q1, q2], [deadTask1, deadTask2, aliveTask]);

      // Second queued task is already in queue
      queue.contains
        .mockReturnValueOnce(false) // q1 not in queue
        .mockReturnValueOnce(true); // q2 already in queue

      // Worker lookups: dead tasks have no worker, alive task has worker
      workerRepo.findByTaskId
        .mockReturnValueOnce(ok(null)) // dead-1: no worker
        .mockReturnValueOnce(ok(null)) // dead-2: no worker
        .mockReturnValueOnce(
          ok({
            workerId: WorkerId('w-alive'),
            taskId: aliveTask.id,
            pid: ALIVE_PID,
            ownerPid: ALIVE_PID,
            agent: 'claude',
            startedAt: Date.now(),
          }),
        );

      await manager.recover();

      // q1 enqueued, q2 skipped
      expect(queue.enqueue).toHaveBeenCalledTimes(1);
      expect(queue.enqueue).toHaveBeenCalledWith(q1);

      // 2 dead tasks marked FAILED (alive task skipped)
      const failedUpdateCalls = repo.update.mock.calls.filter((call: unknown[]) => {
        const update = call[1] as { status?: string };
        return update.status === TaskStatus.FAILED;
      });
      expect(failedUpdateCalls).toHaveLength(2);
    });
  });

  describe('TaskQueued event emit failure', () => {
    it('should log TaskQueued event emit failure but still count task as recovered', async () => {
      const task = buildQueuedTask('event-fail');
      setupFindByStatus([task], []);
      const emitError = new BackbeatError(ErrorCode.SYSTEM_ERROR, 'Event bus error');

      // TaskQueued fails
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
      // Even a very recent task with no worker row is definitively crashed
      const base = new TaskFactory()
        .withStatus(TaskStatus.RUNNING)
        .withStartedAt(Date.now() - 1000) // Started 1 second ago
        .build();
      const task = { ...base, id: TaskId('recent-no-worker') };
      setupFindByStatus([], [task]);
      // Default: findByTaskId returns ok(null)

      await manager.recover();

      // PID-based: no worker → FAILED, regardless of age
      expect(repo.update).toHaveBeenCalledWith(
        task.id,
        expect.objectContaining({
          status: TaskStatus.FAILED,
          exitCode: -1,
        }),
      );
    });

    it('should call findByStatus with correct status values', async () => {
      setupFindByStatus([], []);

      await manager.recover();

      expect(repo.findByStatus).toHaveBeenCalledWith(TaskStatus.QUEUED);
      expect(repo.findByStatus).toHaveBeenCalledWith(TaskStatus.RUNNING);
    });

    it('should return ok result on successful recovery', async () => {
      setupFindByStatus([], []);

      const result = await manager.recover();

      expect(result).toEqual({ ok: true, value: undefined });
    });
  });
});
