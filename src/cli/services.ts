import { bootstrap } from '../bootstrap.js';
import type { Container } from '../core/container.js';
import type { ScheduleService, TaskManager } from '../core/interfaces.js';
import { createReadOnlyContext, type ReadOnlyContext } from './read-only-context.js';
import type { Spinner } from './ui.js';
import * as ui from './ui.js';

/** Extract a safe error message from an unknown catch value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Create a lightweight read-only context for query commands.
 *
 * **Read-only commands** (status, logs, list, schedule list/get): Use this —
 * opens Database + repos directly, skipping EventBus, handlers, WorkerPool, etc.
 *
 * **Mutation commands** (run, cancel, retry, resume, schedule create/cancel/pause/resume):
 * Use `withServices()` — full bootstrap with EventBus + handlers.
 *
 * **MCP server**: Uses full `bootstrap()` directly.
 */
export function withReadOnlyContext(s?: Spinner): ReadOnlyContext {
  const result = createReadOnlyContext();
  if (!result.ok) {
    s?.stop('Initialization failed');
    ui.error(`Failed to initialize: ${result.error.message}`);
    process.exit(1);
  }
  return result.value;
}

/**
 * Bootstrap and resolve services, eliminating repeated boilerplate.
 * Accepts an optional spinner for progress feedback during async init.
 * Returns typed services or exits on failure.
 *
 * Used for mutation commands that need the full event-driven pipeline.
 * Skips recovery and schedule executor — only the MCP server daemon needs those.
 */
export async function withServices(s?: Spinner): Promise<{
  container: Container;
  taskManager: TaskManager;
  scheduleService: ScheduleService;
}> {
  s?.message('Initializing...');
  const containerResult = await bootstrap({ mode: 'cli' });
  if (!containerResult.ok) {
    s?.stop('Initialization failed');
    ui.error(`Bootstrap failed: ${containerResult.error.message}`);
    process.exit(1);
  }
  const container = containerResult.value;

  const taskManagerResult = await container.resolve<TaskManager>('taskManager');
  if (!taskManagerResult.ok) {
    s?.stop('Initialization failed');
    ui.error(`Failed to get task manager: ${taskManagerResult.error.message}`);
    process.exit(1);
  }

  const scheduleServiceResult = container.get<ScheduleService>('scheduleService');
  if (!scheduleServiceResult.ok) {
    s?.stop('Initialization failed');
    ui.error(`Failed to get schedule service: ${scheduleServiceResult.error.message}`);
    process.exit(1);
  }

  return {
    container,
    taskManager: taskManagerResult.value,
    scheduleService: scheduleServiceResult.value,
  };
}
