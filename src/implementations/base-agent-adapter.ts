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
  type InteractiveSpawnOptions,
  isCommandInPath,
  SpawnOptions,
} from '../core/agents.js';
import {
  AgentConfig,
  Configuration,
  isRuntimeSupportedForAgent,
  loadAgentConfig,
  RUNTIME_AGENT_SUPPORT,
} from '../core/configuration.js';
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

  /**
   * Build CLI args for interactive mode (stdio: 'inherit').
   * Each adapter omits headless flags (e.g. --print, --quiet, --prompt).
   */
  protected abstract buildInteractiveArgs(prompt: string, model?: string): readonly string[];

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
   * Adapters that require a file (e.g. Gemini) must write it inside this method.
   * The base class handles prompt prepending when prependToPrompt is true.
   *
   * @param systemPrompt - The system prompt text to inject
   * @param systemPromptPath - Resolved temp file path for adapters that write to disk
   * @returns Injection configuration:
   *   - args: Additional CLI args to append (e.g. ['--append-system-prompt', text])
   *   - env: Additional env vars to inject (e.g. { GEMINI_SYSTEM_MD: path })
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

  /**
   * Resolve the runtime wrapper configuration for this spawn.
   *
   * When a runtime (e.g. 'ollama') is configured, spawn is wrapped:
   *   ollama launch <agent-command> [--model <model>] --yes -- <inner-args...>
   *
   * Ollama handles model routing and API compatibility, so the inner agent
   * command does not receive --model, auth env vars, or baseUrl overrides.
   *
   * Returns ok(null) when no runtime is configured (normal direct spawn).
   * Returns err(agentMisconfigured) when the runtime doesn't support this agent.
   *
   * @param agentConfig - Pre-loaded agent config
   * @param taskModel - Optional per-task model override
   */
  protected resolveRuntime(
    agentConfig: AgentConfig,
    taskModel?: string,
  ): Result<{
    command: string;
    prependArgs: readonly string[];
    suppressModel: boolean;
    suppressAuth: boolean;
    suppressBaseUrl: boolean;
  } | null> {
    if (!agentConfig.runtime) return ok(null);

    if (!isRuntimeSupportedForAgent(agentConfig.runtime, this.provider)) {
      return err(
        agentMisconfigured(
          this.provider,
          `Runtime '${agentConfig.runtime}' does not support agent '${this.provider}'. ` +
            `Supported agents: ${RUNTIME_AGENT_SUPPORT[agentConfig.runtime].join(', ')}. ` +
            `Clear with: beat agents config set ${this.provider} runtime ""`,
        ),
      );
    }

    // DECISION: Single-runtime direct dispatch. With one runtime ('ollama'), a strategy
    // pattern would be over-engineering. The exhaustive guard below ensures compile-time
    // error if RUNTIME_TARGETS gains a new entry without handler.
    if (agentConfig.runtime === 'ollama') {
      const effectiveModel = taskModel ?? agentConfig.model;
      const modelArgs: string[] = effectiveModel ? ['--model', effectiveModel] : [];
      return ok({
        command: 'ollama',
        // --yes: auto-accept model downloads + license prompts (without it, ollama blocks on interactive confirmation)
        prependArgs: ['launch', this.command, ...modelArgs, '--yes', '--'],
        suppressModel: true,
        suppressAuth: true,
        suppressBaseUrl: true,
      });
    }

    // Exhaustive guard: if a new runtime is added to RUNTIME_TARGETS but not handled
    // above, fail loudly rather than silently ignoring the configuration.
    const _exhaustive: never = agentConfig.runtime;
    return err(
      agentMisconfigured(this.provider, `Unhandled runtime: '${_exhaustive}'. This is a bug — please report it.`),
    );
  }

  private resolveSystemPromptInjection(
    prompt: string,
    systemPrompt: string | undefined,
    taskId: string | undefined,
  ): { effectivePrompt: string; args: readonly string[]; env: Record<string, string> } {
    if (!systemPrompt) return { effectivePrompt: prompt, args: [], env: {} };

    const safeId = taskId ?? crypto.randomUUID().substring(0, 8);
    const systemPromptPath = path.join(os.homedir(), '.autobeat', 'system-prompts', `${safeId}.md`);
    const config = this.getSystemPromptConfig(systemPrompt, systemPromptPath);

    if (config.prependToPrompt) {
      return { effectivePrompt: `${systemPrompt}\n\n${prompt}`, args: config.args, env: config.env };
    }
    return { effectivePrompt: prompt, args: config.args, env: config.env };
  }

  /**
   * Shared resolution logic: loads config, resolves runtime/auth/model/system-prompt/env.
   * Used by both spawn() and spawnInteractive() to avoid duplicating the resolution chain.
   *
   * Resolution order:
   * 1. Runtime config (resolveRuntime) — checked first; when a runtime (e.g. 'ollama') is
   *    active, auth/baseUrl/model are suppressed so the runtime handles them internally.
   *    DECISION: Runtime takes precedence over proxy. See also bootstrap.ts (proxy startup skip)
   *    and mcp-adapter.ts set/check handlers (warning path).
   * 2. CLI binary existence — validated before auth to give a clear error if the agent is
   *    not installed, avoiding misleading auth failures.
   * 3. Auth (resolveAuth) — skipped when suppressAuth is set by the runtime config.
   * 4. Model (resolveModel) — task-level model overrides agent-level config; runtime may
   *    suppress both via suppressModel.
   * 5. System prompt injection — resolved before env so the prompt variant (args vs env var
   *    vs prepend) is determined before the env map is frozen.
   * 6. Env assembly (buildSpawnEnv) — merges runtime, agent config, auth, and system prompt
   *    env vars into a single clean environment for the spawned process.
   */
  protected resolveSpawnConfig(options: {
    prompt: string;
    workingDirectory: string;
    taskId?: string;
    model?: string;
    orchestratorId?: string;
    systemPrompt?: string;
  }): Result<{
    readonly command: string;
    readonly runtimePrependArgs: readonly string[];
    readonly resolvedModel: string | undefined;
    readonly systemPromptArgs: readonly string[];
    readonly effectivePrompt: string;
    readonly env: Record<string, string>;
    readonly workingDirectory: string;
  }> {
    const agentConfig = loadAgentConfig(this.provider);

    const runtimeResult = this.resolveRuntime(agentConfig, options.model);
    if (!runtimeResult.ok) return runtimeResult;
    const runtimeConfig = runtimeResult.value;

    const commandToCheck = runtimeConfig ? runtimeConfig.command : this.command;
    if (!isCommandInPath(commandToCheck)) {
      return err(
        agentMisconfigured(
          this.provider,
          [
            `CLI binary '${commandToCheck}' not found in PATH.`,
            runtimeConfig ? '  Install Ollama: https://ollama.com/download' : `  Install: ${this.authConfig.loginHint}`,
          ].join('\n'),
        ),
      );
    }

    const authResult = runtimeConfig?.suppressAuth
      ? ok({ injectedEnv: {} as Record<string, string> })
      : this.resolveAuth(agentConfig);
    if (!authResult.ok) return authResult;

    const resolvedModel = runtimeConfig?.suppressModel ? undefined : this.resolveModel(agentConfig, options.model);

    const {
      effectivePrompt,
      args: systemPromptArgs,
      env: systemPromptEnv,
    } = this.resolveSystemPromptInjection(options.prompt, options.systemPrompt, options.taskId);

    const env = this.buildSpawnEnv({
      runtimeConfig,
      agentConfig,
      authEnv: authResult.value.injectedEnv,
      systemPromptEnv,
      taskId: options.taskId,
      orchestratorId: options.orchestratorId,
    });

    return ok({
      command: runtimeConfig ? runtimeConfig.command : this.command,
      runtimePrependArgs: runtimeConfig ? runtimeConfig.prependArgs : [],
      resolvedModel,
      systemPromptArgs: [...systemPromptArgs],
      effectivePrompt,
      env,
      workingDirectory: options.workingDirectory,
    });
  }

  private buildSpawnEnv(options: {
    runtimeConfig: { suppressBaseUrl: boolean } | null;
    agentConfig: AgentConfig;
    authEnv: Record<string, string>;
    systemPromptEnv: Record<string, string>;
    taskId?: string;
    orchestratorId?: string;
  }): Record<string, string> {
    const exactMatches = this.envExactMatchesToStrip;
    const cleanEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !this.envPrefixesToStrip.some((prefix) => key.startsWith(prefix)) && !exactMatches.includes(key),
      ),
    );
    const baseUrlEnv = options.runtimeConfig?.suppressBaseUrl ? {} : this.resolveBaseUrl(options.agentConfig);

    const ORCHESTRATOR_ID_RE = /^orchestrator-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const safeOrchestratorId =
      options.orchestratorId && ORCHESTRATOR_ID_RE.test(options.orchestratorId) ? options.orchestratorId : undefined;
    if (options.orchestratorId && !safeOrchestratorId) {
      console.error(
        JSON.stringify({
          level: 'warn',
          message: 'spawn: dropping malformed AUTOBEAT_ORCHESTRATOR_ID — format did not match canonical pattern',
          provider: this.provider,
        }),
      );
    }

    return {
      ...this.additionalEnv,
      ...cleanEnv,
      ...options.authEnv,
      ...baseUrlEnv,
      ...options.systemPromptEnv,
      AUTOBEAT_WORKER: 'true',
      ...(options.taskId && { AUTOBEAT_TASK_ID: options.taskId }),
      ...(safeOrchestratorId && { AUTOBEAT_ORCHESTRATOR_ID: safeOrchestratorId }),
    };
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
      const configResult = this.resolveSpawnConfig({
        prompt,
        workingDirectory,
        taskId,
        model,
        orchestratorId,
        systemPrompt,
      });
      if (!configResult.ok) return configResult;
      const cfg = configResult.value;

      const finalPrompt = this.transformPrompt(cfg.effectivePrompt);
      const args = [...this.buildArgs(finalPrompt, cfg.resolvedModel, jsonSchema), ...cfg.systemPromptArgs];

      const spawnArgs = cfg.runtimePrependArgs.length > 0 ? [...cfg.runtimePrependArgs, ...args] : args;

      const child = spawn(cfg.command, spawnArgs, {
        cwd: cfg.workingDirectory,
        env: cfg.env,
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

  spawnInteractive({
    prompt,
    workingDirectory,
    taskId,
    model,
    orchestratorId,
    systemPrompt,
  }: InteractiveSpawnOptions): Result<{ process: ChildProcess; pid: number }> {
    try {
      const configResult = this.resolveSpawnConfig({ prompt, workingDirectory, taskId, model, orchestratorId, systemPrompt });
      if (!configResult.ok) return configResult;
      const cfg = configResult.value;

      const finalPrompt = this.transformPrompt(cfg.effectivePrompt);
      const args = [...this.buildInteractiveArgs(finalPrompt, cfg.resolvedModel), ...cfg.systemPromptArgs];

      const spawnArgs = cfg.runtimePrependArgs.length > 0 ? [...cfg.runtimePrependArgs, ...args] : args;

      // Interactive: omit AUTOBEAT_WORKER from env (not a background worker)
      const { AUTOBEAT_WORKER: _, ...interactiveEnv } = cfg.env;

      const child = spawn(cfg.command, spawnArgs, {
        cwd: cfg.workingDirectory,
        env: interactiveEnv,
        stdio: 'inherit',
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
   * Default no-op cleanup. Adapters that write task-scoped files (e.g. Gemini)
   * override this to remove them.
   */
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
