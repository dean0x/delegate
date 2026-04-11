/**
 * Dashboard entry point
 * ARCHITECTURE: TTY guard, alternate screen management, Ink render lifecycle
 * Renders to stderr (process.stderr) so stdout remains usable for piping
 *
 * DECISION (2026-04-10): The dashboard uses bootstrap({ mode: 'cli' }) instead of
 * createReadOnlyContext() because manual cancel/delete keybindings need mutation
 * access via orchestrationService. Adds ~200-500ms to dashboard startup but
 * acceptable because the dashboard is launched interactively.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ansiEscapes from 'ansi-escapes';
import { render } from 'ink';
import React from 'react';
import { bootstrap } from '../../bootstrap.js';
import type {
  LoopRepository,
  LoopService,
  OrchestrationRepository,
  OrchestrationService,
  OutputRepository,
  ResourceMonitor,
  ScheduleRepository,
  ScheduleService,
  TaskManager,
  TaskRepository,
  UsageRepository,
  WorkerRepository,
} from '../../core/interfaces.js';
import { DEFAULT_DASHBOARD_LOG_PATH, type DisposableLogger, FileLogger } from '../../implementations/file-logger.js';
import { LogLevel } from '../../implementations/logger.js';
import type { ReadOnlyContext } from '../read-only-context.js';
import { App } from './app.js';
import type { DashboardMutationContext } from './types.js';

const MIN_COLS = 80;
const MIN_ROWS = 20;

/**
 * Start the interactive terminal dashboard.
 * Checks for TTY, sets up alternate screen, renders the Ink app, then cleans up.
 */
