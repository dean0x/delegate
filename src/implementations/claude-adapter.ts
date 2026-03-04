/**
 * Claude Code agent adapter implementation
 *
 * ARCHITECTURE: Extracts Claude-specific spawn logic from ClaudeProcessSpawner
 * into the AgentAdapter interface for multi-agent support.
 *
 * The original ClaudeProcessSpawner remains intact for backward compatibility
 * with the ProcessSpawner interface.
 */

import { ChildProcess, spawn } from 'child_process';
import { AgentAdapter, AgentProvider } from '../core/agents.js';
import { Configuration } from '../core/configuration.js';
import { BackbeatError, ErrorCode, processSpawnFailed } from '../core/errors.js';
import { err, ok, Result, tryCatch } from '../core/result.js';

export class ClaudeAdapter implements AgentAdapter {
  readonly provider: AgentProvider = 'claude';

  private readonly claudeCommand: string;
  private readonly baseArgs: readonly string[];
  private readonly killTimeouts = new Map<number, NodeJS.Timeout>();
  private readonly config: Configuration;

  constructor(config: Configuration, claudeCommand = 'claude') {
    this.config = config;
    this.claudeCommand = claudeCommand;
    this.baseArgs = Object.freeze(['--print', '--dangerously-skip-permissions', '--output-format', 'json']);
  }

  spawn(prompt: string, workingDirectory: string, taskId?: string): Result<{ process: ChildProcess; pid: number }> {
    try {
      // Make prompt more explicit if it looks like a simple command
      let finalPrompt = prompt;

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

      // CRITICAL: Strip all Claude Code nesting indicators to prevent rejection
      // Workers are independent Claude Code instances, not nested sessions
      const cleanEnv = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key !== 'CLAUDECODE' && !key.startsWith('CLAUDE_CODE_')),
      );
      const env = {
        ...cleanEnv,
        BACKBEAT_WORKER: 'true',
        ...(taskId && { BACKBEAT_TASK_ID: taskId }),
      };

      const child = spawn(this.claudeCommand, args, {
        cwd: workingDirectory,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

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
        this.clearKillTimeout(pid);
        process.kill(pid, 'SIGTERM');

        const timeoutId = setTimeout(() => {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // Process might already be dead
          } finally {
            this.killTimeouts.delete(pid);
          }
        }, this.config.killGracePeriodMs!);

        this.killTimeouts.set(pid, timeoutId);
      },
      (error) =>
        new BackbeatError(ErrorCode.PROCESS_KILL_FAILED, `Failed to kill process ${pid}: ${error}`, { pid, error }),
    );
  }

  dispose(): void {
    for (const [, timeoutId] of this.killTimeouts) {
      clearTimeout(timeoutId);
    }
    this.killTimeouts.clear();
  }

  private clearKillTimeout(pid: number): void {
    const timeoutId = this.killTimeouts.get(pid);
    if (timeoutId) {
      clearTimeout(timeoutId);
      this.killTimeouts.delete(pid);
    }
  }
}
