/**
 * Unit tests for RecoveryManager
 * ARCHITECTURE: Tests startup task recovery with pure mocks (no DB)
 * Pattern: Behavioral testing - focuses on recovery decisions:
 *   - QUEUED tasks are re-queued
 *   - Stale RUNNING tasks (>=30min) are marked FAILED
 *   - Recent RUNNING tasks (<30min) are re-queued
 *   - Duplicate detection via queue.contains()
 *   - Error propagation from repository
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../../src/core/domain';
import { TaskId, TaskStatus } from '../../../src/core/domain';
import { BackbeatError, ErrorCode } from '../../../src/core/errors';
import type { EventBus } from '../../../src/core/events/event-bus';
import type { Logger, TaskQueue, TaskRepository } from '../../../src/core/interfaces';
import { err, ok } from '../../../src/core/result';
import { RecoveryManager } from '../../../src/services/recovery-manager';
import { TaskFactory } from '../../fixtures/factories';
import { createMockLogger } from '../../fixtures/mocks';

// --- Mock factories ---

const createMockRepo = () => ({
  save: vi.fn(),
  update: vi.fn().mockResolvedValue(ok(undefined)),
  findById: vi.fn(),
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

describe('RecoveryManager', () => {
  let manager: RecoveryManager;
  let repo: ReturnType<typeof createMockRepo>;
  let queue: ReturnType<typeof createMockQueue>;
  let eventBus: ReturnType<typeof createTestEventBus>;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    repo = createMockRepo();
    queue = createMockQueue();
    eventBus = createTestEventBus();
    logger = createMockLogger();

    manager = new RecoveryManager(
      repo as unknown as TaskRepository,
      queue as unknown as TaskQueue,
      eventBus as unknown as EventBus,
      logger as unknown as Logger,
    );
  });

  // --- Helpers ---
  // NOTE: TaskFactory.withId() cannot be used because createTask() returns a frozen object.
  // Instead, we build via the factory and spread into a new (unfrozen) object with the desired id.

  const THIRTY_ONE_MINUTES_AGO = Date.now() - 31 * 60 * 1000;
  const FIVE_MINUTES_AGO = Date.now() - 5 * 60 * 1000;

  function buildQueuedTask(id: string): Task {
    const base = new TaskFactory().withStatus(TaskStatus.QUEUED).build();
    return { ...base, id: TaskId(id) };
  }

  function buildStaleRunningTask(id: string): Task {
    const base = new TaskFactory().withStatus(TaskStatus.RUNNING).withStartedAt(THIRTY_ONE_MINUTES_AGO).build();
    return { ...base, id: TaskId(id) };
  }

  function buildRecentRunningTask(id: string): Task {
    const base = new TaskFactory().withStatus(TaskStatus.RUNNING).withStartedAt(FIVE_MINUTES_AGO).build();
    return { ...base, id: TaskId(id) };
  }

  function setupFindByStatus(queuedTasks: readonly unknown[], runningTasks: readonly unknown[]): void {
    repo.findByStatus.mockResolvedValueOnce(ok(queuedTasks)).mockResolvedValueOnce(ok(runningTasks));
  }

  // --- Tests ---

  describe('Recovery events', () => {
    it('should emit RecoveryStarted event at the beginning', async () => {
      setupFindByStatus([], []);

      await manager.recover();

      expect(eventBus.emit).toHaveBeenCalledWith('RecoveryStarted', {});
    });

    it('should emit RecoveryCompleted event with correct counts when no tasks exist', async () => {
      setupFindByStatus([], []);

      const result = await manager.recover();

      expect(result.ok).toBe(true);
      expect(eventBus.emit).toHaveBeenCalledWith('RecoveryCompleted', {
        tasksRecovered: 0,
        tasksMarkedFailed: 0,
      });
    });
  });

  describe('Empty recovery', () => {
    it('should succeed with no operations when no queued or running tasks exist', async () => {
      setupFindByStatus([], []);

      const result = await manager.recover();

      expect(result.ok).toBe(true);
      expect(queue.enqueue).not.toHaveBeenCalled();
      expect(repo.update).not.toHaveBeenCalled();
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
        task: task1,
      });
      expect(eventBus.emit).toHaveBeenCalledWith('TaskQueued', {
        taskId: task2.id,
        task: task2,
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
        task: task2,
      });
    });

    it('should include re-queued QUEUED tasks in RecoveryCompleted count', async () => {
      const task = buildQueuedTask('counted-task');
      setupFindByStatus([task], []);

      await manager.recover();

      expect(eventBus.emit).toHaveBeenCalledWith('RecoveryCompleted', {
        tasksRecovered: 1,
        tasksMarkedFailed: 0,
      });
    });
  });

  describe('RUNNING task recovery - stale tasks', () => {
    it('should mark stale RUNNING tasks (>=30 min) as FAILED with exitCode -1', async () => {
      const staleTask = buildStaleRunningTask('stale-1');
      setupFindByStatus([], [staleTask]);

      const result = await manager.recover();

      expect(result.ok).toBe(true);
      expect(repo.update).toHaveBeenCalledWith(
        staleTask.id,
        expect.objectContaining({
          status: TaskStatus.FAILED,
          exitCode: -1,
          completedAt: expect.any(Number),
        }),
      );
    });

    it('should not re-queue stale RUNNING tasks', async () => {
      const staleTask = buildStaleRunningTask('stale-no-queue');
      setupFindByStatus([], [staleTask]);

      await manager.recover();

      // Enqueue should not be called for stale tasks
      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it('should use startedAt for age calculation when available', async () => {
      // Create task with startedAt 5 min ago but createdAt 2 hours ago
      const base = new TaskFactory().withStatus(TaskStatus.RUNNING).withStartedAt(FIVE_MINUTES_AGO).build();
      const task = {
        ...base,
        id: TaskId('started-at-test'),
        createdAt: Date.now() - 120 * 60 * 1000,
      };
      setupFindByStatus([], [task]);

      await manager.recover();

      // Should be treated as recent (using startedAt=5min, not createdAt=2hr)
      expect(queue.enqueue).toHaveBeenCalledWith(task);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('should fall back to createdAt when startedAt is undefined', async () => {
      // Task with no startedAt, createdAt 31 min ago
      const base = new TaskFactory().withStatus(TaskStatus.RUNNING).build();
      const taskWithoutStartedAt = {
        ...base,
        id: TaskId('no-started-at'),
        createdAt: THIRTY_ONE_MINUTES_AGO,
        startedAt: undefined,
      };
      setupFindByStatus([], [taskWithoutStartedAt]);

      await manager.recover();

      // Should use createdAt => 31 min => stale => marked FAILED
      expect(repo.update).toHaveBeenCalledWith(
        taskWithoutStartedAt.id,
        expect.objectContaining({
          status: TaskStatus.FAILED,
          exitCode: -1,
        }),
      );
    });

    it('should include stale tasks in RecoveryCompleted markedFailed count', async () => {
      const staleTask = buildStaleRunningTask('stale-counted');
      setupFindByStatus([], [staleTask]);

      await manager.recover();

      expect(eventBus.emit).toHaveBeenCalledWith('RecoveryCompleted', {
        tasksRecovered: 0,
        tasksMarkedFailed: 1,
      });
    });

    it('should log stale task failure with age in minutes', async () => {
      const staleTask = buildStaleRunningTask('stale-logged');
      setupFindByStatus([], [staleTask]);

      await manager.recover();

      expect(logger.info).toHaveBeenCalledWith(
        'Marked stale crashed task as failed',
        expect.objectContaining({
          taskId: staleTask.id,
          ageMinutes: expect.any(Number),
        }),
      );
    });

    it('should log error when update fails for stale task', async () => {
      const staleTask = buildStaleRunningTask('stale-update-fail');
      setupFindByStatus([], [staleTask]);
      const updateError = new BackbeatError(ErrorCode.SYSTEM_ERROR, 'DB write failed');
      repo.update.mockResolvedValue(err(updateError));

      await manager.recover();

      expect(logger.error).toHaveBeenCalledWith('Failed to update stale crashed task', updateError, {
        taskId: staleTask.id,
      });
    });
  });

  describe('RUNNING task recovery - recent tasks', () => {
    it('should re-queue recent RUNNING tasks (<30 min) and emit TaskQueued events', async () => {
      const recentTask = buildRecentRunningTask('recent-1');
      setupFindByStatus([], [recentTask]);

      const result = await manager.recover();

      expect(result.ok).toBe(true);
      expect(queue.enqueue).toHaveBeenCalledWith(recentTask);
      expect(eventBus.emit).toHaveBeenCalledWith('TaskQueued', {
        taskId: recentTask.id,
        task: recentTask,
      });
    });

    it('should skip recent RUNNING tasks already in the queue', async () => {
      const recentTask = buildRecentRunningTask('recent-already-queued');
      setupFindByStatus([], [recentTask]);
      queue.contains.mockReturnValue(true);

      await manager.recover();

      expect(queue.enqueue).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith('Task already in queue, skipping re-queue', { taskId: recentTask.id });
    });

    it('should include re-queued recent tasks in RecoveryCompleted tasksRecovered count', async () => {
      const recentTask = buildRecentRunningTask('recent-counted');
      setupFindByStatus([], [recentTask]);

      await manager.recover();

      expect(eventBus.emit).toHaveBeenCalledWith('RecoveryCompleted', {
        tasksRecovered: 1,
        tasksMarkedFailed: 0,
      });
    });

    it('should log enqueue failure for recent running task but continue', async () => {
      const recentTask = buildRecentRunningTask('recent-enqueue-fail');
      setupFindByStatus([], [recentTask]);
      const enqueueError = new BackbeatError(ErrorCode.QUEUE_FULL, 'Queue full');
      queue.enqueue.mockReturnValue(err(enqueueError));

      const result = await manager.recover();

      expect(result.ok).toBe(true);
      expect(logger.error).toHaveBeenCalledWith('Failed to re-queue recent running task', enqueueError, {
        taskId: recentTask.id,
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

    it('should log error when RecoveryStarted emit fails but continue recovery', async () => {
      const emitError = new BackbeatError(ErrorCode.SYSTEM_ERROR, 'Event bus error');
      eventBus.emit
        .mockResolvedValueOnce(err(emitError)) // RecoveryStarted fails
        .mockResolvedValue(ok(undefined)); // All subsequent emits succeed
      setupFindByStatus([], []);

      const result = await manager.recover();

      // Recovery should still succeed
      expect(result.ok).toBe(true);
      expect(logger.error).toHaveBeenCalledWith('Failed to emit RecoveryStarted event', emitError);
    });

    it('should log error when RecoveryCompleted emit fails', async () => {
      setupFindByStatus([], []);
      const emitError = new BackbeatError(ErrorCode.SYSTEM_ERROR, 'Event bus error');
      // RecoveryStarted succeeds, RecoveryCompleted fails
      eventBus.emit
        .mockResolvedValueOnce(ok(undefined)) // RecoveryStarted
        .mockResolvedValueOnce(err(emitError)); // RecoveryCompleted

      const result = await manager.recover();

      // Recovery should still return ok (emit failure is logged, not propagated)
      expect(result.ok).toBe(true);
      expect(logger.error).toHaveBeenCalledWith('Failed to emit RecoveryCompleted event', emitError);
    });
  });

  describe('Mixed scenario', () => {
    it('should handle a mix of queued, stale running, and recent running tasks', async () => {
      const queuedTask = buildQueuedTask('q-1');
      const staleTask = buildStaleRunningTask('stale-1');
      const recentTask = buildRecentRunningTask('recent-1');
      setupFindByStatus([queuedTask], [staleTask, recentTask]);

      const result = await manager.recover();

      expect(result.ok).toBe(true);

      // Queued task re-queued
      expect(queue.enqueue).toHaveBeenCalledWith(queuedTask);

      // Stale task marked FAILED
      expect(repo.update).toHaveBeenCalledWith(
        staleTask.id,
        expect.objectContaining({
          status: TaskStatus.FAILED,
          exitCode: -1,
        }),
      );

      // Recent task re-queued
      expect(queue.enqueue).toHaveBeenCalledWith(recentTask);

      // Correct counts: 2 re-queued (queued + recent), 1 failed (stale)
      expect(eventBus.emit).toHaveBeenCalledWith('RecoveryCompleted', {
        tasksRecovered: 2,
        tasksMarkedFailed: 1,
      });
    });

    it('should handle multiple queued and multiple running tasks', async () => {
      const q1 = buildQueuedTask('q-1');
      const q2 = buildQueuedTask('q-2');
      const stale1 = buildStaleRunningTask('stale-1');
      const stale2 = buildStaleRunningTask('stale-2');
      const recent1 = buildRecentRunningTask('recent-1');
      setupFindByStatus([q1, q2], [stale1, stale2, recent1]);

      // Second queued task is already in queue
      queue.contains
        .mockReturnValueOnce(false) // q1 not in queue
        .mockReturnValueOnce(true) // q2 already in queue
        .mockReturnValueOnce(false); // recent1 not in queue

      await manager.recover();

      // q1 enqueued, q2 skipped, recent1 enqueued
      expect(queue.enqueue).toHaveBeenCalledTimes(2);
      expect(queue.enqueue).toHaveBeenCalledWith(q1);
      expect(queue.enqueue).toHaveBeenCalledWith(recent1);

      // 2 stale tasks marked FAILED
      expect(repo.update).toHaveBeenCalledTimes(2);

      // 2 re-queued (q1 + recent1), 2 marked failed (stale1 + stale2)
      expect(eventBus.emit).toHaveBeenCalledWith('RecoveryCompleted', {
        tasksRecovered: 2,
        tasksMarkedFailed: 2,
      });
    });
  });

  describe('TaskQueued event emit failure', () => {
    it('should log TaskQueued event emit failure but still count task as recovered', async () => {
      const task = buildQueuedTask('event-fail');
      setupFindByStatus([task], []);
      const emitError = new BackbeatError(ErrorCode.SYSTEM_ERROR, 'Event bus error');

      // RecoveryStarted succeeds, TaskQueued fails, RecoveryCompleted succeeds
      eventBus.emit
        .mockResolvedValueOnce(ok(undefined)) // RecoveryStarted
        .mockResolvedValueOnce(err(emitError)) // TaskQueued
        .mockResolvedValueOnce(ok(undefined)); // RecoveryCompleted

      const result = await manager.recover();

      expect(result.ok).toBe(true);
      expect(logger.error).toHaveBeenCalledWith('Failed to emit TaskQueued event for recovered task', emitError, {
        taskId: task.id,
      });
      // Task is still counted despite event emit failure
      expect(eventBus.emit).toHaveBeenCalledWith('RecoveryCompleted', {
        tasksRecovered: 1,
        tasksMarkedFailed: 0,
      });
    });
  });

  describe('Edge cases', () => {
    it('should handle task at exactly 30 minute boundary as not stale', async () => {
      // Task started slightly less than 30 minutes ago to avoid timing drift
      // between Date.now() here and Date.now() inside recover()
      const base = new TaskFactory()
        .withStatus(TaskStatus.RUNNING)
        .withStartedAt(Date.now() - 30 * 60 * 1000 + 1000)
        .build();
      const task = { ...base, id: TaskId('boundary-task') };
      setupFindByStatus([], [task]);

      await manager.recover();

      // Under 30 min threshold, so isStale = false (> not >=)
      // The task should be re-queued, not marked failed
      expect(queue.enqueue).toHaveBeenCalledWith(task);
      expect(repo.update).not.toHaveBeenCalled();
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
