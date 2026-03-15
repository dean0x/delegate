/**
 * Dependency handler for task dependency management
 * ARCHITECTURE: Event-driven DAG validation and dependency resolution
 * Pattern: Event-driven with cycle detection before mutation
 * Rationale: Ensures dependency integrity, prevents deadlocks, enables parallel task execution
 */

import { DependencyGraph } from '../../core/dependency-graph.js';
import { type TaskCheckpoint, TaskId } from '../../core/domain.js';
import { BackbeatError, ErrorCode } from '../../core/errors.js';
import { EventBus } from '../../core/events/event-bus.js';
import {
  CheckpointCreatedEvent,
  TaskCancelledEvent,
  TaskCompletedEvent,
  TaskDelegatedEvent,
  TaskFailedEvent,
  TaskTimeoutEvent,
} from '../../core/events/events.js';
import { BaseEventHandler } from '../../core/events/handlers.js';
import { CheckpointLookup, DependencyRepository, Logger, TaskRepository } from '../../core/interfaces.js';
import { err, ok, Result } from '../../core/result.js';
import { buildContinuationPrompt } from '../../utils/continuation-prompt.js';

// SECURITY: Maximum allowed depth for dependency chains (DoS prevention)
// Configurable via DependencyHandler.create() options
export const DEFAULT_MAX_DEPENDENCY_CHAIN_DEPTH = 100;

/**
 * Options for DependencyHandler configuration
 * @since 0.3.2
 */
export interface DependencyHandlerOptions {
  /** Maximum allowed depth for dependency chains (DoS prevention). Default: 100 */
  readonly maxChainDepth?: number;
  /** Checkpoint lookup for continueFrom enrichment. Optional - enrichment skipped if absent. */
  readonly checkpointLookup?: CheckpointLookup;
}

export class DependencyHandler extends BaseEventHandler {
  private eventBus: EventBus;
  private graph: DependencyGraph;
  private readonly maxChainDepth: number;
  private readonly checkpointLookup?: CheckpointLookup;

  /**
   * Private constructor - use DependencyHandler.create() instead
   * ARCHITECTURE: Factory pattern ensures handler is fully initialized before use
   */
  private constructor(
    private readonly dependencyRepo: DependencyRepository,
    private readonly taskRepo: TaskRepository,
    logger: Logger,
    eventBus: EventBus,
    graph: DependencyGraph,
    maxChainDepth: number,
    checkpointLookup?: CheckpointLookup,
  ) {
    super(logger, 'DependencyHandler');
    this.eventBus = eventBus;
    this.graph = graph;
    this.maxChainDepth = maxChainDepth;
    this.checkpointLookup = checkpointLookup;
  }

