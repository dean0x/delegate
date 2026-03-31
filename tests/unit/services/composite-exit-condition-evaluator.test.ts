/**
 * Unit tests for CompositeExitConditionEvaluator
 * ARCHITECTURE: Tests dispatcher routing — shell mode → shellEvaluator, agent mode → agentEvaluator
 * Pattern: Behavioral testing — verifies correct delegation based on loop.evalMode
 */

import { describe, expect, it, vi } from 'vitest';
import type { Loop } from '../../../src/core/domain.js';
import { createLoop, LoopStrategy, TaskId } from '../../../src/core/domain.js';
import type { EvalResult, ExitConditionEvaluator } from '../../../src/core/interfaces.js';
import { CompositeExitConditionEvaluator } from '../../../src/services/composite-exit-condition-evaluator.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function createMockEvaluator(result: EvalResult): ExitConditionEvaluator {
  return { evaluate: vi.fn().mockResolvedValue(result) };
}

function createTestLoop(evalMode: 'shell' | 'agent'): Loop {
  return createLoop(
    {
      prompt: 'test task',
      strategy: LoopStrategy.RETRY,
      exitCondition: evalMode === 'shell' ? 'npm test' : '',
      evalMode,
      maxIterations: 3,
      evalTimeout: 30000,
    },
    '/workspace',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('CompositeExitConditionEvaluator', () => {
  const taskId = TaskId('task-abc');

  describe('Routing by evalMode', () => {
    it('delegates to shellEvaluator when evalMode is shell', async () => {
      const shellResult: EvalResult = { passed: true, exitCode: 0 };
      const agentResult: EvalResult = { passed: false, error: 'should not be called' };

      const shellEvaluator = createMockEvaluator(shellResult);
      const agentEvaluator = createMockEvaluator(agentResult);
      const composite = new CompositeExitConditionEvaluator(shellEvaluator, agentEvaluator);

      const loop = createTestLoop('shell');
      const result = await composite.evaluate(loop, taskId);

      expect(result).toEqual(shellResult);
      expect(shellEvaluator.evaluate).toHaveBeenCalledOnce();
      expect(shellEvaluator.evaluate).toHaveBeenCalledWith(loop, taskId);
      expect(agentEvaluator.evaluate).not.toHaveBeenCalled();
    });

    it('delegates to agentEvaluator when evalMode is agent', async () => {
      const shellResult: EvalResult = { passed: false, error: 'should not be called' };
      const agentResult: EvalResult = { passed: true, feedback: 'Code looks clean.' };

      const shellEvaluator = createMockEvaluator(shellResult);
      const agentEvaluator = createMockEvaluator(agentResult);
      const composite = new CompositeExitConditionEvaluator(shellEvaluator, agentEvaluator);

      const loop = createTestLoop('agent');
      const result = await composite.evaluate(loop, taskId);

      expect(result).toEqual(agentResult);
      expect(agentEvaluator.evaluate).toHaveBeenCalledOnce();
      expect(agentEvaluator.evaluate).toHaveBeenCalledWith(loop, taskId);
      expect(shellEvaluator.evaluate).not.toHaveBeenCalled();
    });
  });

  describe('Return value passthrough', () => {
    it('passes shell evaluator result through unchanged', async () => {
      const shellResult: EvalResult = { passed: false, exitCode: 1, error: 'test failed' };
      const shellEvaluator = createMockEvaluator(shellResult);
      const agentEvaluator = createMockEvaluator({ passed: true });
      const composite = new CompositeExitConditionEvaluator(shellEvaluator, agentEvaluator);

      const loop = createTestLoop('shell');
      const result = await composite.evaluate(loop, taskId);

      expect(result.passed).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.error).toBe('test failed');
    });

    it('passes agent evaluator result through unchanged', async () => {
      const agentResult: EvalResult = { passed: true, score: 92, feedback: 'Excellent work.' };
      const shellEvaluator = createMockEvaluator({ passed: false });
      const agentEvaluator = createMockEvaluator(agentResult);
      const composite = new CompositeExitConditionEvaluator(shellEvaluator, agentEvaluator);

      const loop = createTestLoop('agent');
      const result = await composite.evaluate(loop, taskId);

      expect(result.passed).toBe(true);
      expect(result.score).toBe(92);
      expect(result.feedback).toBe('Excellent work.');
    });
  });
});
