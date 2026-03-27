/**
 * Checkpoint handler for automatic task state capture
 * ARCHITECTURE: Event-driven checkpoint creation on task terminal events
 * Pattern: Factory pattern for async initialization (matches ScheduleHandler)
 * Rationale: Captures task state snapshots for "smart retry" enrichment
 */

import type { TaskCheckpoint, TaskId } from '../../core/domain.js';
import { AutobeatError, ErrorCode } from '../../core/errors.js';
import { EventBus } from '../../core/events/event-bus.js';
import type { TaskCancelledEvent, TaskCompletedEvent, TaskFailedEvent } from '../../core/events/events.js';
import { BaseEventHandler } from '../../core/events/handlers.js';
import { CheckpointRepository, Logger, OutputCapture, TaskRepository } from '../../core/interfaces.js';
import { err, ok, Result } from '../../core/result.js';
import { captureGitState } from '../../utils/git-state.js';

/** Maximum characters for output/error summaries stored in checkpoints */
const MAX_SUMMARY_LENGTH = 2000;

/** Number of output lines to capture for checkpoint summaries */
const OUTPUT_TAIL_LINES = 50;

export interface CheckpointHandlerDeps {
  readonly checkpointRepo: CheckpointRepository;
  readonly outputCapture: OutputCapture;
  readonly taskRepo: TaskRepository;
  readonly eventBus: EventBus;
  readonly logger: Logger;
}

export class CheckpointHandler extends BaseEventHandler {
  private readonly checkpointRepo: CheckpointRepository;
  private readonly outputCapture: OutputCapture;
  private readonly taskRepo: TaskRepository;
  private readonly eventBus: EventBus;

  /**
   * Private constructor - use CheckpointHandler.create() instead
   * ARCHITECTURE: Factory pattern ensures handler is fully initialized before use
   */
  private constructor(deps: CheckpointHandlerDeps) {
    super(deps.logger, 'CheckpointHandler');
    this.checkpointRepo = deps.checkpointRepo;
    this.outputCapture = deps.outputCapture;
    this.taskRepo = deps.taskRepo;
    this.eventBus = deps.eventBus;
  }

  /**
   * Factory method to create a fully initialized CheckpointHandler
   * ARCHITECTURE: Guarantees handler is ready to use - no uninitialized state possible
   */
  static async create(deps: CheckpointHandlerDeps): Promise<Result<CheckpointHandler, AutobeatError>> {
    const handlerLogger = deps.logger.child ? deps.logger.child({ module: 'CheckpointHandler' }) : deps.logger;

    const handler = new CheckpointHandler({ ...deps, logger: handlerLogger });

    const subscribeResult = handler.subscribeToEvents();
    if (!subscribeResult.ok) {
      return subscribeResult;
    }

    handlerLogger.info('CheckpointHandler initialized');

    return ok(handler);
  }

  /**
   * Subscribe to task terminal events
   * ARCHITECTURE: Called by factory after initialization
   */
  private subscribeToEvents(): Result<void, AutobeatError> {
    const subscriptions = [
      this.eventBus.subscribe('TaskCompleted', this.handleTaskCompleted.bind(this)),
      this.eventBus.subscribe('TaskFailed', this.handleTaskFailed.bind(this)),
      this.eventBus.subscribe('TaskCancelled', this.handleTaskCancelled.bind(this)),
    ];

    for (const result of subscriptions) {
      if (!result.ok) {
        return err(
          new AutobeatError(ErrorCode.SYSTEM_ERROR, `Failed to subscribe to events: ${result.error.message}`, {
            error: result.error,
          }),
        );
      }
    }

    return ok(undefined);
  }

  // ============================================================================
  // TASK TERMINAL EVENT HANDLERS
  // ============================================================================

  private async handleTaskCompleted(event: TaskCompletedEvent): Promise<void> {
    await this.handleEvent(event, async (e) => {
      return this.createCheckpoint(e.taskId, 'completed');
    });
  }

  private async handleTaskFailed(event: TaskFailedEvent): Promise<void> {
    await this.handleEvent(event, async (e) => {
      return this.createCheckpoint(e.taskId, 'failed', e.error?.message);
    });
  }

