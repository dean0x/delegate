/**
 * Base agent adapter — shared tmux command assembly logic for all agent adapters
 *
 * ARCHITECTURE: All agent adapters share identical configuration resolution
 * for tmux-based worker spawning. Each subclass provides only:
 * 1. The CLI command name
 * 2. The tmux CLI args (no prompt — delivered via send-keys)
 * 3. The env var prefixes to strip (prevents nesting issues)
 * 4. Optional prompt transformation (e.g., Claude's short-prompt detection)
 *
 * Pattern: Template Method — shared algorithm, pluggable steps
 */

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
import {
  AgentConfig,
  Configuration,
  isRuntimeSupportedForAgent,
  loadAgentConfig,
  RUNTIME_AGENT_SUPPORT,
} from '../core/configuration.js';
import type { TaskId } from '../core/domain.js';
import { AutobeatError, agentMisconfigured, ErrorCode } from '../core/errors.js';
import { err, ok, Result } from '../core/result.js';
import type { TmuxSpawnCoreConfig } from '../core/tmux-types.js';
import { TASK_ID_REGEX, type TmuxAgentType } from './tmux/types.js';

export abstract class BaseAgentAdapter implements AgentAdapter {
  abstract readonly provider: AgentProvider;

  constructor(
    protected readonly config: Configuration,
    protected readonly command: string,
  ) {}

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
   *   - env: Additional env vars to inject (e.g. { MY_AGENT_VAR: value })
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

  /**
   * Build CLI args for interactive tmux mode (no prompt — delivered via send-keys).
   * Each adapter omits headless flags (e.g. --print, --quiet) and prompt.
   * Default returns empty args; Claude and Codex override to add agent-specific flags.
   * New adapters that support tmux should override this method.
   */
  protected buildTmuxArgs(_model?: string): readonly string[] {
    return [];
  }

  /**
   * Produce a TmuxSpawnCoreConfig + prompt delivery strategy.
   *
   * All sessions run in interactive mode (setup shim). The prompt is returned
   * separately for delivery via send-keys after the session is alive.
   *
   * DECISION: Wrapper pipeline mode (--print/--quiet based) has been removed.
   * All tmux sessions are interactive; output is captured via the Stop hook.
   * The `persistent` option is accepted for backward compatibility but has no
   * effect — every spawn uses the interactive (setup shim) path.
   */
  buildTmuxCommand(options: SpawnOptions & { sessionsDir: string; persistent?: boolean }): Result<{
    readonly config: TmuxSpawnCoreConfig;
    readonly prompt: string;
  }> {
    if (!options.taskId) {
      return err(
        agentMisconfigured(
          this.provider,
          'buildTmuxCommand requires a taskId — tmux session name cannot be derived without it',
        ),
      );
    }

    if (this.provider !== 'claude' && this.provider !== 'codex') {
      return err(agentMisconfigured(this.provider, 'tmux mode is not supported for this agent'));
    }

    // Defense-in-depth: validate taskId before the expensive resolveSpawnConfig call.
    // Downstream tmux-hooks.ts validates too, but this surfaces invalid IDs earlier
    // with a clearer error.
    if (!TASK_ID_REGEX.test(options.taskId)) {
      return err(agentMisconfigured(this.provider, `invalid taskId: ${options.taskId}`));
    }

    // Explicit narrowing — avoids `as TmuxAgentType` cast. If AgentProvider gains a new
    // value, the guard above will catch it and the assignment below will never be reached
    // with an unsupported value.
    const agent: TmuxAgentType = this.provider === 'claude' ? 'claude' : 'codex';

    const configResult = this.resolveSpawnConfig(options);
    if (!configResult.ok) return configResult;
    const cfg = configResult.value;

    const transformedPrompt = this.transformPrompt(cfg.effectivePrompt);

    // Always interactive mode: use buildTmuxArgs (no --print/--quiet), prompt delivered via send-keys.
    const baseFlags = this.buildTmuxArgs(cfg.resolvedModel);
    const flagArgs = [...baseFlags, ...cfg.systemPromptArgs];
    const spawnArgs = [...cfg.runtimePrependArgs, ...flagArgs];

    return ok({
      config: {
        name: `beat-task-${options.taskId.replace(/_/g, '-')}`,
        command: cfg.command,
        agentArgs: spawnArgs,
        cwd: cfg.workingDirectory,
        env: cfg.env,
        agent,
        taskId: options.taskId as TaskId,
        sessionsDir: options.sessionsDir,
      },
      prompt: transformedPrompt,
    });
  }

  /** Auth config for this agent's provider */
  protected get authConfig(): AgentAuthConfig {
    return AGENT_AUTH[this.provider];
  }

  /**
   * Resolve authentication before spawn.
   * Resolution order: env var → config file → CLI login (assumed)
   *
   * NOTE: buildTmuxCommand() verifies CLI binary exists before calling resolveAuth(),
   * so step 3 safely assumes login-based auth if no explicit key is configured.
   *
   * @param agentConfig - Pre-loaded agent config (loaded once in buildTmuxCommand() to avoid redundant reads)
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

    // 3. CLI binary already verified in buildTmuxCommand() — assume login-based auth
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
   * @param agentConfig - Pre-loaded agent config (loaded once in buildTmuxCommand() to avoid redundant reads)
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
   * @param agentConfig - Pre-loaded agent config (loaded once in buildTmuxCommand() to avoid redundant reads)
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
            `Supported agents: ${(RUNTIME_AGENT_SUPPORT[agentConfig.runtime] ?? []).join(', ') || 'none'}. ` +
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

    const safeId = (taskId ?? crypto.randomUUID().substring(0, 8)).replace(/[^a-z0-9_-]/gi, '');
    const systemPromptPath = path.join(os.homedir(), '.autobeat', 'system-prompts', `${safeId}.md`);
    const config = this.getSystemPromptConfig(systemPrompt, systemPromptPath);

    if (config.prependToPrompt) {
      return { effectivePrompt: `${systemPrompt}\n\n${prompt}`, args: config.args, env: config.env };
    }
    return { effectivePrompt: prompt, args: config.args, env: config.env };
  }

  /**
   * Shared resolution logic: loads config, resolves runtime/auth/model/system-prompt/env.
   * Used by buildTmuxCommand() to resolve the full spawn configuration chain.
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

  dispose(): void {
    // No resources to clean up in base class.
    // Subclasses that write temp files override cleanup() instead.
  }

  /**
   * Default no-op cleanup. Adapters that write task-scoped files
   * override this to remove them.
   */
  cleanup(_taskId: string): void {
    // no-op — subclasses override if they create task-scoped resources
  }
}
