/**
 * Unit tests for SQLiteLoopRepository
 * ARCHITECTURE: Tests repository operations in isolation with in-memory database
 * Pattern: Behavior-driven testing with Result pattern validation
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createLoop,
  createTask,
  type Loop,
  LoopId,
  type LoopIteration,
  LoopStatus,
  LoopStrategy,
  OptimizeDirection,
  TaskId,
} from '../../../src/core/domain.js';
import { Database } from '../../../src/implementations/database.js';
import { SQLiteLoopRepository } from '../../../src/implementations/loop-repository.js';
import { SQLiteTaskRepository } from '../../../src/implementations/task-repository.js';

describe('SQLiteLoopRepository - Unit Tests', () => {
  let db: Database;
  let repo: SQLiteLoopRepository;
  let taskRepo: SQLiteTaskRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    repo = new SQLiteLoopRepository(db);
    taskRepo = new SQLiteTaskRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  // Helper to create a loop with sensible defaults
  function createTestLoop(overrides: Partial<Parameters<typeof createLoop>[0]> = {}): Loop {
    return createLoop(
      {
        prompt: 'Run the tests',
        strategy: LoopStrategy.RETRY,
        exitCondition: 'test -f /tmp/done',
        maxIterations: 10,
        maxConsecutiveFailures: 3,
        cooldownMs: 0,
        freshContext: true,
        evalTimeout: 60000,
        ...overrides,
      },
      '/tmp',
    );
  }

  // Helper: create a task in the task repo so FK constraint is satisfied
  async function createTaskInRepo(taskId: TaskId): Promise<void> {
    const task = { ...createTask({ prompt: 'test', workingDirectory: '/tmp' }), id: taskId };
    await taskRepo.save(task);
  }

  // Helper to create a loop iteration (must call createTaskInRepo first for taskId)
  function createTestIteration(
    loopId: LoopId,
    iterationNumber: number,
    overrides: Partial<LoopIteration> = {},
  ): LoopIteration {
    return {
      id: 0, // Auto-increment
      loopId,
      iterationNumber,
      taskId: TaskId(`task-iter-${iterationNumber}`),
      status: 'running',
      startedAt: Date.now(),
      ...overrides,
    };
  }

  // Helper: create task in repo, then record iteration
  async function saveIteration(
    loopId: LoopId,
    iterationNumber: number,
    overrides: Partial<LoopIteration> = {},
  ): Promise<void> {
    const iteration = createTestIteration(loopId, iterationNumber, overrides);
    await createTaskInRepo(iteration.taskId);
    await repo.recordIteration(iteration);
  }

  describe('save() and findById()', () => {
    it('should save and retrieve a loop by ID', async () => {
      const loop = createTestLoop();
      const saveResult = await repo.save(loop);
      expect(saveResult.ok).toBe(true);

      const findResult = await repo.findById(loop.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      expect(findResult.value).toBeDefined();
      expect(findResult.value!.id).toBe(loop.id);
      expect(findResult.value!.strategy).toBe(LoopStrategy.RETRY);
      expect(findResult.value!.exitCondition).toBe('test -f /tmp/done');
      expect(findResult.value!.maxIterations).toBe(10);
      expect(findResult.value!.maxConsecutiveFailures).toBe(3);
      expect(findResult.value!.status).toBe(LoopStatus.RUNNING);
      expect(findResult.value!.currentIteration).toBe(0);
      expect(findResult.value!.consecutiveFailures).toBe(0);
    });

    it('should persist task_template JSON correctly', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      const findResult = await repo.findById(loop.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      expect(findResult.value!.taskTemplate.prompt).toBe('Run the tests');
      expect(findResult.value!.taskTemplate.workingDirectory).toBe('/tmp');
    });

    it('should return undefined when loop not found', async () => {
      const result = await repo.findById(LoopId('non-existent'));
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toBeUndefined();
    });

    it('should handle optimize strategy with evalDirection', async () => {
      const loop = createTestLoop({
        strategy: LoopStrategy.OPTIMIZE,
        evalDirection: OptimizeDirection.MINIMIZE,
      });

      await repo.save(loop);
      const findResult = await repo.findById(loop.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      expect(findResult.value!.strategy).toBe(LoopStrategy.OPTIMIZE);
      expect(findResult.value!.evalDirection).toBe(OptimizeDirection.MINIMIZE);
    });
  });

  describe('update()', () => {
    it('should update loop status', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      const updated = { ...loop, status: LoopStatus.COMPLETED, completedAt: Date.now(), updatedAt: Date.now() };
      const updateResult = await repo.update(updated);
      expect(updateResult.ok).toBe(true);

      const findResult = await repo.findById(loop.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      expect(findResult.value!.status).toBe(LoopStatus.COMPLETED);
      expect(findResult.value!.completedAt).toBeDefined();
    });

    it('should update currentIteration and consecutiveFailures', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      const updated = { ...loop, currentIteration: 5, consecutiveFailures: 2, updatedAt: Date.now() };
      await repo.update(updated);

      const findResult = await repo.findById(loop.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      expect(findResult.value!.currentIteration).toBe(5);
      expect(findResult.value!.consecutiveFailures).toBe(2);
    });

    it('should update bestScore and bestIterationId', async () => {
      const loop = createTestLoop({
        strategy: LoopStrategy.OPTIMIZE,
        evalDirection: OptimizeDirection.MAXIMIZE,
      });
      await repo.save(loop);

      const updated = { ...loop, bestScore: 0.95, bestIterationId: 3, updatedAt: Date.now() };
      await repo.update(updated);

      const findResult = await repo.findById(loop.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      expect(findResult.value!.bestScore).toBe(0.95);
      expect(findResult.value!.bestIterationId).toBe(3);
    });
  });

  describe('findByStatus()', () => {
    it('should return loops with matching status', async () => {
      const running = createTestLoop();
      const completed = createTestLoop();
      await repo.save(running);
      await repo.save(completed);

      // Complete the second loop
      const updatedCompleted = {
        ...completed,
        status: LoopStatus.COMPLETED,
        completedAt: Date.now(),
        updatedAt: Date.now(),
      };
      await repo.update(updatedCompleted);

      const result = await repo.findByStatus(LoopStatus.RUNNING);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(1);
      expect(result.value[0].id).toBe(running.id);
    });

    it('should return empty array when no matching loops', async () => {
      await repo.save(createTestLoop());

      const result = await repo.findByStatus(LoopStatus.CANCELLED);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(0);
    });

    it('should respect limit and offset for pagination', async () => {
      for (let i = 0; i < 5; i++) {
        await repo.save(createTestLoop());
      }

      const result = await repo.findByStatus(LoopStatus.RUNNING, 2, 1);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(2);
    });
  });

  describe('findAll()', () => {
    it('should return all loops', async () => {
      await repo.save(createTestLoop());
      await repo.save(createTestLoop());
      await repo.save(createTestLoop());

      const result = await repo.findAll();
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(3);
    });

    it('should return empty array when no loops exist', async () => {
      const result = await repo.findAll();
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(0);
    });

    it('should respect custom limit and offset', async () => {
      for (let i = 0; i < 10; i++) {
        await repo.save(createTestLoop());
      }

      const result = await repo.findAll(3, 2);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(3);
    });

    it('should apply default limit of 100', async () => {
      for (let i = 0; i < 105; i++) {
        await repo.save(createTestLoop());
      }

      const result = await repo.findAll();
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(100);
    });
  });

  describe('count()', () => {
    it('should return total loop count', async () => {
      await repo.save(createTestLoop());
      await repo.save(createTestLoop());

      const result = await repo.count();
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toBe(2);
    });

    it('should return 0 for empty repository', async () => {
      const result = await repo.count();
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toBe(0);
    });
  });

  describe('delete()', () => {
    it('should delete a loop', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      const deleteResult = await repo.delete(loop.id);
      expect(deleteResult.ok).toBe(true);

      const findResult = await repo.findById(loop.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      expect(findResult.value).toBeUndefined();
    });

    it('should cascade delete iterations when loop is deleted', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      // Record iterations (create tasks first for FK constraint)
      await saveIteration(loop.id, 1);
      await saveIteration(loop.id, 2);

      // Verify iterations exist
      const itersBefore = await repo.getIterations(loop.id);
      expect(itersBefore.ok).toBe(true);
      if (!itersBefore.ok) return;
      expect(itersBefore.value).toHaveLength(2);

      // Delete loop
      await repo.delete(loop.id);

      // Iterations should be cascade-deleted
      const itersAfter = await repo.getIterations(loop.id);
      expect(itersAfter.ok).toBe(true);
      if (!itersAfter.ok) return;
      expect(itersAfter.value).toHaveLength(0);
    });

    it('should succeed even when loop does not exist', async () => {
      const result = await repo.delete(LoopId('non-existent'));
      expect(result.ok).toBe(true);
    });
  });

  describe('recordIteration() and getIterations()', () => {
    it('should record and retrieve an iteration', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      await saveIteration(loop.id, 1);

      const getResult = await repo.getIterations(loop.id);
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;

      expect(getResult.value).toHaveLength(1);
      expect(getResult.value[0].loopId).toBe(loop.id);
      expect(getResult.value[0].iterationNumber).toBe(1);
      expect(getResult.value[0].status).toBe('running');
    });

    it('should return iterations in DESC order by iteration_number', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      await saveIteration(loop.id, 1);
      await saveIteration(loop.id, 2);
      await saveIteration(loop.id, 3);

      const result = await repo.getIterations(loop.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(3);
      expect(result.value[0].iterationNumber).toBe(3);
      expect(result.value[1].iterationNumber).toBe(2);
      expect(result.value[2].iterationNumber).toBe(1);
    });

    it('should respect limit for getIterations', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      for (let i = 1; i <= 5; i++) {
        await saveIteration(loop.id, i);
      }

      const result = await repo.getIterations(loop.id, 2);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(2);
      // Should get the latest 2 (iteration 5 and 4)
      expect(result.value[0].iterationNumber).toBe(5);
      expect(result.value[1].iterationNumber).toBe(4);
    });
  });

  describe('findIterationByTaskId()', () => {
    it('should find iteration by its task ID', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      const taskId = TaskId('task-lookup-test');
      await createTaskInRepo(taskId);
      await repo.recordIteration(createTestIteration(loop.id, 1, { taskId }));

      const result = await repo.findIterationByTaskId(taskId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toBeDefined();
      expect(result.value!.taskId).toBe(taskId);
      expect(result.value!.iterationNumber).toBe(1);
    });

    it('should return undefined when task ID not found', async () => {
      const result = await repo.findIterationByTaskId(TaskId('no-such-task'));
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toBeUndefined();
    });
  });

  describe('findRunningIterations()', () => {
    it('should find iterations where both loop and iteration are running', async () => {
      const running = createTestLoop();
      const completed = createTestLoop();
      await repo.save(running);
      await repo.save(completed);

      // Complete the second loop
      const updatedCompleted = { ...completed, status: LoopStatus.COMPLETED, updatedAt: Date.now() };
      await repo.update(updatedCompleted);

      // Add running iterations to both loops (need unique task IDs)
      const runningTaskId = TaskId('task-running-iter');
      const completedTaskId = TaskId('task-completed-iter');
      await createTaskInRepo(runningTaskId);
      await createTaskInRepo(completedTaskId);
      await repo.recordIteration(createTestIteration(running.id, 1, { status: 'running', taskId: runningTaskId }));
      await repo.recordIteration(createTestIteration(completed.id, 1, { status: 'running', taskId: completedTaskId }));

      const result = await repo.findRunningIterations();
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Only the iteration from the running loop should be returned
      expect(result.value).toHaveLength(1);
      expect(result.value[0].loopId).toBe(running.id);
    });

    it('should not include completed iterations on running loops', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      await saveIteration(loop.id, 1, { status: 'pass' });

      const result = await repo.findRunningIterations();
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(0);
    });
  });

  describe('updateIteration()', () => {
    it('should update iteration status, score, exitCode, and completedAt', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      await saveIteration(loop.id, 1);

      // Fetch the iteration to get the auto-generated ID
      const iters = await repo.getIterations(loop.id);
      expect(iters.ok).toBe(true);
      if (!iters.ok) return;

      const iteration = iters.value[0];
      const now = Date.now();
      const updateResult = await repo.updateIteration({
        ...iteration,
        status: 'pass',
        score: 42.5,
        exitCode: 0,
        completedAt: now,
      });
      expect(updateResult.ok).toBe(true);

      // Re-fetch and verify
      const updated = await repo.getIterations(loop.id);
      expect(updated.ok).toBe(true);
      if (!updated.ok) return;

      expect(updated.value[0].status).toBe('pass');
      expect(updated.value[0].score).toBe(42.5);
      expect(updated.value[0].exitCode).toBe(0);
      expect(updated.value[0].completedAt).toBeDefined();
    });

    it('should update error message on failure', async () => {
      const loop = createTestLoop();
      await repo.save(loop);
      await saveIteration(loop.id, 1);

      const iters = await repo.getIterations(loop.id);
      expect(iters.ok).toBe(true);
      if (!iters.ok) return;

      const iteration = iters.value[0];
      await repo.updateIteration({
        ...iteration,
        status: 'fail',
        errorMessage: 'Exit condition failed',
        exitCode: 1,
        completedAt: Date.now(),
      });

      const updated = await repo.getIterations(loop.id);
      expect(updated.ok).toBe(true);
      if (!updated.ok) return;

      expect(updated.value[0].status).toBe('fail');
      expect(updated.value[0].errorMessage).toBe('Exit condition failed');
    });
  });

  describe('Sync operations (for transactions)', () => {
    it('updateSync should update loop fields', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      const updated = { ...loop, currentIteration: 3, consecutiveFailures: 1, updatedAt: Date.now() };
      repo.updateSync(updated);

      const found = repo.findByIdSync(loop.id);
      expect(found).toBeDefined();
      expect(found!.currentIteration).toBe(3);
      expect(found!.consecutiveFailures).toBe(1);
    });

    it('findByIdSync should return undefined when not found', () => {
      const found = repo.findByIdSync(LoopId('no-such-loop'));
      expect(found).toBeUndefined();
    });

    it('recordIterationSync should record an iteration', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      const taskId = TaskId('task-sync-record');
      await createTaskInRepo(taskId);
      repo.recordIterationSync(createTestIteration(loop.id, 1, { taskId }));

      const iters = await repo.getIterations(loop.id);
      expect(iters.ok).toBe(true);
      if (!iters.ok) return;

      expect(iters.value).toHaveLength(1);
    });

    it('updateIterationSync should update an iteration', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      await saveIteration(loop.id, 1);

      const iters = await repo.getIterations(loop.id);
      expect(iters.ok).toBe(true);
      if (!iters.ok) return;

      const iteration = iters.value[0];
      repo.updateIterationSync({
        ...iteration,
        status: 'pass',
        exitCode: 0,
        completedAt: Date.now(),
      });

      const updated = await repo.getIterations(loop.id);
      expect(updated.ok).toBe(true);
      if (!updated.ok) return;

      expect(updated.value[0].status).toBe('pass');
    });

    it('should work correctly inside Database.runInTransaction', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      const taskId = TaskId('task-tx-test');
      await createTaskInRepo(taskId);

      const result = db.runInTransaction(() => {
        const updated = { ...loop, currentIteration: 1, updatedAt: Date.now() };
        repo.updateSync(updated);
        repo.recordIterationSync(createTestIteration(loop.id, 1, { taskId }));
      });

      expect(result.ok).toBe(true);

      // Verify both operations committed
      const found = repo.findByIdSync(loop.id);
      expect(found!.currentIteration).toBe(1);

      const iters = await repo.getIterations(loop.id);
      expect(iters.ok).toBe(true);
      if (!iters.ok) return;
      expect(iters.value).toHaveLength(1);
    });

    it('should rollback all operations when transaction fails', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      const result = db.runInTransaction(() => {
        const updated = { ...loop, currentIteration: 99, updatedAt: Date.now() };
        repo.updateSync(updated);
        throw new Error('simulated failure');
      });

      expect(result.ok).toBe(false);

      // currentIteration should not have changed
      const found = repo.findByIdSync(loop.id);
      expect(found!.currentIteration).toBe(0);
    });
  });

  describe('JSON serialization round-trips', () => {
    it('should serialize and deserialize pipeline_steps correctly', async () => {
      const loop = createTestLoop({
        pipelineSteps: ['lint the code', 'run the tests', 'build the project'],
      });

      await repo.save(loop);
      const findResult = await repo.findById(loop.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      expect(findResult.value!.pipelineSteps).toBeDefined();
      expect(findResult.value!.pipelineSteps).toHaveLength(3);
      expect(findResult.value!.pipelineSteps![0]).toBe('lint the code');
      expect(findResult.value!.pipelineSteps![2]).toBe('build the project');
    });

    it('should return undefined pipelineSteps for non-pipeline loops', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      const findResult = await repo.findById(loop.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      expect(findResult.value!.pipelineSteps).toBeUndefined();
    });

    it('should serialize and deserialize pipeline_task_ids in iterations', async () => {
      const loop = createTestLoop();
      await repo.save(loop);

      const taskIds = [TaskId('task-a'), TaskId('task-b'), TaskId('task-c')];
      // Create all tasks for FK constraint, then record iteration using the last task as the main task_id
      for (const tid of taskIds) {
        await createTaskInRepo(tid);
      }
      await repo.recordIteration(createTestIteration(loop.id, 1, { taskId: taskIds[2], pipelineTaskIds: taskIds }));

      const iters = await repo.getIterations(loop.id);
      expect(iters.ok).toBe(true);
      if (!iters.ok) return;

      expect(iters.value[0].pipelineTaskIds).toBeDefined();
      expect(iters.value[0].pipelineTaskIds).toHaveLength(3);
      expect(iters.value[0].pipelineTaskIds![0]).toBe('task-a');
      expect(iters.value[0].pipelineTaskIds![2]).toBe('task-c');
    });
  });

  describe('Boolean/integer conversion for fresh_context', () => {
    it('should store freshContext=true as 1 and retrieve as true', async () => {
      const loop = createTestLoop({ freshContext: true });
      await repo.save(loop);

      const findResult = await repo.findById(loop.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      expect(findResult.value!.freshContext).toBe(true);
    });

    it('should store freshContext=false as 0 and retrieve as false', async () => {
      const loop = createTestLoop({ freshContext: false });
      await repo.save(loop);

      const findResult = await repo.findById(loop.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      expect(findResult.value!.freshContext).toBe(false);
    });
  });

  describe('LoopStatus mapping', () => {
    it('should correctly map all status values', async () => {
      const statuses = [LoopStatus.RUNNING, LoopStatus.COMPLETED, LoopStatus.FAILED, LoopStatus.CANCELLED];

      for (const status of statuses) {
        const loop = createTestLoop();
        await repo.save(loop);
        const updated = { ...loop, status, updatedAt: Date.now() };
        await repo.update(updated);

        const result = await repo.findById(loop.id);
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.value?.status).toBe(status);
      }
    });
  });

  describe('LoopStrategy mapping', () => {
    it('should correctly map retry strategy', async () => {
      const loop = createTestLoop({ strategy: LoopStrategy.RETRY });
      await repo.save(loop);

      const result = await repo.findById(loop.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value!.strategy).toBe(LoopStrategy.RETRY);
    });

    it('should correctly map optimize strategy', async () => {
      const loop = createTestLoop({
        strategy: LoopStrategy.OPTIMIZE,
        evalDirection: OptimizeDirection.MAXIMIZE,
      });
      await repo.save(loop);

      const result = await repo.findById(loop.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value!.strategy).toBe(LoopStrategy.OPTIMIZE);
    });
  });

  describe('OptimizeDirection mapping', () => {
    it('should correctly map minimize direction', async () => {
      const loop = createTestLoop({
        strategy: LoopStrategy.OPTIMIZE,
        evalDirection: OptimizeDirection.MINIMIZE,
      });
      await repo.save(loop);

      const result = await repo.findById(loop.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value!.evalDirection).toBe(OptimizeDirection.MINIMIZE);
    });

    it('should correctly map maximize direction', async () => {
      const loop = createTestLoop({
        strategy: LoopStrategy.OPTIMIZE,
        evalDirection: OptimizeDirection.MAXIMIZE,
      });
      await repo.save(loop);

      const result = await repo.findById(loop.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value!.evalDirection).toBe(OptimizeDirection.MAXIMIZE);
    });

    it('should return undefined evalDirection for retry strategy', async () => {
      const loop = createTestLoop({ strategy: LoopStrategy.RETRY });
      await repo.save(loop);

      const result = await repo.findById(loop.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value!.evalDirection).toBeUndefined();
    });
  });
});