  private async handleTaskCancelled(event: TaskCancelledEvent): Promise<void> {
    await this.handleEvent(event, async (e) => {
      return this.createCheckpoint(e.taskId, 'cancelled', e.reason);
    });
  }

  // ============================================================================
  // CHECKPOINT CREATION
  // ============================================================================

  /**
   * Create a checkpoint for a task that reached a terminal state
   * Captures output summary, error info, and git state
   */
  private async createCheckpoint(
    taskId: TaskId,
    checkpointType: TaskCheckpoint['checkpointType'],
    errorMessage?: string,
  ): Promise<Result<void>> {
    this.logger.info('Creating checkpoint', { taskId, checkpointType });

    // Fetch task to get working directory for git state
    const taskResult = await this.taskRepo.findById(taskId);
    if (!taskResult.ok) {
      this.logger.error('Failed to fetch task for checkpoint', taskResult.error, { taskId });
      return err(taskResult.error);
    }

    const task = taskResult.value;
    if (!task) {
      this.logger.warn('Task not found for checkpoint creation', { taskId });
      return ok(undefined); // Not a fatal error - task may have been deleted
    }

    // Get last N lines of output
    let outputSummary: string | undefined;
    let errorSummary: string | undefined;

    const outputResult = this.outputCapture.getOutput(taskId, OUTPUT_TAIL_LINES);
    if (outputResult.ok) {
      const output = outputResult.value;

      if (output.stdout.length > 0) {
        outputSummary = output.stdout.join('\n');
        if (outputSummary.length > MAX_SUMMARY_LENGTH) {
          outputSummary = outputSummary.substring(outputSummary.length - MAX_SUMMARY_LENGTH);
        }
      }

      if (output.stderr.length > 0) {
        errorSummary = output.stderr.join('\n');
        if (errorSummary.length > MAX_SUMMARY_LENGTH) {
          errorSummary = errorSummary.substring(errorSummary.length - MAX_SUMMARY_LENGTH);
        }
      }
    }

    // Use event error message as errorSummary if stderr is empty
    if (!errorSummary && errorMessage) {
      errorSummary =
        errorMessage.length > MAX_SUMMARY_LENGTH ? errorMessage.substring(0, MAX_SUMMARY_LENGTH) : errorMessage;
    }

    // Capture git state if task has a working directory
    let gitBranch: string | undefined;
    let gitCommitSha: string | undefined;
    let gitDirtyFiles: readonly string[] | undefined;

    if (task.workingDirectory) {
      const gitResult = await captureGitState(task.workingDirectory);
      if (gitResult.ok && gitResult.value) {
        gitBranch = gitResult.value.branch;
        gitCommitSha = gitResult.value.commitSha;
        gitDirtyFiles = gitResult.value.dirtyFiles;
      } else if (!gitResult.ok) {
        this.logger.warn('Failed to capture git state for checkpoint', {
          taskId,
          error: gitResult.error.message,
        });
      }
    }

    // Save checkpoint
    const checkpoint: Omit<TaskCheckpoint, 'id'> = {
      taskId,
      checkpointType,
      outputSummary,
      errorSummary,
      gitBranch,
      gitCommitSha,
      gitDirtyFiles,
      createdAt: Date.now(),
    };

    const saveResult = await this.checkpointRepo.save(checkpoint);
    if (!saveResult.ok) {
      this.logger.error('Failed to save checkpoint', saveResult.error, { taskId });
      return err(saveResult.error);
    }

    const savedCheckpoint = saveResult.value;

    // Emit CheckpointCreated event
    await this.emitEvent(
      this.eventBus,
      'CheckpointCreated',
      {
        taskId,
        checkpoint: savedCheckpoint,
      },
      { context: { taskId, checkpointType } },
    );

    this.logger.info('Checkpoint created', {
      taskId,
      checkpointId: savedCheckpoint.id,
      checkpointType,
      hasOutputSummary: !!outputSummary,
      hasErrorSummary: !!errorSummary,
      hasGitState: !!gitBranch,
    });

    return ok(undefined);
  }
}
