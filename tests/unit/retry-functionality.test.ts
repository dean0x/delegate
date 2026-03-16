/**
 * Tests for retry functionality
 * Validates task retry behavior and tracking
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Configuration } from '../../src/core/configuration.js';
import { createTask, isTerminalState, Priority, Task, TaskId, TaskRequest, TaskStatus } from '../../src/core/domain.js';
import { ErrorCode } from '../../src/core/errors.js';
import { InMemoryEventBus } from '../../src/core/events/event-bus.js';
import { err, ok } from '../../src/core/result.js';
import { Database } from '../../src/implementations/database.js';
import { SQLiteDependencyRepository } from '../../src/implementations/dependency-repository.js';
import { BufferedOutputCapture } from '../../src/implementations/output-capture.js';
import { PriorityTaskQueue } from '../../src/implementations/task-queue.js';
import { SQLiteTaskRepository } from '../../src/implementations/task-repository.js';
import { PersistenceHandler } from '../../src/services/handlers/persistence-handler.js';
import { QueueHandler } from '../../src/services/handlers/queue-handler.js';
import { TaskManagerService } from '../../src/services/task-manager.js';
import { BUFFER_SIZES, TIMEOUTS } from '../constants.js';
import { TestLogger } from '../fixtures/test-doubles.js';

describe('Retry Functionality', () => {
  let taskManager: TaskManagerService;
  let eventBus: InMemoryEventBus;
  let repository: SQLiteTaskRepository;
  let database: Database;
  let logger: TestLogger;

  beforeEach(async () => {
    // Set up dependencies
    logger = new TestLogger();

    const config: Configuration = {
      timeout: TIMEOUTS.DEFAULT_TASK,
      maxOutputBuffer: BUFFER_SIZES.MEDIUM,
      cpuCoresReserved: 2,
      memoryReserve: 1073741824,
      logLevel: 'info',
      maxListenersPerEvent: 100,
      maxTotalSubscriptions: 1000,
      defaultAgent: 'claude',
    };

    // FIX: EventBus constructor expects (config, logger) not (logger)
    eventBus = new InMemoryEventBus(config, logger);
    database = new Database(':memory:');
    repository = new SQLiteTaskRepository(database);

    const outputCapture = new BufferedOutputCapture(BUFFER_SIZES.MEDIUM, eventBus);

    // Initialize task manager with hybrid architecture: direct repository + event bus
    taskManager = new TaskManagerService(eventBus, logger, config, repository, outputCapture);

    // Set up persistence handler for task save on TaskDelegated
    const dependencyRepo = new SQLiteDependencyRepository(database);
    const taskQueue = new PriorityTaskQueue();
    const queueHandler = new QueueHandler(taskQueue, dependencyRepo, repository, logger);
    const persistenceHandler = new PersistenceHandler(repository, queueHandler, logger);
    await persistenceHandler.setup(eventBus);
  });

  afterEach(() => {
    database.close();
  });

  describe('Task Retry Tracking', () => {
    it('should add retry tracking fields to new retry tasks', async () => {
      // Create original task
      const request: TaskRequest = {
        prompt: 'original task',
        priority: Priority.P2,
      };

      const originalResult = await taskManager.delegate(request);
      expect(originalResult.ok).toBe(true);
      if (!originalResult.ok) return;

      const originalTask = originalResult.value;

      // Mark task as failed
      await repository.update(originalTask.id, {
        status: TaskStatus.FAILED,
        error: 'Test failure',
      });

      // Retry the task
      const retryResult = await taskManager.retry(originalTask.id);
      expect(retryResult.ok).toBe(true);
      if (!retryResult.ok) return;

      const retryTask = retryResult.value;

      // Verify retry tracking fields
      expect(retryTask.parentTaskId).toBe(originalTask.id);
      expect(retryTask.retryCount).toBe(1);
      expect(retryTask.retryOf).toBe(originalTask.id);
      expect(retryTask.prompt).toBe(originalTask.prompt);
      expect(retryTask.priority).toBe(originalTask.priority);
    });

    it('should track multiple retry attempts correctly', async () => {
      // Create original task
      const request: TaskRequest = {
        prompt: 'task to retry multiple times',
      };

      const originalResult = await taskManager.delegate(request);
      expect(originalResult.ok).toBe(true);
      if (!originalResult.ok) return;

      const originalTask = originalResult.value;

      // First retry
      await repository.update(originalTask.id, { status: TaskStatus.FAILED });
      const retry1Result = await taskManager.retry(originalTask.id);
      expect(retry1Result.ok).toBe(true);
      if (!retry1Result.ok) return;

      const retry1 = retry1Result.value;
      expect(retry1.retryCount).toBe(1);
      expect(retry1.parentTaskId).toBe(originalTask.id);
      expect(retry1.retryOf).toBe(originalTask.id);

      // Second retry (retry the retry)
      await repository.update(retry1.id, { status: TaskStatus.FAILED });
      const retry2Result = await taskManager.retry(retry1.id);
      expect(retry2Result.ok).toBe(true);
      if (!retry2Result.ok) return;

      const retry2 = retry2Result.value;
      expect(retry2.retryCount).toBe(2);
      expect(retry2.parentTaskId).toBe(originalTask.id); // Still points to original
      expect(retry2.retryOf).toBe(retry1.id); // Direct parent is retry1
    });
  });

  describe('Retry Validation', () => {
    it('should only allow retry of terminal state tasks', async () => {
      // Create task
      const request: TaskRequest = {
        prompt: 'task to test retry validation',
      };

      const result = await taskManager.delegate(request);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const task = result.value;

      // Try to retry a queued task (should fail)
      const retryQueued = await taskManager.retry(task.id);
      expect(retryQueued.ok).toBe(false);
      if (retryQueued.ok) return;
      expect(retryQueued.error.code).toBe(ErrorCode.INVALID_OPERATION);

      // Try to retry a running task (should fail)
      await repository.update(task.id, { status: TaskStatus.RUNNING });
      const retryRunning = await taskManager.retry(task.id);
      expect(retryRunning.ok).toBe(false);
      if (retryRunning.ok) return;
      expect(retryRunning.error.code).toBe(ErrorCode.INVALID_OPERATION);

      // Retry a completed task (should succeed)
      await repository.update(task.id, { status: TaskStatus.COMPLETED });
      const retryCompleted = await taskManager.retry(task.id);
      expect(retryCompleted.ok).toBe(true);

      // Retry a failed task (should succeed)
      await repository.update(task.id, { status: TaskStatus.FAILED });
      const retryFailed = await taskManager.retry(task.id);
      expect(retryFailed.ok).toBe(true);

      // Retry a cancelled task (should succeed)
      await repository.update(task.id, { status: TaskStatus.CANCELLED });
      const retryCancelled = await taskManager.retry(task.id);
      expect(retryCancelled.ok).toBe(true);
    });

    it('should return error for non-existent tasks', async () => {
      const fakeId = TaskId('non-existent-task-id');
      const result = await taskManager.retry(fakeId);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe(ErrorCode.TASK_NOT_FOUND);
    });
  });

  describe('Retry Task Creation', () => {
    it('should preserve all task configuration in retries', async () => {
      // Create task with full configuration
      const request: TaskRequest = {
        prompt: 'complex task with all options',
        priority: Priority.P0,
        workingDirectory: '/test/dir',
        timeout: 60000,
        maxOutputBuffer: 1024,
      };

      const originalResult = await taskManager.delegate(request);
      expect(originalResult.ok).toBe(true);
      if (!originalResult.ok) return;

      const originalTask = originalResult.value;

      // Mark as failed and retry
      await repository.update(originalTask.id, { status: TaskStatus.FAILED });
      const retryResult = await taskManager.retry(originalTask.id);
      expect(retryResult.ok).toBe(true);
      if (!retryResult.ok) return;

      const retryTask = retryResult.value;

      // Verify all configuration is preserved
      expect(retryTask.prompt).toBe(originalTask.prompt);
      expect(retryTask.priority).toBe(originalTask.priority);
      expect(retryTask.workingDirectory).toBe(originalTask.workingDirectory);
      expect(retryTask.timeout).toBe(originalTask.timeout);
      expect(retryTask.maxOutputBuffer).toBe(originalTask.maxOutputBuffer);
    });

    it('should create a new task ID for retries', async () => {
      const request: TaskRequest = {
        prompt: 'test new ID generation',
      };

      const originalResult = await taskManager.delegate(request);
      expect(originalResult.ok).toBe(true);
      if (!originalResult.ok) return;

      const originalTask = originalResult.value;

      await repository.update(originalTask.id, { status: TaskStatus.FAILED });
      const retryResult = await taskManager.retry(originalTask.id);
      expect(retryResult.ok).toBe(true);
      if (!retryResult.ok) return;

      const retryTask = retryResult.value;

      // Should have different IDs
      expect(retryTask.id).not.toBe(originalTask.id);
      // But retry should reference original
      expect(retryTask.retryOf).toBe(originalTask.id);
    });
  });

  describe('Retry Event Handling', () => {
    it('should emit TaskDelegated event for retry task', async () => {
      let delegatedEvents: Array<{ task: Task }> = [];

      // Subscribe to TaskDelegated events
      eventBus.subscribe('TaskDelegated', async (event) => {
        delegatedEvents.push(event);
      });

      // Create and fail a task
      const request: TaskRequest = {
        prompt: 'test retry event',
      };

      const result = await taskManager.delegate(request);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const task = result.value;
      await repository.update(task.id, { status: TaskStatus.FAILED });

      // Retry the task
      const retryResult = await taskManager.retry(task.id);
      expect(retryResult.ok).toBe(true);
      if (!retryResult.ok) return;

      // Should have 2 TaskDelegated events (original + retry)
      expect(delegatedEvents.length).toBe(2);

      // Second event should be for retry task
      const retryEvent = delegatedEvents[1];
      expect(retryEvent.task.retryOf).toBe(task.id);
      expect(retryEvent.task.retryCount).toBe(1);
    });

    it('should trigger normal task processing for retry tasks', async () => {
      let delegatedEventCount = 0;

      // Count TaskDelegated events
      eventBus.subscribe('TaskDelegated', async () => {
        delegatedEventCount++;
      });

      // Create original task
      const request: TaskRequest = {
        prompt: 'test retry processing',
      };

      await taskManager.delegate(request);
      expect(delegatedEventCount).toBe(1);

      // Get the task and mark as failed
      const allTasks = await repository.findAllUnbounded();
      expect(allTasks.ok).toBe(true);
      if (!allTasks.ok) return;

      const originalTask = allTasks.value[0];
      await repository.update(originalTask.id, { status: TaskStatus.FAILED });

      // Retry should trigger another TaskDelegated event
      await taskManager.retry(originalTask.id);
      expect(delegatedEventCount).toBe(2);
    });
  });

  describe('Domain Helper Functions', () => {
    it('should correctly identify terminal states', () => {
      expect(isTerminalState(TaskStatus.COMPLETED)).toBe(true);
      expect(isTerminalState(TaskStatus.FAILED)).toBe(true);
      expect(isTerminalState(TaskStatus.CANCELLED)).toBe(true);
      expect(isTerminalState(TaskStatus.QUEUED)).toBe(false);
      expect(isTerminalState(TaskStatus.RUNNING)).toBe(false);
    });

    it('should correctly create tasks with retry fields', () => {
      const request: TaskRequest = {
        prompt: 'test',
        parentTaskId: TaskId('parent-123'),
        retryCount: 2,
        retryOf: TaskId('retry-of-123'),
      };

      const task = createTask(request);

      expect(task.parentTaskId).toBe(request.parentTaskId);
      expect(task.retryCount).toBe(2);
      expect(task.retryOf).toBe(request.retryOf);
    });
  });
});
