/**
 * Bootstrap and dependency injection
 * Wires all components together
 */

import { validateConfiguration } from './core/config-validator.js';
import { Configuration, loadConfiguration } from './core/configuration.js';
import { Container } from './core/container.js';
import { AutobeatError, ErrorCode } from './core/errors.js';
import { EventBus, InMemoryEventBus } from './core/events/event-bus.js';
import {
  CheckpointRepository,
  DependencyRepository,
  Logger,
  LoopRepository,
  LoopService,
  OrchestrationRepository,
  OrchestrationService,
  OutputCapture,
  OutputRepository,
  PipelineRepository,
  ProcessSpawner,
  ResourceMonitor,
  ScheduleRepository,
  ScheduleService,
  SyncScheduleOperations,
  TaskManager,
  TaskQueue,
  TaskRepository,
  TransactionRunner,
  UsageRepository,
  WorkerPool,
  WorkerRepository,
} from './core/interfaces.js';
import { err, ok, Result } from './core/result.js';

/**
 * Bootstrap mode determines which subsystems are initialized.
 * - 'server': All subsystems (MCP daemon — recovery, executor, monitoring)
 * - 'cli': Skip executor + recovery (mutation commands: cancel, retry, schedule ops)
 * - 'run': Skip executor + monitoring (single-task `beat run` with crash recovery)
 *
 * DECISION (2026-04-10): Handler subscription is mode-independent. Event handlers
 * are subscribed at bootstrap time regardless of which service is resolved by the
 * caller. All modes (server, cli, run) get the same handler wiring.
 */
export type BootstrapMode = 'server' | 'cli' | 'run';

export interface ModeFlags {
  skipResourceMonitoring: boolean;
  skipScheduleExecutor: boolean;
  skipRecovery: boolean;
  skipProxy: boolean;
}

/**
 * Derive subsystem flags from a BootstrapMode.
 *
 * Pure function — no side effects, safe for unit testing.
 */
export function deriveModeFlags(mode: BootstrapMode): ModeFlags {
  return {
    // DECISION: Resource monitoring in all modes. Why: 'run' mode workers need resource
    // checks to prevent overload. Prior behavior (skip for 'run') could allow unchecked spawning.
    skipResourceMonitoring: false,
    skipScheduleExecutor: mode === 'cli' || mode === 'run',
    skipRecovery: mode === 'cli',
    // DECISION: Proxy starts in any mode that spawns workers ('server', 'run').
    // Skipped in 'cli' mode (management commands that never spawn workers).
    // The processSpawner guard is separate — checked at the call site because
    // it's an options check, not a mode-derived flag.
    skipProxy: mode === 'cli',
  };
}

export interface BootstrapOptions {
  /** Bootstrap mode controlling which subsystems are initialized (default: 'server') */
  mode?: BootstrapMode;
  /** Custom ProcessSpawner (e.g., NoOpProcessSpawner for tests) */
  processSpawner?: ProcessSpawner;
  /** Custom ResourceMonitor (e.g., TestResourceMonitor for tests) */
  resourceMonitor?: ResourceMonitor;
  /**
   * Custom Logger instance — when provided, this logger is used instead of the
   * default ConsoleLogger/StructuredLogger. Used by the dashboard to swap in
   * FileLogger so log output does not interleave with Ink's frame rendering
   * on stderr.
   */
  logger?: Logger;
}

// Adapters
import { MCPAdapter } from './adapters/mcp-adapter.js';

// Core
import { AgentRegistry } from './core/agents.js';

