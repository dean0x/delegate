/**
 * Unit tests for ShellExitConditionEvaluator
 * ARCHITECTURE: Tests the shell exec evaluator with mocked child_process
 * Pattern: Behavior-driven testing — verifies pass/fail, score parsing, env injection
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Loop } from '../../../src/core/domain.js';
import { createLoop, LoopStrategy, OptimizeDirection, TaskId } from '../../../src/core/domain.js';

// Mock child_process.exec
vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

import { exec } from 'child_process';
import { ShellExitConditionEvaluator } from '../../../src/services/exit-condition-evaluator.js';

/**
 * Helper: mock async exec (via promisify) to succeed with given stdout
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

function createTestLoop(overrides: Partial<Parameters<typeof createLoop>[0]> = {}): Loop {
  return createLoop(
    {
      prompt: 'test prompt',
      strategy: LoopStrategy.RETRY,
      exitCondition: 'test -f /tmp/done',
      maxIterations: 10,
      evalTimeout: 60000,
      ...overrides,
    },
    '/tmp',
  );
}

describe('ShellExitConditionEvaluator', () => {
  const evaluator = new ShellExitConditionEvaluator();
  const taskId = TaskId('task-test-123');

  beforeEach(() => {
    vi.mocked(exec).mockReset();
  });

  describe('Retry strategy', () => {
    it('should return passed=true when exit code is 0', async () => {
      mockExecSuccess('success\n');

      const loop = createTestLoop({ strategy: LoopStrategy.RETRY });
      const result = await evaluator.evaluate(loop, taskId);

      expect(result.passed).toBe(true);
      expect(result.exitCode).toBe(0);
    });

    it('should return passed=false when exit code is non-zero', async () => {
      mockExecFailure(1, 'test failed');

      const loop = createTestLoop({ strategy: LoopStrategy.RETRY });
      const result = await evaluator.evaluate(loop, taskId);

      expect(result.passed).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.error).toBe('test failed');
    });
  });

  describe('Optimize strategy', () => {
    it('should parse score from last non-empty line of stdout', async () => {
      mockExecSuccess('some output\n42.5\n');

      const loop = createTestLoop({
        strategy: LoopStrategy.OPTIMIZE,
        evalDirection: OptimizeDirection.MAXIMIZE,
      });
      const result = await evaluator.evaluate(loop, taskId);

      expect(result.passed).toBe(true);
      expect(result.score).toBe(42.5);
      expect(result.exitCode).toBe(0);
    });

    it('should return error for NaN score', async () => {
      mockExecSuccess('not-a-number\n');

      const loop = createTestLoop({
        strategy: LoopStrategy.OPTIMIZE,
        evalDirection: OptimizeDirection.MAXIMIZE,
      });
      const result = await evaluator.evaluate(loop, taskId);

      expect(result.passed).toBe(false);
      expect(result.error).toContain('Invalid score');
    });

    it('should return error for empty output', async () => {
      mockExecSuccess('');

      const loop = createTestLoop({
        strategy: LoopStrategy.OPTIMIZE,
        evalDirection: OptimizeDirection.MAXIMIZE,
      });
      const result = await evaluator.evaluate(loop, taskId);

      expect(result.passed).toBe(false);
      expect(result.error).toContain('No output');
    });

    it('should return error when exec fails in optimize mode', async () => {
      mockExecFailure(1, 'script error');

      const loop = createTestLoop({
        strategy: LoopStrategy.OPTIMIZE,
        evalDirection: OptimizeDirection.MAXIMIZE,
      });
      const result = await evaluator.evaluate(loop, taskId);

      expect(result.passed).toBe(false);
      expect(result.error).toBe('script error');
    });
  });

  describe('Empty exitCondition guard', () => {
    it('should return error when exitCondition is empty', async () => {
      const loop = createTestLoop({ exitCondition: '' });
      const result = await evaluator.evaluate(loop, taskId);

      expect(result.passed).toBe(false);
      expect(result.error).toContain('exitCondition cannot be empty');
      expect(exec).not.toHaveBeenCalled();
    });

    it('should return error when exitCondition is whitespace-only', async () => {
      const loop = createTestLoop({ exitCondition: '   \n\t  ' });
      const result = await evaluator.evaluate(loop, taskId);

      expect(result.passed).toBe(false);
      expect(result.error).toContain('exitCondition cannot be empty');
      expect(exec).not.toHaveBeenCalled();
    });
  });

  describe('Environment variable injection (R11)', () => {
    it('should inject AUTOBEAT_LOOP_ID, AUTOBEAT_ITERATION, AUTOBEAT_TASK_ID', async () => {
      mockExecSuccess('ok\n');

      const loop = createTestLoop({ strategy: LoopStrategy.RETRY });
      await evaluator.evaluate(loop, taskId);

      expect(exec).toHaveBeenCalled();
      const callArgs = vi.mocked(exec).mock.calls[0];
      const options = callArgs[1] as Record<string, unknown>;
      const env = options.env as Record<string, string>;

      expect(env.AUTOBEAT_LOOP_ID).toBe(loop.id);
      expect(env.AUTOBEAT_ITERATION).toBeDefined();
      expect(env.AUTOBEAT_TASK_ID).toBe(taskId);
    });

    it('should use loop workingDirectory as cwd', async () => {
      mockExecSuccess('ok\n');

      const loop = createTestLoop({ strategy: LoopStrategy.RETRY });
      await evaluator.evaluate(loop, taskId);

      const callArgs = vi.mocked(exec).mock.calls[0];
      const options = callArgs[1] as Record<string, unknown>;
      expect(options.cwd).toBe(loop.workingDirectory);
    });

    it('should use loop evalTimeout as timeout', async () => {
      mockExecSuccess('ok\n');

      const loop = createTestLoop({ strategy: LoopStrategy.RETRY, evalTimeout: 30000 });
      await evaluator.evaluate(loop, taskId);

      const callArgs = vi.mocked(exec).mock.calls[0];
      const options = callArgs[1] as Record<string, unknown>;
      expect(options.timeout).toBe(30000);
    });
  });
});