  /**
   * Factory method to create a fully initialized DependencyHandler
   * ARCHITECTURE: Guarantees handler is ready to use - no uninitialized state possible
   * PERFORMANCE: Graph initialized once from database (O(N) one-time cost)
   *
   * @param dependencyRepo - Repository for dependency persistence
   * @param taskRepo - Repository for task lookups (needed for TaskUnblocked events)
   * @param logger - Logger instance
   * @param eventBus - Event bus for subscriptions
   * @param options - Optional configuration. Defaults: maxChainDepth=100
   * @returns Result containing initialized handler or error
   */
  static async create(
    dependencyRepo: DependencyRepository,
    taskRepo: TaskRepository,
    logger: Logger,
    eventBus: EventBus,
    options?: DependencyHandlerOptions,
  ): Promise<Result<DependencyHandler>> {
    const maxChainDepth = options?.maxChainDepth ?? DEFAULT_MAX_DEPENDENCY_CHAIN_DEPTH;
    const checkpointLookup = options?.checkpointLookup;
    const handlerLogger = logger.child ? logger.child({ module: 'DependencyHandler' }) : logger;

    // PERFORMANCE: Initialize graph eagerly (one-time O(N) cost)
    // Subsequent operations use incremental O(1) updates instead of rebuilding
    // ARCHITECTURE: Use findAllUnbounded() explicitly - we intentionally need ALL dependencies for graph init
    // Full table scan is acceptable here because:
    // 1. This runs once at startup, not per-request
    // 2. Graph must be complete for cycle detection to work correctly
    // 3. Typical dependency count is <1000, scan takes <10ms
    handlerLogger.debug('Initializing dependency graph from database');
    const allDepsResult = await dependencyRepo.findAllUnbounded();
    if (!allDepsResult.ok) {
      handlerLogger.error('Failed to initialize dependency graph', allDepsResult.error);
      return err(allDepsResult.error);
    }

    const graph = new DependencyGraph(allDepsResult.value);
    handlerLogger.info('Dependency graph initialized', {
      nodeCount: graph.size(),
      dependencyCount: allDepsResult.value.length,
    });

    // Create handler with initialized graph
    const handler = new DependencyHandler(
      dependencyRepo,
      taskRepo,
      handlerLogger,
      eventBus,
      graph,
      maxChainDepth,
      checkpointLookup,
    );

    // Subscribe to events
    const subscribeResult = handler.subscribeToEvents();
    if (!subscribeResult.ok) {
      return subscribeResult;
    }

    handlerLogger.info('DependencyHandler initialized with incremental graph updates', {
      pattern: 'event-driven incremental updates',
      maxDepth: maxChainDepth,
    });

    return ok(handler);
  }

  /**
   * Subscribe to all relevant events
   * ARCHITECTURE: Called by factory after graph initialization
   */
  private subscribeToEvents(): Result<void> {
    const subscriptions = [
      // Listen for new tasks to add dependencies
      this.eventBus.subscribe('TaskDelegated', this.handleTaskDelegated.bind(this)),
      // Listen for task completions to resolve dependencies
      this.eventBus.subscribe('TaskCompleted', this.handleTaskCompleted.bind(this)),
      this.eventBus.subscribe('TaskFailed', this.handleTaskFailed.bind(this)),
      this.eventBus.subscribe('TaskCancelled', this.handleTaskCancelled.bind(this)),
      this.eventBus.subscribe('TaskTimeout', this.handleTaskTimeout.bind(this)),
      // NOTE: No longer subscribe to TaskDependencyAdded - we update graph directly
    ];

    // Check if any subscription failed
    for (const result of subscriptions) {
      if (!result.ok) {
        return result;
      }
    }

    return ok(undefined);
  }

  // ============================================================================
  // EXTRACTED METHODS - handleTaskDelegated() decomposition
  // See docs/architecture/HANDLER-DECOMPOSITION-INVARIANTS.md for constraints
  // ============================================================================

  /**
   * Validate a single dependency - check for cycles and depth limits
   * PURE: Read-only operation, no side effects
   *
   * @returns Validation result with type indicating: ok, cycle, depth, or system error
   */
  private validateSingleDependency(
    taskId: TaskId,
    depId: TaskId,
  ): { depId: TaskId; error: Error | null; type: 'ok' | 'cycle' | 'depth' | 'system' } {
    // Cycle detection
    const cycleCheck = this.graph.wouldCreateCycle(taskId, depId);
    if (!cycleCheck.ok) {
      return { depId, error: cycleCheck.error, type: 'system' };
    }
    if (cycleCheck.value) {
      return {
        depId,
        error: new BackbeatError(
          ErrorCode.INVALID_OPERATION,
          `Cannot add dependency: would create cycle (${taskId} -> ${depId})`,
          { taskId, dependsOnTaskId: depId },
        ),
        type: 'cycle',
      };
    }

    // Depth check
    const depDepth = this.graph.getMaxDepth(depId);
    const resultingDepth = 1 + depDepth;
    if (resultingDepth > this.maxChainDepth) {
      return {
        depId,
        error: new BackbeatError(
          ErrorCode.INVALID_OPERATION,
          `Cannot add dependency: would create chain depth of ${resultingDepth} (max ${this.maxChainDepth})`,
          { taskId, dependsOnTaskId: depId, depth: resultingDepth },
        ),
        type: 'depth',
      };
    }

    return { depId, error: null, type: 'ok' };
  }

