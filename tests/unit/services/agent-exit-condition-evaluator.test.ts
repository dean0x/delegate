/**
 * Unit tests for AgentExitConditionEvaluator
 * ARCHITECTURE: Tests agent-based eval using TestEventBus (DI pattern)
 * Pattern: Behavioral testing — verifies PASS/FAIL parsing, score parsing,
 * feedback capture, timeout handling, task failure/cancellation, and subscription cleanup
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Loop } from '../../../src/core/domain.js';
import { createLoop, LoopId, LoopStrategy, OptimizeDirection, TaskId } from '../../../src/core/domain.js';
import type { EvalResult, LoopRepository, OutputRepository } from '../../../src/core/interfaces.js';
import { err, ok } from '../../../src/core/result.js';
import { AgentExitConditionEvaluator } from '../../../src/services/agent-exit-condition-evaluator.js';
import { TestEventBus, TestLogger } from '../../fixtures/test-doubles.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function createTestLoop(overrides: Partial<Parameters<typeof createLoop>[0]> = {}): Loop {
  return createLoop(
    {
      prompt: 'Improve the code quality',
      strategy: LoopStrategy.RETRY,
      exitCondition: '',
      evalMode: 'agent',
      maxIterations: 5,
      evalTimeout: 10000,
      ...overrides,
    },
    '/workspace',
  );
}

/**
 * Create mock OutputRepository that returns given stdout lines
 */
function createOutputRepo(lines: string[]): OutputRepository {
  return {
    get: vi.fn().mockResolvedValue(
      ok({
        stdout: lines,
        stderr: [],
        truncated: false,
        byteSize: lines.join('\n').length,
      }),
    ),
    save: vi.fn().mockResolvedValue(ok(undefined)),
    delete: vi.fn().mockResolvedValue(ok(undefined)),
    getByteSize: vi.fn().mockResolvedValue(ok(0)),
  } as unknown as OutputRepository;
}

/**
 * Create mock LoopRepository that returns a minimal iteration record
 */
function createLoopRepo(preIterationCommitSha?: string): LoopRepository {
  return {
    findIterationByTaskId: vi
      .fn()
      .mockResolvedValue(
        ok(preIterationCommitSha ? { iterationNumber: 1, preIterationCommitSha, status: 'running' } : null),
      ),
    findById: vi.fn().mockResolvedValue(ok(null)),
    findAll: vi.fn().mockResolvedValue(ok([])),
    findByStatus: vi.fn().mockResolvedValue(ok([])),
    save: vi.fn().mockResolvedValue(ok(undefined)),
    updateStatus: vi.fn().mockResolvedValue(ok(undefined)),
    recordIteration: vi.fn().mockResolvedValue(ok(undefined)),
    updateIteration: vi.fn().mockResolvedValue(ok(undefined)),
    getIterations: vi.fn().mockResolvedValue(ok([])),
    // Sync methods
    saveSync: vi.fn().mockReturnValue(ok(undefined)),
    updateStatusSync: vi.fn().mockReturnValue(ok(undefined)),
    recordIterationSync: vi.fn().mockReturnValue(ok(undefined)),
    updateIterationSync: vi.fn().mockReturnValue(ok(undefined)),
  } as unknown as LoopRepository;
}

/**
 * After calling evaluator.evaluate(), emit the terminal event for the eval task
 * to simulate agent completion.
 */
async function simulateEvalTaskComplete(eventBus: TestEventBus, evalTaskId: string): Promise<void> {
  await eventBus.emit('TaskCompleted', {
    taskId: evalTaskId as ReturnType<typeof TaskId>,
    workerId: 'w1' as unknown as never,
  });
}

async function simulateEvalTaskFailed(eventBus: TestEventBus, evalTaskId: string, errorMsg: string): Promise<void> {
  await eventBus.emit('TaskFailed', {
    taskId: evalTaskId as ReturnType<typeof TaskId>,
    error: new Error(errorMsg),
    workerId: 'w1' as unknown as never,
  });
}

async function simulateEvalTaskCancelled(eventBus: TestEventBus, evalTaskId: string): Promise<void> {
  await eventBus.emit('TaskCancelled', { taskId: evalTaskId as ReturnType<typeof TaskId>, reason: 'manual' });
}

async function simulateEvalTaskTimeout(eventBus: TestEventBus, evalTaskId: string): Promise<void> {
  await eventBus.emit('TaskTimeout', { taskId: evalTaskId as ReturnType<typeof TaskId> });
}

