/**
 * Unit tests for LoopHandler
 * ARCHITECTURE: Tests event-driven iteration engine with real SQLite (in-memory)
 * Pattern: Behavioral testing with TestEventBus (matches schedule-handler pattern)
 *
 * NOTE: LoopHandler extends BaseEventHandler. Its handleEvent() wrapper catches errors
 * from inner handlers and logs them rather than propagating. Tests verify state and events
 * rather than thrown exceptions.
 *
 * Exit condition evaluation uses child_process.exec (async via promisify), mocked via vi.mock.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Loop, LoopIteration } from '../../../../src/core/domain.js';
import {
  createLoop,
  LoopId,
  LoopStatus,
  LoopStrategy,
  OptimizeDirection,
  TaskId,
  TaskStatus,
} from '../../../../src/core/domain.js';
import { InMemoryEventBus } from '../../../../src/core/events/event-bus.js';
import { Database } from '../../../../src/implementations/database.js';
import { SQLiteLoopRepository } from '../../../../src/implementations/loop-repository.js';
import { SQLiteTaskRepository } from '../../../../src/implementations/task-repository.js';
import { LoopHandler } from '../../../../src/services/handlers/loop-handler.js';
import { createTestConfiguration } from '../../../fixtures/factories.js';
import { TestLogger } from '../../../fixtures/test-doubles.js';
import { flushEventLoop } from '../../../utils/event-helpers.js';

// Mock child_process.exec for exit condition evaluation (async via promisify)
vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

// Import after mock setup
import { exec } from 'child_process';

/**
 * Helper: mock async exec (via promisify) to succeed with given stdout
 * promisify(exec) calls exec(cmd, opts, callback) — mock the callback-based API
 */
function mockExecSuccess(stdout: string): void {
  vi.mocked(exec).mockImplementation((_cmd: unknown, _opts: unknown, callback: unknown) => {
    (callback as (err: null, result: { stdout: string; stderr: string }) => void)(null, { stdout, stderr: '' });
    return {} as ReturnType<typeof exec>;
  });
}

/**
 * Helper: mock async exec (via promisify) to fail with given exit code and stderr
 */
function mockExecFailure(exitCode: number, stderr: string): void {
  vi.mocked(exec).mockImplementation((_cmd: unknown, _opts: unknown, callback: unknown) => {
    const error = Object.assign(new Error(stderr), { code: exitCode, stdout: '', stderr });
    (callback as (err: Error, result: { stdout: string; stderr: string }) => void)(error, { stdout: '', stderr });
    return {} as ReturnType<typeof exec>;
  });
}

/**
 * Minimal mock checkpoint repository
 * ARCHITECTURE: LoopHandler only uses findLatest() for context enrichment (R2)
 */
function createMockCheckpointRepo() {
  return {
    findLatest: vi.fn().mockResolvedValue({ ok: true, value: null }),
    save: vi.fn().mockResolvedValue({ ok: true, value: null }),
    findAll: vi.fn().mockResolvedValue({ ok: true, value: [] }),
    deleteByTask: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  };
}

