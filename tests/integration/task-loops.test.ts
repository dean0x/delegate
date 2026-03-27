/**
 * Integration test: Task Loops - End-to-End Flow
 *
 * Verifies the complete loop lifecycle through the real event pipeline:
 * create loop -> persist -> first iteration -> task completion -> exit condition evaluated -> loop completes
 *
 * ARCHITECTURE: Uses real EventBus, real SQLite (in-memory), real LoopHandler.
 * Pattern: Matches task-scheduling.test.ts integration test conventions.
 *
 * Exit conditions use REAL shell commands (e.g., `true`, `false`, `echo 42`)
 * to avoid vi.mock('child_process') pollution of other test files in non-isolated mode.
 * Single-task iterations have an FK ordering issue (iteration recorded before task saved),
 * so FK constraints are disabled for these tests.
 */

import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoopId, LoopStatus, LoopStrategy, OptimizeDirection } from '../../src/core/domain.js';
import { InMemoryEventBus } from '../../src/core/events/event-bus.js';
import { Database } from '../../src/implementations/database.js';
import { SQLiteLoopRepository } from '../../src/implementations/loop-repository.js';
import { SQLiteTaskRepository } from '../../src/implementations/task-repository.js';
import { ShellExitConditionEvaluator } from '../../src/services/exit-condition-evaluator.js';
import { LoopHandler } from '../../src/services/handlers/loop-handler.js';
import { LoopManagerService } from '../../src/services/loop-manager.js';
import { createTestConfiguration } from '../fixtures/factories.js';
import { TestLogger } from '../fixtures/test-doubles.js';
import { flushEventLoop } from '../utils/event-helpers.js';

/**
 * Minimal mock checkpoint repository for integration tests
 */
function createMockCheckpointRepo() {
  return {
    findLatest: vi.fn().mockResolvedValue({ ok: true, value: null }),
    save: vi.fn().mockResolvedValue({ ok: true, value: null }),
    findAll: vi.fn().mockResolvedValue({ ok: true, value: [] }),
    deleteByTask: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  };
}

