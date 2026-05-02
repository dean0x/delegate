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
import os from 'os';
import path from 'path';
import {
  AGENT_AUTH,
  AGENT_BASE_URL_ENV,
  AgentAdapter,
  AgentAuthConfig,
  AgentProvider,
  isCommandInPath,
  SpawnOptions,
} from '../core/agents.js';
import { AgentConfig, Configuration, loadAgentConfig } from '../core/configuration.js';
import { AutobeatError, agentMisconfigured, ErrorCode, processSpawnFailed } from '../core/errors.js';
import { err, ok, Result, tryCatch } from '../core/result.js';

export abstract class BaseAgentAdapter implements AgentAdapter {
  abstract readonly provider: AgentProvider;

  private readonly killTimeouts = new Map<number, NodeJS.Timeout>();

  constructor(
    protected readonly config: Configuration,
    protected readonly command: string,
  ) {}

  /**
   * Build CLI args for the given prompt, optional model override, and optional JSON schema.
   * Subclasses that support structured output (Claude) should use jsonSchema;
   * others should accept the parameter but ignore it.
   */
  protected abstract buildArgs(prompt: string, model?: string, jsonSchema?: string): readonly string[];

  /** Env var prefixes to strip before spawning (prevents nesting issues) */
  protected abstract get envPrefixesToStrip(): readonly string[];

  /** Env var exact names to strip (matched with === instead of startsWith) */
  protected get envExactMatchesToStrip(): readonly string[] {
    return [];
  }

  /**
   * Declare how this adapter injects a system prompt into the spawned agent.
   *
   * DECISION: Each agent CLI has a different mechanism for system prompts (inline flag,
   * config override, env var + file). This pattern lets each adapter declare its needs.
   * Adapters that require a file must write it inside this method.
   * The base class handles prompt prepending when prependToPrompt is true.
   *
   * @param systemPrompt - The system prompt text to inject
   * @param systemPromptPath - Resolved temp file path for adapters that write to disk
   * @returns Injection configuration:
   *   - args: Additional CLI args to append (e.g. ['--append-system-prompt', text])
   *   - env: Additional env vars to inject
   *   - prependToPrompt: If true, base class prepends systemPrompt to user prompt instead
   */
  protected abstract getSystemPromptConfig(
    systemPrompt: string,
    systemPromptPath: string,
  ): { args: readonly string[]; env: Record<string, string>; prependToPrompt: boolean };

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
   * Resolution order: env var → config file → CLI login (assumed)
   *
   * NOTE: spawn() verifies CLI binary exists before calling resolveAuth(),
   * so step 3 safely assumes login-based auth if no explicit key is configured.
   *
   * @param agentConfig - Pre-loaded agent config (loaded once in spawn() to avoid redundant reads)
   * @returns Additional env vars to inject (e.g., stored API key), or error
   */
  protected resolveAuth(agentConfig: AgentConfig): Result<{ injectedEnv: Record<string, string> }> {
    const auth = this.authConfig;

    // 1. Check env vars (explicit override, CI use case)
    for (const envVar of auth.envVars) {
      if (process.env[envVar]) {
        return ok({ injectedEnv: {} });
      }
    }

    // 2. Check config file for stored API key
    if (agentConfig.apiKey) {
      // Inject stored key as the first env var for this agent
      return ok({ injectedEnv: { [auth.envVars[0]]: agentConfig.apiKey } });
    }

    // 3. CLI binary already verified in spawn() — assume login-based auth
    return ok({ injectedEnv: {} });
  }

  /** Additional env vars to inject into the spawned process (override in subclasses) */
  protected get additionalEnv(): Record<string, string> {
    return {};
  }

  /**
   * Resolve base URL env var to inject into spawn env.
   * Resolution order: user env (already in cleanEnv, takes precedence) → config file.
   * Returns env var name → value to inject. Empty object means nothing to inject.
   *
   * @param agentConfig - Pre-loaded agent config (loaded once in spawn() to avoid redundant reads)
   */
  protected resolveBaseUrl(agentConfig: AgentConfig): Record<string, string> {
    const baseUrlEnvVar = AGENT_BASE_URL_ENV[this.provider];
    // If user already has it set in their env, don't inject (cleanEnv will carry it through)
    if (process.env[baseUrlEnvVar]) {
      return {};
    }
    // Check config file
    if (agentConfig.baseUrl) {
      return { [baseUrlEnvVar]: agentConfig.baseUrl };
    }
    return {};
  }

  /**
   * Resolve the model to use for this spawn.
   * Resolution order: per-task model → agent-config model → undefined (use CLI default).
   *
   * @param agentConfig - Pre-loaded agent config (loaded once in spawn() to avoid redundant reads)
   */
  protected resolveModel(agentConfig: AgentConfig, taskModel?: string): string | undefined {
    if (taskModel) return taskModel;
    return agentConfig.model;
  }

