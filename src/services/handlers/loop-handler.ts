/**
 * Loop handler for iterative task/pipeline execution
 * ARCHITECTURE: Event-driven iteration engine for v0.7.0 task loops
 * Pattern: Factory pattern for async initialization (matches ScheduleHandler)
 * Rationale: Manages loop lifecycle, iteration dispatch, exit condition evaluation,
 *   and crash recovery — all driven by events from task completion/failure
 */

import type { Loop, LoopIteration, Task } from '../../core/domain.js';
import {
  createTask,
  isTerminalState,
  LoopId,
  LoopStatus,
  LoopStrategy,
  OptimizeDirection,
  TaskId,
  TaskStatus,
  updateLoop,
} from '../../core/domain.js';
import { BackbeatError, ErrorCode } from '../../core/errors.js';
import { EventBus } from '../../core/events/event-bus.js';
import type {
  LoopCancelledEvent,
  LoopCreatedEvent,
  LoopPausedEvent,
  LoopResumedEvent,
  TaskCancelledEvent,
  TaskCompletedEvent,
  TaskFailedEvent,
} from '../../core/events/events.js';
import { BaseEventHandler } from '../../core/events/handlers.js';
import type {
  CheckpointRepository,
  EvalResult,
  ExitConditionEvaluator,
  Logger,
  LoopRepository,
  SyncLoopOperations,
  SyncTaskOperations,
  TaskRepository,
  TransactionRunner,
} from '../../core/interfaces.js';
import { err, ok, type Result } from '../../core/result.js';
import {
  captureGitDiff,
  commitAllChanges,
  createAndCheckoutBranch,
  getCurrentCommitSha,
  resetToCommit,
} from '../../utils/git-state.js';

export class LoopHandler extends BaseEventHandler {
  // In-memory state (rebuilt from DB on restart)
  private taskToLoop: Map<TaskId, LoopId> = new Map(); // taskId → loopId
  private pipelineTasks: Map<string, Set<TaskId>> = new Map(); // "loopId:iteration" → set of taskIds
  private cooldownTimers: Map<LoopId, NodeJS.Timeout> = new Map(); // loopId → timer

  /**
   * Private constructor - use LoopHandler.create() instead
   * ARCHITECTURE: Factory pattern ensures handler is fully initialized before use
   */
  private constructor(
    private readonly loopRepo: LoopRepository & SyncLoopOperations,
    private readonly taskRepo: TaskRepository & SyncTaskOperations,
    private readonly checkpointRepo: CheckpointRepository,
    private readonly eventBus: EventBus,
    private readonly database: TransactionRunner,
    private readonly exitConditionEvaluator: ExitConditionEvaluator,
    logger: Logger,
  ) {
    super(logger, 'LoopHandler');
  }

  /**
   * Factory method to create a fully initialized LoopHandler
   * ARCHITECTURE: Guarantees handler is ready to use — no uninitialized state possible
   * Runs recovery on startup (R3) — self-healing regardless of RecoveryManager timing
   */
  static async create(
    loopRepo: LoopRepository & SyncLoopOperations,
    taskRepo: TaskRepository & SyncTaskOperations,
    checkpointRepo: CheckpointRepository,
    eventBus: EventBus,
    database: TransactionRunner,
    exitConditionEvaluator: ExitConditionEvaluator,
    logger: Logger,
  ): Promise<Result<LoopHandler, BackbeatError>> {
    const handlerLogger = logger.child ? logger.child({ module: 'LoopHandler' }) : logger;

    const handler = new LoopHandler(
      loopRepo,
      taskRepo,
      checkpointRepo,
      eventBus,
      database,
      exitConditionEvaluator,
      handlerLogger,
    );

    // Subscribe to events
    const subscribeResult = handler.subscribeToEvents();
    if (!subscribeResult.ok) {
      return subscribeResult;
    }

    // Recovery: rebuild in-memory maps from DB (R3)
    await handler.rebuildMaps();
    await handler.recoverStuckLoops();

    handlerLogger.info('LoopHandler initialized', {
      trackedTasks: handler.taskToLoop.size,
      trackedPipelines: handler.pipelineTasks.size,
    });

    return ok(handler);
  }

  /**
   * Subscribe to all relevant events
   * ARCHITECTURE: Called by factory after initialization
   */
  private subscribeToEvents(): Result<void, BackbeatError> {
    const subscriptions = [
      this.eventBus.subscribe('LoopCreated', this.handleLoopCreated.bind(this)),
      this.eventBus.subscribe('TaskCompleted', this.handleTaskTerminal.bind(this)),
      this.eventBus.subscribe('TaskFailed', this.handleTaskTerminal.bind(this)),
      this.eventBus.subscribe('TaskCancelled', this.handleTaskCancelled.bind(this)),
      this.eventBus.subscribe('LoopCancelled', this.handleLoopCancelled.bind(this)),
      this.eventBus.subscribe('LoopPaused', this.handleLoopPaused.bind(this)),
      this.eventBus.subscribe('LoopResumed', this.handleLoopResumed.bind(this)),
    ];

    for (const result of subscriptions) {
      if (!result.ok) {
        return err(
          new BackbeatError(ErrorCode.SYSTEM_ERROR, `Failed to subscribe to events: ${result.error.message}`, {
            error: result.error,
          }),
        );
      }
    }

    return ok(undefined);
  }

  // ============================================================================
  // EVENT HANDLERS
  // ============================================================================

  /**
   * Handle loop creation — persist via repo, then start first iteration
   */
  private async handleLoopCreated(event: LoopCreatedEvent): Promise<void> {
    await this.handleEvent(event, async (e) => {
      const loop = e.loop;

      this.logger.info('Processing new loop', {
        loopId: loop.id,
        strategy: loop.strategy,
        maxIterations: loop.maxIterations,
      });

      // Persist loop via repo
      const saveResult = await this.loopRepo.save(loop);
      if (!saveResult.ok) {
        this.logger.error('Failed to save loop', saveResult.error, { loopId: loop.id });
        return err(saveResult.error);
      }

      // Start first iteration
      await this.startNextIteration(loop);

      return ok(undefined);
    });
  }

