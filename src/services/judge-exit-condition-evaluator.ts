/**
 * Judge exit condition evaluator
 *
 * ARCHITECTURE: Two-phase eval+judge strategy.
 * Phase 1 — Eval agent: runs with evalPrompt to produce findings.
 * Phase 2 — Judge agent: reads findings and writes a decision file.
 *
 * DECISION: Judge writes decision to .autobeat-judge file.
 * Why: file creation is the most reliable cross-agent mechanism — all coding agents
 * can write files. stdout parsing is fragile because agents may emit logs, progress
 * messages, or other non-decision output.
 *
 * DECISION: Belt-and-suspenders for Claude judge.
 * If judgeAgent is 'claude', also inject --json-schema so structured output is
 * attempted. If both fail (file missing + structured parse error), default to 'continue'
 * (safe fallback — never block unexpectedly).
 *
 * Pattern: Strategy pattern — implements ExitConditionEvaluator
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
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

/** File written by the judge agent in the working directory */
const JUDGE_DECISION_FILE = '.autobeat-judge';

const MAX_FEEDBACK_LENGTH = 16_000;

/**
 * JSON schema for Claude judge structured output.
 * Belt-and-suspenders: file-based decision is primary, this is secondary.
 */
const JUDGE_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    continue: { type: 'boolean' },
    reasoning: { type: 'string' },
  },
  required: ['continue', 'reasoning'],
});

export class JudgeExitConditionEvaluator implements ExitConditionEvaluator {
  constructor(
    private readonly eventBus: EventBus,
    private readonly outputRepo: OutputRepository,
    private readonly loopRepo: LoopRepository,
    private readonly logger: Logger,
  ) {}

  /**
   * Evaluate iteration quality using two-phase eval+judge strategy.
   *
   * Phase 1: Eval agent runs evalPrompt → produces findings text.
   * Phase 2: Judge agent reads findings → writes .autobeat-judge with decision.
   * Decision extraction: file-based first, then structured output (Claude only), then default continue.
   */
  async evaluate(loop: Loop, taskId: TaskId): Promise<EvalResult> {
    // Phase 1: Gather findings via eval agent
    const findings = await this.runEvalAgent(loop, taskId);

    // Phase 2: Run judge agent with findings
    const judgeDecision = await this.runJudgeAgent(loop, findings ?? '');

    return {
      passed: false,
      decision: judgeDecision.continue ? 'continue' : 'stop',
      feedback: findings ?? undefined,
      evalResponse: JSON.stringify({
        judgeDecision: { continue: judgeDecision.continue, reasoning: judgeDecision.reasoning },
        evalFindings: findings,
      }),
    };
  }

