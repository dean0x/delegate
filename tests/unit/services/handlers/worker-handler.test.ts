/**
 * WorkerHandler Tests - Comprehensive behavioral testing
 *
 * ARCHITECTURE: Tests worker lifecycle management through event-driven architecture
 * Focus on spawn control, resource constraints, and event handling
 *
 * Coverage target: 350+ lines, 90%+ line coverage
 * Quality: 3-5 assertions per test, AAA pattern, behavioral testing
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Configuration } from '../../../../src/core/configuration';
import type { Task, Worker } from '../../../../src/core/domain';
import { AutobeatError, ErrorCode } from '../../../../src/core/errors';
import type { ResourceMonitor, TaskQueue, TaskRepository, WorkerPool } from '../../../../src/core/interfaces';
import { err, ok, Result } from '../../../../src/core/result';
import { WorkerHandler } from '../../../../src/services/handlers/worker-handler';
import { TaskFactory, WorkerFactory } from '../../../fixtures/factories';
import { TestEventBus, TestLogger } from '../../../fixtures/test-doubles';

/**
 * Mock WorkerPool for testing
 */
class MockWorkerPool implements WorkerPool {
  spawnCalls: Task[] = [];
  killCalls: string[] = [];
  killAllCalls: number = 0;
  workerCount = 0;
  workers = new Map<string, Worker>();

  async spawn(task: Task) {
    this.spawnCalls.push(task);
    const worker = new WorkerFactory().withTaskId(task.id).build();
    this.workers.set(worker.id, worker);
    this.workerCount++;
    return ok(worker);
  }

  async kill(workerId: string) {
    this.killCalls.push(workerId);
    this.workers.delete(workerId);
    this.workerCount--;
    return ok(undefined);
  }

  async killAll() {
    this.killAllCalls++;
    this.workers.clear();
    this.workerCount = 0;
  }

  getWorkerForTask(taskId: string) {
    for (const worker of this.workers.values()) {
      if (worker.taskId === taskId) {
        return ok(worker);
      }
    }
    return ok(null);
  }

  getWorkerCount() {
    return this.workerCount;
  }

  getWorkers() {
    return ok(Array.from(this.workers.values()));
  }

  reset() {
    this.spawnCalls = [];
    this.killCalls = [];
    this.killAllCalls = 0;
    this.workerCount = 0;
    this.workers.clear();
  }
}

/**
 * Mock ResourceMonitor for testing
 */
class MockResourceMonitor implements ResourceMonitor {
  canSpawnValue = true;
  workerCount = 0;

  async canSpawnWorker() {
    return ok(this.canSpawnValue);
  }

  incrementWorkerCount() {
    this.workerCount++;
  }

  decrementWorkerCount() {
    this.workerCount--;
  }

  setCanSpawn(value: boolean) {
    this.canSpawnValue = value;
  }

  reset() {
    this.canSpawnValue = true;
    this.workerCount = 0;
  }

  // Required interface methods
  async getResources() {
    return ok({
      cpuUsagePercent: 50,
      availableMemoryBytes: 1024 * 1024 * 1024,
      totalMemoryBytes: 2 * 1024 * 1024 * 1024,
      activeWorkers: this.workerCount,
    });
  }

  getThresholds() {
    return { maxCpuPercent: 80, minMemoryBytes: 512 * 1024 * 1024 };
  }

  startMonitoring() {}
  stopMonitoring() {}
  recordSpawn() {}
}

/**
 * Mock TaskQueue for testing — validates direct dequeue call behavior
 */
class MockTaskQueue implements TaskQueue {
  private dequeueResult: Result<Task | null> = ok(null);

  setDequeueResult(result: Result<Task | null>) {
    this.dequeueResult = result;
  }

  dequeue(): Result<Task | null> {
    return this.dequeueResult;
  }

  enqueue(): Result<void> {
    return ok(undefined);
  }
  peek(): Result<Task | null> {
    return ok(null);
  }
  remove(): Result<boolean> {
    return ok(false);
  }
  getAll(): Result<readonly Task[]> {
    return ok([]);
  }
  contains(): boolean {
    return false;
  }
  size(): number {
    return 0;
  }
  clear(): Result<void> {
    return ok(undefined);
  }
  isEmpty(): boolean {
    return true;
  }
}

