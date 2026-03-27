/**
 * Handler setup module for bootstrap
 * ARCHITECTURE: Centralizes event handler creation and registration
 * Rationale: Reduces bootstrap.ts complexity, enables easy handler additions for v0.4.0
 */

import { Configuration } from '../core/configuration.js';
import { Container } from '../core/container.js';
import { AutobeatError, ErrorCode } from '../core/errors.js';
import { EventBus } from '../core/events/event-bus.js';
import { EventHandlerRegistry } from '../core/events/handlers.js';
import {
  CheckpointRepository,
  DependencyRepository,
  Logger,
  LoopRepository,
  LoopService,
  OutputCapture,
  ResourceMonitor,
  ScheduleRepository,
  SyncLoopOperations,
  SyncOrchestrationOperations,
  SyncScheduleOperations,
  SyncTaskOperations,
  TaskQueue,
  TaskRepository,
  TransactionRunner,
  WorkerPool,
} from '../core/interfaces.js';
import { err, ok, Result } from '../core/result.js';
import { ShellExitConditionEvaluator } from './exit-condition-evaluator.js';
import { CheckpointHandler } from './handlers/checkpoint-handler.js';
import { DependencyHandler } from './handlers/dependency-handler.js';
import { LoopHandler } from './handlers/loop-handler.js';
import { OrchestrationHandler } from './handlers/orchestration-handler.js';
import { PersistenceHandler } from './handlers/persistence-handler.js';
import { QueueHandler } from './handlers/queue-handler.js';
import { ScheduleHandler } from './handlers/schedule-handler.js';
import { WorkerHandler } from './handlers/worker-handler.js';

/**
 * Dependencies required for handler setup
 * Extracted from Container to make testing easier and types explicit
 */
export interface HandlerDependencies {
  readonly config: Configuration;
  readonly logger: Logger;
  readonly eventBus: EventBus;
  readonly database: TransactionRunner;
  readonly taskRepository: TaskRepository & SyncTaskOperations;
  readonly outputCapture: OutputCapture;
  readonly taskQueue: TaskQueue;
  readonly dependencyRepository: DependencyRepository;
  readonly workerPool: WorkerPool;
  readonly resourceMonitor: ResourceMonitor;
  readonly scheduleRepository: ScheduleRepository & SyncScheduleOperations;
  readonly checkpointRepository: CheckpointRepository;
  readonly loopRepository: LoopRepository & SyncLoopOperations;
  readonly loopService?: LoopService;
  readonly orchestrationRepository?: SyncOrchestrationOperations;
}

/**
 * Result of handler setup including registry and handlers for lifecycle management
 */
export interface HandlerSetupResult {
  readonly registry: EventHandlerRegistry;
  /** DependencyHandler uses factory pattern, returned separately for unified lifecycle */
  readonly dependencyHandler: DependencyHandler;
  /** ScheduleHandler uses factory pattern, returned separately for unified lifecycle */
  readonly scheduleHandler: ScheduleHandler;
  /** CheckpointHandler uses factory pattern, returned separately for unified lifecycle */
  readonly checkpointHandler: CheckpointHandler;
  /** LoopHandler uses factory pattern, returned separately for unified lifecycle */
  readonly loopHandler: LoopHandler;
  /** OrchestrationHandler uses factory pattern, returned separately for unified lifecycle */
  readonly orchestrationHandler?: OrchestrationHandler;
}

/**
 * Extract a single dependency from container with typed error
 */
function getDependency<T>(container: Container, key: string): Result<T> {
  const result = container.get(key);
  if (!result.ok) {
    return err(
      new AutobeatError(ErrorCode.DEPENDENCY_INJECTION_FAILED, `Handler setup requires '${key}' service`, {
        service: key,
        error: result.error.message,
      }),
    );
  }
  return ok(result.value as T);
}

