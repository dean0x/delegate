/**
 * Composite exit condition evaluator
 * ARCHITECTURE: Dispatcher that routes to shell or agent evaluator based on loop.evalMode
 * Pattern: Composite pattern — transparent to callers, implements ExitConditionEvaluator
 */

import type { Loop, TaskId } from '../core/domain.js';
import { EvalMode } from '../core/domain.js';
import type { EvalResult, ExitConditionEvaluator } from '../core/interfaces.js';

export class CompositeExitConditionEvaluator implements ExitConditionEvaluator {
  constructor(
    private readonly shellEvaluator: ExitConditionEvaluator,
    private readonly agentEvaluator: ExitConditionEvaluator,
  ) {}

  async evaluate(loop: Loop, taskId: TaskId): Promise<EvalResult> {
    switch (loop.evalMode) {
      case EvalMode.AGENT:
        return this.agentEvaluator.evaluate(loop, taskId);
      case EvalMode.SHELL:
        return this.shellEvaluator.evaluate(loop, taskId);
      default: {
        const _exhaustive: never = loop.evalMode;
        throw new Error(`Unhandled evalMode: ${_exhaustive}`);
      }
    }
  }
}
