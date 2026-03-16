/**
 * Task manager orchestrator
 *
 * ARCHITECTURE: Hybrid approach — commands go through EventBus, queries go direct
 * Pattern: Commands via events (fire-and-forget emit), queries via repository
 * Rationale: Eliminates unnecessary event indirection for read operations
 *
 * Rules:
 * - Commands (delegate) use fire-and-forget emit()
 * - Commands with validation (cancel) validate then emit
 * - Queries (getStatus, getLogs, retry lookup, resume lookup) use direct repository calls
 * - All state changes MUST go through events
 */

import { resolveDefaultAgent } from '../core/agents.js';
import { Configuration } from '../core/configuration.js';
import {
  createTask,
  isTerminalState,
  ResumeTaskRequest,
  Task,
  TaskId,
  TaskOutput,
  TaskRequest,
} from '../core/domain.js';
import { BackbeatError, ErrorCode, taskNotFound } from '../core/errors.js';
import { EventBus } from '../core/events/event-bus.js';
import { CheckpointRepository, Logger, OutputCapture, TaskManager, TaskRepository } from '../core/interfaces.js';
import { err, ok, Result } from '../core/result.js';

export class TaskManagerService implements TaskManager {
  constructor(
    private readonly eventBus: EventBus,
    private readonly logger: Logger,
    private readonly config: Configuration,
    private readonly taskRepo: TaskRepository,
    private readonly outputCapture: OutputCapture,
    private readonly checkpointRepo?: CheckpointRepository,
  ) {
    this.logger.debug('TaskManager initialized with hybrid architecture (commands via events, queries direct)');
  }

  /**
   * Delegate a task - commands go through events
   */
  async delegate(request: TaskRequest): Promise<Result<Task>> {
    // Apply configuration defaults to request
    let requestWithDefaults: TaskRequest = {
      ...request,
      timeout: request.timeout ?? this.config.timeout,
      maxOutputBuffer: request.maxOutputBuffer ?? this.config.maxOutputBuffer,
    };

    // continueFrom validation: verify task exists and ensure it's in dependsOn
    if (requestWithDefaults.continueFrom) {
      const continueFromId = requestWithDefaults.continueFrom;

      // Validate referenced task exists via direct repository call
      const lookupResult = await this.taskRepo.findById(continueFromId);
      if (!lookupResult.ok || lookupResult.value === null) {
        return err(new BackbeatError(ErrorCode.TASK_NOT_FOUND, `continueFrom task not found: ${continueFromId}`));
      }

      // Auto-add to dependsOn if missing
      const deps = requestWithDefaults.dependsOn ?? [];
      if (!deps.includes(continueFromId)) {
        requestWithDefaults = {
          ...requestWithDefaults,
          dependsOn: [...deps, continueFromId],
        };
      }
    }

    // Resolve agent: explicit → config default → error
    const agentResult = resolveDefaultAgent(requestWithDefaults.agent, this.config.defaultAgent);
    if (!agentResult.ok) return agentResult;
    requestWithDefaults = { ...requestWithDefaults, agent: agentResult.value };

    // Create task using pure function with defaults applied
    const task = createTask(requestWithDefaults);

    this.logger.info('Delegating task', {
      taskId: task.id,
      priority: task.priority,
      prompt: task.prompt.substring(0, 100),
      agent: task.agent,
    });

    // Emit event - all state management happens in event handlers
    const result = await this.eventBus.emit('TaskDelegated', { task });

    if (!result.ok) {
      this.logger.error('Task delegation failed', result.error, {
        taskId: task.id,
      });
      return err(result.error);
    }

    return ok(task);
  }

  async getStatus(taskId?: TaskId): Promise<Result<Task | readonly Task[]>> {
    if (taskId) {
      const result = await this.taskRepo.findById(taskId);
      if (!result.ok) {
        this.logger.error('Task status query failed', result.error, { taskId });
        return result;
      }
      if (!result.value) {
        return err(taskNotFound(taskId));
      }
      return ok(result.value);
    }
    return this.taskRepo.findAllUnbounded();
  }

  async getLogs(taskId: TaskId, tail?: number): Promise<Result<TaskOutput>> {
    // Validate task exists first
    const taskResult = await this.taskRepo.findById(taskId);
    if (!taskResult.ok) {
      this.logger.error('Task logs query failed', taskResult.error, { taskId });
      return taskResult;
    }
    if (!taskResult.value) {
      return err(taskNotFound(taskId));
    }

    return this.outputCapture.getOutput(taskId, tail);
  }