/**
 * Extract all dependencies needed for handler setup from Container
 *
 * Performs fail-fast validation - returns immediately on first missing dependency.
 * Each missing dependency produces a specific error message identifying which service is missing.
 *
 * @param container - The DI container with registered services
 * @returns Result containing all handler dependencies or error identifying missing service
 * @throws Never - Returns errors in Result type instead of throwing
 *
 * @example
 * ```typescript
 * const depsResult = extractHandlerDependencies(container);
 * if (!depsResult.ok) {
 *   logger.error('Missing dependency', depsResult.error);
 *   return depsResult;
 * }
 * const deps = depsResult.value;
 * ```
 */
export function extractHandlerDependencies(container: Container): Result<HandlerDependencies> {
  // Extract all 13 dependencies - fail fast on any missing
  const configResult = getDependency<Configuration>(container, 'config');
  if (!configResult.ok) return configResult;

  const loggerResult = getDependency<Logger>(container, 'logger');
  if (!loggerResult.ok) return loggerResult;

  const eventBusResult = getDependency<EventBus>(container, 'eventBus');
  if (!eventBusResult.ok) return eventBusResult;

  const databaseResult = getDependency<TransactionRunner>(container, 'database');
  if (!databaseResult.ok) return databaseResult;

  const taskRepositoryResult = getDependency<TaskRepository & SyncTaskOperations>(container, 'taskRepository');
  if (!taskRepositoryResult.ok) return taskRepositoryResult;

  const outputCaptureResult = getDependency<OutputCapture>(container, 'outputCapture');
  if (!outputCaptureResult.ok) return outputCaptureResult;

  const taskQueueResult = getDependency<TaskQueue>(container, 'taskQueue');
  if (!taskQueueResult.ok) return taskQueueResult;

  const dependencyRepositoryResult = getDependency<DependencyRepository>(container, 'dependencyRepository');
  if (!dependencyRepositoryResult.ok) return dependencyRepositoryResult;

  const workerPoolResult = getDependency<WorkerPool>(container, 'workerPool');
  if (!workerPoolResult.ok) return workerPoolResult;

  const resourceMonitorResult = getDependency<ResourceMonitor>(container, 'resourceMonitor');
  if (!resourceMonitorResult.ok) return resourceMonitorResult;

  const scheduleRepositoryResult = getDependency<ScheduleRepository & SyncScheduleOperations>(
    container,
    'scheduleRepository',
  );
  if (!scheduleRepositoryResult.ok) return scheduleRepositoryResult;

  const checkpointRepositoryResult = getDependency<CheckpointRepository>(container, 'checkpointRepository');
  if (!checkpointRepositoryResult.ok) return checkpointRepositoryResult;

  const loopRepositoryResult = getDependency<LoopRepository & SyncLoopOperations>(container, 'loopRepository');
  if (!loopRepositoryResult.ok) return loopRepositoryResult;

  // Optional: LoopService for ScheduleHandler validation (graceful if not registered)
  const loopServiceResult = getDependency<LoopService>(container, 'loopService');
  const loopService = loopServiceResult.ok ? loopServiceResult.value : undefined;

  // Optional: OrchestrationRepository for OrchestrationHandler (graceful if not registered)
  const orchestrationRepoResult = getDependency<SyncOrchestrationOperations>(container, 'orchestrationRepository');
  const orchestrationRepository = orchestrationRepoResult.ok ? orchestrationRepoResult.value : undefined;

  return ok({
    config: configResult.value,
    logger: loggerResult.value,
    eventBus: eventBusResult.value,
    database: databaseResult.value,
    taskRepository: taskRepositoryResult.value,
    outputCapture: outputCaptureResult.value,
    taskQueue: taskQueueResult.value,
    dependencyRepository: dependencyRepositoryResult.value,
    workerPool: workerPoolResult.value,
    resourceMonitor: resourceMonitorResult.value,
    scheduleRepository: scheduleRepositoryResult.value,
    checkpointRepository: checkpointRepositoryResult.value,
    loopRepository: loopRepositoryResult.value,
    loopService,
    orchestrationRepository,
  });
}