  /**
   * Handle task terminal events (TaskCompleted, TaskFailed) — evaluate exit condition
   * ARCHITECTURE: Both events share the same handler since iteration evaluation logic
   * is identical: look up loop, check status, evaluate condition, decide next step
   */
  private async handleTaskTerminal(event: TaskCompletedEvent | TaskFailedEvent): Promise<void> {
    await this.handleEvent(event, async (e) => {
      const taskId = e.taskId;

      // Look up loop from in-memory map
      const loopId = this.taskToLoop.get(taskId);
      if (!loopId) {
        // Not a loop task — ignore
        return ok(undefined);
      }

      // Get loop from repo
      const loopResult = await this.loopRepo.findById(loopId);
      if (!loopResult.ok) {
        this.logger.error('Failed to fetch loop for terminal task', loopResult.error, { taskId, loopId });
        return err(loopResult.error);
      }

      const loop = loopResult.value;
      if (!loop) {
        this.logger.warn('Loop not found for terminal task', { taskId, loopId });
        return ok(undefined);
      }

      // Prevents action after cancel (R5 race condition)
      // Allow PAUSED through so iteration results are recorded (graceful pause)
      if (loop.status !== LoopStatus.RUNNING && loop.status !== LoopStatus.PAUSED) {
        this.logger.debug('Loop not running or paused, ignoring terminal event', {
          loopId,
          status: loop.status,
          taskId,
        });
        // Clean up tracking
        this.taskToLoop.delete(taskId);
        return ok(undefined);
      }

      // Get the iteration record for this task (only matches if this is the tail task)
      const iterationResult = await this.loopRepo.findIterationByTaskId(taskId);
      if (!iterationResult.ok || !iterationResult.value) {
        // Not the tail task — check if it's a non-tail pipeline intermediate task
        return this.handlePipelineIntermediateTask(event, taskId, loop);
      }

      const iteration = iterationResult.value;

      // Guard: skip processing if iteration is no longer running (e.g., force-paused → cancelled)
      // Prevents late TaskCompleted/TaskFailed from overwriting cancelled/terminal iteration status
      if (iteration.status !== 'running') {
        this.logger.debug('Iteration not running, skipping terminal processing', {
          loopId,
          taskId,
          iterationStatus: iteration.status,
        });
        this.cleanupPipelineTaskTracking(iteration);
        this.taskToLoop.delete(taskId);
        this.cleanupPipelineTasks(loopId, iteration.iterationNumber);
        return ok(undefined);
      }

      // Determine outcome based on event type
      const isTaskFailed = event.type === 'TaskFailed';

      if (isTaskFailed) {
        // Task FAILED — record failure, check limits
        const failedEvent = event as TaskFailedEvent;
        const newConsecutiveFailures = loop.consecutiveFailures + 1;

        // Atomic: iteration fail + consecutiveFailures in single transaction
        const updatedLoop = updateLoop(loop, { consecutiveFailures: newConsecutiveFailures });
        const txResult = this.database.runInTransaction(() => {
          this.loopRepo.updateIterationSync({
            ...iteration,
            status: 'fail',
            exitCode: failedEvent.exitCode,
            errorMessage: failedEvent.error?.message ?? 'Task failed',
            completedAt: Date.now(),
          });
          this.loopRepo.updateSync(updatedLoop);
        });

        if (!txResult.ok) {
          this.logger.error('Failed to persist task failure', txResult.error, { loopId });
          await this.completeLoop(loop, LoopStatus.FAILED, 'Failed to persist task failure');
        } else if (loop.maxConsecutiveFailures > 0 && newConsecutiveFailures >= loop.maxConsecutiveFailures) {
          await this.completeLoop(updatedLoop, LoopStatus.FAILED, 'Max consecutive failures reached');
        } else {
          await this.scheduleNextIteration(updatedLoop);
        }
      } else {
        // Task COMPLETED — run exit condition evaluation
        const evalResult = await this.exitConditionEvaluator.evaluate(loop, taskId);
        await this.handleIterationResult(loop, iteration, evalResult);
      }

      // Clean up all pipeline task tracking for this iteration
      this.cleanupPipelineTaskTracking(iteration);
      this.taskToLoop.delete(taskId);
      this.cleanupPipelineTasks(loopId, iteration.iterationNumber);

      return ok(undefined);
    });
  }

  /**
   * Handle task cancellation — clean up if it's a loop task
   */
  private async handleTaskCancelled(event: TaskCancelledEvent): Promise<void> {
    await this.handleEvent(event, async (e) => {
      const taskId = e.taskId;
      const loopId = this.taskToLoop.get(taskId);
      if (!loopId) {
        return ok(undefined);
      }

      this.logger.info('Loop task cancelled', { loopId, taskId });

      // Get iteration to mark as cancelled
      const iterationResult = await this.loopRepo.findIterationByTaskId(taskId);
      if (iterationResult.ok && iterationResult.value) {
        await this.loopRepo.updateIteration({
          ...iterationResult.value,
          status: 'cancelled',
          completedAt: Date.now(),
        });
        this.cleanupPipelineTasks(loopId, iterationResult.value.iterationNumber);
      }

      this.taskToLoop.delete(taskId);

      return ok(undefined);
    });
  }

  /**
   * Handle loop cancellation — update status, cancel in-flight tasks, clear timers
   */
  private async handleLoopCancelled(event: LoopCancelledEvent): Promise<void> {
    await this.handleEvent(event, async (e) => {
      const { loopId, reason } = e;

      this.logger.info('Processing loop cancellation', { loopId, reason });

      // Fetch current loop state
      const loopResult = await this.loopRepo.findById(loopId);
      if (!loopResult.ok || !loopResult.value) {
        this.logger.warn('Loop not found for cancellation', { loopId });
        return ok(undefined);
      }

      const loop = loopResult.value;

      // Update loop status to CANCELLED
      const updatedLoop = updateLoop(loop, {
        status: LoopStatus.CANCELLED,
        completedAt: Date.now(),
      });
      await this.loopRepo.update(updatedLoop);

      // Clear cooldown timer if exists
      const timer = this.cooldownTimers.get(loopId);
      if (timer) {
        clearTimeout(timer);
        this.cooldownTimers.delete(loopId);
      }

      // Clean up taskToLoop entries for this loop
      for (const [taskId, lId] of this.taskToLoop.entries()) {
        if (lId === loopId) {
          this.taskToLoop.delete(taskId);
        }
      }

      // Mark current running iteration as 'cancelled'
      const iterationsResult = await this.loopRepo.getIterations(loopId, 1);
      if (iterationsResult.ok && iterationsResult.value.length > 0) {
        const latestIteration = iterationsResult.value[0];
        if (latestIteration.status === 'running') {
          await this.loopRepo.updateIteration({
            ...latestIteration,
            status: 'cancelled',
            completedAt: Date.now(),
          });
        }
      }

      // Clean up all pipeline task entries for this loop
      for (const key of this.pipelineTasks.keys()) {
        if (key.startsWith(`${loopId}:`)) {
          this.pipelineTasks.delete(key);
        }
      }

      this.logger.info('Loop cancelled', { loopId, reason });

      return ok(undefined);
    });
  }