  /**
   * Handle validation failure - log appropriately and emit failure event
   * INVARIANT: Must emit TaskDependencyFailed event
   *
   * Type narrowed: Only called when validation fails (error is always present)
   */
  private async handleValidationFailure(
    taskId: TaskId,
    requestedDependencies: readonly TaskId[],
    failure: { depId: TaskId; error: Error; type: 'cycle' | 'depth' | 'system' },
  ): Promise<void> {
    const context = { taskId, dependsOnTaskId: failure.depId };

    // Log based on failure type
    if (failure.type === 'system') {
      this.logger.error('Validation failed', failure.error, context);
    } else if (failure.type === 'cycle') {
      this.logger.warn('Cycle detected, rejecting dependency', context);
    } else {
      this.logger.warn('Depth limit exceeded, rejecting dependency', context);
    }

    // Emit batch failure event
    await this.eventBus.emit('TaskDependencyFailed', {
      taskId,
      failedDependencyId: failure.depId,
      requestedDependencies,
      error: failure.error,
    });
  }

  /**
   * Handle database write failure - log and emit failure event
   * INVARIANT: Must emit TaskDependencyFailed event
   *
   * Note: dependencies array is guaranteed non-empty by caller (handleTaskDelegated
   * early-exits when dependsOn is empty), but defensive check added for safety.
   */
  private async handleDatabaseFailure(taskId: TaskId, dependencies: readonly TaskId[], error: Error): Promise<void> {
    this.logger.error('Failed to add dependencies', error, {
      taskId,
      dependencies,
    });

    // Defensive: use first dependency if available, otherwise use taskId as fallback
    const failedDepId = dependencies.length > 0 ? dependencies[0] : taskId;

    await this.eventBus.emit('TaskDependencyFailed', {
      taskId,
      failedDependencyId: failedDepId,
      error,
    });
  }

  /**
   * Update in-memory graph after successful database persistence
   * INVARIANT: Must happen AFTER database write succeeds
   * RECOVERY: Graph errors are logged but don't fail - reconciled on restart
   */
  private updateGraphAfterPersistence(dependencies: readonly { taskId: TaskId; dependsOnTaskId: TaskId }[]): void {
    for (const dependency of dependencies) {
      const edgeResult = this.graph.addEdge(dependency.taskId, dependency.dependsOnTaskId);
      if (!edgeResult.ok) {
        // This should never happen for valid data, but log if it does
        this.logger.error('Unexpected error updating graph after DB write', edgeResult.error, {
          taskId: dependency.taskId,
          dependsOnTaskId: dependency.dependsOnTaskId,
        });
        // Continue - graph will be reconciled on restart
      }
      this.logger.debug('Graph updated with new dependency', {
        taskId: dependency.taskId,
        dependsOnTaskId: dependency.dependsOnTaskId,
      });
    }
  }

  /**
   * Emit TaskDependencyAdded events for each dependency
   * INVARIANT: Must happen AFTER graph update
   */
  private async emitDependencyAddedEvents(
    dependencies: readonly { taskId: TaskId; dependsOnTaskId: TaskId }[],
  ): Promise<void> {
    for (const dependency of dependencies) {
      await this.eventBus.emit('TaskDependencyAdded', {
        taskId: dependency.taskId,
        dependsOnTaskId: dependency.dependsOnTaskId,
      });
    }
  }

  // ============================================================================
  // MAIN ORCHESTRATION METHOD
  // ============================================================================

