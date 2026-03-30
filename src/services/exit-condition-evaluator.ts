/**
 * Shell-based exit condition evaluator
 * ARCHITECTURE: Extracted from LoopHandler for dependency injection
 * Pattern: Strategy pattern — evaluates loop exit conditions via child_process.exec
 */

import { exec as cpExec } from 'child_process';
import { promisify } from 'util';
import type { Loop } from '../core/domain.js';
import { LoopStrategy, type TaskId } from '../core/domain.js';
import type { EvalResult, ExitConditionEvaluator } from '../core/interfaces.js';

const execAsync = promisify(cpExec);

export class ShellExitConditionEvaluator implements ExitConditionEvaluator {
  /**
   * Evaluate the exit condition for an iteration
   * ARCHITECTURE: Uses child_process.exec (async via promisify) with injected env vars (R11)
   * - Retry strategy: exit code 0 = pass, non-zero = fail
   * - Optimize strategy: parse last non-empty line of stdout as score
   */
  async evaluate(loop: Loop, taskId: TaskId): Promise<EvalResult> {
    if (!loop.exitCondition?.trim()) {
      return { passed: false, error: 'exitCondition cannot be empty in shell eval mode' };
    }

    const env = {
      ...process.env,
      AUTOBEAT_LOOP_ID: loop.id,
      AUTOBEAT_ITERATION: String(loop.currentIteration),
      AUTOBEAT_TASK_ID: taskId,
    };

    try {
      const { stdout } = await execAsync(loop.exitCondition, {
        cwd: loop.workingDirectory,
        timeout: loop.evalTimeout,
        env,
      });

      if (loop.strategy === LoopStrategy.RETRY) {
        // Exit code 0 = pass
        return { passed: true, exitCode: 0 };
      }

      // OPTIMIZE strategy: parse last non-empty line as score (R11)
      const lines = stdout.split('\n').filter((line) => line.trim().length > 0);
      if (lines.length === 0) {
        return { passed: false, error: 'No output from exit condition for optimize strategy' };
      }

      const lastLine = lines[lines.length - 1].trim();
      const score = Number.parseFloat(lastLine);

      if (!Number.isFinite(score)) {
        // NaN or Infinity → crash
        return { passed: false, error: `Invalid score: ${lastLine} (must be a finite number)`, exitCode: 0 };
      }

      return { passed: true, score, exitCode: 0 };
    } catch (execError: unknown) {
      const error = execError as { code?: number; stderr?: string; message?: string };

      if (loop.strategy === LoopStrategy.RETRY) {
        // Non-zero exit or timeout → fail
        return {
          passed: false,
          exitCode: error.code ?? 1,
          error: error.stderr || error.message || 'Exit condition failed',
        };
      }

      // OPTIMIZE strategy: exec failure → crash
      return {
        passed: false,
        error: error.stderr || error.message || 'Exit condition evaluation failed',
        exitCode: error.code,
      };
    }
  }
}
