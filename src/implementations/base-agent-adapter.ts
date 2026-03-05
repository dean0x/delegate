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
import { AGENT_AUTH, AgentAdapter, AgentAuthConfig, AgentProvider, isCommandInPath } from '../core/agents.js';
import { Configuration, loadAgentConfig } from '../core/configuration.js';
import { agentMisconfigured, BackbeatError, ErrorCode, processSpawnFailed } from '../core/errors.js';
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

  /** Env var exact names to strip (matched with === instead of startsWith) */
  protected get envExactMatchesToStrip(): readonly string[] {
    return [];
  }

  /**
   * Optional prompt transformation before passing to the CLI.
   * Override in subclasses that need prompt preprocessing.
   * Default: returns prompt unchanged.
   */
  protected transformPrompt(prompt: string): string {
    return prompt;
  }

  /** Auth config for this agent's provider */
  protected get authConfig(): AgentAuthConfig {
    return AGENT_AUTH[this.provider];
  }

  /**
   * Resolve authentication before spawn.
   * Resolution order: env var → config file → CLI in PATH → error
   *
   * @returns Additional env vars to inject (e.g., stored API key), or error
   */
  protected resolveAuth(): Result<{ injectedEnv: Record<string, string> }> {
    const auth = this.authConfig;

    // 1. Check env vars (explicit override, CI use case)
    for (const envVar of auth.envVars) {
      if (process.env[envVar]) {
        return ok({ injectedEnv: {} });
      }
    }

    // 2. Check config file for stored API key
    const agentConfig = loadAgentConfig(this.provider);
    if (agentConfig.apiKey) {
      // Inject stored key as the first env var for this agent
      return ok({ injectedEnv: { [auth.envVars[0]]: agentConfig.apiKey } });
    }

    // 3. Check CLI binary in PATH (login-based auth assumed)
    if (isCommandInPath(this.command)) {
      return ok({ injectedEnv: {} });
    }

    // 4. Nothing configured — fail fast with actionable message
    return err(
      agentMisconfigured(
        this.provider,
        [
          'Not configured. Either:',
          `  1. Log in: ${auth.loginHint}`,
          `  2. Set API key: ${auth.apiKeyHint}`,
          `  3. Store key: beat agents config set ${this.provider} apiKey <key>`,
        ].join('\n'),
      ),
    );
  }

  spawn(prompt: string, workingDirectory: string, taskId?: string): Result<{ process: ChildProcess; pid: number }> {
    try {
      // Pre-spawn: verify CLI binary exists before anything else
      if (!isCommandInPath(this.command)) {
        return err(
          agentMisconfigured(
            this.provider,
            [`CLI binary '${this.command}' not found in PATH.`, `  Install: ${this.authConfig.loginHint}`].join('\n'),
          ),
        );
      }

      // Pre-spawn auth validation
      const authResult = this.resolveAuth();
      if (!authResult.ok) return authResult;

      const finalPrompt = this.transformPrompt(prompt);
      const args = this.buildArgs(finalPrompt);

      const exactMatches = this.envExactMatchesToStrip;
      const cleanEnv = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !this.envPrefixesToStrip.some((prefix) => key.startsWith(prefix)) && !exactMatches.includes(key),
        ),
      );
      const env = {
        ...cleanEnv,
        ...authResult.value.injectedEnv,
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
        }, this.config.killGracePeriodMs);

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