  /**
   * Run the eval agent to generate findings.
   * ARCHITECTURE: Same pattern as AgentExitConditionEvaluator — TaskDelegated event,
   * waitForTaskCompletion, then read output. No jsonSchema — we want raw narrative findings.
   */
  private async runEvalAgent(loop: Loop, taskId: TaskId): Promise<string | null> {
    const prompt = await this.buildEvalPrompt(loop, taskId);

    const evalTaskRequest: TaskRequest = {
      prompt: `[EVAL] ${prompt}`,
      priority: loop.taskTemplate.priority,
      workingDirectory: loop.workingDirectory,
      agent: loop.taskTemplate.agent,
      jsonSchema: undefined,
    };
    const evalTask = createTask(evalTaskRequest);
    const evalTaskId = evalTask.id;

    this.logger.info('Starting judge eval task (phase 1)', {
      loopId: loop.id,
      evalTaskId,
      workTaskId: taskId,
    });

    const completionPromise = this.waitForTaskCompletion(evalTaskId, loop.evalTimeout, loop.id);

    const emitResult = await this.eventBus.emit('TaskDelegated', { task: evalTask });
    if (!emitResult.ok) {
      this.logger.error('Failed to emit TaskDelegated for judge eval task', emitResult.error, {
        loopId: loop.id,
        evalTaskId,
      });
      return null;
    }

    const completionStatus = await completionPromise;
    if (completionStatus.type !== 'completed') {
      this.logger.warn('Judge eval task (phase 1) did not complete successfully', {
        loopId: loop.id,
        evalTaskId,
        completionStatus: completionStatus.type,
      });
      return null;
    }

    const outputResult = await this.outputRepo.get(evalTaskId);
    if (!outputResult.ok || !outputResult.value) {
      this.logger.warn('Failed to read judge eval task output', {
        loopId: loop.id,
        evalTaskId,
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
   * Run the judge agent to produce a decision.
   * Uses belt-and-suspenders: --json-schema for Claude, file-based for all agents.
   * Safe fallback: if both mechanisms fail, defaults to continue=true.
   */
  private async runJudgeAgent(loop: Loop, findings: string): Promise<{ continue: boolean; reasoning: string }> {
    const judgeAgent = loop.judgeAgent ?? loop.taskTemplate.agent;
    const judgePromptText = this.buildJudgePrompt(loop, findings);

    // Use jsonSchema only for Claude — other agents don't support structured output
    const jsonSchema = judgeAgent === 'claude' ? JUDGE_SCHEMA : undefined;

    const judgeTaskRequest: TaskRequest = {
      prompt: `[JUDGE] ${judgePromptText}`,
      priority: loop.taskTemplate.priority,
      workingDirectory: loop.workingDirectory,
      agent: judgeAgent,
      jsonSchema,
    };
    const judgeTask = createTask(judgeTaskRequest);
    const judgeTaskId = judgeTask.id;

    this.logger.info('Starting judge decision task (phase 2)', {
      loopId: loop.id,
      judgeTaskId,
      judgeAgent,
    });

    // Clean up any stale decision file before the judge runs
    const decisionFilePath = path.join(loop.workingDirectory, JUDGE_DECISION_FILE);
    await this.cleanupDecisionFile(decisionFilePath);

    const completionPromise = this.waitForTaskCompletion(judgeTaskId, loop.evalTimeout, loop.id);

    const emitResult = await this.eventBus.emit('TaskDelegated', { task: judgeTask });
    if (!emitResult.ok) {
      this.logger.error('Failed to emit TaskDelegated for judge decision task', emitResult.error, {
        loopId: loop.id,
        judgeTaskId,
      });
      // Safe fallback — never block on emission failure
      return { continue: true, reasoning: 'Judge task emission failed — defaulting to continue' };
    }

    const completionStatus = await completionPromise;
    if (completionStatus.type !== 'completed') {
      this.logger.warn('Judge decision task (phase 2) did not complete successfully', {
        loopId: loop.id,
        judgeTaskId,
        completionStatus: completionStatus.type,
      });
      return { continue: true, reasoning: `Judge task ${completionStatus.type} — defaulting to continue` };
    }

    // Attempt structured output first (Claude + --json-schema belt-and-suspenders)
    const outputResult = await this.outputRepo.get(judgeTaskId);
    if (outputResult.ok && outputResult.value) {
      const structured = this.tryParseStructuredOutput(outputResult.value.stdout);
      if (structured) {
        await this.cleanupDecisionFile(decisionFilePath);
        return structured;
      }
    }

    // Primary mechanism: read .autobeat-judge file written by the judge agent
    const fileDecision = await this.readDecisionFile(decisionFilePath);
    if (fileDecision) {
      await this.cleanupDecisionFile(decisionFilePath);
      return fileDecision;
    }

    // Safe fallback: default to continue
    this.logger.warn('Judge decision not found in structured output or file — defaulting to continue', {
      loopId: loop.id,
      judgeTaskId,
    });
    return { continue: true, reasoning: 'Judge decision not found — defaulting to continue' };
  }

  /**
   * Build the eval prompt for phase 1 (findings gathering).
   */
  private async buildEvalPrompt(loop: Loop, taskId: TaskId): Promise<string> {
    let preIterationCommitSha: string | undefined;
    const iterationResult = await this.loopRepo.findIterationByTaskId(taskId);
    if (iterationResult.ok && iterationResult.value) {
      preIterationCommitSha = iterationResult.value.preIterationCommitSha;
    }

    const gitDiffInstruction = preIterationCommitSha
      ? `Use \`git diff ${preIterationCommitSha}..HEAD\` to see what changed in this iteration.`
      : 'Use `git diff HEAD~1..HEAD` to see what changed in this iteration.';

    const toolInstructions = `${gitDiffInstruction} Use \`beat logs ${taskId}\` to read the worker's output.`;

    const criteria = loop.evalPrompt ?? 'Review the code changes and provide detailed observations and findings.';

    return `You are reviewing the result of an automated code improvement iteration.
Provide detailed findings — a judge agent will read your output and make the final decision.

IMPORTANT: Do NOT modify any files. You are a reviewer — read and assess only.

Working directory: ${loop.workingDirectory}
Iteration: ${loop.currentIteration}
Task ID: ${taskId}

${toolInstructions}

${criteria}

Provide your detailed findings. There is no special format required — write naturally.`;
  }

  /**
   * Build the judge prompt for phase 2 (decision making).
   *
   * DECISION: File-based decision mechanism.
   * Why: All coding agents can write files — stdout capture is unreliable across agents.
   * The file path is fixed (.autobeat-judge) so the judge knows where to write.
   */
  private buildJudgePrompt(loop: Loop, findings: string): string {
    const judgeInstructions = loop.judgePrompt ?? 'Based on the findings, should the work continue iterating?';

    return `You are evaluating whether a coding task should continue iterating.

Working directory: ${loop.workingDirectory}
Iteration: ${loop.currentIteration}

=== Evaluation Findings ===
${findings || '(No findings provided)'}
===

${judgeInstructions}

IMPORTANT: Write your decision to the file \`.autobeat-judge\` in the working directory (${loop.workingDirectory}/.autobeat-judge).
The file must contain valid JSON with exactly this structure:
{"continue": true, "reasoning": "..."} to continue iterating
{"continue": false, "reasoning": "..."} to stop

Example — continue: {"continue": true, "reasoning": "Progress is being made but tests still fail."}
Example — stop: {"continue": false, "reasoning": "All acceptance criteria are met."}

Do NOT include any other content in the file. The file will be read programmatically.`;
  }

  /**
   * Try to parse structured output from Claude's --json-schema response.
   * Belt-and-suspenders: file-based decision is primary, this is secondary.
   */
  private tryParseStructuredOutput(stdout: readonly string[]): { continue: boolean; reasoning: string } | null {
    if (stdout.length === 0) return null;

    const combined = stdout.join('');
    if (combined.length === 0) return null;

    const marker = '{"type":"result"';
    const markerIndex = combined.lastIndexOf(marker);
    if (markerIndex === -1) return null;

    const suffix = combined.slice(markerIndex);
    let parsed: unknown;
    try {
      parsed = JSON.parse(suffix);
    } catch {
      return null;
    }

    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    if (obj.type !== 'result') return null;

    const structuredOutput = obj.structured_output;
    if (!structuredOutput || typeof structuredOutput !== 'object') return null;
    const so = structuredOutput as Record<string, unknown>;

    if (typeof so.continue !== 'boolean') return null;
    const reasoning = typeof so.reasoning === 'string' ? so.reasoning : 'No reasoning provided';

    return { continue: so.continue, reasoning };
  }

  /**
   * Read and parse the .autobeat-judge decision file.
   * Returns null if file doesn't exist or contains invalid JSON.
   */
  private async readDecisionFile(filePath: string): Promise<{ continue: boolean; reasoning: string } | null> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content.trim()) as unknown;

      if (!parsed || typeof parsed !== 'object') {
        this.logger.warn('Judge decision file contains invalid JSON structure', { filePath });
        return null;
      }

      const obj = parsed as Record<string, unknown>;
      if (typeof obj.continue !== 'boolean') {
        this.logger.warn('Judge decision file missing "continue" boolean field', { filePath });
        return null;
      }

      const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning : 'No reasoning provided';
      return { continue: obj.continue, reasoning };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // File doesn't exist — not an error, just wasn't written
        return null;
      }
      this.logger.warn('Failed to read judge decision file', {
        filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Remove the .autobeat-judge file to prevent stale decisions across iterations.
   * Errors are swallowed — cleanup failure is not fatal.
   */
  private async cleanupDecisionFile(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch {
      // ENOENT is expected when file doesn't exist — ignore all cleanup errors
    }
  }

  /**
   * Wait for eval/judge task to reach a terminal state.
   * ARCHITECTURE: Same pattern as AgentExitConditionEvaluator.waitForTaskCompletion.
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
        this.logger.info('Loop cancelled while judge task running — cancelling eval task', {
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
        this.logger.warn('Judge eval task completion timed out by fallback timer', {
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
