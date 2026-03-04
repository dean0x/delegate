/**
 * Base agent adapter — shared spawn/kill/dispose logic for all agent adapters
 *
 * ARCHITECTURE: All agent adapters share identical process lifecycle management
 * (spawn, kill with SIGTERM->SIGKILL escalation, timeout tracking, dispose).
 * Each subclass provides only:
 * 1. The CLI command name
 * 2. The CLI args for a given prompt
 * 3. The env var prefixes to strip (prevents nesting issues)
 * 4. Optional prompt transformation (e.g., Claude's short-prompt detection)
 *
 * Pattern: Template Method — shared algorithm, pluggable steps
 */

import { ChildProcess, spawn } from 'child_process';
import { AgentAdapter, AgentProvider } from '../core/agents.js';
import { Configuration } from '../core/configuration.js';
import { BackbeatError, ErrorCode, processSpawnFailed } from '../core/errors.js';
import { err, ok, Result, tryCatch } from '../core/result.js';

export abstract class BaseAgentAdapter implements AgentAdapter {
  abstract readonly provider: AgentProvider;

  private readonly killTimeouts = new Map<number, NodeJS.Timeout>();

  constructor(
    protected readonly config: Configuration,
    protected readonly command: string,
  ) {}

  /** Build CLI args for the given prompt */
  protected abstract buildArgs(prompt: string): readonly string[];

  /** Env var prefixes to strip before spawning (prevents nesting issues) */
  protected abstract get envPrefixesToStrip(): readonly string[];

  /**
   * Optional prompt transformation before passing to the CLI.
   * Override in subclasses that need prompt preprocessing.
   * Default: returns prompt unchanged.
   */
  protected transformPrompt(prompt: string): string {
    return prompt;
  }

  spawn(prompt: string, workingDirectory: string, taskId?: string): Result<{ process: ChildProcess; pid: number }> {
    try {
      const finalPrompt = this.transformPrompt(prompt);
      const args = this.buildArgs(finalPrompt);

      const cleanEnv = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !this.envPrefixesToStrip.some((prefix) => key.startsWith(prefix))),
      );
      const env = {
        ...cleanEnv,
        BACKBEAT_WORKER: 'true',
        ...(taskId && { BACKBEAT_TASK_ID: taskId }),
      };

      const child = spawn(this.command, [...args], {
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