  spawn({
    prompt,
    workingDirectory,
    taskId,
    model,
    orchestratorId,
    jsonSchema,
    systemPrompt,
  }: SpawnOptions): Result<{ process: ChildProcess; pid: number }> {
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

      // Load agent config once — passed to resolveAuth, resolveBaseUrl, resolveModel
      // to avoid redundant readFileSync + JSON.parse calls per spawn
      const agentConfig = loadAgentConfig(this.provider);

      // Pre-spawn auth validation
      const authResult = this.resolveAuth(agentConfig);
      if (!authResult.ok) return authResult;

      const resolvedModel = this.resolveModel(agentConfig, model);

      // Resolve system prompt injection
      let effectivePrompt = prompt;
      let systemPromptArgs: readonly string[] = [];
      let systemPromptEnv: Record<string, string> = {};

      if (systemPrompt) {
        // Compute temp file path — passed to adapters that need to write a file.
        // Use a random suffix when taskId is absent to avoid path collisions across concurrent spawns.
        const safeId = taskId ?? crypto.randomUUID().substring(0, 8);
        const systemPromptPath = path.join(os.homedir(), '.autobeat', 'system-prompts', `${safeId}.md`);

        const config = this.getSystemPromptConfig(systemPrompt, systemPromptPath);

        if (config.prependToPrompt) {
          // Adapter cannot inject via CLI args/env — prepend to user prompt as fallback
          effectivePrompt = `${systemPrompt}\n\n${prompt}`;
        } else {
          // Adapter is responsible for any file I/O inside getSystemPromptConfig
          systemPromptArgs = config.args;
          systemPromptEnv = config.env;
        }
      }

      const finalPrompt = this.transformPrompt(effectivePrompt);
      const args = [...this.buildArgs(finalPrompt, resolvedModel, jsonSchema), ...systemPromptArgs];

      const exactMatches = this.envExactMatchesToStrip;
      const cleanEnv = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !this.envPrefixesToStrip.some((prefix) => key.startsWith(prefix)) && !exactMatches.includes(key),
        ),
      );
      const baseUrlEnv = this.resolveBaseUrl(agentConfig);
      // NOTE: AUTOBEAT_ prefix is NOT in envPrefixesToStrip — it is preserved in cleanEnv.
      // We explicitly set AUTOBEAT_WORKER and AUTOBEAT_TASK_ID here, and optionally
      // AUTOBEAT_ORCHESTRATOR_ID so sub-tasks spawned by this agent are attributed to
      // the parent orchestration (v1.3.0).
      //
      // SECURITY: Validate orchestratorId format before injecting into child env.
      // Belt-and-suspenders: the MCP path already validates via Zod, but the env var
      // path (run.ts reading AUTOBEAT_ORCHESTRATOR_ID) or a persisted DB row may not
      // have gone through the same boundary. Reject malformed values here to prevent
      // log injection in child processes. Attribution silently fails but spawn succeeds.
      const ORCHESTRATOR_ID_RE = /^orchestrator-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      const safeOrchestratorId = orchestratorId && ORCHESTRATOR_ID_RE.test(orchestratorId) ? orchestratorId : undefined;
      if (orchestratorId && !safeOrchestratorId) {
        // Log structured warning — do not throw; spawn continues without attribution
        console.error(
          JSON.stringify({
            level: 'warn',
            message: 'spawn: dropping malformed AUTOBEAT_ORCHESTRATOR_ID — format did not match canonical pattern',
            provider: this.provider,
          }),
        );
      }
      const env = {
        ...this.additionalEnv,
        ...cleanEnv,
        ...authResult.value.injectedEnv,
        ...baseUrlEnv,
        ...systemPromptEnv,
        AUTOBEAT_WORKER: 'true',
        ...(taskId && { AUTOBEAT_TASK_ID: taskId }),
        ...(safeOrchestratorId && { AUTOBEAT_ORCHESTRATOR_ID: safeOrchestratorId }),
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
        new AutobeatError(ErrorCode.PROCESS_KILL_FAILED, `Failed to kill process ${pid}: ${error}`, { pid, error }),
    );
  }

  dispose(): void {
    for (const [, timeoutId] of this.killTimeouts) {
      clearTimeout(timeoutId);
    }
    this.killTimeouts.clear();
  }

  /**
   * Default no-op cleanup. Adapters that write task-scoped files
   * override this to remove them.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  cleanup(_taskId: string): void {
    // no-op — subclasses override if they create task-scoped resources
  }

  private clearKillTimeout(pid: number): void {
    const timeoutId = this.killTimeouts.get(pid);
    if (timeoutId) {
      clearTimeout(timeoutId);
      this.killTimeouts.delete(pid);
    }
  }
}
