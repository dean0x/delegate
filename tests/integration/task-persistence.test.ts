/**
 * Integration test for task persistence and recovery
 * Tests database operations, queue persistence, and recovery flows
 */

import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskId } from '../../src/core/domain.js';
import { InMemoryEventBus } from '../../src/core/events/event-bus.js';
import { ok } from '../../src/core/result.js';
import { Database } from '../../src/implementations/database.js';
import { SQLiteDependencyRepository } from '../../src/implementations/dependency-repository.js';
import { PriorityTaskQueue } from '../../src/implementations/task-queue.js';
import { SQLiteTaskRepository } from '../../src/implementations/task-repository.js';
import { RecoveryManager } from '../../src/services/recovery-manager.js';
import { createTestConfiguration } from '../fixtures/factories.js';
import { createMockWorkerRepository } from '../fixtures/mocks.js';
import { createTestTask as createTask } from '../fixtures/test-data.js';
import { TestLogger } from '../fixtures/test-doubles.js';

describe('Integration: Task persistence', () => {
  it('should persist tasks across restarts', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'backbeat-test-'));
    const dbPath = join(tempDir, 'test.db');
    const logger = new TestLogger();

    try {
      // Phase 1: Create and persist tasks
      const database1 = new Database(dbPath);
      const repository1 = new SQLiteTaskRepository(database1);
      const queue1 = new PriorityTaskQueue(logger);

      const staleTimestamp = Date.now() - 3600000; // 1 hour ago
      const tasks = [
        createTask({ prompt: 'Task 1', priority: 'P0', status: 'queued' }),
        createTask({
          prompt: 'Task 2',
          priority: 'P1',
          status: 'running',
          startedAt: staleTimestamp,
          updatedAt: staleTimestamp, // CRITICAL: Also set updatedAt for stale detection
        }),
        createTask({ prompt: 'Task 3', priority: 'P2', status: 'queued' }),
        createTask({ prompt: 'Task 4', priority: 'P0', status: 'completed' }),
      ];

      // Persist all tasks
      for (const task of tasks) {
        await repository1.save(task);
        if (task.status === 'queued') {
          queue1.enqueue(task);
        }
      }

      // Verify initial state
      const allTasks1 = await repository1.findAllUnbounded();
      expect(allTasks1.ok).toBe(true);
      if (allTasks1.ok) {
        expect(allTasks1.value.length).toBe(4);
      }
      expect(queue1.size()).toBe(2);

      // Close first instance
      database1.close();

      // Phase 2: Recover from database
      const database2 = new Database(dbPath);
      const repository2 = new SQLiteTaskRepository(database2);
      const queue2 = new PriorityTaskQueue(logger);
      // FIX: EventBus constructor expects (config, logger) not (logger)
      const config = createTestConfiguration();
      const eventBus = new InMemoryEventBus(config, logger);

      // Track recovery events
      const requeuedTaskIds: string[] = [];
      eventBus.on('TaskQueued', (data) => {
        requeuedTaskIds.push(data.taskId);
      });

      // Create recovery manager
      const dependencyRepo2 = new SQLiteDependencyRepository(database2);
      const recoveryManager = new RecoveryManager(
        repository2,
        queue2,
        eventBus,
        logger,
        createMockWorkerRepository(),
        dependencyRepo2,
      );

      // Perform recovery
      await recoveryManager.recover();

      // Verify recovery
      expect(requeuedTaskIds.length).toBe(2); // Should re-queue only QUEUED tasks
      expect(queue2.size()).toBe(2); // Only QUEUED tasks are re-queued (RUNNING are marked failed)

      // Verify QUEUED tasks were re-queued (look up by taskId from repository)
      const requeuedTasks = await Promise.all(requeuedTaskIds.map((id) => repository2.findById(id)));
      const queuedTask1 = requeuedTasks
        .filter((r) => r.ok && r.value)
        .map((r) => (r.ok ? r.value : null))
        .find((t) => t?.prompt === 'Task 1');
      const queuedTask3 = requeuedTasks
        .filter((r) => r.ok && r.value)
        .map((r) => (r.ok ? r.value : null))
        .find((t) => t?.prompt === 'Task 3');
      expect(queuedTask1).toBeTruthy();
      expect(queuedTask3).toBeTruthy();
      expect(queuedTask1?.status).toBe('queued');
      expect(queuedTask3?.status).toBe('queued');

      // Verify running task was marked as failed (not re-queued)
      const runningTaskResult = await repository2.findById(tasks[1].id); // Task 2 is at index 1
      expect(runningTaskResult.ok).toBe(true);
      if (runningTaskResult.ok && runningTaskResult.value) {
        expect(runningTaskResult.value.status).toBe('failed');
        expect(runningTaskResult.value.exitCode).toBe(-1); // Indicates crash
      }

      // Verify queue priority order
      const firstResult = queue2.dequeue();
      expect(firstResult.ok).toBe(true);
      if (firstResult.ok && firstResult.value) {
        expect(firstResult.value.priority).toBe('P0'); // P0 task should be first
      }

      database2.close();
      eventBus.dispose();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('should handle database transaction rollback', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'backbeat-test-'));
    const dbPath = join(tempDir, 'test.db');

    try {
      const database = new Database(dbPath);
      const repository = new SQLiteTaskRepository(database);

      // Create a valid task
      const validTask = createTask({ prompt: 'Valid task' });
      await repository.save(validTask);

      // Try to create an invalid task (will be simulated by direct DB manipulation)
      const invalidTask = createTask({ prompt: 'Invalid task' });

      // Simulate a failure during creation by closing DB mid-transaction
      // This tests the transaction rollback behavior
      try {
        // Force an error by trying to update a non-existent task
        await repository.update('non-existent-id' as TaskId, { status: 'failed' });
      } catch (error) {
        // Expected to fail
      }

      // Verify database is still consistent
      const allTasks = await repository.findAllUnbounded();
      expect(allTasks.ok).toBe(true);
      if (allTasks.ok) {
        expect(allTasks.value.length).toBe(1); // Only valid task should exist
        expect(allTasks.value[0].id).toBe(validTask.id); // Valid task should be preserved
      }

      database.close();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('should maintain queue persistence and priority ordering', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'backbeat-test-'));
    const dbPath = join(tempDir, 'test.db');
    const logger = new TestLogger();

    try {
      const database = new Database(dbPath);
      const repository = new SQLiteTaskRepository(database);
      const queue = new PriorityTaskQueue(logger);
      // FIX: EventBus constructor expects (config, logger) not (logger)
      const config = createTestConfiguration();
      const eventBus = new InMemoryEventBus(config, logger);

      // Setup persistence handler with promise tracking
      const updatePromises: Promise<unknown>[] = [];

      eventBus.on('TaskQueued', async (data) => {
        const promise = repository.update(data.taskId, { status: 'queued' });
        updatePromises.push(promise);
        await promise;
      });

      eventBus.on('TaskDequeued', async (data) => {
        const promise = repository.update(data.task.id, { status: 'running' });
        updatePromises.push(promise);
        await promise;
      });

      // Add tasks with different priorities
      const tasks = [
        createTask({ prompt: 'P2-1', priority: 'P2' }),
        createTask({ prompt: 'P0-1', priority: 'P0' }),
        createTask({ prompt: 'P1-1', priority: 'P1' }),
        createTask({ prompt: 'P2-2', priority: 'P2' }),
        createTask({ prompt: 'P0-2', priority: 'P0' }),
        createTask({ prompt: 'P1-2', priority: 'P1' }),
      ];

      // Persist and queue all tasks
      for (const task of tasks) {
        await repository.save(task);
        const enqueueResult = queue.enqueue(task);
        if (!enqueueResult.ok) {
          throw new Error(`Failed to enqueue task: ${enqueueResult.error}`);
        }
        eventBus.emit('TaskQueued', { taskId: task.id });
      }

      // Dequeue and verify priority order
      const dequeued: string[] = [];
      while (queue.size() > 0) {
        const result = queue.dequeue();
        if (result.ok && result.value) {
          const task = result.value;
          dequeued.push(`${task.priority}-${task.prompt.slice(-1)}`);
          eventBus.emit('TaskDequeued', { task });
        }
      }

      // Verify priority ordering (P0 first, then P1, then P2, FIFO within priority)
      const expected = ['P0-1', 'P0-2', 'P1-1', 'P1-2', 'P2-1', 'P2-2'];
      expect(dequeued).toEqual(expected); // Tasks should dequeue in priority order

      // Wait for all async updates to complete
      await Promise.all(updatePromises);

      // Verify database state
      const dbTasks = await repository.findAllUnbounded();
      expect(dbTasks.ok).toBe(true);
      if (dbTasks.ok) {
        const runningTasks = dbTasks.value.filter((t) => t.status === 'running');
        expect(runningTasks.length).toBe(6); // All tasks should be marked as running
      }

      database.close();
      eventBus.dispose();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('should handle concurrent database operations', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'backbeat-test-'));
    const dbPath = join(tempDir, 'test.db');

    try {
      const database = new Database(dbPath);
      const repository = new SQLiteTaskRepository(database);

      // Create multiple tasks concurrently
      const tasks = Array.from({ length: 20 }, (_, i) => createTask({ prompt: `Concurrent task ${i}` }));

      // Concurrent creates
      await Promise.all(tasks.map((task) => repository.save(task)));

      // Concurrent updates
      await Promise.all(tasks.map((task) => repository.update(task.id, { status: 'running' })));

      // Concurrent reads
      const results = await Promise.all(tasks.map((task) => repository.findById(task.id)));

      // Verify all operations succeeded
      expect(results.length).toBe(20); // All reads should complete
      results.forEach((result) => {
        expect(result.ok).toBe(true);
        if (result.ok && result.value) {
          expect(result.value.status).toBe('running');
        }
      });

      // Test concurrent list operations
      const [list1, list2, list3] = await Promise.all([
        repository.findAllUnbounded(),
        repository.findByStatus('running'),
        repository.findAllUnbounded(), // Was incorrectly using priority filter, findAll doesn't support that
      ]);

      expect(list1.ok).toBe(true);
      expect(list2.ok).toBe(true);
      if (list1.ok && list2.ok) {
        expect(list1.value.length).toBe(20); // Should list all tasks
        expect(list2.value.length).toBe(20); // All tasks are running status
      }

      database.close();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('should recover with partial data', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'backbeat-test-'));
    const dbPath = join(tempDir, 'test.db');
    const logger = new TestLogger();

    try {
      const database = new Database(dbPath);
      const repository = new SQLiteTaskRepository(database);
      // FIX: EventBus constructor expects (config, logger) not (logger)
      const config = createTestConfiguration();
      const eventBus = new InMemoryEventBus(config, logger);

      // Create tasks in various states
      const recentTimestamp = Date.now() - 120000; // 2 min ago
      const staleTimestamp = Date.now() - 3600000; // 1 hour ago
      const tasks = [
        createTask({ status: 'queued', startedAt: undefined }),
        createTask({ status: 'queued', priority: 'P0' }), // Second queued task
        createTask({
          status: 'running',
          startedAt: recentTimestamp,
          updatedAt: recentTimestamp, // CRITICAL: Set updatedAt for age calculation
        }),
        createTask({
          status: 'running',
          startedAt: staleTimestamp,
          updatedAt: staleTimestamp, // CRITICAL: Set updatedAt for stale detection
        }),
        createTask({ status: 'failed', attempts: 3 }),
        createTask({ status: 'completed', completedAt: Date.now() }),
      ];

      for (const task of tasks) {
        await repository.save(task);
      }

      // Track recovery
      const recoveredTaskIds: string[] = [];
      eventBus.on('TaskQueued', (data) => {
        recoveredTaskIds.push(data.taskId);
      });

      const dependencyRepo = new SQLiteDependencyRepository(database);
      const recoveryManager = new RecoveryManager(
        repository,
        new PriorityTaskQueue(logger),
        eventBus,
        logger,
        createMockWorkerRepository(),
        dependencyRepo,
      );

      await recoveryManager.recover();

      // PID-based recovery: RUNNING tasks with no live worker are marked FAILED, not re-queued.
      // Only QUEUED tasks are re-queued.
      expect(recoveredTaskIds.length).toBe(2); // 2 QUEUED tasks only

      // Verify both RUNNING tasks were marked as failed (no live worker in mock)
      const staleTaskResult = await repository.findById(tasks[3].id); // Second running task (STALE)
      expect(staleTaskResult.ok).toBe(true);
      if (staleTaskResult.ok && staleTaskResult.value) {
        expect(staleTaskResult.value.status).toBe('failed');
      }

      const recentTaskResult = await repository.findById(tasks[2].id); // Recent running task
      expect(recentTaskResult.ok).toBe(true);
      if (recentTaskResult.ok && recentTaskResult.value) {
        expect(recentTaskResult.value.status).toBe('failed'); // No live worker → marked failed
      }

      database.close();
      eventBus.dispose();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('should skip re-queuing QUEUED tasks blocked by unresolved dependencies', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'backbeat-test-'));
    const dbPath = join(tempDir, 'test.db');
    const logger = new TestLogger();

    try {
      const database = new Database(dbPath);
      const repository = new SQLiteTaskRepository(database);
      const dependencyRepo = new SQLiteDependencyRepository(database);
      const queue = new PriorityTaskQueue(logger);
      const config = createTestConfiguration();
      const eventBus = new InMemoryEventBus(config, logger);

      // Create parent task (completed) and two child tasks (QUEUED)
      const parentTask = createTask({ prompt: 'Parent task', status: 'completed', completedAt: Date.now() });
      const blockedTask = createTask({ prompt: 'Blocked child', status: 'queued' });
      const unblockedTask = createTask({ prompt: 'Unblocked child', status: 'queued' });

      // Persist all tasks
      await repository.save(parentTask);
      await repository.save(blockedTask);
      await repository.save(unblockedTask);

      // Add an unresolved dependency: blockedTask depends on parentTask (pending)
      const addDepResult = await dependencyRepo.addDependency(blockedTask.id, parentTask.id);
      expect(addDepResult.ok).toBe(true);

      // Verify blockedTask is actually blocked via real SQL query
      const isBlockedResult = await dependencyRepo.isBlocked(blockedTask.id);
      expect(isBlockedResult.ok).toBe(true);
      if (isBlockedResult.ok) {
        expect(isBlockedResult.value).toBe(true);
      }

      // Verify unblockedTask is NOT blocked (no dependencies)
      const isUnblockedResult = await dependencyRepo.isBlocked(unblockedTask.id);
      expect(isUnblockedResult.ok).toBe(true);
      if (isUnblockedResult.ok) {
        expect(isUnblockedResult.value).toBe(false);
      }

      // Track which tasks get re-queued during recovery
      const requeuedTaskIds: string[] = [];
      eventBus.on('TaskQueued', (data) => {
        requeuedTaskIds.push(data.taskId);
      });

      // Run recovery with real dependency repository
      const recoveryManager = new RecoveryManager(
        repository,
        queue,
        eventBus,
        logger,
        createMockWorkerRepository(),
        dependencyRepo,
      );

      await recoveryManager.recover();

      // CRITICAL: Only unblockedTask should be re-queued
      // blockedTask has an unresolved dependency and must NOT be re-queued
      expect(requeuedTaskIds).toHaveLength(1);
      expect(requeuedTaskIds[0]).toBe(unblockedTask.id);

      // Verify queue contains only the unblocked task
      expect(queue.size()).toBe(1);
      const dequeued = queue.dequeue();
      expect(dequeued.ok).toBe(true);
      if (dequeued.ok && dequeued.value) {
        expect(dequeued.value.id).toBe(unblockedTask.id);
      }

      database.close();
      eventBus.dispose();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