/**
 * Create and setup all event handlers
 *
 * Initializes 7 handlers: 3 standard handlers via EventHandlerRegistry,
 * plus DependencyHandler, ScheduleHandler, CheckpointHandler, and LoopHandler via factory pattern.
 * On any failure, performs cleanup of already-initialized handlers before returning error.
 *
 * ARCHITECTURE: Standard handlers use setup(eventBus) pattern via registry.
 * Factory handlers use create() for async initialization with proper event subscription.
 *
 * @param deps - All dependencies needed for handler creation
 * @returns Result containing registry and all factory handlers for lifecycle management
 * @throws Never - Returns errors in Result type instead of throwing
 */
export async function setupEventHandlers(deps: HandlerDependencies): Promise<Result<HandlerSetupResult>> {
  const { logger, eventBus } = deps;
  const setupLogger = logger.child({ module: 'HandlerSetup' });

  // Create registry using existing EventHandlerRegistry
  const registry = new EventHandlerRegistry(eventBus, setupLogger);

  // Helper for creating child loggers
  const childLogger = (module: string) => logger.child({ module });

  // Create QueueHandler first so PersistenceHandler can call it directly after save
  const queueHandler = new QueueHandler(
    deps.taskQueue,
    deps.dependencyRepository,
    deps.taskRepository,
    childLogger('QueueHandler'),
  );

  // Create 3 standard handlers that use setup(eventBus) pattern
  const standardHandlers = [
    // 1. Persistence Handler - saves task, then calls QueueHandler.enqueueIfReady()
    new PersistenceHandler(deps.taskRepository, queueHandler, childLogger('PersistenceHandler')),
    // 2. Queue Handler - manages task queue operations with dependency awareness
    queueHandler,
    // 3. Worker Handler - manages worker lifecycle
    new WorkerHandler({
      config: deps.config,
      workerPool: deps.workerPool,
      resourceMonitor: deps.resourceMonitor,
      eventBus,
      taskQueue: deps.taskQueue,
      taskRepo: deps.taskRepository,
      logger: childLogger('WorkerHandler'),
    }),
  ];

  // Register all standard handlers
  const registerResult = registry.registerAll(standardHandlers);
  if (!registerResult.ok) {
    return err(
      new AutobeatError(ErrorCode.SYSTEM_ERROR, `Failed to register event handlers: ${registerResult.error.message}`, {
        error: registerResult.error,
      }),
    );
  }

  // Initialize all standard handlers (calls setup(eventBus) on each)
  const initResult = await registry.initialize();
  if (!initResult.ok) {
    // Cleanup any handlers that were already initialized
    await registry.shutdown();
    return err(
      new AutobeatError(ErrorCode.SYSTEM_ERROR, `Failed to initialize event handlers: ${initResult.error.message}`, {
        error: initResult.error,
      }),
    );
  }

  // 4. Dependency Handler - uses factory pattern for async graph initialization
  // ARCHITECTURE: Factory pattern ensures handler is fully initialized before use
  // Cannot use registry because create() does its own event subscription
  const dependencyHandlerResult = await DependencyHandler.create(
    {
      dependencyRepo: deps.dependencyRepository,
      taskRepo: deps.taskRepository,
      logger,
      eventBus,
    },
    { checkpointLookup: deps.checkpointRepository },
  );
  if (!dependencyHandlerResult.ok) {
    // Cleanup standard handlers on failure
    await registry.shutdown();
    return err(
      new AutobeatError(
        ErrorCode.SYSTEM_ERROR,
        `Failed to create DependencyHandler: ${dependencyHandlerResult.error.message}`,
        { error: dependencyHandlerResult.error },
      ),
    );
  }

  const dependencyHandler = dependencyHandlerResult.value;

  // 5. Schedule Handler - uses factory pattern for async event subscription
  // ARCHITECTURE: Factory pattern ensures handler is fully initialized before use
  // Cannot use registry because create() does its own event subscription
  const scheduleHandlerResult = await ScheduleHandler.create({
    scheduleRepo: deps.scheduleRepository,
    taskRepo: deps.taskRepository,
    eventBus,
    database: deps.database,
    loopRepo: deps.loopRepository,
    loopService: deps.loopService,
    logger: childLogger('ScheduleHandler'),
  });
  if (!scheduleHandlerResult.ok) {
    // Cleanup previous handlers on failure
    await registry.shutdown();
    return err(
      new AutobeatError(
        ErrorCode.SYSTEM_ERROR,
        `Failed to create ScheduleHandler: ${scheduleHandlerResult.error.message}`,
        { error: scheduleHandlerResult.error },
      ),
    );
  }

  const scheduleHandler = scheduleHandlerResult.value;

  // 6. Checkpoint Handler - auto-creates checkpoints on task terminal events
  // ARCHITECTURE: Factory pattern ensures handler is fully initialized before use
  const checkpointHandlerResult = await CheckpointHandler.create({
    checkpointRepo: deps.checkpointRepository,
    outputCapture: deps.outputCapture,
    taskRepo: deps.taskRepository,
    eventBus,
    logger: childLogger('CheckpointHandler'),
  });
  if (!checkpointHandlerResult.ok) {
    // Cleanup previous handlers on failure
    await registry.shutdown();
    return err(
      new AutobeatError(
        ErrorCode.SYSTEM_ERROR,
        `Failed to create CheckpointHandler: ${checkpointHandlerResult.error.message}`,
        { error: checkpointHandlerResult.error },
      ),
    );
  }

  const checkpointHandler = checkpointHandlerResult.value;

  // 7. Loop Handler - iterative task/pipeline execution engine (v0.7.0)
  // ARCHITECTURE: Factory pattern ensures handler is fully initialized before use
  // Created AFTER CheckpointHandler because it needs checkpointRepository for context enrichment
  const loopHandlerResult = await LoopHandler.create({
    loopRepo: deps.loopRepository,
    taskRepo: deps.taskRepository,
    checkpointRepo: deps.checkpointRepository,
    eventBus,
    database: deps.database,
    exitConditionEvaluator: new ShellExitConditionEvaluator(),
    logger: childLogger('LoopHandler'),
  });
  if (!loopHandlerResult.ok) {
    // Cleanup previous handlers on failure
    await registry.shutdown();
    return err(
      new AutobeatError(ErrorCode.SYSTEM_ERROR, `Failed to create LoopHandler: ${loopHandlerResult.error.message}`, {
        error: loopHandlerResult.error,
      }),
    );
  }

  const loopHandler = loopHandlerResult.value;

  // 8. Orchestration Handler - correlates loop events to orchestration status (v0.9.0)
  // ARCHITECTURE: Optional — only created if orchestrationRepository is registered
  let orchestrationHandler: OrchestrationHandler | undefined;
  if (deps.orchestrationRepository) {
    const orchestrationHandlerResult = await OrchestrationHandler.create(
      deps.orchestrationRepository,
      deps.loopRepository,
      deps.database,
      eventBus,
      childLogger('OrchestrationHandler'),
    );
    if (!orchestrationHandlerResult.ok) {
      // Non-fatal: log warning but continue without orchestration handler
      setupLogger.warn('Failed to create OrchestrationHandler', {
        error: orchestrationHandlerResult.error.message,
      });
    } else {
      orchestrationHandler = orchestrationHandlerResult.value;
    }
  }

  setupLogger.info('Event handlers initialized successfully', {
    standardHandlers: standardHandlers.length,
    totalHandlers: standardHandlers.length + 4 + (orchestrationHandler ? 1 : 0),
  });

  return ok({ registry, dependencyHandler, scheduleHandler, checkpointHandler, loopHandler, orchestrationHandler });
}
