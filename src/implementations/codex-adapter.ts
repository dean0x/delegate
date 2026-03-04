/**
 * OpenAI Codex CLI agent adapter implementation
 *
 * ARCHITECTURE: Implements AgentAdapter for the Codex CLI coding agent.
 * Uses --quiet and --full-auto flags for non-interactive execution.
 */

import { ChildProcess, spawn } from 'child_process';
import { AgentAdapter, AgentProvider } from '../core/agents.js';
import { Configuration } from '../core/configuration.js';
import { BackbeatError, ErrorCode, processSpawnFailed } from '../core/errors.js';
import { err, ok, Result, tryCatch } from '../core/result.js';

export class CodexAdapter implements AgentAdapter {
  readonly provider: AgentProvider = 'codex';

  private readonly codexCommand: string;
  private readonly killTimeouts = new Map<number, NodeJS.Timeout>();
  private readonly config: Configuration;

  constructor(config: Configuration, codexCommand = 'codex') {
    this.config = config;
    this.codexCommand = codexCommand;
  }

  spawn(prompt: string, workingDirectory: string, taskId?: string): Result<{ process: ChildProcess; pid: number }> {
    try {
      // Codex CLI uses --quiet for minimal output and --full-auto for non-interactive mode
      const args = ['--quiet', '--full-auto', prompt];

      // Strip Codex-specific nesting indicators to prevent issues
      const cleanEnv = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('CODEX_')),
      );
      const env = {
        ...cleanEnv,
        BACKBEAT_WORKER: 'true',
        ...(taskId && { BACKBEAT_TASK_ID: taskId }),
      };

      const child = spawn(this.codexCommand, args, {
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