// Implementations
import { InMemoryAgentRegistry } from './implementations/agent-registry.js';
import { SQLiteCheckpointRepository } from './implementations/checkpoint-repository.js';
import { ClaudeAdapter } from './implementations/claude-adapter.js';
import { CodexAdapter } from './implementations/codex-adapter.js';
import { Database } from './implementations/database.js';
import { SQLiteDependencyRepository } from './implementations/dependency-repository.js';
import { EventDrivenWorkerPool } from './implementations/event-driven-worker-pool.js';
import { GeminiAdapter } from './implementations/gemini-adapter.js';
import { ConsoleLogger, LogLevel, StructuredLogger } from './implementations/logger.js';
import { SQLiteLoopRepository } from './implementations/loop-repository.js';
import { SQLiteOrchestrationRepository } from './implementations/orchestration-repository.js';
import { BufferedOutputCapture } from './implementations/output-capture.js';
import { SQLiteOutputRepository } from './implementations/output-repository.js';
import { SQLitePipelineRepository } from './implementations/pipeline-repository.js';
import { ProcessSpawnerAdapter } from './implementations/process-spawner-adapter.js';
import { SystemResourceMonitor } from './implementations/resource-monitor.js';
import { SQLiteScheduleRepository } from './implementations/schedule-repository.js';
import { PriorityTaskQueue } from './implementations/task-queue.js';
import { SQLiteTaskRepository } from './implementations/task-repository.js';
import { SQLiteUsageRepository } from './implementations/usage-repository.js';
import { SQLiteWorkerRepository } from './implementations/worker-repository.js';

// Services
import { extractHandlerDependencies, setupEventHandlers } from './services/handler-setup.js';
import { LoopManagerService } from './services/loop-manager.js';
import { OrchestrationManagerService } from './services/orchestration-manager.js';
import { RecoveryManager } from './services/recovery-manager.js';
import { ScheduleExecutor } from './services/schedule-executor.js';
import { ScheduleManagerService } from './services/schedule-manager.js';
import { TaskManagerService } from './services/task-manager.js';

// Translation proxy
import { ProxiedClaudeAdapter } from './translation/proxy/proxied-claude-adapter.js';
import { loadProxyConfig, ProxyManager } from './translation/proxy/proxy-manager.js';

/**
 * Helper for dependency injection in factory functions
 *
 * ARCHITECTURE NOTE: This function throws instead of returning Result
 * because it's used inside registerSingleton() factory callbacks.
 *
 * Factory functions execute LAZILY when a service is first resolved,
 * not during bootstrap. Throwing here is acceptable because:
 * 1. Errors are caught by the DI container's resolve() method
 * 2. The container.resolve() already returns Result<T>
 * 3. This keeps factory function code clean and synchronous
 *
 * For the main bootstrap flow, use getFromContainerSafe() instead.
 */
const getFromContainer = <T>(container: Container, key: string): T => {
  const result = container.get(key);
  if (!result.ok) {
    throw new Error(`Failed to get ${key} from container: ${result.error.message}`);
  }
  return result.value as T;
};

// Safe version for use in async bootstrap flow
const getFromContainerSafe = <T>(container: Container, key: string): Result<T> => {
  const result = container.get(key);
  if (!result.ok) {
    return err(
      new AutobeatError(ErrorCode.DEPENDENCY_INJECTION_FAILED, `Failed to get ${key} from container`, {
        key,
        error: result.error.message,
      }),
    );
  }
  return ok(result.value as T);
};

/**
 * Bootstrap the application with all dependencies
 * ARCHITECTURE: Returns Result instead of throwing - follows Result pattern
 */
