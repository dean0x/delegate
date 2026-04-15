/**
 * Shared eval prompt builder for exit condition evaluators (#140)
 *
 * ARCHITECTURE: Builds shared prompt sections used by all 3 evaluator types
 * (AgentExitConditionEvaluator, FeedforwardEvaluator, JudgeExitConditionEvaluator).
 * Each evaluator composes these with its own strategy-specific header, criteria,
 * and format directive.
 *
 * DECISION: Module-level pure function (not a class method) to avoid coupling
 * evaluators to a shared base class. The three evaluators have different constructor
 * signatures and responsibilities — a shared function is the minimal coupling surface.
 */

import type { Loop, TaskId } from '../core/domain.js';
import type { LoopRepository } from '../core/interfaces.js';

/** Maximum feedback string length captured from eval agent output across all evaluators. */
export const MAX_EVAL_FEEDBACK_LENGTH = 16_000;

/**
 * Shared prompt sections built from loop context and iteration git state.
 *
 * All evaluators compose these with their own strategy-specific content:
 * - contextHeader: "IMPORTANT: Do NOT modify files..." + working dir + iteration + task ID
 * - toolInstructions: git diff command + `beat logs <taskId>` (byte-identical across all 3 evaluators)
 *
 * Note: gitDiffInstructions is an internal intermediate used to compose toolInstructions;
 * it is not exposed on the interface since no caller reads it directly.
 */
export interface EvalPromptBase {
  readonly contextHeader: string;
  readonly toolInstructions: string;
}

/**
 * Build shared prompt sections used by all exit condition evaluator types.
 *
 * Fetches preIterationCommitSha from the iteration record to produce the most
 * accurate git diff command. Falls back to HEAD~1 if no iteration record exists
 * (e.g., first iteration or non-git workspace).
 *
 * @param loop - The loop being evaluated
 * @param taskId - The work task ID (used in toolInstructions and contextHeader)
 * @param loopRepo - Repository to fetch preIterationCommitSha from
 */
export async function buildEvalPromptBase(
  loop: Loop,
  taskId: TaskId,
  loopRepo: LoopRepository,
): Promise<EvalPromptBase> {
  let preIterationCommitSha: string | undefined;
  const iterationResult = await loopRepo.findIterationByTaskId(taskId);
  if (iterationResult.ok && iterationResult.value) {
    preIterationCommitSha = iterationResult.value.preIterationCommitSha;
  }

  const gitDiffInstructions = preIterationCommitSha
    ? `Use \`git diff ${preIterationCommitSha}..HEAD\` to see what changed in this iteration.`
    : 'Use `git diff HEAD~1..HEAD` to see what changed in this iteration.';

  const toolInstructions = `${gitDiffInstructions} Use \`beat logs ${taskId}\` to read the worker's output.`;

  const contextHeader = `IMPORTANT: Do NOT modify any files. You are an evaluator — read and assess only.

Working directory: ${loop.workingDirectory}
Iteration: ${loop.currentIteration}
Task ID: ${taskId}`;

  return { contextHeader, toolInstructions };
}
