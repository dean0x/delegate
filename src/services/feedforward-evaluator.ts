/**
 * Feedforward exit condition evaluator
 *
 * ARCHITECTURE: Feedforward evaluator — findings only, no decision.
 * Why: default evalType that works with any agent. Loop continues until maxIterations.
 * consecutiveFailures is bypassed via decision: 'continue' so the loop counter never
 * increments for a quality-gate failure — this evaluator is purely informational.
 *
 * Pattern: Strategy pattern — implements ExitConditionEvaluator
 * Rationale: Enables prompt-level feedback gathering without gating iteration continuation.
 *             Useful when the exit strategy is time/iteration-based, not quality-based.
 */

import type { Loop, LoopId, TaskId } from '../core/domain.js';
import { createTask, TaskRequest } from '../core/domain.js';
import { EventBus } from '../core/events/event-bus.js';
import type {
  LoopCancelledEvent,
  TaskCancelledEvent,
  TaskCompletedEvent,
  TaskFailedEvent,
  TaskTimeoutEvent,
} from '../core/events/events.js';
import type {
  EvalResult,
  ExitConditionEvaluator,
  Logger,
  LoopRepository,
  OutputRepository,
} from '../core/interfaces.js';

type TaskCompletionStatus =
  | { type: 'completed' }
  | { type: 'failed'; error?: string }
  | { type: 'timeout' }
  | { type: 'cancelled' };

const MAX_FEEDBACK_LENGTH = 16_000;

export class FeedforwardEvaluator implements ExitConditionEvaluator {
  constructor(
    private readonly eventBus: EventBus,
    private readonly outputRepo: OutputRepository,
    private readonly loopRepo: LoopRepository,
    private readonly logger: Logger,
  ) {}

  /**
   * Evaluate iteration quality using findings-only mode.
   *
   * DECISION: Always returns decision: 'continue'.
   * Why: feedforward is informational — it gathers findings without making a stop/go
   * decision. The loop handler checks decision BEFORE passed, so this bypasses
   * consecutiveFailures increment. Loop control is purely maxIterations-based.
   *
   * If evalPrompt is configured: spawns an eval agent to generate findings (feedback).
   * If no evalPrompt: returns immediately with no feedback — pure pass-through.
   */
  async evaluate(loop: Loop, taskId: TaskId): Promise<EvalResult> {
    if (!loop.evalPrompt) {
      // No eval prompt configured — pure feedforward, no findings
      return { passed: false, decision: 'continue', feedback: undefined };
    }

    // Run eval agent for findings only (no decision extraction needed)
    const findings = await this.runEvalAgent(loop, taskId);
    return { passed: false, decision: 'continue', feedback: findings ?? undefined };
  }

  /**
   * Spawn an eval agent to generate findings.
   * ARCHITECTURE: Reuses the same TaskDelegated event pattern as AgentExitConditionEvaluator.
   * Does NOT use jsonSchema — feedforward doesn't need structured output since we only
   * capture the full output as feedback text.
   */
  private async runEvalAgent(loop: Loop, taskId: TaskId): Promise<string | null> {
    const prompt = await this.buildFindingsPrompt(loop, taskId);

    // Feedforward never injects jsonSchema — we want the full narrative output as findings
    const evalTaskRequest: TaskRequest = {
      prompt: `[EVAL-FEEDFORWARD] ${prompt}`,
      priority: loop.taskTemplate.priority,
      workingDirectory: loop.workingDirectory,
      agent: loop.taskTemplate.agent,
      jsonSchema: undefined,
    };
    const evalTask = createTask(evalTaskRequest);
    const evalTaskId = evalTask.id;

    this.logger.info('Starting feedforward eval task', {
      loopId: loop.id,
      evalTaskId,
      workTaskId: taskId,
    });

    // Set up completion listener BEFORE emitting to prevent race conditions
    const completionPromise = this.waitForTaskCompletion(evalTaskId, loop.evalTimeout, loop.id);

    const emitResult = await this.eventBus.emit('TaskDelegated', { task: evalTask });
    if (!emitResult.ok) {
      this.logger.error('Failed to emit TaskDelegated for feedforward eval task', emitResult.error, {
        loopId: loop.id,
        evalTaskId,
      });
      return null;
    }

    const completionStatus = await completionPromise;

    if (completionStatus.type !== 'completed') {
      this.logger.warn('Feedforward eval task did not complete successfully', {
        loopId: loop.id,
        evalTaskId,
        completionStatus: completionStatus.type,
      });
      return null;
    }

    const outputResult = await this.outputRepo.get(evalTaskId);
    if (!outputResult.ok || !outputResult.value) {
      this.logger.warn('Failed to read feedforward eval task output', {
        loopId: loop.id,
        evalTaskId,
        error: outputResult.ok ? 'no output' : outputResult.error.message,
      });
      return null;
    }

    const output = outputResult.value;
    const allLines = [...output.stdout, ...output.stderr].filter((l) => l.trim().length > 0);
    if (allLines.length === 0) return null;

    const joined = allLines.join('\n');
    return joined.length > MAX_FEEDBACK_LENGTH ? joined.slice(0, MAX_FEEDBACK_LENGTH) : joined;
  }