  async cancel(taskId: TaskId, reason?: string): Promise<Result<void>> {
    // Validate task exists and is cancellable (consistent with retry pattern)
    const taskResult = await this.taskRepo.findById(taskId);
    if (!taskResult.ok) {
      this.logger.error('Task cancellation check failed', taskResult.error, { taskId });
      return taskResult;
    }
    if (!taskResult.value) {
      return err(taskNotFound(taskId));
    }

    const task = taskResult.value;
    if (task.status !== 'queued' && task.status !== 'running') {
      return err(
        new BackbeatError(ErrorCode.TASK_CANNOT_CANCEL, `Task ${taskId} cannot be cancelled in state ${task.status}`),
      );
    }

    this.logger.info('Cancelling task', { taskId, reason });
    const result = await this.eventBus.emit('TaskCancellationRequested', { taskId, reason });

    if (!result.ok) {
      this.logger.error('Task cancellation failed', result.error, { taskId });
      return err(result.error);
    }

    return ok(undefined);
  }

  /**
   * Retry a failed or completed task by creating a new task with the same configuration
   *
   * Creates a completely new task to avoid side effects from partially executed
   * Claude Code operations (file changes, commits, etc.). The new task maintains
   * a link to the original via retry tracking fields.
   *
   * RETRY CHAIN BEHAVIOR:
   * - Each retry creates a NEW task with a unique ID
   * - parentTaskId: Points to the root task of the retry chain
   * - retryOf: Points to the immediate parent being retried
   * - retryCount: Increments with each retry in the chain
   *
   * Example retry chain:
   * 1. Original task: task-A (parentTaskId: null, retryCount: 0, retryOf: null)
   * 2. First retry: task-B (parentTaskId: task-A, retryCount: 1, retryOf: task-A)
   * 3. Second retry: task-C (parentTaskId: task-A, retryCount: 2, retryOf: task-B)
   *
   * This allows tracking the full retry history while maintaining a reference
   * to the original task request.
   *
   * @param taskId - ID of the task to retry (must be in terminal state)
   * @returns New task with retry tracking, or error if task cannot be retried
   *
   * @example
   * // CLI usage: beat retry abc-123
   * // Creates new task def-456 with:
   * // - parentTaskId: abc-123 (or original if abc-123 is already a retry)
   * // - retryCount: 1 (or incremented from abc-123's count)
   * // - retryOf: abc-123 (direct parent)
   */
  async retry(taskId: TaskId): Promise<Result<Task>> {
    const taskResult = await this.taskRepo.findById(taskId);

    if (!taskResult.ok) {
      return err(taskResult.error);
    }

    if (taskResult.value === null) {
      return err(taskNotFound(taskId));
    }

    const originalTask = taskResult.value;

    // Only retry tasks that are in terminal states
    if (!isTerminalState(originalTask.status)) {
      return err(
        new BackbeatError(
          ErrorCode.INVALID_OPERATION,
          `Task ${taskId} cannot be retried in state ${originalTask.status}`,
        ),
      );
    }

    this.logger.info('Retrying task', {
      taskId,
      status: originalTask.status,
      prompt: originalTask.prompt.substring(0, 100),
    });

    // Find the root parent task ID (for tracking all retries in a chain)
    const parentTaskId = originalTask.parentTaskId || taskId;
    const retryCount = (originalTask.retryCount || 0) + 1;

    // Create the retry request with all the original task's configuration
    const retryRequest: TaskRequest = {
      prompt: originalTask.prompt,
      priority: originalTask.priority,
      workingDirectory: originalTask.workingDirectory,
      timeout: originalTask.timeout,
      maxOutputBuffer: originalTask.maxOutputBuffer,
      parentTaskId: TaskId(parentTaskId),
      retryCount,
      retryOf: taskId,
      agent: originalTask.agent,
    };

    // Create the new retry task
    const newTask = createTask(retryRequest);

    this.logger.info('Creating retry task', {
      originalTaskId: taskId,
      newTaskId: newTask.id,
      retryCount,
      parentTaskId,
    });

    // Emit TaskDelegated event for the new retry task
    const result = await this.eventBus.emit('TaskDelegated', { task: newTask });

    if (!result.ok) {
      this.logger.error('Failed to delegate retry task', result.error, {
        originalTaskId: taskId,
        newTaskId: newTask.id,
      });
      return err(result.error);
    }

    return ok(newTask);
  }

