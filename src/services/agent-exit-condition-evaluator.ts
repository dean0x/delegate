/**
 * Agent-based exit condition evaluator
 * ARCHITECTURE: Spawns a separate Claude Code instance to review iteration quality
 * Pattern: Strategy pattern — implements ExitConditionEvaluator using TaskDelegated events
 * Rationale: Enables code-comprehension-based evaluation that shell commands cannot perform
 */

import type { Loop, TaskId } from '../core/domain.js';
import { createTask, LoopStrategy } from '../core/domain.js';
import { EventBus } from '../core/events/event-bus.js';
import type {
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

export class AgentExitConditionEvaluator implements ExitConditionEvaluator {
  constructor(
    private readonly eventBus: EventBus,
    private readonly outputRepository: OutputRepository,
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

    // Create eval task via pure domain factory
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
    const completionPromise = this.waitForTaskCompletion(evalTaskId, loop.evalTimeout);

    // Emit TaskDelegated — PersistenceHandler persists, WorkerHandler spawns
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

    // Wait for eval task completion
    const completionStatus = await completionPromise;

    if (
      completionStatus.type === 'failed' ||
      completionStatus.type === 'timeout' ||
      completionStatus.type === 'cancelled'
    ) {
      const errorMsg =
        completionStatus.type === 'timeout'
          ? `Eval agent timed out after ${loop.evalTimeout}ms`
          : completionStatus.type === 'cancelled'
            ? 'Eval agent was cancelled'
            : `Eval agent failed: ${completionStatus.error ?? 'unknown error'}`;

      this.logger.warn('Eval task did not complete successfully', {
        loopId: loop.id,
        evalTaskId,
        completionStatus: completionStatus.type,
      });

      return { passed: false, error: errorMsg };
    }

    // Read eval task output
    const outputResult = await this.outputRepository.get(evalTaskId);
    if (!outputResult.ok || !outputResult.value) {
      this.logger.warn('Failed to read eval task output', {
        loopId: loop.id,
        evalTaskId,
        error: outputResult.ok ? 'no output' : outputResult.error.message,
      });
      return { passed: false, error: 'Failed to read eval agent output' };
    }

    const output = outputResult.value;
    const fullText = [...output.stdout, ...output.stderr].join('\n');

    return this.parseEvalOutput(fullText, loop.strategy);
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

    if (loop.strategy === LoopStrategy.RETRY) {
      const userPrompt =
        loop.evalPrompt ??
        `Review the code changes. ${gitDiffInstruction} Use \`beat logs ${taskId}\` to read the worker's output. Output PASS if the changes are acceptable, FAIL if not. The LAST LINE of your response must be exactly PASS or FAIL.`;

      return `You are evaluating the result of an automated code improvement iteration.

Working directory: ${loop.workingDirectory}
Iteration: ${loop.currentIteration}
Task ID: ${taskId}

${userPrompt}`;
    } else {
      // OPTIMIZE strategy
      const userPrompt =
        loop.evalPrompt ??
        `Score the code change quality 0-100. ${gitDiffInstruction} Use \`beat logs ${taskId}\` to read the worker's output. Provide your analysis, then on the LAST LINE output a single numeric score between 0 and 100.`;

      return `You are evaluating and scoring the result of an automated code improvement iteration.

Working directory: ${loop.workingDirectory}
Iteration: ${loop.currentIteration}
Task ID: ${taskId}

${userPrompt}`;
    }
  }

  /**
   * Wait for eval task to reach a terminal state.
   * Uses .unref() on timer to not block process exit.
   */
  private waitForTaskCompletion(
    evalTaskId: TaskId,
    evalTimeout: number,
  ): Promise<{ type: 'completed' } | { type: 'failed'; error?: string } | { type: 'timeout' } | { type: 'cancelled' }> {
    return new Promise((resolve) => {
      const subscriptionIds: string[] = [];
      let resolved = false;

      const cleanup = (): void => {
        for (const subId of subscriptionIds) {
          this.eventBus.unsubscribe(subId);
        }
      };

      const resolveOnce = (
        result:
          | { type: 'completed' }
          | { type: 'failed'; error?: string }
          | { type: 'timeout' }
          | { type: 'cancelled' },
      ): void => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        cleanup();
        resolve(result);
      };

      // Subscribe to all terminal events for this specific task
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

      // Collect subscription IDs for cleanup
      if (completedSub.ok) subscriptionIds.push(completedSub.value);
      if (failedSub.ok) subscriptionIds.push(failedSub.value);
      if (cancelledSub.ok) subscriptionIds.push(cancelledSub.value);
      if (timeoutSub.ok) subscriptionIds.push(timeoutSub.value);

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
   * Everything before the last line is captured as feedback.
   */
  private parseEvalOutput(output: string, strategy: LoopStrategy): EvalResult {
    const lines = output.split('\n').filter((line) => line.trim().length > 0);

    if (lines.length === 0) {
      return { passed: false, error: 'Eval agent produced no output' };
    }

    const lastLine = lines[lines.length - 1].trim();
    // Everything before the last line (if any) as feedback
    const feedbackLines = lines.slice(0, -1);
    const feedback = feedbackLines.length > 0 ? feedbackLines.join('\n') : undefined;

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