  /**
   * Handle loop pause — update status, clear cooldown, optionally force-cancel current iteration
   * ARCHITECTURE: Graceful pause waits for current iteration to complete;
   * force pause cancels it immediately via TaskCancellationRequested
   */
  private async handleLoopPaused(event: LoopPausedEvent): Promise<void> {
    await this.handleEvent(event, async (e) => {
      const { loopId, force } = e;

      this.logger.info('Processing loop pause', { loopId, force });

      // Fetch current loop state
      const loopResult = await this.loopRepo.findById(loopId);
      if (!loopResult.ok || !loopResult.value) {
        this.logger.warn('Loop not found for pause', { loopId });
        return ok(undefined);
      }

      const loop = loopResult.value;

      // Defense-in-depth: only RUNNING loops can be paused
      // LoopManagerService validates this, but handler is reachable via direct EventBus emission
      if (loop.status !== LoopStatus.RUNNING) {
        this.logger.warn('Cannot pause loop that is not running', {
          loopId,
          currentStatus: loop.status,
        });
        return ok(undefined);
      }

      // Update loop status to PAUSED
      const updatedLoop = updateLoop(loop, { status: LoopStatus.PAUSED });
      await this.loopRepo.update(updatedLoop);

      // Clear cooldown timer if exists
      const timer = this.cooldownTimers.get(loopId);
      if (timer) {
        clearTimeout(timer);
        this.cooldownTimers.delete(loopId);
        this.logger.debug('Cleared cooldown timer for paused loop', { loopId });
      }

      // If force pause: cancel current running iteration and its task
      if (force) {
        await this.forceCancelCurrentIteration(loopId);
      }

      this.logger.info('Loop paused', { loopId, force });

      return ok(undefined);
    });
  }

  /**
   * Handle loop resume — update status to RUNNING and re-derive correct action via recovery
   * ARCHITECTURE: Reuses recoverSingleLoop() to handle all resume cases:
   * - Task completed while paused → recovery evaluates result, continues or completes
   * - Task still running (graceful pause) → re-registers in taskToLoop map, waits
   * - Iteration was cancelled by force pause → starts next iteration
   */
  private async handleLoopResumed(event: LoopResumedEvent): Promise<void> {
    await this.handleEvent(event, async (e) => {
      const { loopId } = e;

      this.logger.info('Processing loop resume', { loopId });

      // Fetch current loop state
      const loopResult = await this.loopRepo.findById(loopId);
      if (!loopResult.ok || !loopResult.value) {
        this.logger.warn('Loop not found for resume', { loopId });
        return ok(undefined);
      }

      const loop = loopResult.value;

      // Update loop status to RUNNING
      const updatedLoop = updateLoop(loop, { status: LoopStatus.RUNNING });
      await this.loopRepo.update(updatedLoop);

      // Reuse recovery logic to derive the correct next action
      await this.recoverSingleLoop(updatedLoop);

      this.logger.info('Loop resumed', { loopId });

      return ok(undefined);
    });
  }

  // ============================================================================
  // CORE ITERATION ENGINE
  // ============================================================================

  /**
   * Start the next iteration of a loop
   * ARCHITECTURE: Atomic iteration increment via runInTransaction prevents R4 double-start
   */
  private async startNextIteration(loop: Loop): Promise<void> {
    const loopId = loop.id;

    // Atomically increment currentIteration
    const txResult = this.database.runInTransaction(() => {
      const current = this.loopRepo.findByIdSync(loopId);
      if (!current) {
        throw new BackbeatError(ErrorCode.TASK_NOT_FOUND, `Loop ${loopId} not found in transaction`);
      }
      if (current.status !== LoopStatus.RUNNING) {
        throw new BackbeatError(ErrorCode.INVALID_OPERATION, `Loop ${loopId} not running (status: ${current.status})`);
      }

      const newIteration = current.currentIteration + 1;
      const updated = updateLoop(current, { currentIteration: newIteration });
      this.loopRepo.updateSync(updated);
      return { updatedLoop: updated, iterationNumber: newIteration };
    });

    if (!txResult.ok) {
      this.logger.error('Failed to start next iteration', txResult.error, { loopId });
      return;
    }

    const { updatedLoop, iterationNumber } = txResult.value;

    this.logger.info('Starting iteration', {
      loopId,
      iterationNumber,
      strategy: updatedLoop.strategy,
    });

    // Git commit-per-iteration (v0.8.1)
    let preIterationCommitSha: string | undefined;
    const isGitLoop = !!(updatedLoop.gitBranch || updatedLoop.gitStartCommitSha);
    if (isGitLoop) {
      // Create branch ONCE on first iteration only
      if (iterationNumber === 1 && updatedLoop.gitBranch) {
        const branchResult = await createAndCheckoutBranch(
          updatedLoop.workingDirectory,
          updatedLoop.gitBranch,
          updatedLoop.gitBaseBranch,
        );
        if (branchResult.ok) {
          this.logger.info('Created git branch for loop', {
            loopId,
            branchName: updatedLoop.gitBranch,
            baseBranch: updatedLoop.gitBaseBranch,
          });
        } else {
          this.logger.warn('Failed to create git branch for loop, continuing without git', {
            loopId,
            branchName: updatedLoop.gitBranch,
            error: branchResult.error.message,
          });
        }
      } else if (iterationNumber > 1 && updatedLoop.gitBranch) {
        // Re-checkout the loop's branch (user/agent may have switched)
        const checkoutResult = await createAndCheckoutBranch(updatedLoop.workingDirectory, updatedLoop.gitBranch);
        if (!checkoutResult.ok) {
          this.logger.warn('Failed to re-checkout loop branch, continuing without git', {
            loopId,
            branchName: updatedLoop.gitBranch,
            error: checkoutResult.error.message,
          });
        }
      }

      // Capture pre-iteration commit SHA for revert/diff baseline
      const shaResult = await getCurrentCommitSha(updatedLoop.workingDirectory);
      if (shaResult.ok) {
        preIterationCommitSha = shaResult.value;
        this.logger.debug('Captured pre-iteration commit SHA', {
          loopId,
          iterationNumber,
          preIterationCommitSha,
        });
      } else {
        this.logger.warn('Failed to capture pre-iteration commit SHA', {
          loopId,
          iterationNumber,
          error: shaResult.error.message,
        });
      }
    }

    if (updatedLoop.pipelineSteps && updatedLoop.pipelineSteps.length > 0) {
      await this.startPipelineIteration(updatedLoop, iterationNumber, preIterationCommitSha);
    } else {
      await this.startSingleTaskIteration(updatedLoop, iterationNumber, preIterationCommitSha);
    }
  }