  /**
   * Resume a terminal task with enriched context from its checkpoint
   *
   * Creates a new task with an enriched prompt that includes the previous attempt's
   * output, errors, and git state. This enables "smart retry" where the new Claude
   * Code instance understands what happened in the previous attempt.
   *
   * RESUME vs RETRY:
   * - retry(): Creates a new task with the exact same prompt (blind retry)
   * - resume(): Creates a new task with enriched prompt including checkpoint context
   *
   * @param request - Resume request with taskId and optional additional context
   * @returns New task with enriched prompt, or error if task cannot be resumed
   */
  async resume(request: ResumeTaskRequest): Promise<Result<Task>> {
    const { taskId, additionalContext } = request;

    // Fetch original task via direct repository call
    const taskResult = await this.taskRepo.findById(taskId);

    if (!taskResult.ok) {
      return err(taskResult.error);
    }

    if (taskResult.value === null) {
      return err(taskNotFound(taskId));
    }

    const originalTask = taskResult.value;

    // Only resume tasks in terminal states
    if (!isTerminalState(originalTask.status)) {
      return err(
        new BackbeatError(
          ErrorCode.INVALID_OPERATION,
          `Task ${taskId} cannot be resumed in state ${originalTask.status}`,
        ),
      );
    }

    this.logger.info('Resuming task', {
      taskId,
      status: originalTask.status,
      hasCheckpointRepo: !!this.checkpointRepo,
      hasAdditionalContext: !!additionalContext,
    });

    // Fetch latest checkpoint if repository is available
    let checkpointUsed = false;
    let enrichedPrompt = this.buildEnrichedPrompt(originalTask, null, additionalContext);

    if (this.checkpointRepo) {
      const checkpointResult = await this.checkpointRepo.findLatest(taskId);
      if (checkpointResult.ok && checkpointResult.value) {
        enrichedPrompt = this.buildEnrichedPrompt(originalTask, checkpointResult.value, additionalContext);
        checkpointUsed = true;
      } else if (!checkpointResult.ok) {
        this.logger.warn('Failed to fetch checkpoint for resume, proceeding without', {
          taskId,
          error: checkpointResult.error.message,
        });
      }
    }

    // Build retry chain tracking
    const parentTaskId = originalTask.parentTaskId || taskId;
    const retryCount = (originalTask.retryCount || 0) + 1;

    // Create new task with enriched prompt and same configuration
    const resumeRequest: TaskRequest = {
      prompt: enrichedPrompt,
      priority: originalTask.priority,
      workingDirectory: originalTask.workingDirectory,
      timeout: originalTask.timeout,
      maxOutputBuffer: originalTask.maxOutputBuffer,
      parentTaskId: TaskId(parentTaskId),
      retryCount,
      retryOf: taskId,
      agent: originalTask.agent,
    };

    const newTask = createTask(resumeRequest);

    this.logger.info('Creating resume task', {
      originalTaskId: taskId,
      newTaskId: newTask.id,
      retryCount,
      parentTaskId,
      checkpointUsed,
    });

    // Emit TaskDelegated event for the new task
    const delegateResult = await this.eventBus.emit('TaskDelegated', { task: newTask });

    if (!delegateResult.ok) {
      this.logger.error('Failed to delegate resume task', delegateResult.error, {
        originalTaskId: taskId,
        newTaskId: newTask.id,
      });
      return err(delegateResult.error);
    }

    return ok(newTask);
  }

  /**
   * Build an enriched prompt that includes previous attempt context
   * ARCHITECTURE: Pure function - takes data in, returns string out
   */
  private buildEnrichedPrompt(
    originalTask: Task,
    checkpoint: import('../core/domain.js').TaskCheckpoint | null,
    additionalContext?: string,
  ): string {
    const parts: string[] = [];

    parts.push('PREVIOUS TASK CONTEXT:');
    parts.push(`The previous attempt at this task ended with status: ${originalTask.status}`);
    parts.push('');
    parts.push(`Original prompt: ${originalTask.prompt}`);

    if (checkpoint) {
      parts.push('');
      if (checkpoint.outputSummary) {
        parts.push(`Last output: ${checkpoint.outputSummary}`);
      }
      if (checkpoint.errorSummary) {
        parts.push(`Error: ${checkpoint.errorSummary}`);
      }
      if (checkpoint.gitBranch) {
        parts.push(`Git state: branch=${checkpoint.gitBranch}, commit=${checkpoint.gitCommitSha ?? 'unknown'}`);
      }
      if (checkpoint.gitDirtyFiles && checkpoint.gitDirtyFiles.length > 0) {
        parts.push(`Modified files: ${checkpoint.gitDirtyFiles.join(', ')}`);
      }
    }

    if (additionalContext) {
      parts.push('');
      parts.push(`Additional context: ${additionalContext}`);
    }

    parts.push('');
    parts.push("Please continue or retry the task, taking into account the previous attempt's results.");

    return parts.join('\n');
  }
}
