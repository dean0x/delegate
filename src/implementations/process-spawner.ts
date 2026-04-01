/**
 * Process spawning implementation
 * Handles Claude Code process creation
 */

import { ChildProcess, spawn } from 'child_process';
import { Configuration } from '../core/configuration.js';
import { AutobeatError, ErrorCode, processSpawnFailed } from '../core/errors.js';
import { ProcessSpawner } from '../core/interfaces.js';
import { err, ok, Result, tryCatch } from '../core/result.js';

export class ClaudeProcessSpawner implements ProcessSpawner {
  private readonly claudeCommand: string;
  private readonly baseArgs: readonly string[];
  private readonly killTimeouts = new Map<number, NodeJS.Timeout>();
  private readonly config: Configuration;

  constructor(config: Configuration, claudeCommand = 'claude') {
    this.config = config;
    this.claudeCommand = claudeCommand;
    this.baseArgs = Object.freeze(['--print', '--dangerously-skip-permissions', '--output-format', 'json']);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  spawn(prompt: string, workingDirectory: string, taskId?: string, _model?: string): Result<{ process: ChildProcess; pid: number }> {
    try {
      // Make prompt more explicit if it looks like a simple command
      let finalPrompt = prompt;

      // If the prompt looks like a simple command without explicit instructions,
      // wrap it to make Claude understand it should execute it
      if (
        !prompt.toLowerCase().includes('run') &&
        !prompt.toLowerCase().includes('execute') &&
        !prompt.toLowerCase().includes('perform') &&
        !prompt.toLowerCase().includes('bash') &&
        !prompt.toLowerCase().includes('command') &&
        prompt.split(' ').length <= 3
      ) {
        finalPrompt = `Execute the following bash command: ${prompt}`;
      }

      // With --print flag, prompt is passed as argument, not via stdin
      const args = [...this.baseArgs, finalPrompt];

      // Log via proper logger instead of console.error to avoid interfering with output capture
      // console.error(`[ProcessSpawner] Executing: ${this.claudeCommand} ${args.map(arg => `"${arg}"`).join(' ')}`);
      // console.error(`[ProcessSpawner] Working directory: ${workingDirectory}`);
      // console.error(`[ProcessSpawner] Environment keys: ${Object.keys(process.env).length}`);

      // Add Autobeat-specific environment variables for identification
      // CRITICAL: Strip all Claude Code nesting indicators to prevent rejection
      // Workers are independent Claude Code instances, not nested sessions
      // Claude Code checks CLAUDECODE and any CLAUDE_CODE_* prefixed vars
      const cleanEnv = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key !== 'CLAUDECODE' && !key.startsWith('CLAUDE_CODE_')),
      );
      const env = {
        ...cleanEnv,
        AUTOBEAT_WORKER: 'true',
        ...(taskId && { AUTOBEAT_TASK_ID: taskId }),
      };

      const child = spawn(this.claudeCommand, args, {
        cwd: workingDirectory,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // ARCHITECTURE: Check PID immediately - spawn() is synchronous for PID assignment
      if (!child.pid) {
        return err(processSpawnFailed('Failed to get process PID'));
      }

      return ok({ process: child, pid: child.pid });
    } catch (error) {
      return err(processSpawnFailed(String(error)));
    }
  }

  kill(pid: number): Result<void> {
    return tryCatch(
      () => {
        // Clear any existing timeout for this PID
        this.clearKillTimeout(pid);

        process.kill(pid, 'SIGTERM');

        // Give it time to terminate gracefully before forcing
        const timeoutId = setTimeout(() => {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // Process might already be dead
          } finally {
            // Clean up timeout reference
            this.killTimeouts.delete(pid);
          }
        }, this.config.killGracePeriodMs!);

        // Track timeout for cleanup
        this.killTimeouts.set(pid, timeoutId);
      },
      (error) =>
        new AutobeatError(ErrorCode.PROCESS_KILL_FAILED, `Failed to kill process ${pid}: ${error}`, { pid, error }),
    );
  }

  /**
   * Clear kill timeout for a specific PID
   * @param pid - Process ID to clear timeout for
   * @remarks Prevents timeout leaks during cleanup
   * @internal
   */
  private clearKillTimeout(pid: number): void {
    const timeoutId = this.killTimeouts.get(pid);
    if (timeoutId) {
      clearTimeout(timeoutId);
      this.killTimeouts.delete(pid);
    }
  }

  /**
   * Clean up all pending kill timeouts and resources
   * @remarks Must be called during shutdown to prevent timeout leaks
   * @example
   * ```typescript
   * const spawner = new ClaudeProcessSpawner();
   * try {
   *   const result = spawner.spawn('test prompt', '/tmp', 'task-123');
   *   // use the spawned process
   * } finally {
   *   spawner.dispose(); // Ensure cleanup
   * }
   * ```
   */
  public dispose(): void {
    for (const [pid, timeoutId] of this.killTimeouts) {
      clearTimeout(timeoutId);
    }
    this.killTimeouts.clear();
  }
}