  /**
   * Start a single-task iteration
   * ARCHITECTURE: Creates task from template, emits TaskDelegated, tracks in taskToLoop
   */
  private async startSingleTaskIteration(
    loop: Loop,
    iterationNumber: number,
    preIterationCommitSha?: string,
  ): Promise<void> {
    const loopId = loop.id;
    let prompt = loop.taskTemplate.prompt;

    // If !freshContext: fetch previous iteration's checkpoint and enrich prompt (R2)
    if (!loop.freshContext && iterationNumber > 1) {
      prompt = await this.enrichPromptWithCheckpoint(loop, iterationNumber, prompt);
    }

    // Create task from template
    const task = createTask({
      ...loop.taskTemplate,
      prompt,
      workingDirectory: loop.workingDirectory,
    });

    // Build iteration record
    const iteration: LoopIteration = {
      id: 0, // Auto-increment
      loopId,
      iterationNumber,
      taskId: task.id,
      preIterationCommitSha,
      status: 'running',
      startedAt: Date.now(),
    };

    // Atomic: save task BEFORE recording iteration (FK constraint: iteration.task_id -> tasks.id)
    const txResult = this.database.runInTransaction(() => {
      this.taskRepo.saveSync(task);
      this.loopRepo.recordIterationSync(iteration);
    });

    if (!txResult.ok) {
      this.logger.error('Failed to save task and record iteration atomically', txResult.error, {
        loopId,
        iterationNumber,
        taskId: task.id,
      });
      return;
    }

    // Track task → loop mapping AFTER successful transaction
    this.taskToLoop.set(task.id, loopId);

    // Emit TaskDelegated event AFTER transaction commit
    const emitResult = await this.eventBus.emit('TaskDelegated', { task });
    if (!emitResult.ok) {
      this.logger.error('Failed to emit TaskDelegated for loop iteration', emitResult.error, {
        loopId,
        iterationNumber,
        taskId: task.id,
      });
    }

    this.logger.info('Single-task iteration started', {
      loopId,
      iterationNumber,
      taskId: task.id,
    });
  }

