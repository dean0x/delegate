/**
 * Loop handler for iterative task/pipeline execution
 * ARCHITECTURE: Event-driven iteration engine for v0.7.0 task loops
 * Pattern: Factory pattern for async initialization (matches ScheduleHandler)
 * Rationale: Manages loop lifecycle, iteration dispatch, exit condition evaluation,
 *   and crash recovery — all driven by events from task completion/failure
 */

import { execSync } from 'child_process';
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
  TaskCancelledEvent,
  TaskCompletedEvent,
  TaskFailedEvent,
} from '../../core/events/events.js';
import { BaseEventHandler } from '../../core/events/handlers.js';
import type {
  CheckpointRepository,
  Logger,
  LoopRepository,
  SyncLoopOperations,
  SyncTaskOperations,
  TaskRepository,
  TransactionRunner,
} from '../../core/interfaces.js';
import { err, ok, type Result } from '../../core/result.js';

/**
 * Exit condition evaluation result
 * ARCHITECTURE: Discriminated by strategy — retry returns pass/fail, optimize returns score
 */
interface EvalResult {
  readonly passed: boolean;
  readonly score?: number;
  readonly exitCode?: number;
  readonly error?: string;
}

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
    logger: Logger,
  ): Promise<Result<LoopHandler, BackbeatError>> {
    const handlerLogger = logger.child ? logger.child({ module: 'LoopHandler' }) : logger;

    const handler = new LoopHandler(loopRepo, taskRepo, checkpointRepo, eventBus, database, handlerLogger);

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
      if (loop.status !== LoopStatus.RUNNING) {
        this.logger.debug('Loop not running, ignoring terminal event', {
          loopId,
          status: loop.status,
          taskId,
        });
        // Clean up tracking
        this.taskToLoop.delete(taskId);
        return ok(undefined);
      }

      // Get the iteration record for this task
      const iterationResult = await this.loopRepo.findIterationByTaskId(taskId);
      if (!iterationResult.ok || !iterationResult.value) {
        this.logger.error('Iteration not found for terminal task', undefined, { taskId, loopId });
        return ok(undefined);
      }

      const iteration = iterationResult.value;

      // Determine outcome based on event type
      const isTaskFailed = event.type === 'TaskFailed';

      if (isTaskFailed) {
        // Task FAILED — record failure, check limits
        const failedEvent = event as TaskFailedEvent;
        const newConsecutiveFailures = loop.consecutiveFailures + 1;

        // Record iteration as 'fail'
        await this.loopRepo.updateIteration({
          ...iteration,
          status: 'fail',
          exitCode: failedEvent.exitCode,
          errorMessage: failedEvent.error?.message ?? 'Task failed',
          completedAt: Date.now(),
        });

        // Check maxConsecutiveFailures limit
        if (loop.maxConsecutiveFailures > 0 && newConsecutiveFailures >= loop.maxConsecutiveFailures) {
          this.logger.info('Loop reached max consecutive failures', {
            loopId,
            consecutiveFailures: newConsecutiveFailures,
            maxConsecutiveFailures: loop.maxConsecutiveFailures,
          });
          await this.completeLoop(loop, LoopStatus.FAILED, 'Max consecutive failures reached', {
            consecutiveFailures: newConsecutiveFailures,
          });
        } else {
          // Update consecutive failures and continue
          const updatedLoop = updateLoop(loop, { consecutiveFailures: newConsecutiveFailures });
          await this.loopRepo.update(updatedLoop);
          await this.scheduleNextIteration(updatedLoop);
        }

        // Clean up tracking
        this.taskToLoop.delete(taskId);
        this.cleanupPipelineTasks(loopId, iteration.iterationNumber);
        return ok(undefined);
      }

      // Task COMPLETED — run exit condition evaluation
      const evalResult = this.evaluateExitCondition(loop, taskId);

      await this.handleIterationResult(loop, iteration, evalResult);

      // Clean up tracking
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

    if (updatedLoop.pipelineSteps && updatedLoop.pipelineSteps.length > 0) {
      await this.startPipelineIteration(updatedLoop, iterationNumber);
    } else {
      await this.startSingleTaskIteration(updatedLoop, iterationNumber);
    }
  }

  /**
   * Start a single-task iteration
   * ARCHITECTURE: Creates task from template, emits TaskDelegated, tracks in taskToLoop
   */
  private async startSingleTaskIteration(loop: Loop, iterationNumber: number): Promise<void> {
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

    // Record iteration in DB
    const iteration: LoopIteration = {
      id: 0, // Auto-increment
      loopId,
      iterationNumber,
      taskId: task.id,
      status: 'running',
      startedAt: Date.now(),
    };
    await this.loopRepo.recordIteration(iteration);

    // Track task → loop mapping
    this.taskToLoop.set(task.id, loopId);

    // Emit TaskDelegated event
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
   * emits TaskDelegated for each, tracks only TAIL task in taskToLoop (R4)
   */
  private async startPipelineIteration(loop: Loop, iterationNumber: number): Promise<void> {
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

    // Track TAIL task only in taskToLoop (R4)
    this.taskToLoop.set(lastTaskId, loopId);

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
  // EXIT CONDITION EVALUATION
  // ============================================================================

  /**
   * Evaluate the exit condition for an iteration
   * ARCHITECTURE: Uses child_process.execSync with injected env vars (R11)
   * - Retry strategy: exit code 0 = pass, non-zero = fail
   * - Optimize strategy: parse last non-empty line of stdout as score
   */
  private evaluateExitCondition(loop: Loop, taskId: TaskId): EvalResult {
    const env = {
      ...process.env,
      BACKBEAT_LOOP_ID: loop.id,
      BACKBEAT_ITERATION: String(loop.currentIteration),
      BACKBEAT_TASK_ID: taskId,
    };

    try {
      const stdout = execSync(loop.exitCondition, {
        cwd: loop.workingDirectory,
        timeout: loop.evalTimeout,
        encoding: 'utf-8',
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
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
      const error = execError as { status?: number; stderr?: string; message?: string };

      if (loop.strategy === LoopStrategy.RETRY) {
        // Non-zero exit or timeout → fail
        return {
          passed: false,
          exitCode: error.status ?? 1,
          error: error.stderr || error.message || 'Exit condition failed',
        };
      }

      // OPTIMIZE strategy: exec failure → crash
      return {
        passed: false,
        error: error.stderr || error.message || 'Exit condition evaluation failed',
        exitCode: error.status,
      };
    }
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
      // Exit condition passed — mark iteration as 'pass', complete loop
      await this.loopRepo.updateIteration({
        ...iteration,
        status: 'pass',
        exitCode: evalResult.exitCode,
        completedAt: Date.now(),
      });

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
   */
  private async scheduleNextIteration(loop: Loop): Promise<void> {
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
    // 1. Update iteration in DB
    await this.loopRepo.updateIteration({
      ...iteration,
      status: iterationStatus,
      score: evalResult?.score ?? iteration.score,
      exitCode: evalResult?.exitCode ?? iteration.exitCode,
      errorMessage: evalResult?.errorMessage ?? iteration.errorMessage,
      completedAt: Date.now(),
    });

    // 2. Emit LoopIterationCompleted event
    await this.eventBus.emit('LoopIterationCompleted', {
      loopId: loop.id,
      iterationNumber: iteration.iterationNumber,
      result: { ...iteration, status: iterationStatus },
    });

    // 3. Apply loop update + persist
    const updatedLoop = updateLoop(loop, loopUpdate);
    await this.loopRepo.update(updatedLoop);

    // 4. Check termination conditions (using updated loop for correct state)
    if (await this.checkTerminationConditions(updatedLoop, consecutiveFailures)) {
      return;
    }

    // 5. Schedule next iteration
    await this.scheduleNextIteration(updatedLoop);
  }

  /**
   * Compare scores respecting optimize direction
   */
  private isScoreBetter(newScore: number, bestScore: number, direction?: OptimizeDirection): boolean {
    if (direction === OptimizeDirection.MINIMIZE) {
      return newScore < bestScore;
    }
    // Default: MAXIMIZE
    return newScore > bestScore;
  }

  /**
   * Enrich prompt with checkpoint context from previous iteration (R2)
   * ARCHITECTURE: NO dependsOn for iteration chaining — LoopHandler manages sequencing directly
   */
  private async enrichPromptWithCheckpoint(loop: Loop, iterationNumber: number, prompt: string): Promise<string> {
    // Get enough iterations to find the previous one (ordered by iteration_number DESC)
    // We need at least 2: the current iteration we just started + the previous one
    const iterationsResult = await this.loopRepo.getIterations(loop.id, iterationNumber, 0);
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
   * Clean up pipeline task entries for a completed iteration
   */
  private cleanupPipelineTasks(loopId: string, iterationNumber: number): void {
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
      this.taskToLoop.set(iteration.taskId, iteration.loopId);

      // Rebuild pipeline task entries
      if (iteration.pipelineTaskIds && iteration.pipelineTaskIds.length > 0) {
        const key = `${iteration.loopId}:${iteration.iterationNumber}`;
        this.pipelineTasks.set(key, new Set(iteration.pipelineTaskIds));
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
      const iterationsResult = await this.loopRepo.getIterations(loop.id, 1);
      if (!iterationsResult.ok || iterationsResult.value.length === 0) {
        // No iterations yet — start first iteration
        this.logger.info('Recovering loop with no iterations', { loopId: loop.id });
        await this.startNextIteration(loop);
        continue;
      }

      const latestIteration = iterationsResult.value[0];

      // If latest iteration is still running, check task status
      if (latestIteration.status === 'running') {
        // Skip if task was cleaned up (ON DELETE SET NULL)
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
          continue;
        }
        const taskResult = await this.taskRepo.findById(latestIteration.taskId);
        if (!taskResult.ok || !taskResult.value) {
          this.logger.warn('Iteration task not found during recovery', {
            loopId: loop.id,
            taskId: latestIteration.taskId,
          });
          continue;
        }

        const task = taskResult.value;
        if (isTerminalState(task.status)) {
          // Task is terminal but iteration wasn't updated — recover
          this.logger.info('Recovering stuck iteration', {
            loopId: loop.id,
            taskId: task.id,
            taskStatus: task.status,
            iterationNumber: latestIteration.iterationNumber,
          });

          if (task.status === TaskStatus.COMPLETED) {
            const evalResult = this.evaluateExitCondition(loop, task.id);
            await this.handleIterationResult(loop, latestIteration, evalResult);
          } else if (task.status === TaskStatus.FAILED) {
            // Record as fail and continue
            const newConsecutiveFailures = loop.consecutiveFailures + 1;
            await this.loopRepo.updateIteration({
              ...latestIteration,
              status: 'fail',
              completedAt: Date.now(),
            });

            if (loop.maxConsecutiveFailures > 0 && newConsecutiveFailures >= loop.maxConsecutiveFailures) {
              await this.completeLoop(loop, LoopStatus.FAILED, 'Max consecutive failures reached (recovered)', {
                consecutiveFailures: newConsecutiveFailures,
              });
            } else {
              const updatedLoop = updateLoop(loop, { consecutiveFailures: newConsecutiveFailures });
              await this.loopRepo.update(updatedLoop);
              await this.scheduleNextIteration(updatedLoop);
            }
          } else {
            // CANCELLED — mark iteration as cancelled
            await this.loopRepo.updateIteration({
              ...latestIteration,
              status: 'cancelled',
              completedAt: Date.now(),
            });
          }
        }
        // else: task still running — do nothing, will complete normally
      }
      // else: iteration already has a terminal status — no recovery needed
    }

    this.logger.info('Loop recovery complete');
  }
}