export async function bootstrap(options: BootstrapOptions = {}): Promise<Result<Container>> {
  const mode = options.mode ?? 'server';
  const { skipResourceMonitoring, skipScheduleExecutor, skipRecovery, skipProxy } = deriveModeFlags(mode);

  const container = new Container();
  const config = loadConfiguration();

  // Register configuration
  container.registerValue('config', config);

  // Register logger with resolved log level
  const LOG_LEVEL_MAP: Record<Configuration['logLevel'], LogLevel> = {
    debug: LogLevel.DEBUG,
    info: LogLevel.INFO,
    warn: LogLevel.WARN,
    error: LogLevel.ERROR,
  };

  const logLevel = LOG_LEVEL_MAP[config.logLevel];

  // If the caller provided a Logger instance (e.g. FileLogger from the dashboard),
  // use it directly. Otherwise construct the default logger based on NODE_ENV.
  if (options.logger) {
    const injectedLogger = options.logger;
    container.registerSingleton('logger', () => injectedLogger);
  } else {
    container.registerSingleton('logger', () => {
      if (process.env.NODE_ENV === 'production') {
        return new StructuredLogger({}, logLevel);
      }
      return new ConsoleLogger('[Autobeat]', true, logLevel);
    });
  }

  // Validate configuration against system (component-level validation)
  const loggerResult = getFromContainerSafe<Logger>(container, 'logger');
  if (!loggerResult.ok) {
    return loggerResult;
  }
  const logger = loggerResult.value;

  const validationWarnings = validateConfiguration(config, logger);

  // Log summary if warnings exist
  if (validationWarnings.length > 0) {
    const warningCount = validationWarnings.filter((w) => w.severity === 'warning').length;
    const infoCount = validationWarnings.filter((w) => w.severity === 'info').length;
    logger.warn('Configuration validation complete', {
      warnings: warningCount,
      info: infoCount,
      total: validationWarnings.length,
    });
  } else {
    logger.debug('Configuration validation passed - no warnings');
  }

  // Register EventBus as singleton - ALL components must use this shared instance
  container.registerSingleton('eventBus', () => {
    const loggerResult = container.get('logger');
    const configResult = container.get('config');

    // These should always succeed since we registered them above
    if (!loggerResult.ok || !configResult.ok) {
      throw new Error('FATAL: Logger or Config not found in container during EventBus creation');
    }

    const cfg = configResult.value as Configuration;
    return new InMemoryEventBus(cfg, (loggerResult.value as Logger).child({ module: 'SharedEventBus' }));
  });

  // All logs go to stderr to keep stdout clean for MCP protocol
  logger.info('Bootstrapping Autobeat', { config });

  // DECISION: Database is registered via registerValue (eager instantiation) rather than
  // registerSingleton (lazy). Eager instantiation is intentional: it forces better-sqlite3's
  // native module to load at bootstrap time so ABI mismatches (NODE_MODULE_VERSION errors)
  // surface immediately with a clear remediation message. With lazy registration the error
  // would only appear on first database access, deep inside request handling, with no context.
  try {
    const dbLogger = logger.child({ module: 'database' });
    const db = new Database(undefined, dbLogger);
    container.registerValue('database', db);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('NODE_MODULE_VERSION')) {
      return err(
        new AutobeatError(
          ErrorCode.SYSTEM_ERROR,
          `better-sqlite3 was compiled for a different Node.js version.\n\n` +
            `  Current Node:  ${process.version}\n` +
            `  Fix:           npm rebuild better-sqlite3 -g\n` +
            `                 (or reinstall: npm install -g autobeat)\n`,
        ),
      );
    }
    return err(
      new AutobeatError(ErrorCode.SYSTEM_ERROR, 'Failed to initialise database', {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  // Register repositories
  container.registerSingleton('taskRepository', () => {
    const dbResult = container.get<Database>('database');
    if (!dbResult.ok) throw new Error('Failed to get database');
    return new SQLiteTaskRepository(dbResult.value);
  });

  container.registerSingleton('outputRepository', () => {
    const configResult = container.get<Configuration>('config');
    const dbResult = container.get<Database>('database');
    if (!configResult.ok) throw new Error('Config required for OutputRepository');
    if (!dbResult.ok) throw new Error('Failed to get database');
    return new SQLiteOutputRepository(configResult.value, dbResult.value);
  });

  // Register DependencyRepository for task dependency management
  container.registerSingleton('dependencyRepository', () => {
    const dbResult = container.get<Database>('database');
    if (!dbResult.ok) throw new Error('Failed to get database for DependencyRepository');
    return new SQLiteDependencyRepository(dbResult.value);
  });

  // Register ScheduleRepository for task scheduling (v0.4.0)
  container.registerSingleton('scheduleRepository', () => {
    const dbResult = container.get<Database>('database');
    if (!dbResult.ok) throw new Error('Failed to get database for ScheduleRepository');
    return new SQLiteScheduleRepository(dbResult.value);
  });

  // Register CheckpointRepository for task resumption (v0.4.0)
  container.registerSingleton('checkpointRepository', () => {
    const dbResult = container.get<Database>('database');
    if (!dbResult.ok) throw new Error('Failed to get database for CheckpointRepository');
    return new SQLiteCheckpointRepository(dbResult.value);
  });

  // Register WorkerRepository for cross-process coordination (v1.0)
  container.registerSingleton('workerRepository', () => {
    const dbResult = container.get<Database>('database');
    if (!dbResult.ok) throw new Error('Failed to get database for WorkerRepository');
    return new SQLiteWorkerRepository(dbResult.value);
  });

  // Register LoopRepository for iterative task/pipeline loops (v0.7.0)
  container.registerSingleton('loopRepository', () => {
    const dbResult = container.get<Database>('database');
    if (!dbResult.ok) throw new Error('Failed to get database for LoopRepository');
    return new SQLiteLoopRepository(dbResult.value);
  });

  // Register OrchestrationRepository for orchestrator mode (v0.9.0)
  container.registerSingleton('orchestrationRepository', () => {
    const dbResult = container.get<Database>('database');
    if (!dbResult.ok) throw new Error('Failed to get database for OrchestrationRepository');
    return new SQLiteOrchestrationRepository(dbResult.value);
  });

  // Register UsageRepository for token/cost tracking (v1.3.0)
  container.registerSingleton('usageRepository', () => {
    const dbResult = container.get<Database>('database');
    if (!dbResult.ok) throw new Error('Failed to get database for UsageRepository');
    return new SQLiteUsageRepository(dbResult.value);
  });

  // Register PipelineRepository for first-class pipeline entity tracking (Phase A)
  container.registerSingleton('pipelineRepository', () => {
    const dbResult = container.get<Database>('database');
    if (!dbResult.ok) throw new Error('Failed to get database for PipelineRepository');
    return new SQLitePipelineRepository(dbResult.value);
  });

  // Register ScheduleService for schedule management (v0.4.0)
  container.registerSingleton('scheduleService', () => {
    return new ScheduleManagerService(
      getFromContainer<EventBus>(container, 'eventBus'),
      getFromContainer<Logger>(container, 'logger').child({ module: 'ScheduleManager' }),
      getFromContainer<ScheduleRepository>(container, 'scheduleRepository'),
      config,
      getFromContainer<PipelineRepository>(container, 'pipelineRepository'),
    );
  });

  // Register LoopService for iterative task/pipeline loops (v0.7.0)
  container.registerSingleton('loopService', () => {
    return new LoopManagerService(
      getFromContainer<EventBus>(container, 'eventBus'),
      getFromContainer<Logger>(container, 'logger').child({ module: 'LoopManager' }),
      getFromContainer<LoopRepository>(container, 'loopRepository'),
      config,
    );
  });

  // Register OrchestrationService for orchestrator mode (v0.9.0)
  // Cancel cascade (v1.3.0) is handled by AttributedTaskCancellationHandler via OrchestrationCancelled event.
  container.registerSingleton('orchestrationService', () => {
    return new OrchestrationManagerService({
      eventBus: getFromContainer<EventBus>(container, 'eventBus'),
      logger: getFromContainer<Logger>(container, 'logger').child({ module: 'OrchestrationManager' }),
      orchestrationRepo: getFromContainer<OrchestrationRepository>(container, 'orchestrationRepository'),
      loopService: getFromContainer<LoopService>(container, 'loopService'),
      config,
    });
  });

  // Register core services
  container.registerSingleton('taskQueue', () => new PriorityTaskQueue());

  // ============================================================================
  // Translation proxy — optional, activated by agents.claude.proxy config
  //
  // ARCHITECTURE: If proxy config exists, start a local TranslationProxy that
  // routes Anthropic Messages API requests to an OpenAI-compatible backend.
  // The proxy URL is captured here (before agentRegistry is registered) so the
  // agentRegistry factory can use ProxiedClaudeAdapter with the correct port.
  //
  // TEMPORAL DEPENDENCY: proxyPort is captured in the enclosing scope and read
  // inside the agentRegistry factory closure (registered below). This means proxy
  // startup MUST complete before agentRegistry is registered — the current code
  // ordering enforces this. Do NOT move agentRegistry registration above this block.
  //
  // DECISION: Proxy startup is eagerly awaited at bootstrap time (not lazily).
  // Rationale: The port must be known before the agentRegistry factory runs,
  // and factory functions are synchronous. Eager start ensures consistency.
  //
  // DECISION: Proxy starts in server and run modes (both spawn workers).
  // Skipped in cli mode (management commands that never spawn workers) and
  // when a processSpawner is injected (tests with mock spawners).
  //
  // DECISION: Proxy failure is fatal when config exists. The user
  // explicitly configured proxy — falling back to direct Anthropic API
  // would fail (wrong key/model) and produce confusing downstream errors.
  // Error message includes remediation steps for working without the proxy.
  // ============================================================================
  let proxyPort: number | undefined;

  if (!options.processSpawner && !skipProxy) {
    const proxyConfig = loadProxyConfig('claude');
    if (proxyConfig !== null) {
      const proxyManager = new ProxyManager(proxyConfig, logger.child({ module: 'ProxyManager' }));
      const proxyResult = await proxyManager.start();
      if (proxyResult.ok) {
        proxyPort = proxyResult.value.port;
        container.registerValue('proxyManager', proxyManager);
        // Only non-secret fields logged here — proxyConfig.targetApiKey is intentionally omitted.
        logger.info('Translation proxy active', { port: proxyPort, targetBaseUrl: proxyConfig.targetBaseUrl });
      } else {
        return err(
          new AutobeatError(
            ErrorCode.CONFIGURATION_ERROR,
            `Translation proxy failed to start: ${proxyResult.error.message}. ` +
              'To work without the proxy, run: beat agents config set claude proxy ""',
            { error: proxyResult.error.message },
          ),
        );
      }
    }
  }

  // Register AgentRegistry for multi-agent support (v0.5.0)
  // ARCHITECTURE: If a custom ProcessSpawner is injected (tests), wrap it in a
  // compatibility adapter. Otherwise, register all 4 agent adapters.
  // If a translation proxy is active (proxyPort set), use ProxiedClaudeAdapter.
  container.registerSingleton('agentRegistry', () => {
    if (options.processSpawner) {
      logger.info('Using ProcessSpawnerAdapter for injected ProcessSpawner');
      const adapter = new ProcessSpawnerAdapter(options.processSpawner);
      return new InMemoryAgentRegistry([adapter]);
    }

    const configResult = container.get<Configuration>('config');
    if (!configResult.ok) throw new Error('Config required for AgentRegistry');
    const cfg = configResult.value;

    // Use ProxiedClaudeAdapter if translation proxy is active
    const claudeAdapter = proxyPort !== undefined ? new ProxiedClaudeAdapter(cfg, proxyPort) : new ClaudeAdapter(cfg);

    const adapters = [claudeAdapter, new CodexAdapter(cfg), new GeminiAdapter(cfg)];
    return new InMemoryAgentRegistry(adapters);
  });

  container.registerSingleton('resourceMonitor', () => {
    // Use provided resourceMonitor if given (e.g., TestResourceMonitor for tests)
    if (options.resourceMonitor) {
      logger.info('Using provided ResourceMonitor');
      return options.resourceMonitor;
    }

    const configResult = container.get<Configuration>('config');
    const loggerResult = container.get('logger');
    const eventBusResult = container.get('eventBus');

    if (!configResult.ok || !loggerResult.ok || !eventBusResult.ok) {
      throw new Error('Config, Logger and EventBus required for ResourceMonitor');
    }

    const monitor = new SystemResourceMonitor(
      configResult.value,
      getFromContainer<WorkerRepository>(container, 'workerRepository'),
      getFromContainer<EventBus>(container, 'eventBus'),
      getFromContainer<Logger>(container, 'logger').child({ module: 'ResourceMonitor' }),
    );

    if (!skipResourceMonitoring) {
      setTimeout(() => monitor.startMonitoring(), 2000);
    } else {
      logger.info(`Skipping resource monitoring (mode=${mode})`);
    }

    return monitor;
  });

  container.registerSingleton('outputCapture', () => {
    const eventBus = getFromContainer<EventBus>(container, 'eventBus');
    return new BufferedOutputCapture(config.maxOutputBuffer, eventBus);
  });

  // Register worker pool (v0.5.0: uses AgentRegistry instead of ProcessSpawner)
  container.registerSingleton('workerPool', () => {
    return new EventDrivenWorkerPool({
      agentRegistry: getFromContainer<AgentRegistry>(container, 'agentRegistry'),
      monitor: getFromContainer<ResourceMonitor>(container, 'resourceMonitor'),
      logger: getFromContainer<Logger>(container, 'logger').child({ module: 'WorkerPool' }),
      eventBus: getFromContainer<EventBus>(container, 'eventBus'),
      outputCapture: getFromContainer<OutputCapture>(container, 'outputCapture'),
      workerRepository: getFromContainer<WorkerRepository>(container, 'workerRepository'),
      outputRepository: getFromContainer<OutputRepository>(container, 'outputRepository'),
      outputFlushIntervalMs: config.outputFlushIntervalMs,
    });
  });

  // ============================================================================
  // DECISION (2026-04-10): Eager subscription. Handler setup MUST run at bootstrap
  // time, not as a side effect of resolving taskManager. Otherwise CLI commands
  // resolving non-taskManager services (e.g., orchestrationService from
  // `beat orchestrate --foreground`) leave the EventBus with zero subscribers,
  // causing emit-based persistence to silently fail (LoopCreated → FK constraint).
  // See bootstrap-handler-wiring.test.ts.
  // ============================================================================
  const depsResult = extractHandlerDependencies(container);
  if (!depsResult.ok) return depsResult;

  const setupResult = await setupEventHandlers(depsResult.value);
  if (!setupResult.ok) return setupResult;

  // Register handlers in container for shutdown/lifecycle access
  container.registerValue('handlerRegistry', setupResult.value.registry);
  container.registerValue('dependencyHandler', setupResult.value.dependencyHandler);
  container.registerValue('scheduleHandler', setupResult.value.scheduleHandler);
  container.registerValue('checkpointHandler', setupResult.value.checkpointHandler);
  container.registerValue('loopHandler', setupResult.value.loopHandler);
  // orchestrationHandler was previously returned from setupEventHandlers but never
  // registered — included here to fix the pre-existing oversight.
  if (setupResult.value.orchestrationHandler) {
    container.registerValue('orchestrationHandler', setupResult.value.orchestrationHandler);
  }

  // Defensive sanity check: assert critical event subscriptions exist.
  // If this fails, the handler wiring code is broken — surface immediately.
  {
    const eventBusResult = container.get<InMemoryEventBus>('eventBus');
    if (eventBusResult.ok) {
      const eventBus = eventBusResult.value;
      const criticalEvents: Array<string> = ['LoopCreated', 'TaskQueued', 'LoopCompleted'];
      for (const eventType of criticalEvents) {
        if (eventBus.getSubscriberCount(eventType) === 0) {
          return err(
            new AutobeatError(
              ErrorCode.SYSTEM_ERROR,
              `Bootstrap sanity check failed: no subscribers for ${eventType}. Event handler setup is likely broken.`,
              { eventType },
            ),
          );
        }
      }
    }
  }

  // Register task manager (synchronous construction only — handlers already wired above)
  container.registerSingleton('taskManager', () => {
    // ARCHITECTURE: Hybrid TaskManager - commands via events, queries via direct repo
    return new TaskManagerService({
      eventBus: getFromContainer<EventBus>(container, 'eventBus'),
      logger: getFromContainer<Logger>(container, 'logger').child({ module: 'TaskManager' }),
      config, // Pass complete config - no partial objects needed
      taskRepo: getFromContainer<TaskRepository>(container, 'taskRepository'),
      outputCapture: getFromContainer<OutputCapture>(container, 'outputCapture'),
      outputRepository: getFromContainer<OutputRepository>(container, 'outputRepository'),
      checkpointRepo: getFromContainer<CheckpointRepository>(container, 'checkpointRepository'),
    });
  });

  // Register MCP adapter
  container.registerSingleton('mcpAdapter', () => {
    const taskManagerResult = container.get<TaskManager>('taskManager');
    if (!taskManagerResult.ok) {
      throw new Error(`Failed to get taskManager for MCPAdapter: ${taskManagerResult.error.message}`);
    }

    return new MCPAdapter({
      taskManager: taskManagerResult.value,
      logger: getFromContainer<Logger>(container, 'logger').child({ module: 'MCP' }),
      scheduleService: getFromContainer<ScheduleService>(container, 'scheduleService'),
      loopService: getFromContainer<LoopService>(container, 'loopService'),
      agentRegistry: getFromContainer<AgentRegistry>(container, 'agentRegistry'),
      config,
      orchestrationService: getFromContainer<OrchestrationService>(container, 'orchestrationService'),
      pipelineRepository: getFromContainer<PipelineRepository>(container, 'pipelineRepository'),
    });
  });

  // Register recovery manager
  container.registerSingleton('recoveryManager', () => {
    const repositoryResult = container.get('taskRepository');

    if (!repositoryResult.ok) {
      throw new Error('TaskRepository required for RecoveryManager');
    }

    return new RecoveryManager({
      taskRepo: repositoryResult.value as TaskRepository,
      queue: getFromContainer<TaskQueue>(container, 'taskQueue'),
      eventBus: getFromContainer<EventBus>(container, 'eventBus'),
      logger: getFromContainer<Logger>(container, 'logger').child({ module: 'Recovery' }),
      workerRepo: getFromContainer<WorkerRepository>(container, 'workerRepository'),
      dependencyRepo: getFromContainer<DependencyRepository>(container, 'dependencyRepository'),
      loopRepo: getFromContainer<LoopRepository>(container, 'loopRepository'),
      orchestrationRepo: getFromContainer<OrchestrationRepository>(container, 'orchestrationRepository'),
    });
  });

  // Run recovery on startup (skip for short-lived CLI commands)
  if (!skipRecovery) {
    const recoveryResult = container.get('recoveryManager');
    if (recoveryResult.ok) {
      const recovery = recoveryResult.value as RecoveryManager;
      recovery.recover().then((result) => {
        if (!result.ok) {
          logger.error('Recovery failed', result.error);
        }
      });
    }
  } else {
    logger.info(`Skipping recovery (mode=${mode})`);
  }

  // Register schedule executor for task scheduling (v0.4.0)
  // ARCHITECTURE: ScheduleExecutor runs timer-based tick loop for due schedules
  // Uses factory pattern (ScheduleExecutor.create()) to keep constructor pure
  container.registerSingleton('scheduleExecutor', () => {
    const scheduleRepoResult = container.get<ScheduleRepository & SyncScheduleOperations>('scheduleRepository');
    const eventBusResult = container.get<EventBus>('eventBus');
    const databaseResult = container.get<TransactionRunner>('database');
    const loggerResult = container.get<Logger>('logger');

    if (!scheduleRepoResult.ok || !eventBusResult.ok || !databaseResult.ok || !loggerResult.ok) {
      throw new Error('Failed to get dependencies for ScheduleExecutor');
    }

    const createResult = ScheduleExecutor.create(
      scheduleRepoResult.value,
      eventBusResult.value,
      databaseResult.value,
      loggerResult.value.child({ module: 'ScheduleExecutor' }),
    );

    if (!createResult.ok) {
      throw new Error(`Failed to create ScheduleExecutor: ${createResult.error.message}`);
    }

    return createResult.value;
  });

  // Initialize schedule executor after recovery completes
  // ARCHITECTURE: Starts the 60-second tick loop for checking due schedules
  // Skip for short-lived CLI commands — only the MCP server daemon needs the executor
  if (!skipScheduleExecutor) {
    const executorResult = container.get<ScheduleExecutor>('scheduleExecutor');
    if (executorResult.ok) {
      const executor = executorResult.value;
      const startResult = executor.start();
      if (!startResult.ok) {
        logger.error('Failed to start ScheduleExecutor', startResult.error);
      } else {
        logger.info('ScheduleExecutor started');
      }
    } else {
      logger.error('Failed to get ScheduleExecutor', executorResult.error);
    }
  } else {
    logger.info(`Skipping ScheduleExecutor (mode=${mode})`);
  }

  logger.info('Bootstrap complete');

  return ok(container);
}