  /**
   * Handle new task delegation - add dependencies atomically with cycle detection
   * ARCHITECTURE: DAG validation BEFORE persisting (handler owns validation logic)
   * ATOMICITY: All dependencies succeed or all fail together (no partial state)
   * PERFORMANCE: Cycle detection uses in-memory graph (O(V+E) not O(N) database query)
   *
   * DECOMPOSITION: This method orchestrates extracted methods while
   * preserving all invariants documented in HANDLER-DECOMPOSITION-INVARIANTS.md
   */
  private async handleTaskDelegated(event: TaskDelegatedEvent): Promise<void> {
    await this.handleEvent(event, async (event) => {
      const task = event.task;

      // Step 1: Skip if no dependencies (INVARIANT: early exit)
      if (!task.dependsOn || task.dependsOn.length === 0) {
        this.logger.debug('Task has no dependencies, skipping', { taskId: task.id });
        return ok(undefined);
      }

      this.logger.info('Processing dependencies for new task', {
        taskId: task.id,
        dependencyCount: task.dependsOn.length,
        dependencies: task.dependsOn,
      });

      // Step 2: Validate all dependencies in parallel (INVARIANT: all validations run)
      // PERFORMANCE: Parallel validation per Issue #14
      const validationResults = await Promise.all(
        task.dependsOn.map((depId) => this.validateSingleDependency(task.id, depId)),
      );

      // Step 3: Check for validation failures (INVARIANT: fail-fast on first error)
      const failure = validationResults.find((r) => r.error !== null);
      if (failure && failure.error) {
        // Type narrow: failure.error is verified non-null, type is not 'ok'
        await this.handleValidationFailure(task.id, task.dependsOn, {
          depId: failure.depId,
          error: failure.error,
          type: failure.type as 'cycle' | 'depth' | 'system',
        });
        return err(failure.error);
      }

      // Step 4: Persist to database (INVARIANT: only after all validations pass)
      const addResult = await this.dependencyRepo.addDependencies(task.id, task.dependsOn);
      if (!addResult.ok) {
        await this.handleDatabaseFailure(task.id, task.dependsOn, addResult.error);
        return addResult;
      }

      this.logger.info('All dependencies added atomically', {
        taskId: task.id,
        count: addResult.value.length,
        dependencyIds: addResult.value.map((d) => d.id),
      });

      // Step 5: Update graph (INVARIANT: only after successful DB write)
      this.updateGraphAfterPersistence(addResult.value);

      // Step 6: Emit success events (INVARIANT: only after graph update)
      await this.emitDependencyAddedEvents(addResult.value);

      return ok(undefined);
    });
  }

  /**
   * Handle task completion - resolve dependencies and unblock dependent tasks
   */
  private async handleTaskCompleted(event: TaskCompletedEvent): Promise<void> {
    await this.handleEvent(event, async (event) => {
      await this.resolveDependencies(event.taskId, 'completed');
      return ok(undefined);
    });
  }

  /**
   * Handle task failure - resolve dependencies as failed
   */
  private async handleTaskFailed(event: TaskFailedEvent): Promise<void> {
    await this.handleEvent(event, async (event) => {
      await this.resolveDependencies(event.taskId, 'failed');
      return ok(undefined);
    });
  }

  /**
   * Handle task cancellation - resolve dependencies as cancelled
   */
  private async handleTaskCancelled(event: TaskCancelledEvent): Promise<void> {
    await this.handleEvent(event, async (event) => {
      await this.resolveDependencies(event.taskId, 'cancelled');
      return ok(undefined);
    });
  }

  /**
   * Handle task timeout - resolve dependencies as failed
   */
  private async handleTaskTimeout(event: TaskTimeoutEvent): Promise<void> {
    await this.handleEvent(event, async (event) => {
      await this.resolveDependencies(event.taskId, 'failed');
      return ok(undefined);
    });
  }

