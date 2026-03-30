/**
 * Agent-based exit condition evaluator
 * ARCHITECTURE: Spawns a separate Claude Code instance to review iteration quality
 * Pattern: Strategy pattern — implements ExitConditionEvaluator using TaskDelegated events
 * Rationale: Enables code-comprehension-based evaluation that shell commands cannot perform
 */

import type { Loop, LoopId, TaskId } from '../core/domain.js';
import { createTask, LoopStrategy } from '../core/domain.js';
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

export class AgentExitConditionEvaluator implements ExitConditionEvaluator {
  constructor(
    private readonly eventBus: EventBus,
    private readonly outputRepo: OutputRepository,
    private readonly loopRepo: LoopRepository,
    private readonly logger: Logger,
  ) {}

  /**
   * Evaluate iteration quality using a dedicated agent task.
   * ARCHITECTURE: Creates eval task via TaskDelegated event (not direct DB write).
   * Eval tasks are NOT registered in LoopHandler.taskToLoop — LoopHandler ignores them.
   */
  async evaluate(loop: Loop, taskId: TaskId): Promise<EvalResult> {
    const prompt = await this.buildEvalPrompt(loop, taskId);

    const evalTask = createTask({
      prompt: `[EVAL] ${prompt}`,
      priority: loop.taskTemplate.priority,
      workingDirectory: loop.workingDirectory,
      agent: loop.taskTemplate.agent,
    });

    const evalTaskId = evalTask.id;

    this.logger.info('Starting agent eval task', {
      loopId: loop.id,
      evalTaskId,
      strategy: loop.strategy,
      workTaskId: taskId,
    });

    // Set up completion listener BEFORE emitting to prevent race conditions
    const completionPromise = this.waitForTaskCompletion(evalTaskId, loop.evalTimeout, loop.id);

    const emitResult = await this.eventBus.emit('TaskDelegated', { task: evalTask });
    if (!emitResult.ok) {
      this.logger.error('Failed to emit TaskDelegated for eval task', emitResult.error, {
        loopId: loop.id,
        evalTaskId,
      });
      return {
        passed: false,
        error: `Failed to spawn eval agent: ${emitResult.error.message}`,
      };
    }

    const completionStatus = await completionPromise;

    if (completionStatus.type !== 'completed') {
      let errorMsg: string;
      switch (completionStatus.type) {
        case 'timeout':
          errorMsg = `Eval agent timed out after ${loop.evalTimeout}ms`;
          break;
        case 'cancelled':
          errorMsg = 'Eval agent was cancelled';
          break;
        case 'failed':
          errorMsg = `Eval agent failed: ${completionStatus.error ?? 'unknown error'}`;
          break;
      }

      this.logger.warn('Eval task did not complete successfully', {
        loopId: loop.id,
        evalTaskId,
        completionStatus: completionStatus.type,
      });

      return { passed: false, error: errorMsg };
    }

    const outputResult = await this.outputRepo.get(evalTaskId);
    if (!outputResult.ok || !outputResult.value) {
      this.logger.warn('Failed to read eval task output', {
        loopId: loop.id,
        evalTaskId,
        error: outputResult.ok ? 'no output' : outputResult.error.message,
      });
      return { passed: false, error: 'Failed to read eval agent output' };
    }

    const output = outputResult.value;
    const lines = [...output.stdout, ...output.stderr];

    return this.parseEvalOutput(lines, loop.strategy);
  }

  /**
   * Build the evaluation prompt for the agent.
   * Provides git diff commands and instructions without pre-injecting content.
   */
  private async buildEvalPrompt(loop: Loop, taskId: TaskId): Promise<string> {
    // Look up preIterationCommitSha from iteration record
    let preIterationCommitSha: string | undefined;
    const iterationResult = await this.loopRepo.findIterationByTaskId(taskId);
    if (iterationResult.ok && iterationResult.value) {
      preIterationCommitSha = iterationResult.value.preIterationCommitSha;
    }

    const gitDiffInstruction = preIterationCommitSha
      ? `Use \`git diff ${preIterationCommitSha}..HEAD\` to see what changed in this iteration.`
      : 'Use `git diff HEAD~1..HEAD` to see what changed in this iteration.';

    const isRetry = loop.strategy === LoopStrategy.RETRY;
    const header = isRetry
      ? 'You are evaluating the result of an automated code improvement iteration.'
      : 'You are evaluating and scoring the result of an automated code improvement iteration.';

    const toolInstructions = `${gitDiffInstruction} Use \`beat logs ${taskId}\` to read the worker's output.`;

    const criteria =
      loop.evalPrompt ??
      (isRetry
        ? 'Review the code changes. Output PASS if the changes are acceptable, FAIL if not.'
        : 'Score the code change quality 0-100. Provide your analysis.');

    const formatDirective = isRetry
      ? 'The LAST LINE of your response must be exactly PASS or FAIL.'
      : 'On the LAST LINE output a single numeric score between 0 and 100.';

    return `${header}

IMPORTANT: Do NOT modify any files. You are an evaluator — read and assess only.

Working directory: ${loop.workingDirectory}
Iteration: ${loop.currentIteration}
Task ID: ${taskId}

${toolInstructions}

${criteria}

${formatDirective}`;
  }

