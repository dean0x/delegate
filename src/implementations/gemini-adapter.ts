/**
 * Google Gemini CLI agent adapter implementation
 *
 * ARCHITECTURE: Implements AgentAdapter for the Gemini CLI coding agent.
 * Uses -sandbox false flag for auto-accept mode.
 */

import { ChildProcess, spawn } from 'child_process';
import { AgentAdapter, AgentProvider } from '../core/agents.js';
import { Configuration } from '../core/configuration.js';
import { BackbeatError, ErrorCode, processSpawnFailed } from '../core/errors.js';
import { err, ok, Result, tryCatch } from '../core/result.js';

export class GeminiAdapter implements AgentAdapter {
  readonly provider: AgentProvider = 'gemini';

  private readonly geminiCommand: string;
  private readonly killTimeouts = new Map<number, NodeJS.Timeout>();
  private readonly config: Configuration;

  constructor(config: Configuration, geminiCommand = 'gemini') {
    this.config = config;
    this.geminiCommand = geminiCommand;
  }

  spawn(prompt: string, workingDirectory: string, taskId?: string): Result<{ process: ChildProcess; pid: number }> {
    try {
      // Gemini CLI uses -sandbox false for auto-accept mode
      const args = ['-sandbox', 'false', prompt];

      // Strip Gemini-specific nesting indicators to prevent issues
      const cleanEnv = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('GEMINI_')),
      );
      const env = {
        ...cleanEnv,
        BACKBEAT_WORKER: 'true',
        ...(taskId && { BACKBEAT_TASK_ID: taskId }),
      };

      const child = spawn(this.geminiCommand, args, {
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