  /**
   * Start a pipeline iteration
   * ARCHITECTURE: Replicates ScheduleHandler.handlePipelineTrigger() pattern
   * Pre-creates N task objects with linear dependsOn chain, saves atomically,
   * emits TaskDelegated for each, tracks ALL tasks in taskToLoop for intermediate failure handling
   */
  private async startPipelineIteration(
    loop: Loop,
    iterationNumber: number,
    preIterationCommitSha?: string,
  ): Promise<void> {
    const loopId = loop.id;
    const steps = loop.pipelineSteps!;
    const defaults = loop.taskTemplate;

    this.logger.info('Starting pipeline iteration', {
      loopId,
      iterationNumber,
      stepCount: steps.length,
    });

    // Pre-create ALL task domain objects OUTSIDE transaction (pure computation)
    const tasks: Task[] = [];
    for (let i = 0; i < steps.length; i++) {
      tasks.push(
        createTask({
          prompt: steps[i],
          priority: defaults.priority,
          workingDirectory: loop.workingDirectory,
          agent: defaults.agent,
          dependsOn: i > 0 ? [tasks[i - 1].id] : undefined,
        }),
      );
    }

    const allTaskIds = tasks.map((t) => t.id);
    const lastTaskId = tasks[tasks.length - 1].id;

    // Atomic: save N tasks + record iteration
    const txResult = this.database.runInTransaction(() => {
      for (let i = 0; i < tasks.length; i++) {
        try {
          this.taskRepo.saveSync(tasks[i]);
        } catch (error) {
          throw new BackbeatError(
            ErrorCode.SYSTEM_ERROR,
            `Pipeline iteration failed at step ${i + 1}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      this.loopRepo.recordIterationSync({
        id: 0, // Auto-increment
        loopId,
        iterationNumber,
        taskId: lastTaskId,
        pipelineTaskIds: allTaskIds,
        preIterationCommitSha,
        status: 'running',
        startedAt: Date.now(),
      });
    });

    if (!txResult.ok) {
      this.logger.error('Failed to save pipeline iteration atomically', txResult.error, {
        loopId,
        iterationNumber,
      });
      return;
    }

    // Track ALL pipeline tasks in taskToLoop for intermediate failure handling
    for (const t of tasks) {
      this.taskToLoop.set(t.id, loopId);
    }

    // Track all pipeline tasks for cleanup
    const pipelineKey = `${loopId}:${iterationNumber}`;
    this.pipelineTasks.set(pipelineKey, new Set(allTaskIds));

    // Emit TaskDelegated for each task AFTER commit
    for (let i = 0; i < tasks.length; i++) {
      const emitResult = await this.eventBus.emit('TaskDelegated', { task: tasks[i] });
      if (!emitResult.ok) {
        this.logger.error('Failed to emit TaskDelegated for pipeline step', emitResult.error, {
          loopId,
          iterationNumber,
          step: i,
          taskId: tasks[i].id,
        });
        // Step 0 failure is critical — cannot proceed
        if (i === 0) {
          return;
        }
      }
    }

    this.logger.info('Pipeline iteration started', {
      loopId,
      iterationNumber,
      stepCount: steps.length,
      tailTaskId: lastTaskId,
    });
  }

  // ============================================================================
  // ITERATION RESULT HANDLING
  // ============================================================================

  /**
   * Process the result of an iteration's exit condition evaluation
   * ARCHITECTURE: Determines whether to continue, complete, or fail the loop
   */
  private async handleIterationResult(loop: Loop, iteration: LoopIteration, evalResult: EvalResult): Promise<void> {
    if (loop.strategy === LoopStrategy.RETRY) {
      await this.handleRetryResult(loop, iteration, evalResult);
    } else {
      await this.handleOptimizeResult(loop, iteration, evalResult);
    }
  }

  /**
   * Handle retry strategy iteration result
   * - pass → complete loop with success
   * - fail → increment consecutiveFailures, check limits
   */
  private async handleRetryResult(loop: Loop, iteration: LoopIteration, evalResult: EvalResult): Promise<void> {
    if (evalResult.passed) {
      // Git: commit changes before persisting pass result (v0.8.1)
      let gitCommitSha: string | undefined;
      let gitDiffSummary: string | undefined;
      if (iteration.preIterationCommitSha) {
        try {
          const gitResult = await this.commitAndCaptureDiff(loop, iteration, 'pass');
          gitCommitSha = gitResult.gitCommitSha;
          gitDiffSummary = gitResult.gitDiffSummary;
        } catch (gitError) {
          this.logger.warn('Git commit failed on retry pass, continuing without git', {
            loopId: loop.id,
            error: gitError instanceof Error ? gitError.message : String(gitError),
          });
        }
      }

      // Atomic: iteration pass + loop completion in single transaction
      const txResult = this.database.runInTransaction(() => {
        this.loopRepo.updateIterationSync({
          ...iteration,
          status: 'pass',
          exitCode: evalResult.exitCode,
          gitCommitSha,
          gitDiffSummary,
          completedAt: Date.now(),
        });
        this.loopRepo.updateSync(
          updateLoop(loop, {
            status: LoopStatus.COMPLETED,
            completedAt: Date.now(),
          }),
        );
      });

      if (!txResult.ok) {
        this.logger.error('Failed to persist pass result', txResult.error, { loopId: loop.id });
        await this.completeLoop(loop, LoopStatus.FAILED, 'Failed to persist pass result');
        return;
      }

      // Post-commit: cleanup (timer, event) — double-write on loop row is harmless
      await this.completeLoop(loop, LoopStatus.COMPLETED, 'Exit condition passed');
      return;
    }

    // Exit condition failed — increment consecutiveFailures
    const newConsecutiveFailures = loop.consecutiveFailures + 1;

    await this.recordAndContinue(
      loop,
      iteration,
      'fail',
      newConsecutiveFailures,
      { consecutiveFailures: newConsecutiveFailures },
      { exitCode: evalResult.exitCode, errorMessage: evalResult.error },
    );
  }

  /**
   * Handle optimize strategy iteration result
   * - First iteration: always 'keep' as baseline (R5)
   * - Better score → 'keep', update bestScore
   * - Equal or worse → 'discard', increment consecutiveFailures
   * - NaN/Infinity → 'crash'
   */
  private async handleOptimizeResult(loop: Loop, iteration: LoopIteration, evalResult: EvalResult): Promise<void> {
    const loopId = loop.id;
    const iterationNumber = iteration.iterationNumber;

    // Check for crash (NaN/Infinity or exec failure in optimize mode)
    if (!evalResult.passed || evalResult.score === undefined) {
      const newConsecutiveFailures = loop.consecutiveFailures + 1;

      await this.recordAndContinue(
        loop,
        iteration,
        'crash',
        newConsecutiveFailures,
        { consecutiveFailures: newConsecutiveFailures },
        { exitCode: evalResult.exitCode, errorMessage: evalResult.error },
      );
      return;
    }

    const score = evalResult.score;

    // First iteration or no bestScore yet: always 'keep' as baseline (R5)
    if (loop.bestScore === undefined) {
      await this.recordAndContinue(
        loop,
        iteration,
        'keep',
        0,
        { bestScore: score, bestIterationId: iterationNumber, consecutiveFailures: 0 },
        { score, exitCode: evalResult.exitCode },
      );
      this.logger.info('Baseline score established', { loopId, score, iterationNumber });
      return;
    }

    // Compare score (respecting direction)
    const isBetter = this.isScoreBetter(score, loop.bestScore, loop.evalDirection);

    if (isBetter) {
      // Better score → 'keep'
      this.logger.info('New best score', {
        loopId,
        score,
        previousBest: loop.bestScore,
        iterationNumber,
      });

      await this.recordAndContinue(
        loop,
        iteration,
        'keep',
        0,
        { bestScore: score, bestIterationId: iterationNumber, consecutiveFailures: 0 },
        { score, exitCode: evalResult.exitCode },
      );
    } else {
      // Equal or worse → 'discard'
      const newConsecutiveFailures = loop.consecutiveFailures + 1;

      await this.recordAndContinue(
        loop,
        iteration,
        'discard',
        newConsecutiveFailures,
        { consecutiveFailures: newConsecutiveFailures },
        { score, exitCode: evalResult.exitCode },
      );
    }
  }

  // ============================================================================
  // HELPERS
  // ============================================================================

  /**
   * Force-cancel the current running iteration and all its tasks.
   * ARCHITECTURE: Extracted from handleLoopPaused() to reduce nesting.
   */
  private async forceCancelCurrentIteration(loopId: LoopId): Promise<void> {
    const iterationsResult = await this.loopRepo.getIterations(loopId, 1);
    if (!iterationsResult.ok || iterationsResult.value.length === 0) return;

    const latestIteration = iterationsResult.value[0];
    if (latestIteration.status !== 'running') return;

    // Mark iteration as cancelled
    await this.loopRepo.updateIteration({
      ...latestIteration,
      status: 'cancelled',
      completedAt: Date.now(),
    });

    // Cancel the in-flight task
    if (latestIteration.taskId) {
      const cancelResult = await this.eventBus.emit('TaskCancellationRequested', {
        taskId: latestIteration.taskId,
        reason: `Loop ${loopId} force paused`,
      });
      if (!cancelResult.ok) {
        this.logger.warn('Failed to cancel task for force-paused loop', {
          taskId: latestIteration.taskId,
          loopId,
          error: cancelResult.error.message,
        });
      }
    }

    // Also cancel pipeline tasks if it's a pipeline iteration
    if (latestIteration.pipelineTaskIds) {
      for (const ptId of latestIteration.pipelineTaskIds) {
        if (ptId === latestIteration.taskId) continue; // Already cancelled above
        await this.eventBus.emit('TaskCancellationRequested', {
          taskId: ptId,
          reason: `Loop ${loopId} force paused`,
        });
      }
    }

    this.logger.info('Force-cancelled running iteration', {
      loopId,
      iterationNumber: latestIteration.iterationNumber,
    });
  }

  /**
   * Check termination conditions (maxIterations, maxConsecutiveFailures)
   * @returns true if loop was terminated, false if it should continue
   */
  private async checkTerminationConditions(loop: Loop, consecutiveFailures: number): Promise<boolean> {
    // Check maxIterations
    if (loop.maxIterations > 0 && loop.currentIteration >= loop.maxIterations) {
      this.logger.info('Loop reached maxIterations', {
        loopId: loop.id,
        currentIteration: loop.currentIteration,
        maxIterations: loop.maxIterations,
      });

      const reason =
        loop.strategy === LoopStrategy.OPTIMIZE
          ? `Max iterations reached (best score: ${loop.bestScore})`
          : 'Max iterations reached';
      await this.completeLoop(loop, LoopStatus.COMPLETED, reason);
      return true;
    }

    // Check maxConsecutiveFailures
    if (loop.maxConsecutiveFailures > 0 && consecutiveFailures >= loop.maxConsecutiveFailures) {
      this.logger.info('Loop reached max consecutive failures', {
        loopId: loop.id,
        consecutiveFailures,
        maxConsecutiveFailures: loop.maxConsecutiveFailures,
      });
      await this.completeLoop(loop, LoopStatus.FAILED, 'Max consecutive failures reached', {
        consecutiveFailures,
      });
      return true;
    }

    return false;
  }

  /**
   * Complete a loop with a final status and reason
   */
  private async completeLoop(
    loop: Loop,
    status: LoopStatus,
    reason: string,
    extraUpdate?: Partial<Loop>,
  ): Promise<void> {
    const updatedLoop = updateLoop(loop, {
      status,
      completedAt: Date.now(),
      ...extraUpdate,
    });
    await this.loopRepo.update(updatedLoop);

    // Clear cooldown timer if exists
    const timer = this.cooldownTimers.get(loop.id);
    if (timer) {
      clearTimeout(timer);
      this.cooldownTimers.delete(loop.id);
    }

    await this.eventBus.emit('LoopCompleted', {
      loopId: loop.id,
      reason,
    });

    this.logger.info('Loop completed', {
      loopId: loop.id,
      status,
      reason,
      totalIterations: loop.currentIteration,
      bestScore: loop.bestScore,
    });
  }

  /**
   * Schedule the next iteration, respecting cooldown (R14)
   * ARCHITECTURE: Uses setTimeout with .unref() to avoid blocking process exit
   * Skips scheduling if loop is PAUSED — result was recorded, resume will re-derive action
   */
  private async scheduleNextIteration(loop: Loop): Promise<void> {
    // If loop is paused, skip scheduling — iteration result is already recorded.
    // Resume handler will re-derive the correct next action via recoverSingleLoop().
    if (loop.status === LoopStatus.PAUSED) {
      this.logger.debug('Loop is paused, skipping next iteration scheduling', {
        loopId: loop.id,
      });
      return;
    }

    if (loop.cooldownMs > 0) {
      this.logger.debug('Scheduling next iteration with cooldown', {
        loopId: loop.id,
        cooldownMs: loop.cooldownMs,
      });

      const timer = setTimeout(() => {
        this.startNextIteration(loop).catch((error) => {
          this.logger.error(
            'Failed to start next iteration after cooldown',
            error instanceof Error ? error : undefined,
            {
              loopId: loop.id,
            },
          );
        });
      }, loop.cooldownMs);

      // R14: Don't block process exit
      timer.unref();

      this.cooldownTimers.set(loop.id, timer);
    } else {
      await this.startNextIteration(loop);
    }
  }

  /**
   * Record iteration result, emit event, check termination, update loop, and schedule next
   * ARCHITECTURE: Reduces duplication across 5 non-terminal iteration branches
   */
  private async recordAndContinue(
    loop: Loop,
    iteration: LoopIteration,
    iterationStatus: LoopIteration['status'],
    consecutiveFailures: number,
    loopUpdate: Partial<Loop>,
    evalResult?: { score?: number; exitCode?: number; errorMessage?: string },
  ): Promise<void> {
    const updatedLoop = updateLoop(loop, loopUpdate);

    // Git commit/revert (v0.8.1): commit on pass/keep, revert on fail/discard/crash
    let gitCommitSha: string | undefined;
    let gitDiffSummary: string | undefined;
    if (iteration.preIterationCommitSha) {
      try {
        const isCommitPath = iterationStatus === 'pass' || iterationStatus === 'keep';
        if (isCommitPath) {
          const gitResult = await this.commitAndCaptureDiff(loop, iteration, iterationStatus);
          gitCommitSha = gitResult.gitCommitSha;
          gitDiffSummary = gitResult.gitDiffSummary;
        } else {
          // Discard path: reset to the appropriate target
          const resetTarget = await this.getResetTargetSha(loop);
          if (resetTarget) {
            const resetResult = await resetToCommit(loop.workingDirectory, resetTarget);
            if (!resetResult.ok) {
              this.logger.warn('Failed to reset to commit after iteration failure', {
                loopId: loop.id,
                iterationNumber: iteration.iterationNumber,
                resetTarget,
                error: resetResult.error.message,
              });
            }
          }
          // gitCommitSha stays undefined for discarded iterations
        }
      } catch (gitError) {
        this.logger.warn('Git operation failed in recordAndContinue, continuing without git', {
          loopId: loop.id,
          iterationNumber: iteration.iterationNumber,
          error: gitError instanceof Error ? gitError.message : String(gitError),
        });
      }
    }

    // Atomic: both DB writes in single transaction
    const txResult = this.database.runInTransaction(() => {
      this.loopRepo.updateIterationSync({
        ...iteration,
        status: iterationStatus,
        score: evalResult?.score ?? iteration.score,
        exitCode: evalResult?.exitCode ?? iteration.exitCode,
        errorMessage: evalResult?.errorMessage ?? iteration.errorMessage,
        gitCommitSha,
        gitDiffSummary: gitDiffSummary ?? iteration.gitDiffSummary,
        completedAt: Date.now(),
      });
      this.loopRepo.updateSync(updatedLoop);
    });

    if (!txResult.ok) {
      this.logger.error('Failed to record iteration result', txResult.error, { loopId: loop.id });
      await this.completeLoop(loop, LoopStatus.FAILED, 'Failed to persist iteration result');
      return;
    }

    // Event AFTER commit (matches schedule-handler pattern)
    await this.eventBus.emit('LoopIterationCompleted', {
      loopId: loop.id,
      iterationNumber: iteration.iterationNumber,
      result: { ...iteration, status: iterationStatus },
    });

    // Check termination conditions (using updated loop for correct state)
    if (await this.checkTerminationConditions(updatedLoop, consecutiveFailures)) {
      return;
    }

    // Schedule next iteration
    await this.scheduleNextIteration(updatedLoop);
  }

  /**
   * Compare scores respecting optimize direction.
   * Uses strict comparison — equal scores are NOT "better".
   * This prevents infinite loops when a deterministic metric produces the same
   * score repeatedly. Equal scores increment consecutiveFailures, eventually
   * triggering maxConsecutiveFailures completion.
   */
  private isScoreBetter(newScore: number, bestScore: number, direction?: OptimizeDirection): boolean {
    if (direction === OptimizeDirection.MINIMIZE) {
      return newScore < bestScore;
    }
    // Default: MAXIMIZE
    return newScore > bestScore;
  }

  /**
   * Commit all changes and capture diff summary for an iteration.
   * Handles both explicit commits and agent-already-committed cases.
   * @returns { gitCommitSha, gitDiffSummary } — either or both may be undefined on failure
   */
  private async commitAndCaptureDiff(
    loop: Loop,
    iteration: LoopIteration,
    iterationStatus: string,
  ): Promise<{ gitCommitSha?: string; gitDiffSummary?: string }> {
    let gitCommitSha: string | undefined;
    let gitDiffSummary: string | undefined;

    const commitResult = await commitAllChanges(
      loop.workingDirectory,
      `Loop ${loop.id} iteration ${iteration.iterationNumber} — ${iterationStatus}`,
    );
    if (commitResult.ok && commitResult.value) {
      gitCommitSha = commitResult.value;
    } else if (commitResult.ok) {
      // null = nothing to commit (agent already committed)
      const shaResult = await getCurrentCommitSha(loop.workingDirectory);
      if (shaResult.ok) {
        gitCommitSha = shaResult.value;
      }
    } else {
      this.logger.warn('Failed to commit iteration changes', {
        loopId: loop.id,
        iterationNumber: iteration.iterationNumber,
        error: commitResult.error.message,
      });
    }

    // Capture diff summary between pre-iteration and new commit
    if (gitCommitSha && iteration.preIterationCommitSha) {
      const diffResult = await captureGitDiff(loop.workingDirectory, iteration.preIterationCommitSha, gitCommitSha);
      if (diffResult.ok && diffResult.value) {
        gitDiffSummary = diffResult.value;
      }
    }

    return { gitCommitSha, gitDiffSummary };
  }

  /**
   * Determine the commit SHA to reset to after a failed/discarded iteration.
   * - Retry fail: reset to loop.gitStartCommitSha (start fresh)
   * - Optimize discard/crash: reset to best iteration's gitCommitSha if available,
   *   fallback to loop.gitStartCommitSha
   * @returns SHA to reset to, or undefined if no git tracking
   */
  private async getResetTargetSha(loop: Loop): Promise<string | undefined> {
    // For optimize strategy: try to reset to the best iteration's commit
    if (loop.strategy === LoopStrategy.OPTIMIZE && loop.bestIterationId !== undefined) {
      const iterationsResult = await this.loopRepo.getIterations(loop.id, 100);
      if (iterationsResult.ok) {
        const bestIteration = iterationsResult.value.find((i) => i.iterationNumber === loop.bestIterationId);
        if (bestIteration?.gitCommitSha) {
          return bestIteration.gitCommitSha;
        }
      }
    }

    // Fallback: reset to the loop's start commit SHA
    return loop.gitStartCommitSha;
  }

  /**
   * Enrich prompt with checkpoint context from previous iteration (R2)
   * ARCHITECTURE: NO dependsOn for iteration chaining — LoopHandler manages sequencing directly
   */
  private async enrichPromptWithCheckpoint(loop: Loop, iterationNumber: number, prompt: string): Promise<string> {
    // Get the 2 most recent iterations (ordered by iteration_number DESC):
    // the current iteration we just started + the previous one for checkpoint context
    const iterationsResult = await this.loopRepo.getIterations(loop.id, 2, 0);
    if (!iterationsResult.ok || iterationsResult.value.length === 0) {
      return prompt;
    }

    // Find the previous iteration (must be terminal, not still running)
    const previousIteration = iterationsResult.value.find(
      (i) => i.iterationNumber === iterationNumber - 1 && i.status !== 'running',
    );
    if (!previousIteration) {
      return prompt;
    }

    // Skip if previous iteration's task was cleaned up (ON DELETE SET NULL)
    if (!previousIteration.taskId) {
      return prompt;
    }

    // Fetch checkpoint for previous iteration's task
    const checkpointResult = await this.checkpointRepo.findLatest(previousIteration.taskId);
    if (!checkpointResult.ok || !checkpointResult.value) {
      this.logger.debug('No checkpoint available for previous iteration', {
        loopId: loop.id,
        previousTaskId: previousIteration.taskId,
      });
      return prompt;
    }

    const checkpoint = checkpointResult.value;
    const contextParts: string[] = [prompt, '', '--- Previous Iteration Context ---'];

    if (checkpoint.outputSummary) {
      contextParts.push(`Output: ${checkpoint.outputSummary}`);
    }
    if (checkpoint.errorSummary) {
      contextParts.push(`Errors: ${checkpoint.errorSummary}`);
    }
    if (checkpoint.gitCommitSha) {
      contextParts.push(`Git commit: ${checkpoint.gitCommitSha}`);
    }

    contextParts.push(`Iteration ${iterationNumber - 1} status: ${previousIteration.status}`);
    contextParts.push('---');

    return contextParts.join('\n');
  }

  /**
   * Handle a non-tail pipeline task terminal event
   * ARCHITECTURE: Intermediate task completion is a no-op; intermediate failure cancels remaining tasks
   * and fails the iteration to prevent the loop from getting stuck
   */
  private async handlePipelineIntermediateTask(
    event: TaskCompletedEvent | TaskFailedEvent,
    taskId: TaskId,
    loop: Loop,
  ): Promise<Result<void>> {
    const loopId = loop.id;

    // Get the latest iteration for this loop to verify this is indeed a pipeline intermediate task
    const iterationsResult = await this.loopRepo.getIterations(loopId, 1);
    if (!iterationsResult.ok || iterationsResult.value.length === 0) {
      this.taskToLoop.delete(taskId);
      return ok(undefined);
    }

    const iteration = iterationsResult.value[0];

    // Verify: must be a pipeline iteration with this taskId in pipelineTaskIds but NOT the tail task
    if (!iteration.pipelineTaskIds || !iteration.pipelineTaskIds.includes(taskId) || iteration.taskId === taskId) {
      this.logger.error('Iteration not found for terminal task', undefined, { taskId, loopId });
      this.taskToLoop.delete(taskId);
      return ok(undefined);
    }

    // Intermediate task completed successfully — just clean up tracking, no-op
    if (event.type === 'TaskCompleted') {
      this.logger.debug('Pipeline intermediate task completed', { taskId, loopId });
      this.taskToLoop.delete(taskId);
      return ok(undefined);
    }

    // Intermediate task FAILED — concurrent failure guard: only process if iteration is still running
    if (iteration.status !== 'running') {
      this.logger.debug('Pipeline iteration already terminal, ignoring intermediate failure', {
        taskId,
        loopId,
        iterationStatus: iteration.status,
      });
      this.taskToLoop.delete(taskId);
      return ok(undefined);
    }

    // Cancel remaining pipeline tasks
    const failedEvent = event as TaskFailedEvent;
    this.logger.info('Pipeline intermediate task failed, failing iteration', {
      taskId,
      loopId,
      iterationNumber: iteration.iterationNumber,
    });

    await this.cancelRemainingPipelineTasks(iteration.pipelineTaskIds, taskId, loopId);

    // Atomic: iteration fail + consecutiveFailures in single transaction
    const newConsecutiveFailures = loop.consecutiveFailures + 1;
    const updatedLoop = updateLoop(loop, { consecutiveFailures: newConsecutiveFailures });
    const txResult = this.database.runInTransaction(() => {
      this.loopRepo.updateIterationSync({
        ...iteration,
        status: 'fail',
        exitCode: failedEvent.exitCode,
        errorMessage: `Pipeline step failed: ${failedEvent.error?.message ?? 'Task failed'}`,
        completedAt: Date.now(),
      });
      this.loopRepo.updateSync(updatedLoop);
    });

    if (!txResult.ok) {
      this.logger.error('Failed to persist pipeline step failure', txResult.error, { loopId });
      await this.completeLoop(loop, LoopStatus.FAILED, 'Failed to persist pipeline step failure');
      return ok(undefined);
    }

    // Post-commit: check limits or schedule next
    if (loop.maxConsecutiveFailures > 0 && newConsecutiveFailures >= loop.maxConsecutiveFailures) {
      await this.completeLoop(updatedLoop, LoopStatus.FAILED, 'Max consecutive failures reached');
    } else {
      await this.scheduleNextIteration(updatedLoop);
    }

    // Clean up all pipeline task tracking
    this.cleanupPipelineTaskTracking(iteration);
    this.cleanupPipelineTasks(loopId, iteration.iterationNumber);

    return ok(undefined);
  }

  /**
   * Cancel remaining pipeline tasks after an intermediate step failure
   * Emits TaskCancellationRequested for each non-terminal pipeline task except the failed one
   */
  private async cancelRemainingPipelineTasks(
    pipelineTaskIds: readonly TaskId[],
    failedTaskId: TaskId,
    loopId: LoopId,
  ): Promise<void> {
    for (const ptId of pipelineTaskIds) {
      if (ptId === failedTaskId) continue;

      // Check if task is still running before cancelling
      const taskResult = await this.taskRepo.findById(ptId);
      if (!taskResult.ok || !taskResult.value) continue;
      if (isTerminalState(taskResult.value.status)) continue;

      const cancelResult = await this.eventBus.emit('TaskCancellationRequested', {
        taskId: ptId,
        reason: `Pipeline step ${failedTaskId} failed in loop ${loopId}`,
      });
      if (!cancelResult.ok) {
        this.logger.warn('Failed to cancel pipeline task', {
          taskId: ptId,
          loopId,
          error: cancelResult.error.message,
        });
      }

      this.taskToLoop.delete(ptId);
    }
  }

  /**
   * Clean up all pipeline task entries from taskToLoop for a completed/failed iteration
   */
  private cleanupPipelineTaskTracking(iteration: LoopIteration): void {
    if (iteration.pipelineTaskIds) {
      for (const ptId of iteration.pipelineTaskIds) {
        this.taskToLoop.delete(ptId);
      }
    }
  }

  /**
   * Clean up pipeline task entries for a completed iteration
   */
  private cleanupPipelineTasks(loopId: LoopId, iterationNumber: number): void {
    const key = `${loopId}:${iterationNumber}`;
    this.pipelineTasks.delete(key);
  }

  // ============================================================================
  // RECOVERY (R3)
  // ============================================================================

  /**
   * Rebuild in-memory maps from database on startup
   * ARCHITECTURE: Ensures LoopHandler can recover state after restart
   */
  private async rebuildMaps(): Promise<void> {
    // Rebuild taskToLoop from running iterations
    const runningResult = await this.loopRepo.findRunningIterations();
    if (!runningResult.ok) {
      this.logger.error('Failed to rebuild task-to-loop maps', runningResult.error);
      return;
    }

    for (const iteration of runningResult.value) {
      // Skip iterations with cleaned-up tasks (ON DELETE SET NULL)
      if (!iteration.taskId) continue;

      // Register ALL pipeline task IDs in taskToLoop for intermediate failure handling
      if (iteration.pipelineTaskIds && iteration.pipelineTaskIds.length > 0) {
        for (const ptId of iteration.pipelineTaskIds) {
          this.taskToLoop.set(ptId, iteration.loopId);
        }
        const key = `${iteration.loopId}:${iteration.iterationNumber}`;
        this.pipelineTasks.set(key, new Set(iteration.pipelineTaskIds));
      } else {
        this.taskToLoop.set(iteration.taskId, iteration.loopId);
      }
    }

    this.logger.info('Rebuilt in-memory maps', {
      taskToLoopSize: this.taskToLoop.size,
      pipelineTasksSize: this.pipelineTasks.size,
    });
  }

  /**
   * Recover stuck loops — find running loops whose latest iteration task is terminal
   * ARCHITECTURE: Self-healing on startup regardless of RecoveryManager timing
   */
  private async recoverStuckLoops(): Promise<void> {
    const runningLoopsResult = await this.loopRepo.findByStatus(LoopStatus.RUNNING);
    if (!runningLoopsResult.ok) {
      this.logger.error('Failed to fetch running loops for recovery', runningLoopsResult.error);
      return;
    }

    for (const loop of runningLoopsResult.value) {
      await this.recoverSingleLoop(loop);
    }

    this.logger.info('Loop recovery complete');
  }

  /**
   * Recover a single loop — check latest iteration status and handle terminal task states
   * ARCHITECTURE: Early-return style for readability (flattened from nested if/else)
   */
  private async recoverSingleLoop(loop: Loop): Promise<void> {
    const iterationsResult = await this.loopRepo.getIterations(loop.id, 1);
    if (!iterationsResult.ok || iterationsResult.value.length === 0) {
      this.logger.info('Recovering loop with no iterations', { loopId: loop.id });
      await this.startNextIteration(loop);
      return;
    }

    const latestIteration = iterationsResult.value[0];

    // Iteration is terminal but loop is still RUNNING — server crashed between
    // DB commit and the post-commit action (completeLoop or scheduleNextIteration).
    // Re-derive the correct action from the iteration's terminal status.
    if (latestIteration.status !== 'running') {
      this.logger.info('Recovering loop with terminal iteration', {
        loopId: loop.id,
        iterationStatus: latestIteration.status,
        iterationNumber: latestIteration.iterationNumber,
      });

      if (latestIteration.status === 'pass') {
        // Exit condition was satisfied — complete the loop
        await this.completeLoop(loop, LoopStatus.COMPLETED, 'Recovered: exit condition already passed');
        return;
      }

      // fail / discard / crash / keep / cancelled — check termination, then continue
      // Loop's consecutiveFailures is already correct (committed atomically with iteration)
      if (await this.checkTerminationConditions(loop, loop.consecutiveFailures)) {
        return;
      }
      await this.startNextIteration(loop);
      return;
    }

    // Task was cleaned up (ON DELETE SET NULL) — mark iteration cancelled and move on
    if (!latestIteration.taskId) {
      this.logger.warn('Running iteration has no task ID, marking as cancelled', {
        loopId: loop.id,
        iterationNumber: latestIteration.iterationNumber,
      });
      await this.loopRepo.updateIteration({
        ...latestIteration,
        status: 'cancelled',
        completedAt: Date.now(),
      });
      await this.startNextIteration(loop);
      return;
    }

    const taskResult = await this.taskRepo.findById(latestIteration.taskId);
    if (!taskResult.ok || !taskResult.value) {
      return;
    }

    // Task still running — will complete normally via event handler
    if (!isTerminalState(taskResult.value.status)) {
      return;
    }

    const task = taskResult.value;
    this.logger.info('Recovering stuck iteration', {
      loopId: loop.id,
      taskId: task.id,
      taskStatus: task.status,
      iterationNumber: latestIteration.iterationNumber,
    });

    if (task.status === TaskStatus.COMPLETED) {
      const evalResult = await this.exitConditionEvaluator.evaluate(loop, task.id);
      await this.handleIterationResult(loop, latestIteration, evalResult);
      return;
    }

    if (task.status === TaskStatus.FAILED) {
      const newConsecutiveFailures = loop.consecutiveFailures + 1;

      // Atomic: iteration fail + consecutiveFailures in single transaction
      const updatedLoop = updateLoop(loop, { consecutiveFailures: newConsecutiveFailures });
      const txResult = this.database.runInTransaction(() => {
        this.loopRepo.updateIterationSync({
          ...latestIteration,
          status: 'fail',
          completedAt: Date.now(),
        });
        this.loopRepo.updateSync(updatedLoop);
      });

      if (!txResult.ok) {
        this.logger.error('Failed to persist recovery failure', txResult.error, { loopId: loop.id });
        await this.completeLoop(loop, LoopStatus.FAILED, 'Failed to persist recovery failure');
        return;
      }

      // Post-commit: check limits or schedule next
      if (loop.maxConsecutiveFailures > 0 && newConsecutiveFailures >= loop.maxConsecutiveFailures) {
        await this.completeLoop(updatedLoop, LoopStatus.FAILED, 'Max consecutive failures reached (recovered)');
      } else {
        await this.scheduleNextIteration(updatedLoop);
      }
      return;
    }

    // CANCELLED — mark iteration as cancelled and continue
    await this.loopRepo.updateIteration({
      ...latestIteration,
      status: 'cancelled',
      completedAt: Date.now(),
    });
    if (await this.checkTerminationConditions(loop, loop.consecutiveFailures)) {
      return;
    }
    await this.startNextIteration(loop);
  }
}
