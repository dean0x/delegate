import { bootstrap } from '../bootstrap.js';
import type { Container } from '../core/container.js';
import type {
  ChannelService,
  LoopService,
  OrchestrationService,
  ScheduleService,
  TaskManager,
} from '../core/interfaces.js';
import type { Result } from '../core/result.js';
import { createReadOnlyContext, type ReadOnlyContext } from './read-only-context.js';
import type { Spinner } from './ui.js';
import * as ui from './ui.js';

/** Extract a safe error message from an unknown catch value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Guard: exit on Result error, returning the unwrapped value on success. */
export function exitOnError<T>(result: Result<T>, s?: Spinner, prefix?: string, stopMsg = 'Failed'): T {
  if (!result.ok) {
    s?.stop(stopMsg);
    ui.error(prefix ? `${prefix}: ${result.error.message}` : result.error.message);
    process.exit(1);
  }
  return result.value;
}

/** Guard: exit on null/undefined, returning the narrowed value on success. */
export function exitOnNull<T>(
  value: T | null | undefined,
  s: Spinner | undefined,
  msg: string,
  stopMsg = 'Not found',
): T {
  if (value == null) {
    s?.stop(stopMsg);
    ui.error(msg);
    process.exit(1);
  }
  return value;
}

/**
 * Create a lightweight read-only context for query commands.
 *
 * **Read-only commands** (status, logs, list, schedule list/status): Use this —
 * opens Database + repos directly, skipping EventBus, handlers, WorkerPool, etc.
 *
 * **Mutation commands** (run, cancel, retry, resume, schedule create/cancel/pause/resume):
 * Use `withServices()` — full bootstrap with EventBus + handlers.
 *
 * **MCP server**: Uses full `bootstrap()` directly.
 */
export function withReadOnlyContext(s?: Spinner): ReadOnlyContext {
  return exitOnError(createReadOnlyContext(), s, 'Failed to initialize', 'Initialization failed');
}

/**
 * Bootstrap and resolve services, eliminating repeated boilerplate.
 * Accepts an optional spinner for progress feedback during async init.
 * Returns typed services or exits on failure.
 *
 * Used for mutation commands that need the full event-driven pipeline.
 * Skips recovery and schedule executor — only the MCP server daemon needs those.
 *
 * ARCHITECTURE: channelService is resolved lazily via `resolveChannelService()`.
 * Non-channel commands never call it and pay zero ChannelManager.create() cost.
 * Channel commands call it once; subsequent calls return the cached singleton.
 */
export async function withServices(s?: Spinner): Promise<{
  container: Container;
  taskManager: TaskManager;
  scheduleService: ScheduleService;
  loopService: LoopService;
  orchestrationService: OrchestrationService;
  resolveChannelService: () => Promise<ChannelService | undefined>;
}> {
  s?.message('Initializing...');
  const container = exitOnError(await bootstrap({ mode: 'cli' }), s, 'Bootstrap failed', 'Initialization failed');
  const taskManager = exitOnError(
    await container.resolve<TaskManager>('taskManager'),
    s,
    'Failed to get task manager',
    'Initialization failed',
  );
  const scheduleService = exitOnError(
    container.get<ScheduleService>('scheduleService'),
    s,
    'Failed to get schedule service',
    'Initialization failed',
  );
  const loopService = exitOnError(
    container.get<LoopService>('loopService'),
    s,
    'Failed to get loop service',
    'Initialization failed',
  );
  const orchestrationService = exitOnError(
    container.get<OrchestrationService>('orchestrationService'),
    s,
    'Failed to get orchestration service',
    'Initialization failed',
  );

  // ARCHITECTURE: Lazy resolver — ChannelManager.create() is async and only needed by
  // channel mutation commands. Non-channel commands (cancel, retry, resume, etc.) never
  // call this and pay no startup cost. The container caches the singleton on first call.
  const resolveChannelService = async (): Promise<ChannelService | undefined> => {
    const result = await container.resolve<ChannelService>('channelService');
    if (result.ok) return result.value;
    ui.info(`Warning: Channel service unavailable: ${result.error.message}`);
    return undefined;
  };

  return { container, taskManager, scheduleService, loopService, orchestrationService, resolveChannelService };
}