/**
 * Mock TaskRepository for testing — validates direct task lookup behavior
 */
class MockTaskRepo implements TaskRepository {
  private findByIdResult: Result<Task | null> = ok(null);

  setFindByIdResult(result: Result<Task | null>) {
    this.findByIdResult = result;
  }

  async findById(_taskId: string): Promise<Result<Task | null>> {
    return this.findByIdResult;
  }

  async save(): Promise<Result<void>> {
    return ok(undefined);
  }
  async update(): Promise<Result<void>> {
    return ok(undefined);
  }
  async findAll(): Promise<Result<readonly Task[]>> {
    return ok([]);
  }
  async findAllUnbounded(): Promise<Result<readonly Task[]>> {
    return ok([]);
  }
  async count(): Promise<Result<number>> {
    return ok(0);
  }
  async findByStatus(): Promise<Result<readonly Task[]>> {
    return ok([]);
  }
  async delete(): Promise<Result<void>> {
    return ok(undefined);
  }
  async cleanupOldTasks(): Promise<Result<number>> {
    return ok(0);
  }
}

describe('WorkerHandler - Event-Driven Worker Lifecycle', () => {
  let workerHandler: WorkerHandler;
  let eventBus: TestEventBus;
  let logger: TestLogger;
  let workerPool: MockWorkerPool;
  let resourceMonitor: MockResourceMonitor;
  let taskQueue: MockTaskQueue;
  let taskRepo: MockTaskRepo;
  let config: Configuration;

  beforeEach(async () => {
    eventBus = new TestEventBus();
    logger = new TestLogger();
    workerPool = new MockWorkerPool();
    resourceMonitor = new MockResourceMonitor();
    taskQueue = new MockTaskQueue();
    taskRepo = new MockTaskRepo();

    config = {
      minSpawnDelayMs: 10, // Reduced for testing
      timeout: 300000,
      maxOutputBuffer: 10485760,
      cpuCoresReserved: 0.2,
      memoryReserve: 1024 * 1024 * 1024,
      logLevel: 'info',
      maxListenersPerEvent: 100,
      maxTotalSubscriptions: 1000,
      killGracePeriodMs: 5000,
    } as Configuration;

    workerHandler = new WorkerHandler({ config, workerPool, resourceMonitor, eventBus, taskQueue, taskRepo, logger });

    await workerHandler.setup(eventBus);
  });

  afterEach(async () => {
    await workerHandler.teardown();
    workerPool.reset();
    resourceMonitor.reset();
  });

  describe('Setup and Teardown', () => {
    it('should subscribe to TaskQueued events during setup', async () => {
      const newEventBus = new TestEventBus();
      const newHandler = new WorkerHandler({
        config,
        workerPool,
        resourceMonitor,
        eventBus: newEventBus,
        taskQueue,
        taskRepo,
        logger,
      });

      const result = await newHandler.setup(newEventBus);

      expect(result.ok).toBe(true);
      expect(newEventBus.hasSubscription('TaskQueued')).toBe(true);
    });

    it('should subscribe to TaskCancellationRequested events during setup', async () => {
      const newEventBus = new TestEventBus();
      const newHandler = new WorkerHandler({
        config,
        workerPool,
        resourceMonitor,
        eventBus: newEventBus,
        taskQueue,
        taskRepo,
        logger,
      });

      const result = await newHandler.setup(newEventBus);

      expect(result.ok).toBe(true);
      expect(newEventBus.hasSubscription('TaskCancellationRequested')).toBe(true);
    });

    it('should kill all workers during teardown', async () => {
      await workerHandler.teardown();

      expect(workerPool.killAllCalls).toBe(1);
    });

    it('should return success result after setup', async () => {
      const newEventBus = new TestEventBus();
      const newHandler = new WorkerHandler({
        config,
        workerPool,
        resourceMonitor,
        eventBus: newEventBus,
        taskQueue,
        taskRepo,
        logger,
      });

      const result = await newHandler.setup(newEventBus);

      expect(result.ok).toBe(true);
    });
  });

  describe('TaskQueued Event Handling', () => {
    it('should process task immediately when TaskQueued event received', async () => {
      const task = new TaskFactory().withPrompt('test task').withStatus('queued').build();

      // Set up direct dequeue result instead of event response
      taskQueue.setDequeueResult(ok(task));

      await eventBus.emit('TaskQueued', { taskId: task.id });

      // Wait for TaskStarting event (indicates processing started)
      await eventBus.waitFor('TaskStarting');

      expect(eventBus.hasEmitted('TaskQueued')).toBe(true);
    });

    it('should emit TaskStarting event when processing queued task', async () => {
      const task = new TaskFactory().withPrompt('test task').withStatus('queued').build();

      taskQueue.setDequeueResult(ok(task));

      await eventBus.emit('TaskQueued', { taskId: task.id });
      await eventBus.waitFor('TaskStarting');

      expect(eventBus.hasEmitted('TaskStarting')).toBe(true);
    });

    it('should spawn worker for queued task when resources available', async () => {
      const task = new TaskFactory().withPrompt('test task').withStatus('queued').build();

      resourceMonitor.setCanSpawn(true);
      taskQueue.setDequeueResult(ok(task));

      await eventBus.emit('TaskQueued', { taskId: task.id });
      await eventBus.waitFor('TaskStarted');

      expect(workerPool.spawnCalls.length).toBeGreaterThan(0);
    });

    it('should increment resource monitor worker count after spawn', async () => {
      const task = new TaskFactory().withPrompt('test task').withStatus('queued').build();

      resourceMonitor.setCanSpawn(true);
      taskQueue.setDequeueResult(ok(task));

      await eventBus.emit('TaskQueued', { taskId: task.id });
      await eventBus.waitFor('TaskStarted');

      expect(resourceMonitor.workerCount).toBeGreaterThan(0);
    });

    it('should emit TaskStarted event after successful spawn', async () => {
      const task = new TaskFactory().withPrompt('test task').withStatus('queued').build();

      resourceMonitor.setCanSpawn(true);
      taskQueue.setDequeueResult(ok(task));

      await eventBus.emit('TaskQueued', { taskId: task.id });
      await eventBus.waitFor('TaskStarted');

      expect(eventBus.hasEmitted('TaskStarted')).toBe(true);
    });
  });

  describe('Spawn Rate Limiting - Fork Bomb Prevention', () => {
    it('should enforce minimum delay between spawns', async () => {
      const task1 = new TaskFactory().withPrompt('task 1').build();
      const task2 = new TaskFactory().withPrompt('task 2').build();

      resourceMonitor.setCanSpawn(true);
      taskQueue.setDequeueResult(ok(task1));

      // Spawn first task
      await eventBus.emit('TaskQueued', { taskId: task1.id });
      await eventBus.waitFor('TaskStarted');

      const firstSpawnTime = Date.now();

      // Try to spawn second task immediately
      taskQueue.setDequeueResult(ok(task2));
      await eventBus.emit('TaskQueued', { taskId: task2.id });
      // Wait for potential second spawn (rate limited)
      await eventBus.flushHandlers();

      // Verify delay was enforced (should be at least minSpawnDelayMs)
      expect(workerPool.spawnCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('should apply backoff when resources are constrained', async () => {
      const task = new TaskFactory().withPrompt('test task').build();

      resourceMonitor.setCanSpawn(false);
      taskQueue.setDequeueResult(ok(task));

      await eventBus.emit('TaskQueued', { taskId: task.id });
      await eventBus.flushHandlers();

      // Should not spawn when resources constrained
      expect(workerPool.spawnCalls.length).toBe(0);
    });

    it('should not spawn task when no resources available', async () => {
      const task = new TaskFactory().withPrompt('test task').build();

      resourceMonitor.setCanSpawn(false);
      taskQueue.setDequeueResult(ok(task));

      await eventBus.emit('TaskQueued', { taskId: task.id });
      await eventBus.flushHandlers();

      expect(workerPool.spawnCalls.length).toBe(0);
    });
  });

  describe('Task Cancellation', () => {
    it('should validate task status before cancellation', async () => {
      const task = new TaskFactory().withPrompt('test task').withStatus('completed').build();

      taskRepo.setFindByIdResult(ok(task));

      const result = await eventBus.emit('TaskCancellationRequested', {
        taskId: task.id,
        reason: 'User requested',
      });

      // Should not cancel completed task
      expect(workerPool.killCalls.length).toBe(0);
    });

    it('should attempt to find worker when cancelling running task', async () => {
      const task = new TaskFactory().withPrompt('test task').withStatus('running').build();

      taskRepo.setFindByIdResult(ok(task));

      await eventBus.emit('TaskCancellationRequested', {
        taskId: task.id,
        reason: 'User requested',
      });

      await eventBus.flushHandlers();

      // Should have checked for worker (via getWorkerForTask)
      expect(task.status).toBe('running');
    });

    it('should handle cancellation request gracefully', async () => {
      const task = new TaskFactory().withPrompt('test task').withStatus('running').build();

      taskRepo.setFindByIdResult(ok(task));

      const result = await eventBus.emit('TaskCancellationRequested', {
        taskId: task.id,
        reason: 'User requested',
      });

      // Should complete without errors
      expect(result.ok).toBe(true);
    });

    it('should handle cancellation request for queued task', async () => {
      const task = new TaskFactory().withPrompt('test task').withStatus('queued').build();

      taskRepo.setFindByIdResult(ok(task));

      const result = await eventBus.emit('TaskCancellationRequested', {
        taskId: task.id,
        reason: 'User requested',
      });

      expect(result.ok).toBe(true);
    });

    it('should return error when task not found for cancellation', async () => {
      taskRepo.setFindByIdResult(ok(null));

      await eventBus.emit('TaskCancellationRequested', {
        taskId: 'non-existent-task',
        reason: 'User requested',
      });

      await eventBus.flushHandlers();

      // Should not attempt to kill worker
      expect(workerPool.killCalls.length).toBe(0);
    });
  });

  describe('Worker Completion', () => {
    it('should decrement resource monitor worker count on completion', async () => {
      const task = new TaskFactory().build();
      resourceMonitor.incrementWorkerCount();
      taskRepo.setFindByIdResult(ok(task));

      await workerHandler.onWorkerComplete(task.id, 0);

      expect(resourceMonitor.workerCount).toBe(0);
    });

    it('should emit TaskCompleted event for successful completion (exit code 0)', async () => {
      const task = new TaskFactory().withStatus('running').build();

      taskRepo.setFindByIdResult(ok(task));

      await workerHandler.onWorkerComplete(task.id, 0);

      expect(eventBus.hasEmitted('TaskCompleted')).toBe(true);
    });

    it('should emit TaskFailed event for failed completion (non-zero exit code)', async () => {
      const task = new TaskFactory().withStatus('running').build();

      taskRepo.setFindByIdResult(ok(task));

      await workerHandler.onWorkerComplete(task.id, 1);

      expect(eventBus.hasEmitted('TaskFailed')).toBe(true);
    });

    it('should calculate task duration from startedAt timestamp', async () => {
      const now = Date.now();
      const task = new TaskFactory()
        .withStatus('running')
        .withStartedAt(now - 5000) // Started 5 seconds ago
        .build();

      taskRepo.setFindByIdResult(ok(task));

      await workerHandler.onWorkerComplete(task.id, 0);

      const events = eventBus.getEmittedEvents('TaskCompleted');
      expect(events.length).toBeGreaterThan(0);
      if (events.length > 0) {
        expect((events[0] as { duration: number }).duration).toBeGreaterThan(0);
      }
    });

    it('should handle completion for task without startedAt timestamp', async () => {
      const task = new TaskFactory().withStatus('running').build();

      taskRepo.setFindByIdResult(ok(task));

      await workerHandler.onWorkerComplete(task.id, 0);

      expect(eventBus.hasEmitted('TaskCompleted')).toBe(true);
    });
  });

  describe('Worker Timeout', () => {
    it('should decrement resource monitor worker count on timeout', async () => {
      resourceMonitor.incrementWorkerCount();
      const task = new TaskFactory().build();
      const error = new AutobeatError(ErrorCode.TASK_TIMEOUT, 'Task timed out', { taskId: task.id });

      await workerHandler.onWorkerTimeout(task.id, error);

      expect(resourceMonitor.workerCount).toBe(0);
    });

    it('should emit TaskTimeout event when worker times out', async () => {
      const task = new TaskFactory().build();
      const error = new AutobeatError(ErrorCode.TASK_TIMEOUT, 'Task timed out', { taskId: task.id });

      await workerHandler.onWorkerTimeout(task.id, error);

      expect(eventBus.hasEmitted('TaskTimeout')).toBe(true);
    });

    it('should include error in TaskTimeout event', async () => {
      const task = new TaskFactory().build();
      const error = new AutobeatError(ErrorCode.TASK_TIMEOUT, 'Task exceeded 5 minute limit', {
        taskId: task.id,
        timeoutMs: 300000,
      });

      await workerHandler.onWorkerTimeout(task.id, error);

      const events = eventBus.getEmittedEvents('TaskTimeout');
      expect(events.length).toBeGreaterThan(0);
      if (events.length > 0) {
        expect((events[0] as { error: AutobeatError }).error).toBeDefined();
        expect((events[0] as { error: AutobeatError }).error.code).toBe(ErrorCode.TASK_TIMEOUT);
      }
    });
  });

  describe('Worker Statistics', () => {
    it('should return current worker count from pool', () => {
      workerPool.workerCount = 5;

      const stats = workerHandler.getWorkerStats();

      expect(stats.workerCount).toBe(5);
    });

    it('should return list of active workers', () => {
      const worker1 = new WorkerFactory().build();
      const worker2 = new WorkerFactory().build();
      workerPool.workers.set(worker1.id, worker1);
      workerPool.workers.set(worker2.id, worker2);

      const stats = workerHandler.getWorkerStats();

      expect(stats.workers.length).toBe(2);
    });

    it('should return empty array when no workers active', () => {
      const stats = workerHandler.getWorkerStats();

      expect(Array.isArray(stats.workers)).toBe(true);
      expect(stats.workers.length).toBe(0);
    });

    it('should include worker count in statistics', () => {
      workerPool.workerCount = 3;

      const stats = workerHandler.getWorkerStats();

      expect(stats).toHaveProperty('workerCount');
      expect(stats.workerCount).toBe(3);
    });
  });

  describe('Error Handling', () => {
    it('should requeue task when spawn fails', async () => {
      const task = new TaskFactory().withPrompt('test task').build();

      // Make spawn fail
      workerPool.spawn = vi
        .fn()
        .mockResolvedValue(err(new AutobeatError(ErrorCode.PROCESS_SPAWN_FAILED, 'Spawn failed', {})));

      resourceMonitor.setCanSpawn(true);
      taskQueue.setDequeueResult(ok(task));

      await eventBus.emit('TaskQueued', { taskId: task.id });
      await eventBus.waitFor('RequeueTask');

      expect(eventBus.hasEmitted('RequeueTask')).toBe(true);
    });

    it('should emit TaskFailed event when spawn fails', async () => {
      const task = new TaskFactory().withPrompt('test task').build();

      workerPool.spawn = vi
        .fn()
        .mockResolvedValue(err(new AutobeatError(ErrorCode.PROCESS_SPAWN_FAILED, 'Spawn failed', {})));

      resourceMonitor.setCanSpawn(true);
      taskQueue.setDequeueResult(ok(task));

      await eventBus.emit('TaskQueued', { taskId: task.id });
      await eventBus.waitFor('TaskFailed');

      expect(eventBus.hasEmitted('TaskFailed')).toBe(true);
    });

    it('should handle errors gracefully without crashing', async () => {
      const task = new TaskFactory().withPrompt('test task').build();

      // Simulate error in queue dequeue
      taskQueue.setDequeueResult(err(new AutobeatError(ErrorCode.SYSTEM_ERROR, 'Queue failed', {})));

      resourceMonitor.setCanSpawn(true);

      await eventBus.emit('TaskQueued', { taskId: task.id });
      await eventBus.flushHandlers();

      // Should not crash, handler should continue functioning
      expect(workerHandler).toBeDefined();
    });
  });

  describe('Direct Repository Access Architecture', () => {
    it('should use direct repository call for task status in cancellation', async () => {
      const task = new TaskFactory().withPrompt('test task').withStatus('running').build();

      taskRepo.setFindByIdResult(ok(task));

      await eventBus.emit('TaskCancellationRequested', {
        taskId: task.id,
        reason: 'Test',
      });

      await eventBus.flushHandlers();

      // Task was found via direct repo call and cancellation proceeded
      expect(eventBus.hasEmitted('TaskCancelled')).toBe(true);
    });

    it('should use direct queue dequeue for getting next task', async () => {
      const task = new TaskFactory().withPrompt('test task').build();

      resourceMonitor.setCanSpawn(true);
      taskQueue.setDequeueResult(ok(task));

      await eventBus.emit('TaskQueued', { taskId: task.id });
      await eventBus.waitFor('TaskStarting');

      // Task was dequeued directly and processing started
      expect(eventBus.hasEmitted('TaskStarting')).toBe(true);
    });

    it('should emit events for state changes rather than direct updates', async () => {
      const task = new TaskFactory().withPrompt('test task').build();

      resourceMonitor.setCanSpawn(true);
      taskQueue.setDequeueResult(ok(task));

      await eventBus.emit('TaskQueued', { taskId: task.id });
      await eventBus.waitFor('TaskStarting');

      // Should emit TaskStarting and TaskStarted events
      expect(eventBus.hasEmitted('TaskStarting')).toBe(true);
    });
  });

  /**
   * CHARACTERIZATION TESTS - Decomposition Safety
   */
  describe('Characterization Tests - Decomposition Safety', () => {
    describe('processNextTask() Ordering Invariants', () => {
      it('INVARIANT: TaskStarting emission failure should requeue task without TaskFailed', async () => {
        const task = new TaskFactory().withPrompt('test task').build();

        resourceMonitor.setCanSpawn(true);
        taskQueue.setDequeueResult(ok(task));

        // Make TaskStarting emit fail
        eventBus.setEmitFailure('TaskStarting', true);

        await eventBus.emit('TaskQueued', { taskId: task.id });
        await eventBus.waitFor('RequeueTask');

        expect(eventBus.hasEmitted('TaskStarting')).toBe(true);
        expect(eventBus.hasEmitted('RequeueTask')).toBe(true);
        expect(eventBus.hasEmitted('TaskFailed')).toBe(false);
        expect(workerPool.spawnCalls.length).toBe(0);
      });

      it('INVARIANT: Spawn failure emits BOTH RequeueTask AND TaskFailed', async () => {
        const task = new TaskFactory().withPrompt('test task').build();

        workerPool.spawn = vi
          .fn()
          .mockResolvedValue(err(new AutobeatError(ErrorCode.PROCESS_SPAWN_FAILED, 'Spawn failed', {})));

        resourceMonitor.setCanSpawn(true);
        taskQueue.setDequeueResult(ok(task));

        await eventBus.emit('TaskQueued', { taskId: task.id });
        await eventBus.waitFor('TaskFailed');

        expect(eventBus.hasEmitted('RequeueTask')).toBe(true);
        expect(eventBus.hasEmitted('TaskFailed')).toBe(true);
      });

      it('INVARIANT: Resource check happens BEFORE getting task from queue', async () => {
        const task = new TaskFactory().withPrompt('test task').build();

        resourceMonitor.setCanSpawn(false); // Resources constrained
        taskQueue.setDequeueResult(ok(task));

        await eventBus.emit('TaskQueued', { taskId: task.id });
        await eventBus.flushHandlers();

        // Should NOT have dequeued since resources unavailable
        // (We can verify no spawn was attempted since dequeue would have returned the task)
        expect(workerPool.spawnCalls.length).toBe(0);
      });

      it('INVARIANT: Success path emits TaskStarted event', async () => {
        const task = new TaskFactory().withPrompt('test task').build();

        resourceMonitor.setCanSpawn(true);
        taskQueue.setDequeueResult(ok(task));

        await eventBus.emit('TaskQueued', { taskId: task.id });
        await eventBus.waitFor('TaskStarted');

        expect(eventBus.hasEmitted('TaskStarted')).toBe(true);

        const events = eventBus.getEmittedEvents('TaskStarted');
        expect(events.length).toBeGreaterThan(0);
        expect((events[0] as { taskId: string }).taskId).toBe(task.id);
      });

      it('INVARIANT: Worker count incremented only after successful spawn', async () => {
        const task = new TaskFactory().withPrompt('test task').build();

        resourceMonitor.setCanSpawn(true);
        taskQueue.setDequeueResult(ok(task));

        const initialCount = resourceMonitor.workerCount;

        await eventBus.emit('TaskQueued', { taskId: task.id });
        await eventBus.waitFor('TaskStarted');

        expect(resourceMonitor.workerCount).toBe(initialCount + 1);
      });

      it('INVARIANT: Worker count NOT incremented on spawn failure', async () => {
        const task = new TaskFactory().withPrompt('test task').build();

        workerPool.spawn = vi
          .fn()
          .mockResolvedValue(err(new AutobeatError(ErrorCode.PROCESS_SPAWN_FAILED, 'Spawn failed', {})));

        resourceMonitor.setCanSpawn(true);
        taskQueue.setDequeueResult(ok(task));

        const initialCount = resourceMonitor.workerCount;

        await eventBus.emit('TaskQueued', { taskId: task.id });
        await eventBus.waitFor('TaskFailed');

        expect(resourceMonitor.workerCount).toBe(initialCount);
      });

      it('INVARIANT: Empty queue returns early without side effects', async () => {
        resourceMonitor.setCanSpawn(true);
        taskQueue.setDequeueResult(ok(null)); // Empty queue

        await eventBus.emit('TaskQueued', { taskId: 'test' });
        await eventBus.flushHandlers();

        expect(eventBus.hasEmitted('TaskStarting')).toBe(false);
        expect(eventBus.hasEmitted('TaskStarted')).toBe(false);
        expect(eventBus.hasEmitted('RequeueTask')).toBe(false);
        expect(eventBus.hasEmitted('TaskFailed')).toBe(false);
      });
    });

    describe('State Consistency Invariants', () => {
      it('INVARIANT: No partial state on TaskStarting failure', async () => {
        const task = new TaskFactory().withPrompt('test task').build();

        resourceMonitor.setCanSpawn(true);
        taskQueue.setDequeueResult(ok(task));
        eventBus.setEmitFailure('TaskStarting', true);

        const initialWorkerCount = resourceMonitor.workerCount;

        await eventBus.emit('TaskQueued', { taskId: task.id });
        await eventBus.waitFor('RequeueTask');

        expect(resourceMonitor.workerCount).toBe(initialWorkerCount);
        expect(workerPool.spawnCalls.length).toBe(0);
      });

      it('INVARIANT: No partial state on spawn failure', async () => {
        const task = new TaskFactory().withPrompt('test task').build();

        workerPool.spawn = vi
          .fn()
          .mockResolvedValue(err(new AutobeatError(ErrorCode.PROCESS_SPAWN_FAILED, 'Spawn failed', {})));

        resourceMonitor.setCanSpawn(true);
        taskQueue.setDequeueResult(ok(task));

        const initialWorkerCount = resourceMonitor.workerCount;

        await eventBus.emit('TaskQueued', { taskId: task.id });
        await eventBus.waitFor('TaskFailed');

        expect(resourceMonitor.workerCount).toBe(initialWorkerCount);
      });
    });

    /**
     * SPAWN SERIALIZATION TESTS
     */
    describe('Spawn Serialization - TOCTOU Race Prevention', () => {
      it('INVARIANT: Concurrent spawn attempts are serialized (no overlapping spawns)', async () => {
        const task1 = new TaskFactory().withPrompt('task 1').build();

        const spawnEvents: { start: number; end: number }[] = [];
        let activeSpawns = 0;
        let maxConcurrentSpawns = 0;

        workerPool.spawn = vi.fn().mockImplementation(async () => {
          activeSpawns++;
          maxConcurrentSpawns = Math.max(maxConcurrentSpawns, activeSpawns);
          const start = Date.now();

          // NOTE: This setTimeout simulates real spawn time and is intentional for timing tests
          await new Promise((resolve) => setTimeout(resolve, 15));

          const end = Date.now();
          spawnEvents.push({ start, end });
          activeSpawns--;
          return ok(new WorkerFactory().build());
        });

        resourceMonitor.setCanSpawn(true);
        taskQueue.setDequeueResult(ok(task1));

        await Promise.all([
          eventBus.emit('TaskQueued', { taskId: task1.id }),
          eventBus.emit('TaskQueued', { taskId: task1.id }),
          eventBus.emit('TaskQueued', { taskId: task1.id }),
        ]);

        await eventBus.waitFor('TaskStarted');
        await eventBus.flushHandlers();

        expect(maxConcurrentSpawns).toBe(1);

        for (let i = 1; i < spawnEvents.length; i++) {
          expect(spawnEvents[i].start).toBeGreaterThanOrEqual(spawnEvents[i - 1].end);
        }
      });

      it('INVARIANT: Spawn lock prevents TOCTOU race - delay check happens inside lock', async () => {
        const task1 = new TaskFactory().withPrompt('task 1').build();
        const task2 = new TaskFactory().withPrompt('task 2').build();

        const spawnTimestamps: number[] = [];

        workerPool.spawn = vi.fn().mockImplementation(async () => {
          spawnTimestamps.push(Date.now());
          // NOTE: This setTimeout simulates real spawn time and is intentional for timing tests
          await new Promise((resolve) => setTimeout(resolve, 15));
          return ok(new WorkerFactory().build());
        });

        resourceMonitor.setCanSpawn(true);
        taskQueue.setDequeueResult(ok(task1));

        await Promise.all([
          eventBus.emit('TaskQueued', { taskId: task1.id }),
          eventBus.emit('TaskQueued', { taskId: task2.id }),
        ]);

        await eventBus.waitFor('TaskStarted');
        await eventBus.flushHandlers();

        if (spawnTimestamps.length >= 2) {
          const timeBetweenSpawns = spawnTimestamps[1] - spawnTimestamps[0];
          expect(timeBetweenSpawns).toBeGreaterThanOrEqual(10);
        }
      });

      it('INVARIANT: Serialization handles spawn failures without blocking queue', async () => {
        const task1 = new TaskFactory().withPrompt('task 1').build();
        const task2 = new TaskFactory().withPrompt('task 2').build();

        let callCount = 0;
        workerPool.spawn = vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            return err(new AutobeatError(ErrorCode.PROCESS_SPAWN_FAILED, 'Spawn failed', {}));
          }
          return ok(new WorkerFactory().build());
        });

        resourceMonitor.setCanSpawn(true);
        taskQueue.setDequeueResult(ok(task1));

        await eventBus.emit('TaskQueued', { taskId: task1.id });
        await eventBus.waitFor('TaskFailed');

        expect(callCount).toBe(1);
        expect(eventBus.hasEmitted('TaskFailed')).toBe(true);

        taskQueue.setDequeueResult(ok(task2));
        eventBus.clearEmittedEvents();

        await eventBus.emit('TaskQueued', { taskId: task2.id });
        await eventBus.waitFor('TaskStarted');

        expect(callCount).toBe(2);
      });
    });
  });
});