export async function startDashboard(): Promise<void> {
  // TTY guard — dashboard requires an interactive terminal
  if (!process.stderr.isTTY) {
    process.stderr.write('Error: beat dashboard requires an interactive terminal (TTY)\n');
    process.exit(1);
  }

  // Terminal size guard — 4-panel grid needs reasonable dimensions
  const cols = process.stderr.columns ?? 0;
  const rows = process.stderr.rows ?? 0;
  if (cols < MIN_COLS || rows < MIN_ROWS) {
    process.stderr.write(`Error: Terminal too small (need ${MIN_COLS}×${MIN_ROWS}, have ${cols}×${rows})\n`);
    process.exit(1);
  }

  // Read version from package.json — graceful fallback if missing or malformed
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  let version = '0.0.0';
  try {
    const raw = readFileSync(path.join(dirname, '..', '..', '..', 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw) as { version?: string };
    version = pkg.version ?? '0.0.0';
  } catch {
    // Fallback — dashboard still works without version display
  }

  // Swap the default stderr-based ConsoleLogger for a file-backed logger so
  // downstream log output does not interleave with Ink's frame rendering.
  // FileLogger.create() never throws — it falls back to a SilentLogger if the
  // file cannot be opened, so the dashboard always has a valid Logger.
  const fileLogger: DisposableLogger = await FileLogger.create(DEFAULT_DASHBOARD_LOG_PATH, LogLevel.INFO);

  // Bootstrap with mode: 'cli' — initialises repositories + services needed for mutations
  // (cancel/delete keybindings) without starting the MCP server or scheduler.
  // Pass the file logger so ConsoleLogger is never registered on stderr.
  const bootstrapResult = await bootstrap({ mode: 'cli', logger: fileLogger });
  if (!bootstrapResult.ok) {
    process.stderr.write(`Error: Failed to initialize: ${bootstrapResult.error.message}\n`);
    await fileLogger.dispose();
    process.exit(1);
  }

  const container = bootstrapResult.value;

  // Extract read-only repositories for data polling
  const taskRepository = container.get<TaskRepository>('taskRepository');
  const loopRepository = container.get<LoopRepository>('loopRepository');
  const scheduleRepository = container.get<ScheduleRepository>('scheduleRepository');
  const orchestrationRepository = container.get<OrchestrationRepository>('orchestrationRepository');
  const workerRepository = container.get<WorkerRepository>('workerRepository');
  const outputRepository = container.get<OutputRepository>('outputRepository');
  const usageRepository = container.get<UsageRepository>('usageRepository');

  if (
    !taskRepository.ok ||
    !loopRepository.ok ||
    !scheduleRepository.ok ||
    !orchestrationRepository.ok ||
    !workerRepository.ok ||
    !outputRepository.ok ||
    !usageRepository.ok
  ) {
    process.stderr.write('Error: Failed to resolve repositories from container\n');
    process.exit(1);
  }

  // Build a ReadOnlyContext view over the bootstrapped container's repositories.
  // close() is a no-op here — container.dispose() in cleanup() handles teardown.
  const ctx: ReadOnlyContext = {
    taskRepository: taskRepository.value,
    loopRepository: loopRepository.value,
    scheduleRepository: scheduleRepository.value,
    orchestrationRepository: orchestrationRepository.value,
    workerRepository: workerRepository.value,
    outputRepository: outputRepository.value,
    usageRepository: usageRepository.value,
    close: () => {
      /* handled by container.dispose() in cleanup() */
    },
  };

  // Extract resource monitor for the resources tile (best-effort — optional)
  const resourceMonitorResult = container.get<ResourceMonitor>('resourceMonitor');
  const resourceMonitor = resourceMonitorResult.ok ? resourceMonitorResult.value : undefined;

  // Extract mutation services for cancel/delete keybindings
  const orchestrationServiceResult = container.get<OrchestrationService>('orchestrationService');
  const loopServiceResult = container.get<LoopService>('loopService');
  const scheduleServiceResult = container.get<ScheduleService>('scheduleService');
  const taskManagerResult = container.get<TaskManager>('taskManager');

  // Mutations are best-effort — dashboard degrades gracefully if unavailable
  const mutations: DashboardMutationContext | undefined =
    orchestrationServiceResult.ok && loopServiceResult.ok && scheduleServiceResult.ok && taskManagerResult.ok
      ? {
          orchestrationService: orchestrationServiceResult.value,
          loopService: loopServiceResult.value,
          scheduleService: scheduleServiceResult.value,
          taskManager: taskManagerResult.value,
          orchestrationRepo: orchestrationRepository.value,
          loopRepo: loopRepository.value,
          taskRepo: taskRepository.value,
          scheduleRepo: scheduleRepository.value,
        }
      : undefined;

  // Emit discovery hint BEFORE entering alternate screen so the message lands in
  // the normal scrollback buffer and is visible after the dashboard exits.
  // Only written when the file logger is active (instanceof FileLogger) — skipped
  // on the SilentLogger fallback path where there is no file to tail.
  if (fileLogger instanceof FileLogger) {
    process.stderr.write(`[dashboard] logs → ${DEFAULT_DASHBOARD_LOG_PATH}\n`);
  }

  // Enter alternate screen and hide cursor on stderr
  process.stderr.write(ansiEscapes.enterAlternativeScreen);
  process.stderr.write(ansiEscapes.cursorHide);

  let cleanupCalled = false;

  const cleanup = (): void => {
    if (cleanupCalled) return;
    cleanupCalled = true;

    // Restore terminal state
    process.stderr.write(ansiEscapes.cursorShow);
    process.stderr.write(ansiEscapes.exitAlternativeScreen);

    // Dispose container (closes DB, stops monitors, etc.) then flush/close the
    // file-backed logger. Both are best-effort — errors are swallowed so
    // exit paths always complete.
    void container.dispose().finally(() => fileLogger.dispose());
  };

  // Handle SIGTERM for graceful shutdown
  // NOTE: SIGINT (Ctrl+C) is handled by Ink — do NOT register a handler for it here
  process.once('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });

  // Catch unexpected errors to ensure terminal is restored
  process.once('uncaughtException', (error) => {
    cleanup();
    process.stderr.write(`\nUnhandled error: ${error.message}\n`);
    process.exit(1);
  });

  process.once('unhandledRejection', (reason) => {
    cleanup();
    const message = reason instanceof Error ? reason.message : String(reason);
    process.stderr.write(`\nUnhandled rejection: ${message}\n`);
    process.exit(1);
  });

  const instance = render(
    <App
      ctx={ctx}
      version={version}
      mutations={mutations}
      resourceMonitor={resourceMonitor}
      outputRepository={outputRepository.value}
    />,
    {
      stdin: process.stdin, // Required: Ink needs stdin to establish raw mode + capture keystrokes
      stdout: process.stderr,
      patchConsole: false,
    },
  );

  try {
    await instance.waitUntilExit();
  } finally {
    cleanup();
  }
}
