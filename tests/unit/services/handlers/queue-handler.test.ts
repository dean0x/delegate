import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTask, type Task, TaskId, TaskStatus } from '../../../../src/core/domain';
import { InMemoryEventBus } from '../../../../src/core/events/event-bus';
import { type TaskQueuedEvent } from '../../../../src/core/events/events';
import { Database } from '../../../../src/implementations/database';
import { SQLiteDependencyRepository } from '../../../../src/implementations/dependency-repository';
import { PriorityTaskQueue } from '../../../../src/implementations/task-queue';
import { SQLiteTaskRepository } from '../../../../src/implementations/task-repository';
import { QueueHandler } from '../../../../src/services/handlers/queue-handler';
import { createTestConfiguration } from '../../../fixtures/factories';
import { TestLogger } from '../../../fixtures/test-doubles';
import { flushEventLoop } from '../../../utils/event-helpers.js';

describe('QueueHandler', () => {
  let handler: QueueHandler;
  let eventBus: InMemoryEventBus;
  let queue: PriorityTaskQueue;
  let dependencyRepo: SQLiteDependencyRepository;
  let taskRepo: SQLiteTaskRepository;
  let database: Database;
  let tempDir: string;
  let logger: TestLogger;

  beforeEach(async () => {
    logger = new TestLogger();
    const config = createTestConfiguration();
    eventBus = new InMemoryEventBus(config, logger);

    tempDir = await mkdtemp(join(tmpdir(), 'queue-handler-test-'));
    database = new Database(join(tempDir, 'test.db'));
    dependencyRepo = new SQLiteDependencyRepository(database);
    taskRepo = new SQLiteTaskRepository(database);
    queue = new PriorityTaskQueue();

    handler = new QueueHandler(queue, dependencyRepo, taskRepo, logger);
    const setupResult = await handler.setup(eventBus);
    if (!setupResult.ok) {
      throw new Error(`Failed to setup QueueHandler: ${setupResult.error.message}`);
    }
  });

  afterEach(async () => {
    eventBus.dispose();
    database.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('enqueueIfReady', () => {
    it('should enqueue task and emit TaskQueued when no dependencies', async () => {
      const task = createTask({ prompt: 'test task' });

      let queuedEvent: TaskQueuedEvent | undefined;
      eventBus.on('TaskQueued', (event: TaskQueuedEvent) => {
        queuedEvent = event;
      });

      const result = await handler.enqueueIfReady(task);
      await flushEventLoop();

      expect(result.ok).toBe(true);
      expect(queue.size()).toBe(1);
      expect(queue.contains(task.id)).toBe(true);
      expect(queuedEvent).toBeDefined();
      expect(queuedEvent!.taskId).toBe(task.id);
    });

    it('should not enqueue task when blocked by dependencies', async () => {
      // Create parent and child tasks in the DB
      const parentTask = createTask({ prompt: 'parent task' });
      const childTask = createTask({ prompt: 'child task', dependsOn: [parentTask.id] });
      await taskRepo.save(parentTask);
      await taskRepo.save(childTask);

      // Add dependency to repo so isBlocked returns true
      await dependencyRepo.addDependency(childTask.id, parentTask.id);

      let queuedEvent: TaskQueuedEvent | undefined;
      eventBus.on('TaskQueued', (event: TaskQueuedEvent) => {
        queuedEvent = event;
      });

      const result = await handler.enqueueIfReady(childTask);
      await flushEventLoop();

      expect(result.ok).toBe(true);
      expect(queue.size()).toBe(0);
      expect(queue.contains(childTask.id)).toBe(false);
      expect(queuedEvent).toBeUndefined();
      expect(logger.hasLogContaining('Task blocked by dependencies')).toBe(true);
    });
  });

  describe('TaskCancellationRequested', () => {
    it('should remove task from queue when present', async () => {
      const task = createTask({ prompt: 'test task' });
      queue.enqueue(task);
      expect(queue.contains(task.id)).toBe(true);

      await eventBus.emit('TaskCancellationRequested', { taskId: task.id, reason: 'user cancel' });
      await flushEventLoop();

      expect(queue.contains(task.id)).toBe(false);
      expect(queue.size()).toBe(0);
    });

    it('should no-op when task is not in queue', async () => {
      // Task not in queue — should not crash
      await eventBus.emit('TaskCancellationRequested', { taskId: TaskId('nonexistent-task') });
      await flushEventLoop();

      expect(queue.size()).toBe(0);
      expect(logger.hasLogContaining('Task not in queue for cancellation')).toBe(true);
    });
  });

  describe('RequeueTask', () => {
    it('should re-enqueue task and emit TaskQueued', async () => {
      const task = createTask({ prompt: 'retried task' });

      let queuedEvent: TaskQueuedEvent | undefined;
      eventBus.on('TaskQueued', (event: TaskQueuedEvent) => {
        queuedEvent = event;
      });

      await eventBus.emit('RequeueTask', { task });
      await flushEventLoop();

      expect(queue.size()).toBe(1);
      expect(queue.contains(task.id)).toBe(true);
      expect(queuedEvent).toBeDefined();
      expect(queuedEvent!.taskId).toBe(task.id);
    });
  });

  describe('Fast-path blocked task check (v0.6.0)', () => {
    it('should not enqueue task when dependencyState is blocked', async () => {
      // Arrange - Create a task with dependsOn set (createTask sets dependencyState: 'blocked' automatically)
      const parentId = TaskId('parent-task-id');
      const task = createTask({ prompt: 'blocked task', dependsOn: [parentId] });
      // dependencyState is 'blocked' because dependsOn is set

      // Act - Call enqueueIfReady directly with the blocked task
      const result = await handler.enqueueIfReady(task);
      await flushEventLoop();

      // Assert - Task should NOT be enqueued (fast-path skip)
      expect(result.ok).toBe(true);
      expect(queue.size()).toBe(0);
      expect(queue.contains(task.id)).toBe(false);
      expect(logger.hasLogContaining('fast-path')).toBe(true);
    });

    it('should still enqueue task when dependencyState is none', async () => {
      // Arrange - Create a task with no dependencies (dependencyState: 'none')
      const task = createTask({ prompt: 'independent task' });
      // dependencyState is 'none' because no dependsOn

      let queuedEvent: TaskQueuedEvent | undefined;
      eventBus.on('TaskQueued', (event: TaskQueuedEvent) => {
        queuedEvent = event;
      });

      // Act - Call enqueueIfReady directly with the unblocked task
      const result = await handler.enqueueIfReady(task);
      await flushEventLoop();

      // Assert - Task should be enqueued normally
      expect(result.ok).toBe(true);
      expect(queue.size()).toBe(1);
      expect(queue.contains(task.id)).toBe(true);
      expect(queuedEvent).toBeDefined();
      expect(queuedEvent!.taskId).toBe(task.id);
    });
  });

  describe('TaskUnblocked', () => {
    it('should fetch fresh task from DB, enqueue, and emit TaskQueued', async () => {
      // Save task then update priority in DB — event payload has stale P2
      const task = createTask({ prompt: 'unblocked task', priority: 'P2' });
      await taskRepo.save(task);
      await taskRepo.update(task.id, { priority: 'P0' as Task['priority'] });

      let queuedEvent: TaskQueuedEvent | undefined;
      eventBus.on('TaskQueued', (event: TaskQueuedEvent) => {
        queuedEvent = event;
      });

      // Event carries stale task — handler should fetch fresh from DB
      await eventBus.emit('TaskUnblocked', { taskId: task.id, task });
      await flushEventLoop();

      expect(queue.size()).toBe(1);
      expect(queue.contains(task.id)).toBe(true);
      expect(queuedEvent).toBeDefined();
      expect(queuedEvent!.taskId).toBe(task.id);

      // Verify enqueued task reflects DB state (P0), not event payload (P2)
      const dequeued = queue.dequeue();
      expect(dequeued.ok).toBe(true);
      expect(dequeued.value!.priority).toBe('P0');
    });

    it('should not enqueue task that is no longer in QUEUED status', async () => {
      // Save task then update to CANCELLED — simulates race condition
      const task = createTask({ prompt: 'cancelled task' });
      await taskRepo.save(task);
      await taskRepo.update(task.id, { status: TaskStatus.CANCELLED });

      await eventBus.emit('TaskUnblocked', { taskId: task.id, task });
      await flushEventLoop();

      expect(queue.size()).toBe(0);
      expect(logger.hasLogContaining('no longer in QUEUED state')).toBe(true);
    });
  });
});