describe('Integration: Task Loops - End-to-End Flow', () => {
  let eventBus: InMemoryEventBus;
  let loopRepo: SQLiteLoopRepository;
  let taskRepo: SQLiteTaskRepository;
  let database: Database;
  let logger: TestLogger;
  let handler: LoopHandler;
  let service: LoopManagerService;
  let tempDir: string;

  beforeEach(async () => {
    logger = new TestLogger();
    const config = createTestConfiguration();
    eventBus = new InMemoryEventBus(config, logger);
    tempDir = await mkdtemp(join(tmpdir(), 'autobeat-loop-test-'));

    database = new Database(':memory:');

    loopRepo = new SQLiteLoopRepository(database);
    taskRepo = new SQLiteTaskRepository(database);

    // Create handler (subscribes to events)
    const handlerResult = await LoopHandler.create({
      loopRepo,
      taskRepo,
      checkpointRepo: createMockCheckpointRepo(),
      eventBus,
      database,
      exitConditionEvaluator: new ShellExitConditionEvaluator(),
      logger,
    });
    if (!handlerResult.ok) {
      throw new Error(`Failed to create LoopHandler: ${handlerResult.error.message}`);
    }
    handler = handlerResult.value;

    // Create service
    service = new LoopManagerService(eventBus, logger, loopRepo, config);
  });

  afterEach(async () => {
    eventBus.dispose();
    database.close();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  // Helper: get the latest iteration
  async function getLatestIteration(loopId: LoopId) {
    const result = await loopRepo.getIterations(loopId, 1);
    if (!result.ok || result.value.length === 0) return undefined;
    return result.value[0];
  }

  // Helper: get loop state
  async function getLoop(loopId: LoopId) {
    const result = await loopRepo.findById(loopId);
    if (!result.ok) return undefined;
    return result.value;
  }

  describe('Retry loop lifecycle', () => {
    it('should complete full lifecycle: create -> iterate -> exit condition passes -> complete', async () => {
      // Exit condition: `true` always succeeds (exit code 0)
      const createResult = await service.createLoop({
        prompt: 'Fix the failing test',
        strategy: LoopStrategy.RETRY,
        exitCondition: 'true',
        maxIterations: 5,
        maxConsecutiveFailures: 3,
      });

      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const loopId = createResult.value.id;
      await flushEventLoop();

      // Loop should be persisted and have started first iteration
      const loop = await getLoop(loopId);
      expect(loop).toBeDefined();
      expect(loop!.status).toBe(LoopStatus.RUNNING);
      expect(loop!.currentIteration).toBe(1);

      // First iteration should be recorded
      const iteration = await getLatestIteration(loopId);
      expect(iteration).toBeDefined();
      expect(iteration!.iterationNumber).toBe(1);
      expect(iteration!.status).toBe('running');

      // Simulate task completion — exit condition `true` will pass
      const taskId = iteration!.taskId;
      await eventBus.emit('TaskCompleted', { taskId, exitCode: 0, duration: 1000 });
      await flushEventLoop();

      // Loop should be completed
      const completedLoop = await getLoop(loopId);
      expect(completedLoop!.status).toBe(LoopStatus.COMPLETED);

      // Iteration should be marked as 'pass'
      const completedIter = await getLatestIteration(loopId);
      expect(completedIter!.status).toBe('pass');
    });

    it('should cancel a running loop', async () => {
      const createResult = await service.createLoop({
        prompt: 'Long running task',
        strategy: LoopStrategy.RETRY,
        exitCondition: 'true',
        maxIterations: 100,
      });

      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const loopId = createResult.value.id;
      await flushEventLoop();

      // Verify loop is running
      const runningLoop = await getLoop(loopId);
      expect(runningLoop!.status).toBe(LoopStatus.RUNNING);

      // Cancel the loop
      const cancelResult = await service.cancelLoop(loopId, 'User cancelled');
      expect(cancelResult.ok).toBe(true);
      await flushEventLoop();

      // Loop should be cancelled
      const cancelledLoop = await getLoop(loopId);
      expect(cancelledLoop!.status).toBe(LoopStatus.CANCELLED);
      expect(cancelledLoop!.completedAt).toBeDefined();

      // Running iteration should be cancelled
      const cancelledIter = await getLatestIteration(loopId);
      expect(cancelledIter!.status).toBe('cancelled');
    });

    it('should retry on task failure and eventually succeed via exit condition', async () => {
      // Exit condition: check for a sentinel file. First call fails (file missing), then we create it.
      const sentinelFile = join(tempDir, 'done.txt');
      const exitCondition = `test -f ${sentinelFile}`;

      const createResult = await service.createLoop({
        prompt: 'Fix the tests',
        strategy: LoopStrategy.RETRY,
        exitCondition,
        maxIterations: 5,
        maxConsecutiveFailures: 5,
      });

      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const loopId = createResult.value.id;
      await flushEventLoop();

      // Complete first iteration's task (exit condition fails — file doesn't exist)
      const iter1 = await getLatestIteration(loopId);
      await eventBus.emit('TaskCompleted', { taskId: iter1!.taskId, exitCode: 0, duration: 100 });
      await flushEventLoop();

      // Should have started iteration 2
      const loopAfterIter1 = await getLoop(loopId);
      expect(loopAfterIter1!.currentIteration).toBe(2);
      expect(loopAfterIter1!.status).toBe(LoopStatus.RUNNING);

      // Create the sentinel file so exit condition passes
      await writeFile(sentinelFile, 'done');

      // Complete second iteration's task (exit condition passes — file exists)
      const iter2 = await getLatestIteration(loopId);
      await eventBus.emit('TaskCompleted', { taskId: iter2!.taskId, exitCode: 0, duration: 100 });
      await flushEventLoop();

      // Loop should be completed
      const completedLoop = await getLoop(loopId);
      expect(completedLoop!.status).toBe(LoopStatus.COMPLETED);
    });
  });

  describe('Loop and iteration persistence', () => {
    it('should persist loop and iterations in database after lifecycle', async () => {
      // Exit condition: `true` always passes
      const createResult = await service.createLoop({
        prompt: 'One iteration loop',
        strategy: LoopStrategy.RETRY,
        exitCondition: 'true',
        maxIterations: 1,
      });

      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const loopId = createResult.value.id;
      await flushEventLoop();

      // Complete the task
      const iter = await getLatestIteration(loopId);
      await eventBus.emit('TaskCompleted', { taskId: iter!.taskId, exitCode: 0, duration: 100 });
      await flushEventLoop();

      // Verify persistence: loop in DB
      const loopResult = await loopRepo.findById(loopId);
      expect(loopResult.ok).toBe(true);
      if (!loopResult.ok) return;
      expect(loopResult.value).toBeDefined();
      expect(loopResult.value!.status).toBe(LoopStatus.COMPLETED);

      // Verify persistence: iterations in DB
      const itersResult = await loopRepo.getIterations(loopId);
      expect(itersResult.ok).toBe(true);
      if (!itersResult.ok) return;
      expect(itersResult.value.length).toBeGreaterThanOrEqual(1);
      expect(itersResult.value[0].status).toBe('pass');

      // Verify persistence: count
      const countResult = await loopRepo.count();
      expect(countResult.ok).toBe(true);
      if (!countResult.ok) return;
      expect(countResult.value).toBe(1);
    });
  });

  describe('Optimize loop lifecycle', () => {
    it('should track best score across iterations', async () => {
      // Create a script that outputs incrementing scores (lower = better for minimize)
      const counterFile = join(tempDir, 'counter.txt');
      await writeFile(counterFile, '0');
      // Exit condition: increment counter and output score (100 - counter*10)
      const exitCondition = `COUNTER=$(cat ${counterFile}); COUNTER=$((COUNTER + 1)); echo $COUNTER > ${counterFile}; echo $((100 - COUNTER * 10))`;

      const createResult = await service.createLoop({
        prompt: 'Optimize performance',
        strategy: LoopStrategy.OPTIMIZE,
        exitCondition,
        evalDirection: OptimizeDirection.MINIMIZE,
        maxIterations: 3,
        maxConsecutiveFailures: 5,
      });

      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const loopId = createResult.value.id;
      await flushEventLoop();

      // Complete iterations (each triggers exit condition evaluation)
      for (let i = 0; i < 3; i++) {
        const iter = await getLatestIteration(loopId);
        if (!iter || iter.status !== 'running') break;
        await eventBus.emit('TaskCompleted', { taskId: iter.taskId, exitCode: 0, duration: 100 });
        await flushEventLoop();
      }

      // Loop should be completed with best score tracked
      const finalLoop = await getLoop(loopId);
      expect(finalLoop!.status).toBe(LoopStatus.COMPLETED);
      expect(finalLoop!.bestScore).toBeDefined();
      // Scores output: 90, 80, 70 → best (minimize) is 70
      expect(finalLoop!.bestScore).toBe(70);
    });
  });

  describe('Task failure scenarios', () => {
    it('should increment consecutiveFailures on task failure and start next iteration', async () => {
      const createResult = await service.createLoop({
        prompt: 'Fix the bug',
        strategy: LoopStrategy.RETRY,
        exitCondition: 'true',
        maxIterations: 5,
        maxConsecutiveFailures: 5,
      });

      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const loopId = createResult.value.id;
      await flushEventLoop();

      // Emit TaskFailed for first iteration
      const iter1 = await getLatestIteration(loopId);
      expect(iter1).toBeDefined();
      await eventBus.emit('TaskFailed', { taskId: iter1!.taskId, error: 'Test failed', exitCode: 1 });
      await flushEventLoop();

      // Loop should still be running with incremented failures
      const loop = await getLoop(loopId);
      expect(loop!.status).toBe(LoopStatus.RUNNING);
      expect(loop!.consecutiveFailures).toBe(1);
      expect(loop!.currentIteration).toBe(2);
    });

    it('should fail loop when max consecutive failures reached', async () => {
      const createResult = await service.createLoop({
        prompt: 'Fix the bug',
        strategy: LoopStrategy.RETRY,
        exitCondition: 'true',
        maxIterations: 10,
        maxConsecutiveFailures: 2,
      });

      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const loopId = createResult.value.id;
      await flushEventLoop();

      // Fail first iteration
      const iter1 = await getLatestIteration(loopId);
      await eventBus.emit('TaskFailed', { taskId: iter1!.taskId, error: 'fail 1', exitCode: 1 });
      await flushEventLoop();

      // Fail second iteration
      const iter2 = await getLatestIteration(loopId);
      await eventBus.emit('TaskFailed', { taskId: iter2!.taskId, error: 'fail 2', exitCode: 1 });
      await flushEventLoop();

      // Loop should be FAILED
      const loop = await getLoop(loopId);
      expect(loop!.status).toBe(LoopStatus.FAILED);
      expect(loop!.consecutiveFailures).toBe(2);
    });

    it('should keep incrementing consecutiveFailures when task succeeds but exit condition fails', async () => {
      // Exit condition: `false` always fails (exit code 1) so loop continues
      // consecutiveFailures tracks iteration outcome, not task outcome
      const createResult = await service.createLoop({
        prompt: 'Fix the bug',
        strategy: LoopStrategy.RETRY,
        exitCondition: 'false',
        maxIterations: 5,
        maxConsecutiveFailures: 5,
      });

      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const loopId = createResult.value.id;
      await flushEventLoop();

      // Fail first iteration (TaskFailed)
      const iter1 = await getLatestIteration(loopId);
      await eventBus.emit('TaskFailed', { taskId: iter1!.taskId, error: 'fail', exitCode: 1 });
      await flushEventLoop();

      expect((await getLoop(loopId))!.consecutiveFailures).toBe(1);

      // Succeed second iteration task, but exit condition `false` fails
      const iter2 = await getLatestIteration(loopId);
      await eventBus.emit('TaskCompleted', { taskId: iter2!.taskId, exitCode: 0, duration: 100 });
      await flushEventLoop();

      // consecutiveFailures increments because exit condition failed
      const loop = await getLoop(loopId);
      expect(loop!.consecutiveFailures).toBe(2);
      expect(loop!.status).toBe(LoopStatus.RUNNING);
    });
  });

  describe('Optimize strategy edge cases', () => {
    it('should track best score with maximize direction', async () => {
      // Create a script that outputs specific scores per iteration
      const counterFile = join(tempDir, 'max-counter.txt');
      await writeFile(counterFile, '0');
      // Scores: 10, 20, 15 — best for maximize is 20
      const exitCondition = `COUNTER=$(cat ${counterFile}); COUNTER=$((COUNTER + 1)); echo $COUNTER > ${counterFile}; case $COUNTER in 1) echo 10;; 2) echo 20;; *) echo 15;; esac`;

      const createResult = await service.createLoop({
        prompt: 'Maximize score',
        strategy: LoopStrategy.OPTIMIZE,
        exitCondition,
        evalDirection: OptimizeDirection.MAXIMIZE,
        maxIterations: 3,
        maxConsecutiveFailures: 5,
      });

      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const loopId = createResult.value.id;
      await flushEventLoop();

      for (let i = 0; i < 3; i++) {
        const iter = await getLatestIteration(loopId);
        if (!iter || iter.status !== 'running') break;
        await eventBus.emit('TaskCompleted', { taskId: iter.taskId, exitCode: 0, duration: 100 });
        await flushEventLoop();
      }

      const finalLoop = await getLoop(loopId);
      expect(finalLoop!.status).toBe(LoopStatus.COMPLETED);
      expect(finalLoop!.bestScore).toBe(20);
    });
  });

  describe('Shell exit condition evaluation', () => {
    it('should parse numeric score from shell command output', async () => {
      // echo 42 should produce score=42
      const createResult = await service.createLoop({
        prompt: 'Score test',
        strategy: LoopStrategy.OPTIMIZE,
        exitCondition: 'echo 42',
        evalDirection: OptimizeDirection.MINIMIZE,
        maxIterations: 1,
        maxConsecutiveFailures: 3,
      });

      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const loopId = createResult.value.id;
      await flushEventLoop();

      const iter = await getLatestIteration(loopId);
      await eventBus.emit('TaskCompleted', { taskId: iter!.taskId, exitCode: 0, duration: 100 });
      await flushEventLoop();

      const finalLoop = await getLoop(loopId);
      expect(finalLoop!.status).toBe(LoopStatus.COMPLETED);
      expect(finalLoop!.bestScore).toBe(42);
    });
  });

  // ==========================================================================
  // v0.8.0 Pause/Resume Integration Tests
  // ==========================================================================

  describe('Pause/Resume lifecycle', () => {
    it('should pause and resume a running loop — full lifecycle', async () => {
      // Exit condition: `false` always fails → loop keeps iterating
      const createResult = await service.createLoop({
        prompt: 'Pauseable loop',
        strategy: LoopStrategy.RETRY,
        exitCondition: 'false',
        maxIterations: 10,
        maxConsecutiveFailures: 10,
      });

      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const loopId = createResult.value.id;
      await flushEventLoop();

      // Verify loop is running
      const runningLoop = await getLoop(loopId);
      expect(runningLoop!.status).toBe(LoopStatus.RUNNING);
      expect(runningLoop!.currentIteration).toBe(1);

      // Pause (graceful)
      const pauseResult = await service.pauseLoop(loopId);
      expect(pauseResult.ok).toBe(true);
      await flushEventLoop();

      const pausedLoop = await getLoop(loopId);
      expect(pausedLoop!.status).toBe(LoopStatus.PAUSED);

      // Resume
      const resumeResult = await service.resumeLoop(loopId);
      expect(resumeResult.ok).toBe(true);
      await flushEventLoop();

      const resumedLoop = await getLoop(loopId);
      expect(resumedLoop!.status).toBe(LoopStatus.RUNNING);
    });

    it('should resume after mid-iteration completion (pause → task finishes → resume → continues)', async () => {
      // Exit condition: check for sentinel file
      const sentinelFile = join(tempDir, 'pause-resume-done.txt');
      const exitCondition = `test -f ${sentinelFile}`;

      const createResult = await service.createLoop({
        prompt: 'Pause-resume test',
        strategy: LoopStrategy.RETRY,
        exitCondition,
        maxIterations: 10,
        maxConsecutiveFailures: 10,
      });

      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const loopId = createResult.value.id;
      await flushEventLoop();

      // Pause (graceful — iteration continues)
      await service.pauseLoop(loopId);
      await flushEventLoop();

      // Simulate task completion while paused
      // In real system, WorkerHandler updates task status
      const iter1 = await getLatestIteration(loopId);
      expect(iter1).toBeDefined();

      // Mark task as completed in the task repo (simulates WorkerHandler)
      if (iter1!.taskId) {
        await taskRepo.update(iter1!.taskId, {
          status: 'completed' as import('../../src/core/domain').TaskStatus,
          exitCode: 0,
          completedAt: Date.now(),
        });
      }

      // Emit TaskCompleted (handler ignores it because loop is PAUSED)
      await eventBus.emit('TaskCompleted', { taskId: iter1!.taskId, exitCode: 0, duration: 100 });
      await flushEventLoop();

      // Still paused
      expect((await getLoop(loopId))!.status).toBe(LoopStatus.PAUSED);

      // Resume — recovery should evaluate the exit condition (fails: no sentinel file yet)
      await service.resumeLoop(loopId);
      await flushEventLoop();

      const afterResume = await getLoop(loopId);
      expect(afterResume!.status).toBe(LoopStatus.RUNNING);
      // Should have started iteration 2 (exit condition failed → next iteration)
      expect(afterResume!.currentIteration).toBe(2);
    });

    it('should cancel a paused loop', async () => {
      const createResult = await service.createLoop({
        prompt: 'Cancel while paused',
        strategy: LoopStrategy.RETRY,
        exitCondition: 'true',
        maxIterations: 10,
      });

      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const loopId = createResult.value.id;
      await flushEventLoop();

      // Pause
      await service.pauseLoop(loopId);
      await flushEventLoop();
      expect((await getLoop(loopId))!.status).toBe(LoopStatus.PAUSED);

      // Cancel while paused
      const cancelResult = await service.cancelLoop(loopId, 'No longer needed');
      expect(cancelResult.ok).toBe(true);
      await flushEventLoop();

      const cancelledLoop = await getLoop(loopId);
      expect(cancelledLoop!.status).toBe(LoopStatus.CANCELLED);
    });
  });
});