  /**
   * Wait for eval task to reach a terminal state.
   * Subscribes to LoopCancelled so that if the parent loop is cancelled while this
   * eval is in-flight, the eval task gets a TaskCancellationRequested immediately
   * rather than running until evalTimeout as an orphan consuming a worker slot.
   * Uses .unref() on timer to not block process exit.
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
      // The eval task is not tracked in LoopHandler.taskToLoop by design, so
      // handleLoopCancelled cannot reach it. We detect the cancellation here
      // and emit TaskCancellationRequested to free the worker slot immediately.
      const loopCancelledSub = this.eventBus.subscribe<LoopCancelledEvent>('LoopCancelled', async (event) => {
        if (event.loopId !== loopId) return;
        this.logger.info('Loop cancelled while eval task running — cancelling eval task', {
          loopId,
          evalTaskId,
        });
        await this.eventBus.emit('TaskCancellationRequested', {
          taskId: evalTaskId,
          reason: `Loop ${loopId} cancelled`,
        });
        // resolveOnce will fire once TaskCancelled arrives for evalTaskId above.
        // Do not resolve here to avoid double-resolve ordering issues.
      });

      if (completedSub.ok) subscriptionIds.push(completedSub.value);
      if (failedSub.ok) subscriptionIds.push(failedSub.value);
      if (cancelledSub.ok) subscriptionIds.push(cancelledSub.value);
      if (timeoutSub.ok) subscriptionIds.push(timeoutSub.value);
      if (loopCancelledSub.ok) subscriptionIds.push(loopCancelledSub.value);

      // Fallback timer: evalTimeout + 5000ms grace period
      const timer = setTimeout(() => {
        this.logger.warn('Eval task completion timed out by fallback timer', {
          evalTaskId,
          evalTimeout,
        });
        resolveOnce({ type: 'timeout' });
      }, evalTimeout + 5000);

      // Don't block process exit
      timer.unref();
    });
  }

  /**
   * Parse eval agent output into EvalResult.
   * For retry: last non-empty line must be PASS or FAIL.
   * For optimize: last non-empty line must be a finite number.
   * Everything before the last line is captured as feedback, capped at MAX_FEEDBACK_LENGTH.
   */
  private parseEvalOutput(rawLines: string[], strategy: LoopStrategy): EvalResult {
    const lines = rawLines.filter((line) => line.trim().length > 0);

    if (lines.length === 0) {
      return { passed: false, error: 'Eval agent produced no output' };
    }

    const lastLine = lines[lines.length - 1].trim();
    // Everything before the last line (if any) as feedback
    const feedbackLines = lines.slice(0, -1);
    let feedback: string | undefined;
    if (feedbackLines.length > 0) {
      const joined = feedbackLines.join('\n');
      feedback = joined.length > MAX_FEEDBACK_LENGTH ? joined.slice(0, MAX_FEEDBACK_LENGTH) : joined;
    }

    if (strategy === LoopStrategy.RETRY) {
      if (lastLine === 'PASS') {
        return { passed: true, feedback };
      }
      if (lastLine === 'FAIL') {
        return { passed: false, feedback };
      }
      return {
        passed: false,
        error: `Eval agent output did not end with PASS or FAIL (got: "${lastLine}")`,
        feedback,
      };
    }

    // OPTIMIZE strategy: parse last line as numeric score
    const score = Number.parseFloat(lastLine);
    if (!Number.isFinite(score)) {
      return {
        passed: false,
        error: `Eval agent output did not end with a numeric score (got: "${lastLine}")`,
        feedback,
      };
    }

    return { passed: true, score, feedback };
  }
}