  /**
   * Build the findings prompt for the feedforward eval agent.
   * Instructs the agent to report findings without making a pass/fail decision.
   */
  private async buildFindingsPrompt(loop: Loop, taskId: TaskId): Promise<string> {
    let preIterationCommitSha: string | undefined;
    const iterationResult = await this.loopRepo.findIterationByTaskId(taskId);
    if (iterationResult.ok && iterationResult.value) {
      preIterationCommitSha = iterationResult.value.preIterationCommitSha;
    }

    const gitDiffInstruction = preIterationCommitSha
      ? `Use \`git diff ${preIterationCommitSha}..HEAD\` to see what changed in this iteration.`
      : 'Use `git diff HEAD~1..HEAD` to see what changed in this iteration.';

    const toolInstructions = `${gitDiffInstruction} Use \`beat logs ${taskId}\` to read the worker's output.`;

    const criteria = loop.evalPrompt ?? 'Review the code changes and provide your observations and findings.';

    return `You are reviewing the result of an automated code improvement iteration.
Provide observations and findings only — do NOT make a pass/fail decision.

IMPORTANT: Do NOT modify any files. You are a reviewer — read and assess only.

Working directory: ${loop.workingDirectory}
Iteration: ${loop.currentIteration}
Task ID: ${taskId}

${toolInstructions}

${criteria}

Provide your detailed findings. There is no special format required — write naturally.`;
  }

  /**
   * Wait for eval task to reach a terminal state.
   * ARCHITECTURE: Same pattern as AgentExitConditionEvaluator.waitForTaskCompletion.
   * Cancels orphaned eval task if parent loop is cancelled.
   */
  private waitForTaskCompletion(
    evalTaskId: TaskId,
    evalTimeout: number,
    loopId: LoopId,
  ): Promise<TaskCompletionStatus> {
    return new Promise((resolve) => {
      const subscriptionIds: string[] = [];
      let resolved = false;

      const cleanup = (): void => {
        for (const subId of subscriptionIds) {
          this.eventBus.unsubscribe(subId);
        }
      };

      const resolveOnce = (result: TaskCompletionStatus): void => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        cleanup();
        resolve(result);
      };

      const completedSub = this.eventBus.subscribe<TaskCompletedEvent>('TaskCompleted', async (event) => {
        if (event.taskId === evalTaskId) {
          resolveOnce({ type: 'completed' });
        }
      });

      const failedSub = this.eventBus.subscribe<TaskFailedEvent>('TaskFailed', async (event) => {
        if (event.taskId === evalTaskId) {
          resolveOnce({ type: 'failed', error: event.error?.message });
        }
      });

      const cancelledSub = this.eventBus.subscribe<TaskCancelledEvent>('TaskCancelled', async (event) => {
        if (event.taskId === evalTaskId) {
          resolveOnce({ type: 'cancelled' });
        }
      });

      const timeoutSub = this.eventBus.subscribe<TaskTimeoutEvent>('TaskTimeout', async (event) => {
        if (event.taskId === evalTaskId) {
          resolveOnce({ type: 'timeout' });
        }
      });

      // Cancel the orphaned eval task when the parent loop is cancelled.
      const loopCancelledSub = this.eventBus.subscribe<LoopCancelledEvent>('LoopCancelled', async (event) => {
        if (event.loopId !== loopId) return;
        this.logger.info('Loop cancelled while feedforward eval task running — cancelling eval task', {
          loopId,
          evalTaskId,
        });
        await this.eventBus.emit('TaskCancellationRequested', {
          taskId: evalTaskId,
          reason: `Loop ${loopId} cancelled`,
        });
      });

      if (completedSub.ok) subscriptionIds.push(completedSub.value);
      if (failedSub.ok) subscriptionIds.push(failedSub.value);
      if (cancelledSub.ok) subscriptionIds.push(cancelledSub.value);
      if (timeoutSub.ok) subscriptionIds.push(timeoutSub.value);
      if (loopCancelledSub.ok) subscriptionIds.push(loopCancelledSub.value);

      // Fallback timer: evalTimeout + 5000ms grace period
      const timer = setTimeout(() => {
        this.logger.warn('Feedforward eval task completion timed out by fallback timer', {
          evalTaskId,
          evalTimeout,
        });
        resolveOnce({ type: 'timeout' });
      }, evalTimeout + 5000);

      // Don't block process exit
      timer.unref();
    });
  }
}
