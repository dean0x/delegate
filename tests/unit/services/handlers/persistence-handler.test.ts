import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTask, TaskId, TaskStatus } from '../../../../src/core/domain';
import { BackbeatError, ErrorCode } from '../../../../src/core/errors';
import { InMemoryEventBus } from '../../../../src/core/events/event-bus';
import { TaskPersistedEvent } from '../../../../src/core/events/events';
import { Database } from '../../../../src/implementations/database';
import { SQLiteTaskRepository } from '../../../../src/implementations/task-repository';
import { PersistenceHandler } from '../../../../src/services/handlers/persistence-handler';
import { createTestConfiguration } from '../../../fixtures/factories';
import { TestLogger } from '../../../fixtures/test-doubles';
import { flushEventLoop } from '../../../utils/event-helpers.js';

describe('PersistenceHandler', () => {
  let handler: PersistenceHandler;
  let eventBus: InMemoryEventBus;
  let taskRepo: SQLiteTaskRepository;
  let database: Database;
  let tempDir: string;
  let logger: TestLogger;

  beforeEach(async () => {
    logger = new TestLogger();
    const config = createTestConfiguration();
    eventBus = new InMemoryEventBus(config, logger);

    tempDir = await mkdtemp(join(tmpdir(), 'persistence-handler-test-'));
    database = new Database(join(tempDir, 'test.db'));
    taskRepo = new SQLiteTaskRepository(database);

    handler = new PersistenceHandler(taskRepo, logger);
    const setupResult = await handler.setup(eventBus);
    if (!setupResult.ok) {
      throw new Error(`Failed to setup PersistenceHandler: ${setupResult.error.message}`);
    }
  });

  afterEach(async () => {
    eventBus.dispose();
    database.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('TaskDelegated', () => {
    it('should save task to repository and emit TaskPersisted', async () => {
      const task = createTask({ prompt: 'test task' });

      // Subscribe to downstream event before emitting
      let persistedEvent: TaskPersistedEvent | undefined;
      eventBus.on('TaskPersisted', (event: TaskPersistedEvent) => {
        persistedEvent = event;
      });

      await eventBus.emit('TaskDelegated', { task });
      await flushEventLoop();

      // Task should be saved in the repository
      const findResult = await taskRepo.findById(task.id);
      expect(findResult.ok).toBe(true);
      expect(findResult.value).not.toBeNull();
      expect(findResult.value!.id).toBe(task.id);

      // TaskPersisted event should have been emitted
      expect(persistedEvent).toBeDefined();
      expect(persistedEvent!.taskId).toBe(task.id);
    });

    it('should log error and not crash when repository save fails', async () => {
      const task = createTask({ prompt: 'test task' });

      // Close the database to force save failure
      database.close();

      await eventBus.emit('TaskDelegated', { task });
      await flushEventLoop();

      // Should have logged an error, not thrown
      const errorLogs = logger.getLogsByLevel('error');
      expect(errorLogs.length).toBeGreaterThan(0);
      expect(errorLogs.some((l) => l.message.includes('Failed to persist delegated task'))).toBe(true);
    });
  });

  describe('TaskStarted', () => {
    it('should update task status to RUNNING with workerId and startedAt', async () => {
      const task = createTask({ prompt: 'test task' });
      await taskRepo.save(task);

      await eventBus.emit('TaskStarted', { taskId: task.id, workerId: 'worker-1' });
      await flushEventLoop();

      const findResult = await taskRepo.findById(task.id);
      expect(findResult.ok).toBe(true);
      expect(findResult.value!.status).toBe(TaskStatus.RUNNING);
      expect(findResult.value!.workerId).toBe('worker-1');
      expect(findResult.value!.startedAt).toBeDefined();
    });

    it('should log error when repository update fails', async () => {
      // Emit TaskStarted for a task that doesn't exist in the DB
      await eventBus.emit('TaskStarted', { taskId: TaskId('nonexistent-task'), workerId: 'worker-1' });
      await flushEventLoop();

      const errorLogs = logger.getLogsByLevel('error');
      expect(errorLogs.length).toBeGreaterThan(0);
      expect(errorLogs.some((l) => l.message.includes('Failed to persist task start'))).toBe(true);
    });
  });

  describe('TaskCompleted', () => {
    it('should update task to COMPLETED with exitCode and duration', async () => {
      const task = createTask({ prompt: 'test task' });
      await taskRepo.save(task);

      await eventBus.emit('TaskCompleted', { taskId: task.id, exitCode: 0, duration: 5000 });
      await flushEventLoop();

      const findResult = await taskRepo.findById(task.id);
      expect(findResult.ok).toBe(true);
      expect(findResult.value!.status).toBe(TaskStatus.COMPLETED);
      expect(findResult.value!.exitCode).toBe(0);
      expect(findResult.value!.completedAt).toBeDefined();
    });
  });

  describe('TaskFailed', () => {
    it('should update task to FAILED with exitCode', async () => {
      const task = createTask({ prompt: 'test task' });
      await taskRepo.save(task);

      const error = new BackbeatError(ErrorCode.TASK_FAILED, 'Process crashed');
      await eventBus.emit('TaskFailed', { taskId: task.id, error, exitCode: 1 });
      await flushEventLoop();

      const findResult = await taskRepo.findById(task.id);
      expect(findResult.ok).toBe(true);
      expect(findResult.value!.status).toBe(TaskStatus.FAILED);
      expect(findResult.value!.exitCode).toBe(1);
      expect(findResult.value!.completedAt).toBeDefined();
    });
  });

  describe('TaskCancelled', () => {
    it('should update task to CANCELLED with completedAt', async () => {
      const task = createTask({ prompt: 'test task' });
      await taskRepo.save(task);

      await eventBus.emit('TaskCancelled', { taskId: task.id, reason: 'user request' });
      await flushEventLoop();

      const findResult = await taskRepo.findById(task.id);
      expect(findResult.ok).toBe(true);
      expect(findResult.value!.status).toBe(TaskStatus.CANCELLED);
      expect(findResult.value!.completedAt).toBeDefined();
    });
  });

  describe('TaskTimeout', () => {
    it('should update task to FAILED with completedAt', async () => {
      const task = createTask({ prompt: 'test task' });
      await taskRepo.save(task);

      const error = new BackbeatError(ErrorCode.TASK_TIMEOUT, 'Task exceeded timeout');
      await eventBus.emit('TaskTimeout', { taskId: task.id, error });
      await flushEventLoop();

      const findResult = await taskRepo.findById(task.id);
      expect(findResult.ok).toBe(true);
      expect(findResult.value!.status).toBe(TaskStatus.FAILED);
      expect(findResult.value!.completedAt).toBeDefined();
    });
  });
});