  /**
   * Wait for a checkpoint to be created for a task
   * Uses subscribe-first pattern to avoid lost-event window:
   * 1. Subscribe to CheckpointCreated event FIRST
   * 2. Then check DB (checkpoint may already exist)
   * 3. Race subscription against timeout
   *
   * ARCHITECTURE: Both DependencyHandler and CheckpointHandler subscribe to TaskCompleted.
   * EventBus runs them via Promise.all, so checkpoint creation may happen in parallel.
   * This method handles the race condition gracefully.
   */
  private async waitForCheckpoint(taskId: TaskId, timeoutMs: number = 5000): Promise<TaskCheckpoint | null> {
    let settled = false;
    let resolvePromise: (checkpoint: TaskCheckpoint | null) => void;
    const waitPromise = new Promise<TaskCheckpoint | null>((resolve) => {
      resolvePromise = resolve;
    });

    // 1. Subscribe to CheckpointCreated FIRST (avoids lost-event window)
    const subscribeResult = this.eventBus.subscribe<CheckpointCreatedEvent>(
      'CheckpointCreated',
      async (event: CheckpointCreatedEvent) => {
        if (event.taskId === taskId && !settled) {
          settled = true;
          resolvePromise(event.checkpoint);
        }
      },
    );

    // Track subscription ID for cleanup
    const subscriptionId = subscribeResult.ok ? subscribeResult.value : null;

    // 2. Check DB (checkpoint may already exist)
    const existingResult = await this.checkpointLookup!.findLatest(taskId);
    if (existingResult.ok && existingResult.value && !settled) {
      settled = true;
      // Cleanup subscription
      if (subscriptionId) {
        this.eventBus.unsubscribe(subscriptionId);
      }
      return existingResult.value;
    }

    // 3. Wait with timeout
    const timeoutPromise = new Promise<TaskCheckpoint | null>((resolve) => {
      setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      }, timeoutMs);
    });

    const result = await Promise.race([waitPromise, timeoutPromise]);

    // Cleanup subscription
    if (subscriptionId) {
      this.eventBus.unsubscribe(subscriptionId);
    }

    return result;
  }

  /**
   * Resolve dependencies and check if dependent tasks are now unblocked
   * PERFORMANCE: Uses batch resolution (single UPDATE) instead of N+1 queries
   * @param completedTaskId Task that just completed/failed/cancelled
   * @param resolution Resolution state
   */
  private async resolveDependencies(
    completedTaskId: TaskId,
    resolution: 'completed' | 'failed' | 'cancelled',
  ): Promise<Result<void>> {
    // PERFORMANCE: Get dependents BEFORE batch resolution to emit events and check unblocked state
    // This is necessary because we need the list of affected tasks for:
    // 1. Emitting TaskDependencyResolved events (one per dependency)
    // 2. Checking which tasks became unblocked (requires isBlocked check per task)
    const dependentsResult = await this.dependencyRepo.getDependents(completedTaskId);
    if (!dependentsResult.ok) {
      this.logger.error('Failed to get dependents', dependentsResult.error, {
        taskId: completedTaskId,
      });
      return dependentsResult;
    }

    const dependents = dependentsResult.value;

    if (dependents.length === 0) {
      this.logger.debug('No dependent tasks to resolve', { taskId: completedTaskId });
      return ok(undefined);
    }

    this.logger.info('Resolving dependencies for completed task', {
      taskId: completedTaskId,
      resolution,
      dependentCount: dependents.length,
    });

    // PERFORMANCE: Batch resolve ALL dependencies in single UPDATE query (7-10× faster)
    // Replaces N individual UPDATE queries with one query that updates all pending dependents
    const batchResolveResult = await this.dependencyRepo.resolveDependenciesBatch(completedTaskId, resolution);

    if (!batchResolveResult.ok) {
      this.logger.error('Failed to batch resolve dependencies', batchResolveResult.error, {
        taskId: completedTaskId,
        resolution,
      });
      return batchResolveResult;
    }

    this.logger.info('Batch resolved dependencies', {
      taskId: completedTaskId,
      resolution,
      resolvedCount: batchResolveResult.value,
    });

    // Emit resolution events and check for unblocked tasks
    // NOTE: We still iterate over dependents for event emission and unblock checks
    // This is unavoidable because each dependent may have different blocking state
    for (const dep of dependents) {
      // Only process dependencies that were pending before the batch update
      // The batch UPDATE only affects pending dependencies, so skip already-resolved ones
      if (dep.resolution !== 'pending') {
        continue;
      }

      this.logger.debug('Dependency resolved', {
        taskId: dep.taskId,
        dependsOnTaskId: dep.dependsOnTaskId,
        resolution,
      });

      // Emit resolution event
      await this.eventBus.emit('TaskDependencyResolved', {
        taskId: dep.taskId,
        dependsOnTaskId: dep.dependsOnTaskId,
        resolution,
      });

      // Check if this task is now unblocked
      const isBlockedResult = await this.dependencyRepo.isBlocked(dep.taskId);
      if (!isBlockedResult.ok) {
        this.logger.error('Failed to check if task is blocked', isBlockedResult.error, {
          taskId: dep.taskId,
        });
        continue;
      }

      if (!isBlockedResult.value) {
        // Task is no longer blocked — but check if any resolved dependency failed/cancelled
        // If so, cascade cancellation instead of unblocking
        const depsResult = await this.dependencyRepo.getDependencies(dep.taskId);
        if (!depsResult.ok) {
          this.logger.warn('getDependencies failed during cascade check, skipping unblock', {
            taskId: dep.taskId,
            error: depsResult.error.message,
          });
          continue;
        }

        const failedDep = depsResult.value.find((d) => d.resolution === 'failed' || d.resolution === 'cancelled');
        if (failedDep) {
          this.logger.info('Dependency resolved as failed/cancelled — cascading cancellation', {
            taskId: dep.taskId,
            failedDependency: failedDep.dependsOnTaskId,
            failedResolution: failedDep.resolution,
          });
          await this.eventBus.emit('TaskCancellationRequested', {
            taskId: dep.taskId,
            reason: `Dependency ${failedDep.dependsOnTaskId} ${failedDep.resolution}`,
          });
          continue;
        }

        // Task is unblocked with all deps completed - fetch task and emit event
        this.logger.info('Task unblocked', { taskId: dep.taskId });

        // ARCHITECTURE: Fetch task to include in event, preventing layer violation
        const taskResult = await this.taskRepo.findById(dep.taskId);
        if (!taskResult.ok || !taskResult.value) {
          const errorMessage = taskResult.ok ? 'Task not found' : taskResult.error.message;
          this.logger.error('Failed to fetch unblocked task', new Error(errorMessage), {
            taskId: dep.taskId,
          });
          continue;
        }

        let task = taskResult.value;

        // continueFrom enrichment: inject dependency context into task prompt
        if (task.continueFrom && this.checkpointLookup) {
          const checkpoint = await this.waitForCheckpoint(task.continueFrom, 5000);

          if (checkpoint) {
            // Fetch the dependency task to get its original prompt
            const depTaskResult = await this.taskRepo.findById(task.continueFrom);
            const dependencyPrompt =
              depTaskResult.ok && depTaskResult.value ? depTaskResult.value.prompt : '(dependency prompt unavailable)';

            const enrichedPrompt = buildContinuationPrompt(task, checkpoint, dependencyPrompt);

            // Update task prompt in DB
            const updateResult = await this.taskRepo.update(dep.taskId, { prompt: enrichedPrompt });
            if (updateResult.ok) {
              // Re-fetch to get updated task
              const refreshResult = await this.taskRepo.findById(dep.taskId);
              if (refreshResult.ok && refreshResult.value) {
                task = refreshResult.value;
              }
              this.logger.info('Task prompt enriched with dependency context', {
                taskId: dep.taskId,
                continueFrom: task.continueFrom,
              });
            } else {
              this.logger.warn('Failed to update task prompt with dependency context', {
                taskId: dep.taskId,
                error: updateResult.error.message,
              });
            }
          } else {
            this.logger.warn('Checkpoint not available for continueFrom enrichment, proceeding without', {
              taskId: dep.taskId,
              continueFrom: task.continueFrom,
            });
          }
        }

        await this.eventBus.emit('TaskUnblocked', {
          taskId: dep.taskId,
          task,
        });
      }
    }

    return ok(undefined);
  }
}