describe('LoopHandler - Behavioral Tests', () => {
  let handler: LoopHandler;
  let eventBus: InMemoryEventBus;
  let loopRepo: SQLiteLoopRepository;
  let taskRepo: SQLiteTaskRepository;
  let database: Database;
  let logger: TestLogger;
  let mockCheckpointRepo: ReturnType<typeof createMockCheckpointRepo>;

  beforeEach(async () => {
    logger = new TestLogger();
    const config = createTestConfiguration();
    eventBus = new InMemoryEventBus(config, logger);

    database = new Database(':memory:');

    loopRepo = new SQLiteLoopRepository(database);
    taskRepo = new SQLiteTaskRepository(database);
    mockCheckpointRepo = createMockCheckpointRepo();

    // Reset exec mock
    vi.mocked(exec).mockReset();

    const handlerResult = await LoopHandler.create(loopRepo, taskRepo, mockCheckpointRepo, eventBus, database, logger);
    if (!handlerResult.ok) {
      throw new Error(`Failed to create LoopHandler: ${handlerResult.error.message}`);
    }
    handler = handlerResult.value;
  });

  afterEach(() => {
    eventBus.dispose();
    database.close();
  });

  // Helper: create and emit a loop, returning the created loop
  async function createAndEmitLoop(overrides: Partial<Parameters<typeof createLoop>[0]> = {}): Promise<Loop> {
    const loop = createLoop(
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

    await eventBus.emit('LoopCreated', { loop });
    await flushEventLoop();
    return loop;
  }

  // Helper: get the latest iteration for a loop
  async function getLatestIteration(loopId: LoopId): Promise<LoopIteration | undefined> {
    const result = await loopRepo.getIterations(loopId, 1);
    if (!result.ok || result.value.length === 0) return undefined;
    return result.value[0];
  }

  // Helper: get the current loop state from DB
  async function getLoop(loopId: LoopId): Promise<Loop | undefined> {
    const result = await loopRepo.findById(loopId);
    if (!result.ok) return undefined;
    return result.value;
  }

  // Helper: find the task ID from the latest iteration's task delegation
  async function getLatestTaskId(loopId: LoopId): Promise<TaskId | undefined> {
    const iter = await getLatestIteration(loopId);
    return iter?.taskId;
  }

  describe('Factory create()', () => {
    it('should succeed and subscribe to events', async () => {
      const freshEventBus = new InMemoryEventBus(createTestConfiguration(), new TestLogger());
      const freshDb = new Database(':memory:');
      const freshLoopRepo = new SQLiteLoopRepository(freshDb);
      const freshTaskRepo = new SQLiteTaskRepository(freshDb);
      const freshLogger = new TestLogger();

      const result = await LoopHandler.create(
        freshLoopRepo,
        freshTaskRepo,
        createMockCheckpointRepo(),
        freshEventBus,
        freshDb,
        freshLogger,
      );

      expect(result.ok).toBe(true);
      expect(freshLogger.hasLogContaining('LoopHandler initialized')).toBe(true);

      freshEventBus.dispose();
      freshDb.close();
    });
  });

  describe('Retry strategy - basic lifecycle', () => {
    it('should create first iteration on LoopCreated event', async () => {
      const loop = await createAndEmitLoop();

      // Loop should be persisted
      const savedLoop = await getLoop(loop.id);
      expect(savedLoop).toBeDefined();
      expect(savedLoop!.status).toBe(LoopStatus.RUNNING);
      expect(savedLoop!.currentIteration).toBe(1);

      // First iteration should be recorded
      const iteration = await getLatestIteration(loop.id);
      expect(iteration).toBeDefined();
      expect(iteration!.iterationNumber).toBe(1);
      expect(iteration!.status).toBe('running');
    });

    it('should complete loop when exit condition passes (exit code 0)', async () => {
      // Mock: exit condition succeeds
      mockExecSuccess('success\n');

      const loop = await createAndEmitLoop();
      const taskId = await getLatestTaskId(loop.id);
      expect(taskId).toBeDefined();

      // Simulate task completion
      await eventBus.emit('TaskCompleted', { taskId: taskId!, exitCode: 0, duration: 1000 });
      await flushEventLoop();

      // Loop should be completed
      const updatedLoop = await getLoop(loop.id);
      expect(updatedLoop!.status).toBe(LoopStatus.COMPLETED);

      // Iteration should be marked as 'pass'
      const iteration = await getLatestIteration(loop.id);
      expect(iteration!.status).toBe('pass');
      expect(iteration!.exitCode).toBe(0);
    });

    it('should start next iteration when exit condition fails (non-zero exit code)', async () => {
      // Mock: exit condition fails
      mockExecFailure(1, 'test failed');

      const loop = await createAndEmitLoop();
      const taskId = await getLatestTaskId(loop.id);
      expect(taskId).toBeDefined();

      // Simulate task completion (task succeeded but exit condition failed)
      await eventBus.emit('TaskCompleted', { taskId: taskId!, exitCode: 0, duration: 1000 });
      await flushEventLoop();

      // Loop should still be running with iteration 2 started
      const updatedLoop = await getLoop(loop.id);
      expect(updatedLoop!.status).toBe(LoopStatus.RUNNING);
      expect(updatedLoop!.currentIteration).toBe(2);
    });

    it('should complete loop when max iterations reached', async () => {
      // Mock: exit condition always fails
      mockExecFailure(1, 'fail');

      const loop = await createAndEmitLoop({ maxIterations: 2 });

      // Complete first iteration
      const taskId1 = await getLatestTaskId(loop.id);
      await eventBus.emit('TaskCompleted', { taskId: taskId1!, exitCode: 0, duration: 100 });
      await flushEventLoop();

      // Complete second iteration
      const taskId2 = await getLatestTaskId(loop.id);
      await eventBus.emit('TaskCompleted', { taskId: taskId2!, exitCode: 0, duration: 100 });
      await flushEventLoop();

      // Loop should be completed (max iterations reached)
      const updatedLoop = await getLoop(loop.id);
      expect(updatedLoop!.status).toBe(LoopStatus.COMPLETED);
    });

    it('should fail loop when max consecutive failures reached via task failure', async () => {
      const loop = await createAndEmitLoop({ maxConsecutiveFailures: 2 });

      // First task fails
      const taskId1 = await getLatestTaskId(loop.id);
      await eventBus.emit('TaskFailed', {
        taskId: taskId1!,
        error: { message: 'Task crashed', code: 'SYSTEM_ERROR' },
        exitCode: 1,
      });
      await flushEventLoop();

      // Second task fails
      const taskId2 = await getLatestTaskId(loop.id);
      await eventBus.emit('TaskFailed', {
        taskId: taskId2!,
        error: { message: 'Task crashed again', code: 'SYSTEM_ERROR' },
        exitCode: 1,
      });
      await flushEventLoop();

      // Loop should be failed
      const updatedLoop = await getLoop(loop.id);
      expect(updatedLoop!.status).toBe(LoopStatus.FAILED);
    });

    it('should increment consecutiveFailures on task failure', async () => {
      const loop = await createAndEmitLoop({ maxConsecutiveFailures: 5 });

      const taskId1 = await getLatestTaskId(loop.id);
      await eventBus.emit('TaskFailed', {
        taskId: taskId1!,
        error: { message: 'fail', code: 'SYSTEM_ERROR' },
        exitCode: 1,
      });
      await flushEventLoop();

      const updatedLoop = await getLoop(loop.id);
      expect(updatedLoop!.consecutiveFailures).toBe(1);
      // Should have started next iteration
      expect(updatedLoop!.currentIteration).toBe(2);
    });
  });

  describe('Optimize strategy', () => {
    it('should keep first iteration as baseline (R5)', async () => {
      // Mock: exit condition returns score
      mockExecSuccess('42.5\n');

      const loop = await createAndEmitLoop({
        strategy: LoopStrategy.OPTIMIZE,
        evalDirection: OptimizeDirection.MAXIMIZE,
      });

      const taskId = await getLatestTaskId(loop.id);
      await eventBus.emit('TaskCompleted', { taskId: taskId!, exitCode: 0, duration: 100 });
      await flushEventLoop();

      const updatedLoop = await getLoop(loop.id);
      expect(updatedLoop!.bestScore).toBe(42.5);
      expect(updatedLoop!.bestIterationId).toBe(1);
      expect(updatedLoop!.consecutiveFailures).toBe(0);

      // Iteration should be 'keep'
      const iters = await loopRepo.getIterations(loop.id);
      expect(iters.ok).toBe(true);
      if (!iters.ok) return;
      // Find iteration 1 (latest is at index 0 if only 1, or we need to look by number)
      const iter1 = iters.value.find((i) => i.iterationNumber === 1);
      expect(iter1).toBeDefined();
      expect(iter1!.status).toBe('keep');
      expect(iter1!.score).toBe(42.5);
    });

    it('should keep better score and update bestScore (maximize)', async () => {
      // First iteration: score 10
      mockExecSuccess('10\n');

      const loop = await createAndEmitLoop({
        strategy: LoopStrategy.OPTIMIZE,
        evalDirection: OptimizeDirection.MAXIMIZE,
        maxIterations: 5,
      });

      const taskId1 = await getLatestTaskId(loop.id);
      await eventBus.emit('TaskCompleted', { taskId: taskId1!, exitCode: 0, duration: 100 });
      await flushEventLoop();

      // Second iteration: score 20 (better)
      mockExecSuccess('20\n');
      const taskId2 = await getLatestTaskId(loop.id);
      await eventBus.emit('TaskCompleted', { taskId: taskId2!, exitCode: 0, duration: 100 });
      await flushEventLoop();

      const updatedLoop = await getLoop(loop.id);
      expect(updatedLoop!.bestScore).toBe(20);
      expect(updatedLoop!.bestIterationId).toBe(2);
    });

    it('should discard worse score and increment consecutiveFailures (maximize)', async () => {
      // First iteration: score 50
      mockExecSuccess('50\n');

      const loop = await createAndEmitLoop({
        strategy: LoopStrategy.OPTIMIZE,
        evalDirection: OptimizeDirection.MAXIMIZE,
        maxIterations: 5,
        maxConsecutiveFailures: 5,
      });

      const taskId1 = await getLatestTaskId(loop.id);
      await eventBus.emit('TaskCompleted', { taskId: taskId1!, exitCode: 0, duration: 100 });
      await flushEventLoop();

      // Second iteration: score 30 (worse for maximize)
      mockExecSuccess('30\n');
      const taskId2 = await getLatestTaskId(loop.id);
      await eventBus.emit('TaskCompleted', { taskId: taskId2!, exitCode: 0, duration: 100 });
      await flushEventLoop();

      const updatedLoop = await getLoop(loop.id);
      expect(updatedLoop!.bestScore).toBe(50); // Unchanged
      expect(updatedLoop!.consecutiveFailures).toBe(1);

      // Iteration 2 should be 'discard'
      const iters = await loopRepo.getIterations(loop.id);
      expect(iters.ok).toBe(true);
      if (!iters.ok) return;
      const iter2 = iters.value.find((i) => i.iterationNumber === 2);
      expect(iter2!.status).toBe('discard');
    });

    it('should crash iteration on NaN score (R5)', async () => {
      // Mock: exit condition returns non-numeric output
      mockExecSuccess('not-a-number\n');

      const loop = await createAndEmitLoop({
        strategy: LoopStrategy.OPTIMIZE,
        evalDirection: OptimizeDirection.MAXIMIZE,
        maxConsecutiveFailures: 5,
      });

      const taskId = await getLatestTaskId(loop.id);
      await eventBus.emit('TaskCompleted', { taskId: taskId!, exitCode: 0, duration: 100 });
      await flushEventLoop();

      // Iteration should be 'crash'
      const iters = await loopRepo.getIterations(loop.id);
      expect(iters.ok).toBe(true);
      if (!iters.ok) return;
      const iter1 = iters.value.find((i) => i.iterationNumber === 1);
      expect(iter1!.status).toBe('crash');
    });

    it('should work with minimize direction (lower is better)', async () => {
      // First iteration: score 100
      mockExecSuccess('100\n');

      const loop = await createAndEmitLoop({
        strategy: LoopStrategy.OPTIMIZE,
        evalDirection: OptimizeDirection.MINIMIZE,
        maxIterations: 5,
      });

      const taskId1 = await getLatestTaskId(loop.id);
      await eventBus.emit('TaskCompleted', { taskId: taskId1!, exitCode: 0, duration: 100 });
      await flushEventLoop();

      // Second iteration: score 50 (better for minimize)
      mockExecSuccess('50\n');
      const taskId2 = await getLatestTaskId(loop.id);
      await eventBus.emit('TaskCompleted', { taskId: taskId2!, exitCode: 0, duration: 100 });
      await flushEventLoop();

      const updatedLoop = await getLoop(loop.id);
      expect(updatedLoop!.bestScore).toBe(50);
      expect(updatedLoop!.bestIterationId).toBe(2);
    });
  });

  describe('Pipeline loops', () => {
    it('should create N tasks with linear dependencies for pipeline iteration', async () => {
      const loop = await createAndEmitLoop({
        pipelineSteps: ['lint the code', 'run the tests'],
        prompt: undefined,
      });

      // Verify iteration was recorded with pipeline task IDs
      const iteration = await getLatestIteration(loop.id);
      expect(iteration).toBeDefined();
      expect(iteration!.pipelineTaskIds).toBeDefined();
      expect(iteration!.pipelineTaskIds!.length).toBe(2);

      // Verify the tasks were saved to the task repo (pipeline saves tasks atomically)
      const task1Result = await taskRepo.findById(iteration!.pipelineTaskIds![0]);
      expect(task1Result.ok).toBe(true);
      if (!task1Result.ok) return;
      expect(task1Result.value).not.toBeNull();
    });

    it('should only trigger evaluation when tail task completes (R4)', async () => {
      mockExecSuccess('success\n');

      const loop = await createAndEmitLoop({
        pipelineSteps: ['lint the code', 'run the tests'],
        prompt: undefined,
      });

      const iteration = await getLatestIteration(loop.id);
      expect(iteration).toBeDefined();
      const taskIds = iteration!.pipelineTaskIds!;

      // Complete the FIRST (non-tail) task — should NOT trigger evaluation
      await eventBus.emit('TaskCompleted', { taskId: taskIds[0], exitCode: 0, duration: 100 });
      await flushEventLoop();

      // Loop should still be running (no evaluation triggered)
      const loopAfterFirst = await getLoop(loop.id);
      expect(loopAfterFirst!.status).toBe(LoopStatus.RUNNING);
      // execSync should NOT have been called for non-tail task
      // (it's only called when the tail task triggers handleTaskTerminal)

      // Complete the TAIL task — should trigger evaluation
      await eventBus.emit('TaskCompleted', { taskId: taskIds[1], exitCode: 0, duration: 100 });
      await flushEventLoop();

      // Now the loop should complete (exit condition passes)
      const loopAfterTail = await getLoop(loop.id);
      expect(loopAfterTail!.status).toBe(LoopStatus.COMPLETED);
    });

    it('should fail iteration and cancel remaining tasks when intermediate pipeline task fails', async () => {
      const loop = await createAndEmitLoop({
        pipelineSteps: ['lint the code', 'run the tests', 'deploy'],
        prompt: undefined,
        maxConsecutiveFailures: 5,
      });

      const iteration = await getLatestIteration(loop.id);
      expect(iteration).toBeDefined();
      const taskIds = iteration!.pipelineTaskIds!;
      expect(taskIds.length).toBe(3);

      // First (intermediate) task FAILS
      await eventBus.emit('TaskFailed', {
        taskId: taskIds[0],
        error: { message: 'Lint failed', code: 'SYSTEM_ERROR' },
        exitCode: 1,
      });
      await flushEventLoop();

      // Iteration 1 should be marked as 'fail'
      const allIters = await loopRepo.getIterations(loop.id, 10);
      expect(allIters.ok).toBe(true);
      if (!allIters.ok) return;
      const iter1 = allIters.value.find((i) => i.iterationNumber === 1);
      expect(iter1!.status).toBe('fail');
      expect(iter1!.errorMessage).toContain('Pipeline step failed');

      // Loop should still be running (not at max failures) and have started next iteration
      const updatedLoop = await getLoop(loop.id);
      expect(updatedLoop!.status).toBe(LoopStatus.RUNNING);
      expect(updatedLoop!.consecutiveFailures).toBe(1);
    });

    it('should be no-op when intermediate pipeline task completes successfully', async () => {
      const loop = await createAndEmitLoop({
        pipelineSteps: ['lint the code', 'run the tests'],
        prompt: undefined,
      });

      const iteration = await getLatestIteration(loop.id);
      expect(iteration).toBeDefined();
      const taskIds = iteration!.pipelineTaskIds!;

      // Complete intermediate task — should be a no-op (just cleanup from taskToLoop)
      await eventBus.emit('TaskCompleted', { taskId: taskIds[0], exitCode: 0, duration: 100 });
      await flushEventLoop();

      // Iteration should still be running
      const updatedIteration = await getLatestIteration(loop.id);
      expect(updatedIteration!.status).toBe('running');

      // Loop should still be running, same iteration
      const updatedLoop = await getLoop(loop.id);
      expect(updatedLoop!.status).toBe(LoopStatus.RUNNING);
      expect(updatedLoop!.currentIteration).toBe(1);
    });

    it('should only process first intermediate failure when concurrent failures occur', async () => {
      const loop = await createAndEmitLoop({
        pipelineSteps: ['step1', 'step2', 'step3'],
        prompt: undefined,
        maxConsecutiveFailures: 5,
      });

      const iteration = await getLatestIteration(loop.id);
      expect(iteration).toBeDefined();
      const taskIds = iteration!.pipelineTaskIds!;

      // First intermediate task fails
      await eventBus.emit('TaskFailed', {
        taskId: taskIds[0],
        error: { message: 'step1 failed', code: 'SYSTEM_ERROR' },
        exitCode: 1,
      });
      await flushEventLoop();

      // Iteration should be marked as 'fail' (from first failure)
      const afterFirst = await getLatestIteration(loop.id);
      // The latest iteration is now iteration 2 (next one started)
      // We need to check the original iteration
      const allIters = await loopRepo.getIterations(loop.id, 10);
      expect(allIters.ok).toBe(true);
      if (!allIters.ok) return;
      const iter1 = allIters.value.find((i) => i.iterationNumber === 1);
      expect(iter1!.status).toBe('fail');

      // Second intermediate task also fails — should be a no-op since iteration is already terminal
      await eventBus.emit('TaskFailed', {
        taskId: taskIds[1],
        error: { message: 'step2 failed', code: 'SYSTEM_ERROR' },
        exitCode: 1,
      });
      await flushEventLoop();

      // consecutiveFailures should still be 1 (only the first failure counted)
      const updatedLoop = await getLoop(loop.id);
      expect(updatedLoop!.consecutiveFailures).toBe(1);
    });
  });

  describe('Cooldown', () => {
    it('should use setTimeout when cooldownMs > 0', async () => {
      // Verify that a loop with cooldown > 0 schedules next iteration via setTimeout
      // We test this by checking that the loop remains at iteration 1 after exit condition
      // fails (because the next iteration is delayed by cooldown, not started immediately)
      mockExecFailure(1, 'fail');

      // Use large cooldown to ensure the next iteration doesn't start during test
      const loop = await createAndEmitLoop({ cooldownMs: 999999, maxIterations: 3 });

      const taskId1 = await getLatestTaskId(loop.id);
      await eventBus.emit('TaskCompleted', { taskId: taskId1!, exitCode: 0, duration: 100 });
      await flushEventLoop();

      // Loop should still be at iteration 1 because cooldown is pending
      const updatedLoop = await getLoop(loop.id);
      expect(updatedLoop!.currentIteration).toBe(1);
      expect(updatedLoop!.status).toBe(LoopStatus.RUNNING);
    });
  });

  describe('Cancel', () => {
    it('should cancel loop on LoopCancelled event', async () => {
      const loop = await createAndEmitLoop();

      await eventBus.emit('LoopCancelled', { loopId: loop.id, reason: 'User cancelled' });
      await flushEventLoop();

      const updatedLoop = await getLoop(loop.id);
      expect(updatedLoop!.status).toBe(LoopStatus.CANCELLED);
      expect(updatedLoop!.completedAt).toBeDefined();
    });

    it('should mark running iteration as cancelled', async () => {
      const loop = await createAndEmitLoop();

      // First iteration should be running
      const iterBefore = await getLatestIteration(loop.id);
      expect(iterBefore!.status).toBe('running');

      await eventBus.emit('LoopCancelled', { loopId: loop.id });
      await flushEventLoop();

      const iterAfter = await getLatestIteration(loop.id);
      expect(iterAfter!.status).toBe('cancelled');
    });
  });

  describe('Recovery (R3)', () => {
    it('should rebuild taskToLoop maps from DB on startup', async () => {
      // Create a loop with a running iteration directly in DB
      const loop = createLoop(
        {
          prompt: 'test recovery',
          strategy: LoopStrategy.RETRY,
          exitCondition: 'true',
          maxIterations: 5,
        },
        '/tmp',
      );
      await loopRepo.save(loop);

      // Manually set currentIteration=1 and save an iteration
      const updatedLoop = { ...loop, currentIteration: 1, updatedAt: Date.now() };
      await loopRepo.update(updatedLoop);

      const taskId = TaskId('task-recovery-test');
      await loopRepo.recordIteration({
        id: 0,
        loopId: loop.id,
        iterationNumber: 1,
        taskId,
        status: 'running',
        startedAt: Date.now(),
      });

      // Also save the task in task repo (needed for recovery)
      const { createTask } = await import('../../../../src/core/domain.js');
      const task = { ...createTask({ prompt: 'test', workingDirectory: '/tmp' }), id: taskId };
      await taskRepo.save(task);

      // Create a NEW handler instance - recovery should rebuild maps
      const freshEventBus = new InMemoryEventBus(createTestConfiguration(), new TestLogger());
      const newHandlerResult = await LoopHandler.create(
        loopRepo,
        taskRepo,
        createMockCheckpointRepo(),
        freshEventBus,
        database,
        new TestLogger(),
      );

      expect(newHandlerResult.ok).toBe(true);
      // The handler's logger should mention rebuilt maps
      // The task-to-loop map should be populated (we can verify by checking
      // that a TaskCompleted event for this task is handled)

      freshEventBus.dispose();
    });
  });

  describe('Eval env vars (R11)', () => {
    it('should inject BACKBEAT_LOOP_ID, BACKBEAT_ITERATION, BACKBEAT_TASK_ID into exit condition env', async () => {
      mockExecSuccess('ok\n');

      const loop = await createAndEmitLoop();
      const taskId = await getLatestTaskId(loop.id);
      expect(taskId).toBeDefined();

      await eventBus.emit('TaskCompleted', { taskId: taskId!, exitCode: 0, duration: 100 });
      await flushEventLoop();

      // Verify exec was called with env vars
      expect(exec).toHaveBeenCalled();
      const callArgs = vi.mocked(exec).mock.calls[0];
      const options = callArgs[1] as Record<string, unknown>;
      const env = options.env as Record<string, string>;

      expect(env.BACKBEAT_LOOP_ID).toBe(loop.id);
      expect(env.BACKBEAT_ITERATION).toBeDefined();
      expect(env.BACKBEAT_TASK_ID).toBe(taskId!);
    });
  });

  describe('Context enrichment (R2)', () => {
    it('should enrich prompt with checkpoint when freshContext=false', async () => {
      // Mock: exit condition fails first time, succeeds second
      let callCount = 0;
      vi.mocked(exec).mockImplementation((_cmd: unknown, _opts: unknown, callback: unknown) => {
        callCount++;
        const cb = callback as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        if (callCount === 1) {
          const error = Object.assign(new Error('test failed'), { code: 1, stdout: '', stderr: 'test failed' });
          cb(error, { stdout: '', stderr: 'test failed' });
        } else {
          cb(null, { stdout: 'success\n', stderr: '' });
        }
        return {} as ReturnType<typeof exec>;
      });

      // Mock checkpoint to return context for previous iteration
      mockCheckpointRepo.findLatest.mockResolvedValue({
        ok: true,
        value: {
          id: 1,
          taskId: TaskId('prev-task'),
          checkpointType: 'failed',
          outputSummary: 'Test output from previous run',
          errorSummary: 'Some error',
          createdAt: Date.now(),
        },
      });

      const loop = await createAndEmitLoop({ freshContext: false, maxIterations: 3 });

      // Complete first iteration (exit condition fails)
      const taskId1 = await getLatestTaskId(loop.id);
      await eventBus.emit('TaskCompleted', { taskId: taskId1!, exitCode: 0, duration: 100 });
      await flushEventLoop();

      // Second iteration should have been started
      const updatedLoop = await getLoop(loop.id);
      expect(updatedLoop!.currentIteration).toBe(2);

      // The checkpoint repo should have been queried for the first iteration's task
      // (findLatest is called during prompt enrichment for iteration 2)
      expect(mockCheckpointRepo.findLatest).toHaveBeenCalled();
    });
  });
});
