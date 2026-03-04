import { spawn } from 'child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { bootstrap } from '../../bootstrap.js';
import type { AgentProvider } from '../../core/agents.js';
import type { Container } from '../../core/container.js';
import type { TaskRequest } from '../../core/domain.js';
import { Priority, TaskId } from '../../core/domain.js';
import type { EventBus } from '../../core/events/event-bus.js';
import type {
  OutputCapturedEvent,
  TaskCancelledEvent,
  TaskCompletedEvent,
  TaskFailedEvent,
  TaskTimeoutEvent,
} from '../../core/events/events.js';
import type { TaskManager } from '../../core/interfaces.js';
import { errorMessage } from '../services.js';
import * as ui from '../ui.js';

/**
 * Subscribe to EventBus events for a specific task and wait for terminal state.
 * Streams OutputCaptured to stdout/stderr in real-time.
 * Returns the worker's exit code (0 = success, non-zero = failure).
 */
export function waitForTaskCompletion(container: Container, taskId: string): Promise<number> {
  const eventBusResult = container.get<EventBus>('eventBus');
  if (!eventBusResult.ok) {
    ui.error(`Failed to get event bus: ${eventBusResult.error.message}`);
    return Promise.resolve(1);
  }
  const eventBus = eventBusResult.value;

  return new Promise((resolve) => {
    let resolved = false;
    const subscriptionIds: string[] = [];

    const cleanup = () => {
      for (const id of subscriptionIds) {
        eventBus.unsubscribe(id);
      }
    };

    const resolveOnce = (exitCode: number) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(exitCode);
    };

    // Stream output in real-time
    const outputSub = eventBus.subscribe<OutputCapturedEvent>('OutputCaptured', async (event) => {
      if (event.taskId !== taskId) return;
      const stream = event.outputType === 'stderr' ? process.stderr : process.stdout;
      stream.write(event.data);
    });
    if (outputSub.ok) subscriptionIds.push(outputSub.value);

    // Terminal states
    const completedSub = eventBus.subscribe<TaskCompletedEvent>('TaskCompleted', async (event) => {
      if (event.taskId !== taskId) return;
      resolveOnce(event.exitCode);
    });
    if (completedSub.ok) subscriptionIds.push(completedSub.value);

    const failedSub = eventBus.subscribe<TaskFailedEvent>('TaskFailed', async (event) => {
      if (event.taskId !== taskId) return;
      resolveOnce(event.exitCode ?? 1);
    });
    if (failedSub.ok) subscriptionIds.push(failedSub.value);

    const cancelledSub = eventBus.subscribe<TaskCancelledEvent>('TaskCancelled', async (event) => {
      if (event.taskId !== taskId) return;
      resolveOnce(1);
    });
    if (cancelledSub.ok) subscriptionIds.push(cancelledSub.value);

    const timeoutSub = eventBus.subscribe<TaskTimeoutEvent>('TaskTimeout', async (event) => {
      if (event.taskId !== taskId) return;
      resolveOnce(1);
    });
    if (timeoutSub.ok) subscriptionIds.push(timeoutSub.value);
  });
}

/**
 * Default detach mode: re-spawn the CLI as a detached background process.
 * The background process runs the full lifecycle (bootstrap, delegate, wait, dispose, exit)
 * with --foreground so it doesn't recurse back into detach mode.
 * The foreground polls the background's log file to extract and print the task ID, then exits.
 */
export function handleDetachMode(runArgs: string[]): void {
  // Validate that at least one non-flag word exists (the prompt)
  const hasPrompt = runArgs.some((arg) => !arg.startsWith('-'));
  if (!hasPrompt) {
    ui.error('Usage: beat run "<prompt>" [options]');
    process.stderr.write('  A prompt is required to delegate a task\n');
    process.exit(1);
  }

  // Create log directory
  const logDir = path.join(homedir(), '.backbeat', 'detach-logs');
  try {
    mkdirSync(logDir, { recursive: true });
  } catch (error) {
    ui.error(`Failed to create log directory: ${logDir}: ${errorMessage(error)}`);
    process.exit(1);
  }

  // Create log file with timestamp and random suffix for uniqueness
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = Math.random().toString(36).substring(2, 8);
  const logFile = path.join(logDir, `detach-${timestamp}-${suffix}.log`);
  let logFd: number;
  try {
    logFd = openSync(logFile, 'w');
  } catch (error) {
    ui.error(`Failed to create log file: ${logFile}: ${errorMessage(error)}`);
    process.exit(1);
  }

  // Re-spawn CLI with --foreground as a detached background process
  const childArgs = [process.argv[1], 'run', '--foreground', ...runArgs];
  try {
    const child = spawn(process.argv[0], childArgs, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      cwd: process.cwd(),
      env: process.env,
    });

    child.unref();

    if (!child.pid) {
      closeSync(logFd);
      ui.error('Failed to spawn background process');
      process.exit(1);
    }

    ui.info(`Background process started (PID: ${child.pid})`);
    ui.info(`Log file: ${logFile}`);
    closeSync(logFd);

    // Poll log file for task ID (max 15s at 200ms intervals)
    const maxAttempts = 75; // 15s / 200ms
    let attempt = 0;
    const taskIdPattern = /Task ID:\s+(task-\S+)/;
    const errorPattern = /^❌/m;

    const s = ui.createSpinner();
    s.start('Waiting for task ID...');

    const pollInterval = setInterval(() => {
      attempt++;
      try {
        const content = readFileSync(logFile, 'utf-8');

        // Check for task ID first — once delegation succeeds, task output may
        // contain ❌ which would be a false positive for the error check below.
        const match = content.match(taskIdPattern);
        if (match) {
          clearInterval(pollInterval);
          const taskId = match[1];
          s.stop(`Task delegated: ${taskId}`);
          ui.info(`Check status: beat status ${taskId}`);
          ui.info(`View logs:    beat logs ${taskId}`);
          process.exit(0);
        }

        // Only check for CLI errors if no task ID yet (pre-delegation phase)
        if (errorPattern.test(content)) {
          clearInterval(pollInterval);
          s.stop('Background process error');
          const lines = content.split('\n').filter((l) => l.trim().length > 0);
          const lastLines = lines.slice(-5);
          ui.error('Background process encountered an error:');
          for (const line of lastLines) {
            process.stderr.write(`  ${line}\n`);
          }
          process.exit(1);
        }
      } catch {
        // Log file not yet readable, continue polling
      }

      if (attempt >= maxAttempts) {
        clearInterval(pollInterval);
        s.stop('Task ID not yet available (background process still starting)');
        ui.info(`Check log file: ${logFile}`);
        process.exit(0);
      }
    }, 200);
  } catch (error) {
    closeSync(logFd);
    ui.error(`Failed to spawn background process: ${errorMessage(error)}`);
    process.exit(1);
  }
}