/**
 * Evaluate with automatic completion simulation.
 * Spies on eventBus.emit to capture the eval task ID from TaskDelegated,
 * then after a tick calls simulateFn(evalTaskId) to drive the eval task to a
 * terminal state. Returns the resolved EvalResult.
 *
 * Reduces each test to: setup evaluator → call evaluateWithCompletion → assert result.
 */
async function evaluateWithCompletion(
  evaluator: AgentExitConditionEvaluator,
  loop: Loop,
  taskId: ReturnType<typeof TaskId>,
  eventBus: TestEventBus,
  simulateFn: (evalTaskId: string) => Promise<void>,
): Promise<EvalResult> {
  let capturedEvalTaskId: string | undefined;
  const origEmit = eventBus.emit.bind(eventBus);
  vi.spyOn(eventBus, 'emit').mockImplementation(async (type: string, payload: unknown) => {
    if (type === 'TaskDelegated') {
      capturedEvalTaskId = (payload as { task: { id: string } }).task.id;
    }
    return origEmit(type as never, payload as never);
  });

  const evalPromise = evaluator.evaluate(loop, taskId);
  // Give async operations a tick to set up subscription before driving terminal event
  await new Promise((r) => setImmediate(r));
  if (capturedEvalTaskId) {
    await simulateFn(capturedEvalTaskId);
  }

  return evalPromise;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('AgentExitConditionEvaluator', () => {
  let eventBus: TestEventBus;
  let logger: TestLogger;
  const workTaskId = TaskId('task-work-abc123');

  beforeEach(() => {
    eventBus = new TestEventBus();
    logger = new TestLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Retry strategy: PASS / FAIL parsing
  // ──────────────────────────────────────────────────────────────────────────

  describe('Retry strategy — output parsing', () => {
    it('returns passed=true when last line is PASS', async () => {
      const loop = createTestLoop({ strategy: LoopStrategy.RETRY });
      const outputRepo = createOutputRepo(['The changes look good.', 'PASS']);
      const loopRepo = createLoopRepo();
      const evaluator = new AgentExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger);

      const result = await evaluateWithCompletion(evaluator, loop, workTaskId, eventBus, (id) =>
        simulateEvalTaskComplete(eventBus, id),
      );
      expect(result.passed).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('returns passed=false when last line is FAIL', async () => {
      const loop = createTestLoop({ strategy: LoopStrategy.RETRY });
      const outputRepo = createOutputRepo(['Tests are still failing.', 'FAIL']);
      const loopRepo = createLoopRepo();
      const evaluator = new AgentExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger);

      const result = await evaluateWithCompletion(evaluator, loop, workTaskId, eventBus, (id) =>
        simulateEvalTaskComplete(eventBus, id),
      );
      expect(result.passed).toBe(false);
      expect(result.error).toBeUndefined();
    });

    it('returns error when last line is neither PASS nor FAIL', async () => {
      const loop = createTestLoop({ strategy: LoopStrategy.RETRY });
      const outputRepo = createOutputRepo(['Some analysis here.', 'MAYBE']);
      const loopRepo = createLoopRepo();
      const evaluator = new AgentExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger);

      const result = await evaluateWithCompletion(evaluator, loop, workTaskId, eventBus, (id) =>
        simulateEvalTaskComplete(eventBus, id),
      );
      expect(result.passed).toBe(false);
      expect(result.error).toContain('PASS or FAIL');
      expect(result.error).toContain('MAYBE');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Optimize strategy: numeric score parsing
  // ──────────────────────────────────────────────────────────────────────────

  describe('Optimize strategy — score parsing', () => {
    it('parses integer score from last line', async () => {
      const loop = createTestLoop({ strategy: LoopStrategy.OPTIMIZE, evalDirection: OptimizeDirection.MAXIMIZE });
      const outputRepo = createOutputRepo(['Quality analysis complete.', '85']);
      const loopRepo = createLoopRepo();
      const evaluator = new AgentExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger);

      const result = await evaluateWithCompletion(evaluator, loop, workTaskId, eventBus, (id) =>
        simulateEvalTaskComplete(eventBus, id),
      );
      expect(result.passed).toBe(true);
      expect(result.score).toBe(85);
    });

    it('parses float score from last line', async () => {
      const loop = createTestLoop({ strategy: LoopStrategy.OPTIMIZE, evalDirection: OptimizeDirection.MAXIMIZE });
      const outputRepo = createOutputRepo(['Detailed review...', '72.5']);
      const loopRepo = createLoopRepo();
      const evaluator = new AgentExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger);

      const result = await evaluateWithCompletion(evaluator, loop, workTaskId, eventBus, (id) =>
        simulateEvalTaskComplete(eventBus, id),
      );
      expect(result.passed).toBe(true);
      expect(result.score).toBe(72.5);
    });

    it('returns error when last line is not a number', async () => {
      const loop = createTestLoop({ strategy: LoopStrategy.OPTIMIZE, evalDirection: OptimizeDirection.MAXIMIZE });
      const outputRepo = createOutputRepo(['The code looks good.', 'good']);
      const loopRepo = createLoopRepo();
      const evaluator = new AgentExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger);

      const result = await evaluateWithCompletion(evaluator, loop, workTaskId, eventBus, (id) =>
        simulateEvalTaskComplete(eventBus, id),
      );
      expect(result.passed).toBe(false);
      expect(result.error).toContain('numeric score');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Feedback capture
  // ──────────────────────────────────────────────────────────────────────────

  describe('Feedback capture', () => {
    it('captures all lines before the decision as feedback', async () => {
      const loop = createTestLoop({ strategy: LoopStrategy.RETRY });
      const outputRepo = createOutputRepo([
        'Line 1: The imports look clean.',
        'Line 2: Error handling is solid.',
        'PASS',
      ]);
      const loopRepo = createLoopRepo();
      const evaluator = new AgentExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger);

      const result = await evaluateWithCompletion(evaluator, loop, workTaskId, eventBus, (id) =>
        simulateEvalTaskComplete(eventBus, id),
      );
      expect(result.passed).toBe(true);
      expect(result.feedback).toContain('Line 1: The imports look clean.');
      expect(result.feedback).toContain('Line 2: Error handling is solid.');
    });

    it('has no feedback when output is single line', async () => {
      const loop = createTestLoop({ strategy: LoopStrategy.RETRY });
      const outputRepo = createOutputRepo(['PASS']);
      const loopRepo = createLoopRepo();
      const evaluator = new AgentExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger);

      const result = await evaluateWithCompletion(evaluator, loop, workTaskId, eventBus, (id) =>
        simulateEvalTaskComplete(eventBus, id),
      );
      expect(result.passed).toBe(true);
      expect(result.feedback).toBeUndefined();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Empty output
  // ──────────────────────────────────────────────────────────────────────────

  describe('Empty output handling', () => {
    it('returns error when eval agent produces no output', async () => {
      const loop = createTestLoop({ strategy: LoopStrategy.RETRY });
      const outputRepo = createOutputRepo([]);
      const loopRepo = createLoopRepo();
      const evaluator = new AgentExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger);

      const result = await evaluateWithCompletion(evaluator, loop, workTaskId, eventBus, (id) =>
        simulateEvalTaskComplete(eventBus, id),
      );
      expect(result.passed).toBe(false);
      expect(result.error).toContain('no output');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Task failure and cancellation
  // ──────────────────────────────────────────────────────────────────────────

  describe('Task terminal states', () => {
    it('returns error when eval task fails', async () => {
      const loop = createTestLoop({ strategy: LoopStrategy.RETRY });
      const outputRepo = createOutputRepo(['PASS']);
      const loopRepo = createLoopRepo();
      const evaluator = new AgentExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger);

      const result = await evaluateWithCompletion(evaluator, loop, workTaskId, eventBus, (id) =>
        simulateEvalTaskFailed(eventBus, id, 'Agent crashed'),
      );
      expect(result.passed).toBe(false);
      expect(result.error).toContain('Agent crashed');
    });

    it('returns error when eval task is cancelled', async () => {
      const loop = createTestLoop({ strategy: LoopStrategy.RETRY });
      const outputRepo = createOutputRepo(['PASS']);
      const loopRepo = createLoopRepo();
      const evaluator = new AgentExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger);

      const result = await evaluateWithCompletion(evaluator, loop, workTaskId, eventBus, (id) =>
        simulateEvalTaskCancelled(eventBus, id),
      );
      expect(result.passed).toBe(false);
      expect(result.error).toContain('cancelled');
    });

    it('returns error when eval task times out via TaskTimeout event', async () => {
      const loop = createTestLoop({ strategy: LoopStrategy.RETRY });
      const outputRepo = createOutputRepo(['PASS']);
      const loopRepo = createLoopRepo();
      const evaluator = new AgentExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger);

      const result = await evaluateWithCompletion(evaluator, loop, workTaskId, eventBus, (id) =>
        simulateEvalTaskTimeout(eventBus, id),
      );
      expect(result.passed).toBe(false);
      expect(result.error).toContain('timed out');
    });

    it('emits TaskCancellationRequested for eval task when parent loop is cancelled', async () => {
      // Regression: eval task was orphaned when LoopCancelled fired during eval wait.
      // The eval task is not in LoopHandler.taskToLoop by design, so handleLoopCancelled
      // cannot reach it. AgentExitConditionEvaluator must self-cancel on LoopCancelled.
      const loop = createTestLoop({ strategy: LoopStrategy.RETRY });
      const outputRepo = createOutputRepo(['PASS']);
      const loopRepo = createLoopRepo();
      const evaluator = new AgentExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger);

      let capturedEvalTaskId: string | undefined;
      const cancellationRequests: string[] = [];
      const origEmit = eventBus.emit.bind(eventBus);
      vi.spyOn(eventBus, 'emit').mockImplementation(async (type: string, payload: unknown) => {
        if (type === 'TaskDelegated') {
          capturedEvalTaskId = (payload as { task: { id: string } }).task.id;
        }
        if (type === 'TaskCancellationRequested') {
          cancellationRequests.push((payload as { taskId: string }).taskId);
        }
        return origEmit(type as never, payload as never);
      });

      const evalPromise = evaluator.evaluate(loop, workTaskId);
      await new Promise((r) => setImmediate(r));

      // Simulate loop cancellation while eval is in-flight
      await eventBus.emit('LoopCancelled', { loopId: loop.id, reason: 'user cancelled' });

      // Give the LoopCancelled handler a tick to emit TaskCancellationRequested
      await new Promise((r) => setImmediate(r));

      // Verify TaskCancellationRequested was emitted for the eval task
      expect(capturedEvalTaskId).toBeDefined();
      expect(cancellationRequests).toContain(capturedEvalTaskId);

      // Now simulate the TaskCancelled arriving (as WorkerHandler would emit after receiving
      // TaskCancellationRequested) so the promise resolves and the test can complete
      if (capturedEvalTaskId) {
        await simulateEvalTaskCancelled(eventBus, capturedEvalTaskId);
      }

      const result = await evalPromise;
      expect(result.passed).toBe(false);
      expect(result.error).toContain('cancelled');
    });

    it('does not emit TaskCancellationRequested when a different loop is cancelled', async () => {
      const loop = createTestLoop({ strategy: LoopStrategy.RETRY });
      const outputRepo = createOutputRepo(['PASS']);
      const loopRepo = createLoopRepo();
      const evaluator = new AgentExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger);

      let capturedEvalTaskId: string | undefined;
      const cancellationRequests: string[] = [];
      const origEmit = eventBus.emit.bind(eventBus);
      vi.spyOn(eventBus, 'emit').mockImplementation(async (type: string, payload: unknown) => {
        if (type === 'TaskDelegated') {
          capturedEvalTaskId = (payload as { task: { id: string } }).task.id;
        }
        if (type === 'TaskCancellationRequested') {
          cancellationRequests.push((payload as { taskId: string }).taskId);
        }
        return origEmit(type as never, payload as never);
      });

      const evalPromise = evaluator.evaluate(loop, workTaskId);
      await new Promise((r) => setImmediate(r));

      // Cancel a DIFFERENT loop — should not affect this eval task
      const otherLoopId = LoopId('loop-other-id');
      await eventBus.emit('LoopCancelled', { loopId: otherLoopId, reason: 'user cancelled' });
      await new Promise((r) => setImmediate(r));

      // No cancellation should have been requested for the eval task
      expect(cancellationRequests).not.toContain(capturedEvalTaskId);

      // Complete the eval normally so the test can exit
      if (capturedEvalTaskId) {
        await simulateEvalTaskComplete(eventBus, capturedEvalTaskId);
      }

      await evalPromise;
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TaskDelegated emit failure
  // ──────────────────────────────────────────────────────────────────────────

  describe('TaskDelegated emit failure', () => {
    it('returns error when TaskDelegated emit fails', async () => {
      const loop = createTestLoop({ strategy: LoopStrategy.RETRY });
      const outputRepo = createOutputRepo(['PASS']);
      const loopRepo = createLoopRepo();

      // Make emit fail for TaskDelegated
      vi.spyOn(eventBus, 'emit').mockResolvedValue(err(new Error('Event bus unavailable')));

      const evaluator = new AgentExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger);
      const result = await evaluator.evaluate(loop, workTaskId);

      expect(result.passed).toBe(false);
      expect(result.error).toContain('spawn eval agent');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Eval task prefix and prompt construction
  // ──────────────────────────────────────────────────────────────────────────

  describe('Eval task construction', () => {
    it('prefixes eval task prompt with [EVAL]', async () => {
      const loop = createTestLoop({ strategy: LoopStrategy.RETRY });
      const outputRepo = createOutputRepo(['PASS']);
      const loopRepo = createLoopRepo();

      const capturedTasks: Array<{ id: string; prompt: string }> = [];
      const origEmit = eventBus.emit.bind(eventBus);
      vi.spyOn(eventBus, 'emit').mockImplementation(async (type: string, payload: unknown) => {
        if (type === 'TaskDelegated') {
          const task = (payload as { task: { id: string; prompt: string } }).task;
          capturedTasks.push({ id: task.id, prompt: task.prompt });
        }
        return origEmit(type as never, payload as never);
      });

      const evaluator = new AgentExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger);
      const evalPromise = evaluator.evaluate(loop, workTaskId);
      await new Promise((r) => setImmediate(r));
      if (capturedTasks[0]) {
        await simulateEvalTaskComplete(eventBus, capturedTasks[0].id);
      }
      await evalPromise;

      expect(capturedTasks).toHaveLength(1);
      expect(capturedTasks[0].prompt).toMatch(/^\[EVAL\]/);
    });

    it('uses custom evalPrompt but still includes format directive for retry', async () => {
      const customPrompt = 'Custom evaluation criteria: check test coverage.';
      const loop = createTestLoop({ strategy: LoopStrategy.RETRY, evalPrompt: customPrompt });
      const outputRepo = createOutputRepo(['PASS']);
      const loopRepo = createLoopRepo();

      const capturedTasks: Array<{ id: string; prompt: string }> = [];
      const origEmit = eventBus.emit.bind(eventBus);
      vi.spyOn(eventBus, 'emit').mockImplementation(async (type: string, payload: unknown) => {
        if (type === 'TaskDelegated') {
          const task = (payload as { task: { id: string; prompt: string } }).task;
          capturedTasks.push({ id: task.id, prompt: task.prompt });
        }
        return origEmit(type as never, payload as never);
      });

      const evaluator = new AgentExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger);
      const evalPromise = evaluator.evaluate(loop, workTaskId);
      await new Promise((r) => setImmediate(r));
      if (capturedTasks[0]) {
        await simulateEvalTaskComplete(eventBus, capturedTasks[0].id);
      }
      await evalPromise;

      expect(capturedTasks[0].prompt).toContain(customPrompt);
      // Format directive must be present even with custom evalPrompt
      expect(capturedTasks[0].prompt).toContain('PASS or FAIL');
    });

    it('uses custom evalPrompt but still includes format directive for optimize', async () => {
      const customPrompt = 'Score correctness and efficiency.';
      const loop = createTestLoop({
        strategy: LoopStrategy.OPTIMIZE,
        evalDirection: OptimizeDirection.MAXIMIZE,
        evalPrompt: customPrompt,
      });
      const outputRepo = createOutputRepo(['85']);
      const loopRepo = createLoopRepo();

      const capturedTasks: Array<{ id: string; prompt: string }> = [];
      const origEmit = eventBus.emit.bind(eventBus);
      vi.spyOn(eventBus, 'emit').mockImplementation(async (type: string, payload: unknown) => {
        if (type === 'TaskDelegated') {
          const task = (payload as { task: { id: string; prompt: string } }).task;
          capturedTasks.push({ id: task.id, prompt: task.prompt });
        }
        return origEmit(type as never, payload as never);
      });

      const evaluator = new AgentExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger);
      const evalPromise = evaluator.evaluate(loop, workTaskId);
      await new Promise((r) => setImmediate(r));
      if (capturedTasks[0]) {
        await simulateEvalTaskComplete(eventBus, capturedTasks[0].id);
      }
      await evalPromise;

      expect(capturedTasks[0].prompt).toContain(customPrompt);
      // Format directive must be present even with custom evalPrompt
      expect(capturedTasks[0].prompt).toContain('numeric score');
    });

    it('includes git diff and beat logs instructions even with custom evalPrompt', async () => {
      const customPrompt = 'Check for security issues.';
      const sha = 'deadbeef12345678';
      const loop = createTestLoop({ strategy: LoopStrategy.RETRY, evalPrompt: customPrompt });
      const outputRepo = createOutputRepo(['PASS']);
      const loopRepo = createLoopRepo(sha);

      const capturedTasks: Array<{ id: string; prompt: string }> = [];
      const origEmit = eventBus.emit.bind(eventBus);
      vi.spyOn(eventBus, 'emit').mockImplementation(async (type: string, payload: unknown) => {
        if (type === 'TaskDelegated') {
          const task = (payload as { task: { id: string; prompt: string } }).task;
          capturedTasks.push({ id: task.id, prompt: task.prompt });
        }
        return origEmit(type as never, payload as never);
      });

      const evaluator = new AgentExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger);
      const evalPromise = evaluator.evaluate(loop, workTaskId);
      await new Promise((r) => setImmediate(r));
      if (capturedTasks[0]) {
        await simulateEvalTaskComplete(eventBus, capturedTasks[0].id);
      }
      await evalPromise;

      expect(capturedTasks[0].prompt).toContain(`git diff ${sha}..HEAD`);
      expect(capturedTasks[0].prompt).toContain('beat logs');
    });

    it('includes preIterationCommitSha in git diff instruction when available', async () => {
      const sha = 'abc1234567890abcdef';
      const loop = createTestLoop({ strategy: LoopStrategy.RETRY });
      const outputRepo = createOutputRepo(['PASS']);
      const loopRepo = createLoopRepo(sha);

      const capturedTasks: Array<{ id: string; prompt: string }> = [];
      const origEmit = eventBus.emit.bind(eventBus);
      vi.spyOn(eventBus, 'emit').mockImplementation(async (type: string, payload: unknown) => {
        if (type === 'TaskDelegated') {
          const task = (payload as { task: { id: string; prompt: string } }).task;
          capturedTasks.push({ id: task.id, prompt: task.prompt });
        }
        return origEmit(type as never, payload as never);
      });

      const evaluator = new AgentExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger);
      const evalPromise = evaluator.evaluate(loop, workTaskId);
      await new Promise((r) => setImmediate(r));
      if (capturedTasks[0]) {
        await simulateEvalTaskComplete(eventBus, capturedTasks[0].id);
      }
      await evalPromise;

      expect(capturedTasks[0].prompt).toContain(`git diff ${sha}..HEAD`);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Output repository failure
  // ──────────────────────────────────────────────────────────────────────────

  describe('Output repository failures', () => {
    it('returns error when output repository fails', async () => {
      const loop = createTestLoop({ strategy: LoopStrategy.RETRY });
      const outputRepo = {
        get: vi.fn().mockResolvedValue(err(new Error('DB read failed'))),
        save: vi.fn(),
        delete: vi.fn(),
        getByteSize: vi.fn(),
      } as unknown as OutputRepository;
      const loopRepo = createLoopRepo();
      const evaluator = new AgentExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger);

      const result = await evaluateWithCompletion(evaluator, loop, workTaskId, eventBus, (id) =>
        simulateEvalTaskComplete(eventBus, id),
      );
      expect(result.passed).toBe(false);
      expect(result.error).toContain('eval agent output');
    });

    it('returns error when output is null', async () => {
      const loop = createTestLoop({ strategy: LoopStrategy.RETRY });
      const outputRepo = {
        get: vi.fn().mockResolvedValue(ok(null)),
        save: vi.fn(),
        delete: vi.fn(),
        getByteSize: vi.fn(),
      } as unknown as OutputRepository;
      const loopRepo = createLoopRepo();
      const evaluator = new AgentExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger);

      const result = await evaluateWithCompletion(evaluator, loop, workTaskId, eventBus, (id) =>
        simulateEvalTaskComplete(eventBus, id),
      );
      expect(result.passed).toBe(false);
      expect(result.error).toContain('eval agent output');
    });
  });
});
