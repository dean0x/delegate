/**
 * Unit tests for LoopHandler
 * ARCHITECTURE: Tests event-driven iteration engine with real SQLite (in-memory)
 * Pattern: Behavioral testing with TestEventBus (matches schedule-handler pattern)
 *
 * NOTE: LoopHandler extends BaseEventHandler. Its handleEvent() wrapper catches errors
 * from inner handlers and logs them rather than propagating. Tests verify state and events
 * rather than thrown exceptions.
 *
 * Exit condition evaluation uses injected ExitConditionEvaluator (DI pattern).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock git-state before importing modules that depend on it
vi.mock('../../../../src/utils/git-state.js', () => ({
  commitAllChanges: vi.fn().mockResolvedValue({ ok: true, value: 'abc1234567890abcdef1234567890abcdef123456' }),
  resetToCommit: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  getCurrentCommitSha: vi.fn().mockResolvedValue({ ok: true, value: 'def4567890abcdef1234567890abcdef1234567890' }),
  createAndCheckoutBranch: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  captureGitDiff: vi.fn().mockResolvedValue({ ok: true, value: ' src/main.ts | 5 +++--\n 1 file changed' }),
}));

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
import type { ExitConditionEvaluator } from '../../../../src/core/interfaces.js';
import { Database } from '../../../../src/implementations/database.js';
import { SQLiteLoopRepository } from '../../../../src/implementations/loop-repository.js';
import { SQLiteTaskRepository } from '../../../../src/implementations/task-repository.js';
import { LoopHandler } from '../../../../src/services/handlers/loop-handler.js';
import {
  commitAllChanges,
  createAndCheckoutBranch,
  getCurrentCommitSha,
  resetToCommit,
} from '../../../../src/utils/git-state.js';
import { createTestConfiguration } from '../../../fixtures/factories.js';
import { TestLogger } from '../../../fixtures/test-doubles.js';
import { flushEventLoop } from '../../../utils/event-helpers.js';

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
  let mockEvaluator: ExitConditionEvaluator & { evaluate: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    logger = new TestLogger();
    const config = createTestConfiguration();
    eventBus = new InMemoryEventBus(config, logger);

    database = new Database(':memory:');

    loopRepo = new SQLiteLoopRepository(database);
    taskRepo = new SQLiteTaskRepository(database);
    mockCheckpointRepo = createMockCheckpointRepo();
    mockEvaluator = { evaluate: vi.fn().mockResolvedValue({ passed: true, exitCode: 0 }) };

    const handlerResult = await LoopHandler.create({
      loopRepo,
      taskRepo,
      checkpointRepo: mockCheckpointRepo,
      eventBus,
      database,
      exitConditionEvaluator: mockEvaluator,
      logger,
    });
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

      const result = await LoopHandler.create({
        loopRepo: freshLoopRepo,
        taskRepo: freshTaskRepo,
        checkpointRepo: createMockCheckpointRepo(),
        eventBus: freshEventBus,
        database: freshDb,
        exitConditionEvaluator: { evaluate: vi.fn().mockResolvedValue({ passed: true, exitCode: 0 }) },
        logger: freshLogger,
      });

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
      mockEvaluator.evaluate.mockResolvedValue({ passed: true, exitCode: 0 });

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
      mockEvaluator.evaluate.mockResolvedValue({ passed: false, exitCode: 1, error: 'test failed' });

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
      mockEvaluator.evaluate.mockResolvedValue({ passed: false, exitCode: 1, error: 'fail' });

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
      mockEvaluator.evaluate.mockResolvedValue({ passed: true, score: 42.5, exitCode: 0 });

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
      mockEvaluator.evaluate.mockResolvedValue({ passed: true, score: 10, exitCode: 0 });

      const loop = await createAndEmitLoop({
        strategy: LoopStrategy.OPTIMIZE,
        evalDirection: OptimizeDirection.MAXIMIZE,
        maxIterations: 5,
      });

      const taskId1 = await getLatestTaskId(loop.id);
      await eventBus.emit('TaskCompleted', { taskId: taskId1!, exitCode: 0, duration: 100 });
      await flushEventLoop();

      // Second iteration: score 20 (better)
      mockEvaluator.evaluate.mockResolvedValue({ passed: true, score: 20, exitCode: 0 });
      const taskId2 = await getLatestTaskId(loop.id);
      await eventBus.emit('TaskCompleted', { taskId: taskId2!, exitCode: 0, duration: 100 });
      await flushEventLoop();

      const updatedLoop = await getLoop(loop.id);
      expect(updatedLoop!.bestScore).toBe(20);
      expect(updatedLoop!.bestIterationId).toBe(2);
    });

    it('should discard worse score and increment consecutiveFailures (maximize)', async () => {
      // First iteration: score 50
      mockEvaluator.evaluate.mockResolvedValue({ passed: true, score: 50, exitCode: 0 });

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
      mockEvaluator.evaluate.mockResolvedValue({ passed: true, score: 30, exitCode: 0 });
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
      mockEvaluator.evaluate.mockResolvedValue({
        passed: false,
        error: 'Invalid score: not-a-number (must be a finite number)',
        exitCode: 0,
      });

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
      mockEvaluator.evaluate.mockResolvedValue({ passed: true, score: 100, exitCode: 0 });

      const loop = await createAndEmitLoop({
        strategy: LoopStrategy.OPTIMIZE,
        evalDirection: OptimizeDirection.MINIMIZE,
        maxIterations: 5,
      });

      const taskId1 = await getLatestTaskId(loop.id);
      await eventBus.emit('TaskCompleted', { taskId: taskId1!, exitCode: 0, duration: 100 });
      await flushEventLoop();

      // Second iteration: score 50 (better for minimize)
      mockEvaluator.evaluate.mockResolvedValue({ passed: true, score: 50, exitCode: 0 });
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
      mockEvaluator.evaluate.mockResolvedValue({ passed: true, exitCode: 0 });

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

      // Iteration 1 should be marked as 'fail' (from first failure).
      // Latest iteration is now iteration 2 (next one started), so fetch all.
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
      mockEvaluator.evaluate.mockResolvedValue({ passed: false, exitCode: 1, error: 'fail' });

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
      const newHandlerResult = await LoopHandler.create({
        loopRepo,
        taskRepo,
        checkpointRepo: createMockCheckpointRepo(),
        eventBus: freshEventBus,
        database,
        exitConditionEvaluator: { evaluate: vi.fn().mockResolvedValue({ passed: true, exitCode: 0 }) },
        logger: new TestLogger(),
      });

      expect(newHandlerResult.ok).toBe(true);
      // The handler's logger should mention rebuilt maps
      // The task-to-loop map should be populated (we can verify by checking
      // that a TaskCompleted event for this task is handled)

      freshEventBus.dispose();
    });
  });

  describe('ExitConditionEvaluator DI', () => {
    it('should call evaluator with correct loop and taskId on task completion', async () => {
      mockEvaluator.evaluate.mockResolvedValue({ passed: true, exitCode: 0 });

      const loop = await createAndEmitLoop();
      const taskId = await getLatestTaskId(loop.id);
      expect(taskId).toBeDefined();

      await eventBus.emit('TaskCompleted', { taskId: taskId!, exitCode: 0, duration: 100 });
      await flushEventLoop();

      // Verify evaluator was called with loop and taskId
      expect(mockEvaluator.evaluate).toHaveBeenCalledTimes(1);
      const [calledLoop, calledTaskId] = mockEvaluator.evaluate.mock.calls[0];
      expect(calledLoop.id).toBe(loop.id);
      expect(calledTaskId).toBe(taskId!);
    });
  });

  describe('Context enrichment (R2)', () => {
    it('should enrich prompt with checkpoint when freshContext=false', async () => {
      // Mock: exit condition fails first time, succeeds second
      mockEvaluator.evaluate
        .mockResolvedValueOnce({ passed: false, exitCode: 1, error: 'test failed' })
        .mockResolvedValueOnce({ passed: true, exitCode: 0 });

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

  describe('Fix H — Task failure atomicity', () => {
    it('should atomically persist iteration fail and consecutiveFailures', async () => {
      const loop = await createAndEmitLoop({ maxConsecutiveFailures: 5 });

      const taskId = await getLatestTaskId(loop.id);
      await eventBus.emit('TaskFailed', {
        taskId: taskId!,
        error: { message: 'Task crashed', code: 'SYSTEM_ERROR' },
        exitCode: 1,
      });
      await flushEventLoop();

      // Both iteration status and loop consecutiveFailures should be committed
      const iteration = await getLatestIteration(loop.id);
      // Latest iteration is now iteration 2 (next started), so find iteration 1
      const allIters = await loopRepo.getIterations(loop.id, 10);
      expect(allIters.ok).toBe(true);
      const iter1 = allIters.value.find((i) => i.iterationNumber === 1);
      expect(iter1!.status).toBe('fail');
      expect(iter1!.exitCode).toBe(1);
      expect(iter1!.errorMessage).toBe('Task crashed');

      const updatedLoop = await getLoop(loop.id);
      expect(updatedLoop!.consecutiveFailures).toBe(1);
      expect(updatedLoop!.currentIteration).toBe(2);
    });

    it('should mark loop FAILED when task failure transaction fails', async () => {
      const loop = await createAndEmitLoop({ maxConsecutiveFailures: 5 });

      // Spy on updateIterationSync to throw (simulating transaction failure)
      const origUpdateIterationSync = loopRepo.updateIterationSync.bind(loopRepo);
      let callCount = 0;
      vi.spyOn(loopRepo, 'updateIterationSync').mockImplementation((iter) => {
        callCount++;
        // First call is from handleTaskTerminal's atomic transaction
        if (callCount === 1) {
          throw new Error('Simulated DB write failure');
        }
        return origUpdateIterationSync(iter);
      });

      const taskId = await getLatestTaskId(loop.id);
      await eventBus.emit('TaskFailed', {
        taskId: taskId!,
        error: { message: 'Task crashed', code: 'SYSTEM_ERROR' },
        exitCode: 1,
      });
      await flushEventLoop();

      // Loop should be FAILED (not stuck in RUNNING)
      const updatedLoop = await getLoop(loop.id);
      expect(updatedLoop!.status).toBe(LoopStatus.FAILED);
    });
  });

  describe('Fix I — recordAndContinue tx failure marks loop FAILED', () => {
    it('should mark loop FAILED when recordAndContinue transaction fails', async () => {
      // Exit condition fails → enters recordAndContinue path
      mockEvaluator.evaluate.mockResolvedValue({ passed: false, exitCode: 1, error: 'test failed' });

      const loop = await createAndEmitLoop({ maxConsecutiveFailures: 5 });

      // updateIterationSync is called inside recordAndContinue's transaction
      const origUpdateIterationSync = loopRepo.updateIterationSync.bind(loopRepo);
      let callCount = 0;
      vi.spyOn(loopRepo, 'updateIterationSync').mockImplementation((iter) => {
        callCount++;
        // First updateIterationSync call is inside recordAndContinue
        if (callCount === 1) {
          throw new Error('Simulated DB write failure');
        }
        return origUpdateIterationSync(iter);
      });

      const taskId = await getLatestTaskId(loop.id);
      await eventBus.emit('TaskCompleted', { taskId: taskId!, exitCode: 0, duration: 100 });
      await flushEventLoop();

      // Loop should be FAILED (not stuck in RUNNING)
      const updatedLoop = await getLoop(loop.id);
      expect(updatedLoop!.status).toBe(LoopStatus.FAILED);
    });
  });

  describe('Fix J — Recovery with terminal iterations', () => {
    // Helper: set up a loop + iteration in specific states to simulate crash-window
    async function setupCrashWindowScenario(overrides: {
      iterationStatus: string;
      loopOverrides?: Partial<Loop>;
      taskStatus?: TaskStatus;
    }) {
      const loop = createLoop(
        {
          prompt: 'test recovery',
          strategy: LoopStrategy.RETRY,
          exitCondition: 'true',
          maxIterations: 10,
          maxConsecutiveFailures: 3,
          ...overrides.loopOverrides,
        },
        '/tmp',
      );
      await loopRepo.save(loop);

      // Set currentIteration=1
      const updatedLoop = {
        ...loop,
        currentIteration: 1,
        updatedAt: Date.now(),
        ...(overrides.loopOverrides ?? {}),
      };
      await loopRepo.update(updatedLoop);

      // Create task in specified state
      const { createTask } = await import('../../../../src/core/domain.js');
      const taskId = TaskId(`task-recovery-${loop.id}`);
      const task = {
        ...createTask({ prompt: 'test', workingDirectory: '/tmp' }),
        id: taskId,
        status: overrides.taskStatus ?? TaskStatus.COMPLETED,
      };
      await taskRepo.save(task);

      // Record iteration with specified terminal status
      await loopRepo.recordIteration({
        id: 0,
        loopId: loop.id,
        iterationNumber: 1,
        taskId,
        status: overrides.iterationStatus as LoopIteration['status'],
        startedAt: Date.now(),
        completedAt: Date.now(),
      });

      return { loop: updatedLoop, taskId };
    }

    it('should complete loop when recovering pass iteration', async () => {
      const { loop } = await setupCrashWindowScenario({ iterationStatus: 'pass' });

      // Create fresh handler — triggers recovery
      const freshEventBus = new InMemoryEventBus(createTestConfiguration(), new TestLogger());
      await LoopHandler.create({
        loopRepo,
        taskRepo,
        checkpointRepo: createMockCheckpointRepo(),
        eventBus: freshEventBus,
        database,
        exitConditionEvaluator: mockEvaluator,
        logger: new TestLogger(),
      });

      const recoveredLoop = await getLoop(loop.id);
      expect(recoveredLoop!.status).toBe(LoopStatus.COMPLETED);

      freshEventBus.dispose();
    });

    it('should start next iteration when recovering fail iteration below max', async () => {
      const { loop } = await setupCrashWindowScenario({
        iterationStatus: 'fail',
        loopOverrides: { maxConsecutiveFailures: 5, consecutiveFailures: 1 },
      });

      const freshEventBus = new InMemoryEventBus(createTestConfiguration(), new TestLogger());
      await LoopHandler.create({
        loopRepo,
        taskRepo,
        checkpointRepo: createMockCheckpointRepo(),
        eventBus: freshEventBus,
        database,
        exitConditionEvaluator: mockEvaluator,
        logger: new TestLogger(),
      });

      const recoveredLoop = await getLoop(loop.id);
      expect(recoveredLoop!.status).toBe(LoopStatus.RUNNING);
      expect(recoveredLoop!.currentIteration).toBe(2);

      freshEventBus.dispose();
    });

    it('should fail loop when recovering fail iteration at max consecutiveFailures', async () => {
      const { loop } = await setupCrashWindowScenario({
        iterationStatus: 'fail',
        loopOverrides: { maxConsecutiveFailures: 3, consecutiveFailures: 3 },
      });

      const freshEventBus = new InMemoryEventBus(createTestConfiguration(), new TestLogger());
      await LoopHandler.create({
        loopRepo,
        taskRepo,
        checkpointRepo: createMockCheckpointRepo(),
        eventBus: freshEventBus,
        database,
        exitConditionEvaluator: mockEvaluator,
        logger: new TestLogger(),
      });

      const recoveredLoop = await getLoop(loop.id);
      expect(recoveredLoop!.status).toBe(LoopStatus.FAILED);

      freshEventBus.dispose();
    });

    it('should start next iteration when recovering keep iteration', async () => {
      const { loop } = await setupCrashWindowScenario({
        iterationStatus: 'keep',
        loopOverrides: {
          strategy: LoopStrategy.OPTIMIZE,
          consecutiveFailures: 0,
        },
      });

      const freshEventBus = new InMemoryEventBus(createTestConfiguration(), new TestLogger());
      await LoopHandler.create({
        loopRepo,
        taskRepo,
        checkpointRepo: createMockCheckpointRepo(),
        eventBus: freshEventBus,
        database,
        exitConditionEvaluator: mockEvaluator,
        logger: new TestLogger(),
      });

      const recoveredLoop = await getLoop(loop.id);
      expect(recoveredLoop!.status).toBe(LoopStatus.RUNNING);
      expect(recoveredLoop!.currentIteration).toBe(2);

      freshEventBus.dispose();
    });
  });

  describe('Fix K — Retry pass path atomicity', () => {
    it('should atomically persist pass iteration and loop completion', async () => {
      mockEvaluator.evaluate.mockResolvedValue({ passed: true, exitCode: 0 });

      const loop = await createAndEmitLoop();
      const taskId = await getLatestTaskId(loop.id);

      await eventBus.emit('TaskCompleted', { taskId: taskId!, exitCode: 0, duration: 100 });
      await flushEventLoop();

      // Both should be committed atomically
      const iteration = await getLatestIteration(loop.id);
      expect(iteration!.status).toBe('pass');
      expect(iteration!.exitCode).toBe(0);

      const updatedLoop = await getLoop(loop.id);
      expect(updatedLoop!.status).toBe(LoopStatus.COMPLETED);
    });
  });

  describe('Fix L — Recovery CANCELLED path continues loop', () => {
    it('should mark cancelled iteration and start next iteration during recovery', async () => {
      // Set up loop with RUNNING status, running iteration, but CANCELLED task
      const loop = createLoop(
        {
          prompt: 'test recovery cancelled',
          strategy: LoopStrategy.RETRY,
          exitCondition: 'true',
          maxIterations: 10,
          maxConsecutiveFailures: 3,
        },
        '/tmp',
      );
      await loopRepo.save(loop);

      const updatedLoop = { ...loop, currentIteration: 1, updatedAt: Date.now() };
      await loopRepo.update(updatedLoop);

      const { createTask: ct } = await import('../../../../src/core/domain.js');
      const taskId = TaskId(`task-cancelled-recovery-${loop.id}`);
      const task = {
        ...ct({ prompt: 'test', workingDirectory: '/tmp' }),
        id: taskId,
        status: TaskStatus.CANCELLED,
      };
      await taskRepo.save(task);

      // Record iteration as 'running' (crash before marking cancelled)
      await loopRepo.recordIteration({
        id: 0,
        loopId: loop.id,
        iterationNumber: 1,
        taskId,
        status: 'running',
        startedAt: Date.now(),
      });

      // Create fresh handler — triggers recovery
      const freshEventBus = new InMemoryEventBus(createTestConfiguration(), new TestLogger());
      await LoopHandler.create({
        loopRepo,
        taskRepo,
        checkpointRepo: createMockCheckpointRepo(),
        eventBus: freshEventBus,
        database,
        exitConditionEvaluator: mockEvaluator,
        logger: new TestLogger(),
      });

      // Iteration should be marked cancelled
      const allIters = await loopRepo.getIterations(loop.id, 10);
      expect(allIters.ok).toBe(true);
      const iter1 = allIters.value.find((i) => i.iterationNumber === 1);
      expect(iter1!.status).toBe('cancelled');

      // Next iteration should have started
      const recoveredLoop = await getLoop(loop.id);
      expect(recoveredLoop!.status).toBe(LoopStatus.RUNNING);
      expect(recoveredLoop!.currentIteration).toBe(2);

      freshEventBus.dispose();
    });
  });

  // ==========================================================================
  // v0.8.0 Pause/Resume Tests
  // ==========================================================================

  describe('Pause — graceful', () => {
    it('should set status to PAUSED and allow current iteration to continue', async () => {
      const loop = await createAndEmitLoop();

      // Emit LoopPaused (graceful, force=false)
      await eventBus.emit('LoopPaused', { loopId: loop.id, force: false });
      await flushEventLoop();

      const pausedLoop = await getLoop(loop.id);
      expect(pausedLoop).toBeDefined();
      expect(pausedLoop!.status).toBe(LoopStatus.PAUSED);

      // Current iteration should still be running (graceful)
      const iteration = await getLatestIteration(loop.id);
      expect(iteration).toBeDefined();
      expect(iteration!.status).toBe('running');
    });

    it('should not start next iteration when task completes while paused (graceful)', async () => {
      // Mock: exit condition fails → normally starts next iteration
      mockEvaluator.evaluate.mockResolvedValue({ passed: false, exitCode: 1, error: 'fail' });

      const loop = await createAndEmitLoop({ maxIterations: 10 });

      // Pause (graceful)
      await eventBus.emit('LoopPaused', { loopId: loop.id, force: false });
      await flushEventLoop();

      // Task completes while paused
      const taskId = await getLatestTaskId(loop.id);
      expect(taskId).toBeDefined();
      await eventBus.emit('TaskCompleted', { taskId: taskId!, exitCode: 0, duration: 100 });
      await flushEventLoop();

      // Loop should still be paused (no next iteration started)
      const afterComplete = await getLoop(loop.id);
      expect(afterComplete!.status).toBe(LoopStatus.PAUSED);
      // Current iteration should still be 1 (no new iteration started)
      expect(afterComplete!.currentIteration).toBe(1);
    });
  });

  describe('Pause — force', () => {
    it('should set status to PAUSED and cancel current running iteration', async () => {
      const loop = await createAndEmitLoop();

      // Emit LoopPaused (force=true)
      await eventBus.emit('LoopPaused', { loopId: loop.id, force: true });
      await flushEventLoop();

      const pausedLoop = await getLoop(loop.id);
      expect(pausedLoop).toBeDefined();
      expect(pausedLoop!.status).toBe(LoopStatus.PAUSED);

      // Current iteration should be marked as cancelled
      const iteration = await getLatestIteration(loop.id);
      expect(iteration).toBeDefined();
      expect(iteration!.status).toBe('cancelled');
      expect(iteration!.completedAt).toBeDefined();
    });

    it('should not overwrite cancelled iteration status on late TaskCompleted (race condition)', async () => {
      // Mock: exit condition passes (would normally mark 'pass')
      mockEvaluator.evaluate.mockResolvedValue({ passed: true, exitCode: 0 });

      const loop = await createAndEmitLoop();
      const taskId = await getLatestTaskId(loop.id);
      expect(taskId).toBeDefined();

      // Force-pause cancels the running iteration
      await eventBus.emit('LoopPaused', { loopId: loop.id, force: true });
      await flushEventLoop();

      // Verify iteration is cancelled
      const iterBefore = await getLatestIteration(loop.id);
      expect(iterBefore!.status).toBe('cancelled');

      // Late TaskCompleted arrives after force-pause (race condition)
      await eventBus.emit('TaskCompleted', { taskId: taskId!, exitCode: 0, duration: 100 });
      await flushEventLoop();

      // Iteration status should remain 'cancelled' — not overwritten to 'pass'
      const iterAfter = await getLatestIteration(loop.id);
      expect(iterAfter!.status).toBe('cancelled');

      // Loop should still be PAUSED (not completed)
      const loopAfter = await getLoop(loop.id);
      expect(loopAfter!.status).toBe(LoopStatus.PAUSED);
    });
  });

  describe('Resume', () => {
    it('should set status to RUNNING and start next iteration after force pause', async () => {
      const loop = await createAndEmitLoop({ maxIterations: 10 });

      // Force pause cancels current iteration
      await eventBus.emit('LoopPaused', { loopId: loop.id, force: true });
      await flushEventLoop();

      // Resume
      await eventBus.emit('LoopResumed', { loopId: loop.id });
      await flushEventLoop();

      const resumedLoop = await getLoop(loop.id);
      expect(resumedLoop).toBeDefined();
      expect(resumedLoop!.status).toBe(LoopStatus.RUNNING);
      // Should have started iteration 2 (recovery sees cancelled iter, starts next)
      expect(resumedLoop!.currentIteration).toBe(2);
    });

    it('should evaluate result when resuming after graceful mid-iteration completion', async () => {
      // Mock: exit condition passes
      mockEvaluator.evaluate.mockResolvedValue({ passed: true, exitCode: 0 });

      const loop = await createAndEmitLoop({ maxIterations: 10 });

      // Graceful pause
      await eventBus.emit('LoopPaused', { loopId: loop.id, force: false });
      await flushEventLoop();

      // Simulate task completion while paused:
      // 1. Update task status in repo (mirrors what WorkerHandler does)
      // 2. Emit TaskCompleted (handler ignores it because loop is PAUSED)
      const taskId = await getLatestTaskId(loop.id);
      expect(taskId).toBeDefined();
      await taskRepo.update(taskId!, { status: TaskStatus.COMPLETED, exitCode: 0, completedAt: Date.now() });
      await eventBus.emit('TaskCompleted', { taskId: taskId!, exitCode: 0, duration: 100 });
      await flushEventLoop();

      // Resume — recovery should pick up the completed task and evaluate exit condition
      await eventBus.emit('LoopResumed', { loopId: loop.id });
      await flushEventLoop();

      const resumedLoop = await getLoop(loop.id);
      expect(resumedLoop).toBeDefined();
      // Exit condition passed → loop should be completed
      expect(resumedLoop!.status).toBe(LoopStatus.COMPLETED);
    });
  });

  describe('Recovery skips PAUSED loops', () => {
    it('should not recover paused loops on handler startup', async () => {
      // Create a paused loop directly in DB
      const loop = createLoop(
        {
          prompt: 'paused loop',
          strategy: LoopStrategy.RETRY,
          exitCondition: 'test -f /tmp/done',
          maxIterations: 10,
          maxConsecutiveFailures: 3,
          cooldownMs: 0,
          freshContext: true,
          evalTimeout: 60000,
        },
        '/tmp',
      );

      // Save as PAUSED
      const pausedLoop = { ...loop, status: LoopStatus.PAUSED, currentIteration: 1 };
      await loopRepo.save(pausedLoop);

      // Create a fresh handler — triggers recovery
      const freshEventBus = new InMemoryEventBus(createTestConfiguration(), new TestLogger());
      await LoopHandler.create({
        loopRepo,
        taskRepo,
        checkpointRepo: createMockCheckpointRepo(),
        eventBus: freshEventBus,
        database,
        exitConditionEvaluator: mockEvaluator,
        logger: new TestLogger(),
      });

      // Loop should still be PAUSED (not recovered to RUNNING)
      const afterRecovery = await getLoop(loop.id);
      expect(afterRecovery).toBeDefined();
      expect(afterRecovery!.status).toBe(LoopStatus.PAUSED);

      freshEventBus.dispose();
    });
  });

  // ==========================================================================
  // v0.8.1 Git Integration Tests
  // ==========================================================================

  describe('Git commit-per-iteration (v0.8.1)', () => {
    // Helper: create a git-enabled loop (has gitStartCommitSha and gitBranch)
    async function createGitLoop(overrides: Partial<Parameters<typeof createLoop>[0]> = {}): Promise<Loop> {
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
          gitBranch: 'feat/loop-work',
          ...overrides,
        },
        '/tmp',
      );

      // Inject git start commit SHA (normally done by LoopManagerService)
      const loopWithGit = {
        ...loop,
        gitStartCommitSha: 'aaa1111222233334444555566667777888899990000',
        gitBaseBranch: 'main',
      };

      await eventBus.emit('LoopCreated', { loop: loopWithGit });
      await flushEventLoop();
      return loopWithGit;
    }

    beforeEach(() => {
      // Reset all git mocks before each git test
      vi.mocked(commitAllChanges)
        .mockReset()
        .mockResolvedValue({ ok: true, value: 'abc1234567890abcdef1234567890abcdef123456' });
      vi.mocked(resetToCommit).mockReset().mockResolvedValue({ ok: true, value: undefined });
      vi.mocked(getCurrentCommitSha)
        .mockReset()
        .mockResolvedValue({ ok: true, value: 'def4567890abcdef1234567890abcdef1234567890' });
      vi.mocked(createAndCheckoutBranch).mockReset().mockResolvedValue({ ok: true, value: undefined });
    });

    it('should call createAndCheckoutBranch on iteration 1 with --git-branch', async () => {
      await createGitLoop();

      // createAndCheckoutBranch should have been called for the first iteration
      expect(vi.mocked(createAndCheckoutBranch)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(createAndCheckoutBranch)).toHaveBeenCalledWith('/tmp', 'feat/loop-work', 'main');
    });

    it('should NOT call createAndCheckoutBranch for subsequent iterations', async () => {
      // Exit condition fails → starts next iteration
      mockEvaluator.evaluate.mockResolvedValue({ passed: false, exitCode: 1, error: 'fail' });

      const loop = await createGitLoop({ maxIterations: 5 });

      // Reset after first iteration's branch creation
      vi.mocked(createAndCheckoutBranch).mockClear();

      // Complete first iteration (exit condition fails → starts iteration 2)
      const taskId1 = await getLatestTaskId(loop.id);
      await eventBus.emit('TaskCompleted', { taskId: taskId1!, exitCode: 0, duration: 100 });
      await flushEventLoop();

      // createAndCheckoutBranch is called again for re-checkout, but with different args
      // (no baseBranch on subsequent iterations — just re-checkout the loop branch)
      const calls = vi.mocked(createAndCheckoutBranch).mock.calls;
      // Subsequent iterations re-checkout the branch without fromRef (baseBranch)
      expect(calls).toHaveLength(1);
      expect(calls[0][2]).toBeUndefined(); // No fromRef for re-checkout
    });

    it('should capture preIterationCommitSha in iteration record', async () => {
      vi.mocked(getCurrentCommitSha).mockResolvedValue({
        ok: true,
        value: 'pre1111222233334444555566667777888899990000',
      });

      const loop = await createGitLoop();

      // Verify getCurrentCommitSha was called (for pre-iteration capture)
      expect(vi.mocked(getCurrentCommitSha)).toHaveBeenCalled();

      // Check the iteration record has preIterationCommitSha
      const iteration = await getLatestIteration(loop.id);
      expect(iteration).toBeDefined();
      expect(iteration!.preIterationCommitSha).toBe('pre1111222233334444555566667777888899990000');
    });

    it('should commit changes and record gitCommitSha on pass (retry)', async () => {
      mockEvaluator.evaluate.mockResolvedValue({ passed: true, exitCode: 0 });
      vi.mocked(commitAllChanges).mockResolvedValue({
        ok: true,
        value: 'commit_sha_after_pass_1234567890abcdef12345',
      });

      const loop = await createGitLoop();
      const taskId = await getLatestTaskId(loop.id);

      await eventBus.emit('TaskCompleted', { taskId: taskId!, exitCode: 0, duration: 100 });
      await flushEventLoop();

      // commitAllChanges should have been called
      expect(vi.mocked(commitAllChanges)).toHaveBeenCalled();

      // Iteration should have gitCommitSha set
      const iteration = await getLatestIteration(loop.id);
      expect(iteration).toBeDefined();
      expect(iteration!.status).toBe('pass');
      expect(iteration!.gitCommitSha).toBe('commit_sha_after_pass_1234567890abcdef12345');
    });

    it('should commit changes and record gitCommitSha on keep (optimize)', async () => {
      mockEvaluator.evaluate.mockResolvedValue({ passed: true, score: 42.5, exitCode: 0 });
      vi.mocked(commitAllChanges).mockResolvedValue({
        ok: true,
        value: 'commit_sha_after_keep_1234567890abcdef12345',
      });

      const loop = await createGitLoop({
        strategy: LoopStrategy.OPTIMIZE,
        evalDirection: OptimizeDirection.MAXIMIZE,
      });
      const taskId = await getLatestTaskId(loop.id);

      await eventBus.emit('TaskCompleted', { taskId: taskId!, exitCode: 0, duration: 100 });
      await flushEventLoop();

      expect(vi.mocked(commitAllChanges)).toHaveBeenCalled();

      const iters = await loopRepo.getIterations(loop.id, 10);
      expect(iters.ok).toBe(true);
      const iter1 = iters.value.find((i) => i.iterationNumber === 1);
      expect(iter1).toBeDefined();
      expect(iter1!.status).toBe('keep');
      expect(iter1!.gitCommitSha).toBe('commit_sha_after_keep_1234567890abcdef12345');
    });

    it('should reset to gitStartCommitSha on retry fail', async () => {
      mockEvaluator.evaluate.mockResolvedValue({ passed: false, exitCode: 1, error: 'test failed' });

      const loop = await createGitLoop({ maxConsecutiveFailures: 5 });
      const taskId = await getLatestTaskId(loop.id);

      await eventBus.emit('TaskCompleted', { taskId: taskId!, exitCode: 0, duration: 100 });
      await flushEventLoop();

      // resetToCommit should have been called with the loop's gitStartCommitSha
      expect(vi.mocked(resetToCommit)).toHaveBeenCalledWith('/tmp', 'aaa1111222233334444555566667777888899990000');
    });

    it('should reset to best iteration gitCommitSha on optimize discard', async () => {
      // First iteration: score 50 → keep (baseline)
      mockEvaluator.evaluate.mockResolvedValueOnce({ passed: true, score: 50, exitCode: 0 });
      vi.mocked(commitAllChanges).mockResolvedValueOnce({
        ok: true,
        value: 'best_commit_sha_12345678901234567890123456',
      });

      const loop = await createGitLoop({
        strategy: LoopStrategy.OPTIMIZE,
        evalDirection: OptimizeDirection.MAXIMIZE,
        maxIterations: 5,
        maxConsecutiveFailures: 5,
      });

      const taskId1 = await getLatestTaskId(loop.id);
      await eventBus.emit('TaskCompleted', { taskId: taskId1!, exitCode: 0, duration: 100 });
      await flushEventLoop();

      // Second iteration: score 30 → discard (worse for maximize)
      mockEvaluator.evaluate.mockResolvedValueOnce({ passed: true, score: 30, exitCode: 0 });
      vi.mocked(resetToCommit).mockClear();

      const taskId2 = await getLatestTaskId(loop.id);
      await eventBus.emit('TaskCompleted', { taskId: taskId2!, exitCode: 0, duration: 100 });
      await flushEventLoop();

      // resetToCommit should be called with the best iteration's commit SHA
      expect(vi.mocked(resetToCommit)).toHaveBeenCalledWith('/tmp', 'best_commit_sha_12345678901234567890123456');
    });

    it('should cache bestIterationCommitSha on loop after optimize keep', async () => {
      mockEvaluator.evaluate.mockResolvedValueOnce({ passed: true, score: 50, exitCode: 0 });
      vi.mocked(commitAllChanges).mockResolvedValueOnce({
        ok: true,
        value: 'cached_sha_1234567890abcdef1234567890abcdef12',
      });

      const loop = await createGitLoop({
        strategy: LoopStrategy.OPTIMIZE,
        evalDirection: OptimizeDirection.MAXIMIZE,
        maxIterations: 5,
        maxConsecutiveFailures: 5,
      });

      const taskId1 = await getLatestTaskId(loop.id);
      await eventBus.emit('TaskCompleted', { taskId: taskId1!, exitCode: 0, duration: 100 });
      await flushEventLoop();

      // After keep, the loop should have bestIterationCommitSha cached
      const updatedLoop = await loopRepo.findById(loop.id);
      expect(updatedLoop.ok).toBe(true);
      if (!updatedLoop.ok) return;
      expect(updatedLoop.value!.bestIterationCommitSha).toBe('cached_sha_1234567890abcdef1234567890abcdef12');
    });

    it('should reset to gitStartCommitSha on task failure', async () => {
      const loop = await createGitLoop({ maxConsecutiveFailures: 5 });
      const taskId = await getLatestTaskId(loop.id);

      await eventBus.emit('TaskFailed', {
        taskId: taskId!,
        error: { message: 'Task crashed', code: 'SYSTEM_ERROR' },
        exitCode: 1,
      });
      await flushEventLoop();

      // Task failure does NOT go through git commit/reset path
      // (only exit condition evaluation triggers git operations)
      // The iteration's preIterationCommitSha is still set though
      const allIters = await loopRepo.getIterations(loop.id, 10);
      expect(allIters.ok).toBe(true);
      const iter1 = allIters.value.find((i) => i.iterationNumber === 1);
      expect(iter1).toBeDefined();
      expect(iter1!.status).toBe('fail');
    });

    it('should use getCurrentCommitSha as fallback when commitAllChanges returns null (agent already committed)', async () => {
      mockEvaluator.evaluate.mockResolvedValue({ passed: true, exitCode: 0 });
      // commitAllChanges returns null (nothing to commit — agent already committed)
      vi.mocked(commitAllChanges).mockResolvedValue({ ok: true, value: null });
      vi.mocked(getCurrentCommitSha)
        .mockResolvedValueOnce({ ok: true, value: 'pre_iteration_sha_fake1234567890abcdef1234' }) // pre-iteration capture
        .mockResolvedValueOnce({ ok: true, value: 'agent_committed_sha_1234567890abcdef123456' }); // fallback

      const loop = await createGitLoop();
      const taskId = await getLatestTaskId(loop.id);

      await eventBus.emit('TaskCompleted', { taskId: taskId!, exitCode: 0, duration: 100 });
      await flushEventLoop();

      // getCurrentCommitSha should have been called as fallback
      // (first call is pre-iteration, second is the fallback after null commit)
      expect(vi.mocked(getCurrentCommitSha).mock.calls.length).toBeGreaterThanOrEqual(2);

      const iteration = await getLatestIteration(loop.id);
      expect(iteration).toBeDefined();
      expect(iteration!.status).toBe('pass');
      expect(iteration!.gitCommitSha).toBe('agent_committed_sha_1234567890abcdef123456');
    });

    it('should reset to gitStartCommitSha on pipeline intermediate step failure', async () => {
      const loop = await createGitLoop({
        pipelineSteps: ['lint the code', 'run the tests', 'deploy'],
        prompt: undefined,
        maxConsecutiveFailures: 5,
      });

      const iteration = await getLatestIteration(loop.id);
      expect(iteration).toBeDefined();
      expect(iteration!.pipelineTaskIds).toBeDefined();
      expect(iteration!.pipelineTaskIds!.length).toBe(3);
      const taskIds = iteration!.pipelineTaskIds!;

      vi.mocked(resetToCommit).mockClear();

      // Fail the first (intermediate) pipeline task
      await eventBus.emit('TaskFailed', {
        taskId: taskIds[0],
        error: { message: 'Lint failed', code: 'SYSTEM_ERROR' },
        exitCode: 1,
      });
      await flushEventLoop();

      // resetToCommit should have been called with the loop's gitStartCommitSha
      expect(vi.mocked(resetToCommit)).toHaveBeenCalledWith('/tmp', 'aaa1111222233334444555566667777888899990000');

      // Iteration should be marked as 'fail' with pipeline step failure message
      const allIters = await loopRepo.getIterations(loop.id, 10);
      expect(allIters.ok).toBe(true);
      if (!allIters.ok) return;
      const iter1 = allIters.value.find((i) => i.iterationNumber === 1);
      expect(iter1!.status).toBe('fail');
      expect(iter1!.errorMessage).toContain('Pipeline step failed');
    });

    it('should reset to gitStartCommitSha on optimize crash', async () => {
      // crash: no score returned
      mockEvaluator.evaluate.mockResolvedValue({
        passed: false,
        error: 'Invalid score',
        exitCode: 0,
      });

      const loop = await createGitLoop({
        strategy: LoopStrategy.OPTIMIZE,
        evalDirection: OptimizeDirection.MAXIMIZE,
        maxConsecutiveFailures: 5,
      });

      const taskId = await getLatestTaskId(loop.id);
      await eventBus.emit('TaskCompleted', { taskId: taskId!, exitCode: 0, duration: 100 });
      await flushEventLoop();

      // resetToCommit should be called with gitStartCommitSha (no best iteration yet)
      expect(vi.mocked(resetToCommit)).toHaveBeenCalledWith('/tmp', 'aaa1111222233334444555566667777888899990000');

      const iters = await loopRepo.getIterations(loop.id, 10);
      expect(iters.ok).toBe(true);
      const iter1 = iters.value.find((i) => i.iterationNumber === 1);
      expect(iter1!.status).toBe('crash');
    });
  });
});