export async function runTask(
  prompt: string,
  options?: {
    priority?: 'P0' | 'P1' | 'P2';
    workingDirectory?: string;
    dependsOn?: readonly string[];
    continueFrom?: string;
    timeout?: number;
    maxOutputBuffer?: number;
    agent?: string;
  },
) {
  let container: Container | undefined;
  const s = ui.createSpinner();
  try {
    s.start('Initializing...');
    const containerResult = await bootstrap({
      skipScheduleExecutor: true,
      skipResourceMonitoring: true,
    });
    if (!containerResult.ok) {
      s.stop('Initialization failed');
      ui.error(`Bootstrap failed: ${containerResult.error.message}`);
      process.exit(1);
    }
    container = containerResult.value;

    const taskManagerResult = await container.resolve<TaskManager>('taskManager');
    if (!taskManagerResult.ok) {
      s.stop('Initialization failed');
      ui.error(`Failed to get task manager: ${taskManagerResult.error.message}`);
      await container.dispose();
      process.exit(1);
    }

    const taskManager = taskManagerResult.value;
    s.stop('Ready');

    // Show task info
    const truncatedPrompt = prompt.substring(0, 100) + (prompt.length > 100 ? '...' : '');
    ui.step(truncatedPrompt);

    if (options) {
      const params: string[] = [];
      if (options.priority) params.push(`Priority: ${options.priority}`);
      if (options.workingDirectory) params.push(`Dir: ${options.workingDirectory}`);
      if (options.agent) params.push(`Agent: ${options.agent}`);
      if (options.dependsOn && options.dependsOn.length > 0) params.push(`Deps: ${options.dependsOn.join(', ')}`);
      if (options.continueFrom) params.push(`Continue from: ${options.continueFrom}`);
      if (options.timeout) params.push(`Timeout: ${ui.formatMs(options.timeout)}`);
      if (options.maxOutputBuffer) params.push(`Buffer: ${ui.formatBytes(options.maxOutputBuffer)}`);
      if (params.length > 0) ui.info(params.join(' | '));
    }

    const request: TaskRequest = {
      prompt,
      ...options,
      priority: options?.priority ? Priority[options.priority as keyof typeof Priority] : undefined,
      dependsOn: options?.dependsOn?.map((id: string) => TaskId(id)),
      continueFrom: options?.continueFrom ? TaskId(options.continueFrom) : undefined,
      agent: options?.agent as AgentProvider | undefined,
    };

    const result = await taskManager.delegate(request);
    if (!result.ok) {
      ui.error(`Failed to delegate task: ${result.error.message}`);
      await container.dispose();
      process.exit(1);
    }

    const task = result.value;
    // CRITICAL: "Task ID:" pattern is used by detach-mode polling
    ui.success(`Task ID: ${task.id}`);

    // Wait for worker completion with real-time output streaming
    let cancelledBySigint = false;
    const sigintHandler = () => {
      process.stderr.write('\nCancelling task...\n');
      cancelledBySigint = true;
      taskManager.cancel(task.id, 'User interrupted (SIGINT)');
    };
    process.on('SIGINT', sigintHandler);

    const waitSpinner = ui.createSpinner();
    waitSpinner.start('Running... (Ctrl+C to cancel)');

    const exitCode = await waitForTaskCompletion(container, task.id);

    if (exitCode === 0) {
      waitSpinner.stop(`Completed (exit ${exitCode})`);
    } else {
      waitSpinner.error(`Failed (exit ${exitCode})`);
    }

    process.removeListener('SIGINT', sigintHandler);
    await container.dispose();
    process.exit(cancelledBySigint ? 130 : exitCode);
  } catch (error) {
    s.stop('Failed');
    ui.error(errorMessage(error));
    if (container) await container.dispose();
    process.exit(1);
  }
}
