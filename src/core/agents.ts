/**
 * Core agent abstraction types for multi-agent support (v0.5.0)
 *
 * ARCHITECTURE: Defines the agent provider type system, adapter interface,
 * and registry interface. All agent interactions go through these abstractions.
 *
 * Pattern: Discriminated union for providers, interface-based DI for adapters
 * Rationale: Enables pluggable agent backends without changing core task logic
 */

import { ChildProcess, spawnSync } from 'child_process';
import { AutobeatError, ErrorCode } from './errors.js';
import { err, ok, Result } from './result.js';

/**
 * Supported agent providers
 * Each provider corresponds to a CLI-based coding agent
 */
export type AgentProvider = 'claude' | 'codex' | 'gemini';

/**
 * All valid agent providers as a Zod-compatible tuple
 * Single source of truth — used by z.enum(), CLI, and iteration
 */
export const AGENT_PROVIDERS_TUPLE: [AgentProvider, ...AgentProvider[]] = ['claude', 'codex', 'gemini'];

/**
 * All valid agent providers as a readonly array
 * Used for validation and iteration
 */
export const AGENT_PROVIDERS: readonly AgentProvider[] = Object.freeze(AGENT_PROVIDERS_TUPLE);

/**
 * Resolve which agent to use for a task.
 *
 * Resolution order: explicit task agent → config default → error.
 * Returns an actionable error when neither is set so the user
 * knows exactly how to fix it.
 *
 * DECISION (2026-04-10): Error hint is command-agnostic — does NOT reference
 * `beat run` specifically, because the same error surfaces when the user
 * invoked `beat orchestrate`. Pointing them at `beat run` when they ran
 * `beat orchestrate` is confusing.
 */
export function resolveDefaultAgent(
  taskAgent: AgentProvider | undefined,
  configDefault: AgentProvider | undefined,
): Result<AgentProvider> {
  if (taskAgent) return ok(taskAgent);
  if (configDefault) return ok(configDefault);
  return err(
    new AutobeatError(
      ErrorCode.INVALID_INPUT,
      [
        'No agent specified and no default agent configured.',
        '  Quick setup: beat init',
        '  Or set directly: beat config set defaultAgent <agent>',
        `  Available agents: ${AGENT_PROVIDERS.join(', ')}`,
        '  Or pass --agent <agent> on the command',
      ].join('\n'),
      { field: 'agent' },
    ),
  );
}

/**
 * Type guard for validating agent provider strings
 * Pattern: Parse, don't validate — used at system boundaries
 */
export function isAgentProvider(value: string): value is AgentProvider {
  return (AGENT_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Human-readable descriptions for each agent provider
 * Single source of truth — used by CLI, MCP adapter, and UI
 */
export const AGENT_DESCRIPTIONS: Readonly<Record<AgentProvider, string>> = Object.freeze({
  claude: 'Claude Code (Anthropic)',
  codex: 'Codex CLI (OpenAI)',
  gemini: 'Gemini CLI (Google)',
});

/**
 * Base URL environment variable names per agent provider
 * Used by BaseAgentAdapter.resolveBaseUrl() to check user env before config
 * Single source of truth — infrastructure-level override
 */
export const AGENT_BASE_URL_ENV: Readonly<Record<AgentProvider, string>> = Object.freeze({
  claude: 'ANTHROPIC_BASE_URL',
  codex: 'OPENAI_BASE_URL',
  gemini: 'GEMINI_BASE_URL',
});

/**
 * Auth requirements per agent provider — single source of truth
 *
 * ARCHITECTURE: Used by checkAgentAuth(), resolveAuth(), CLI `agents check`,
 * and MCP ConfigureAgent/ListAgents tools. One definition, many consumers.
 */
export interface AgentAuthConfig {
  /** Environment variable names that hold API keys */
  readonly envVars: readonly string[];
  /** CLI binary name (checked in PATH) */
  readonly command: string;
  /** Human-readable login instruction */
  readonly loginHint: string;
  /** Human-readable API key instruction */
  readonly apiKeyHint: string;
}

export const AGENT_AUTH: Readonly<Record<AgentProvider, AgentAuthConfig>> = Object.freeze({
  claude: {
    envVars: ['ANTHROPIC_API_KEY'],
    command: 'claude',
    loginHint: 'claude login',
    apiKeyHint: 'export ANTHROPIC_API_KEY=<key>',
  },
  codex: {
    envVars: ['OPENAI_API_KEY'],
    command: 'codex',
    loginHint: 'codex auth login',
    apiKeyHint: 'export OPENAI_API_KEY=<key>',
  },
  gemini: {
    envVars: ['GEMINI_API_KEY'],
    command: 'gemini',
    loginHint: 'gcloud auth application-default login',
    apiKeyHint: 'export GEMINI_API_KEY=<key>',
  },
});

/**
 * Auth status for a single agent — reusable across CLI, MCP, and pre-spawn checks
 */
export interface AgentAuthStatus {
  readonly provider: AgentProvider;
  readonly ready: boolean;
  readonly method: 'env-var' | 'config-file' | 'cli-installed' | 'none';
  /** Which env var is set (if method is 'env-var') */
  readonly envVar?: string;
  /** Whether the CLI binary was found in PATH */
  readonly cliFound: boolean;
  /** Actionable fix hint (only when not ready) */
  readonly hint?: string;
}

/**
 * Check auth status for a given agent provider.
 * Resolution order: env var → config file → CLI binary → not configured
 *
 * @param provider - Agent to check
 * @param configApiKey - API key stored in config file (caller loads from configuration.ts)
 * @param envOverride - Override for process.env (testing only)
 */
export function checkAgentAuth(
  provider: AgentProvider,
  configApiKey?: string,
  envOverride?: Record<string, string | undefined>,
): AgentAuthStatus {
  const auth = AGENT_AUTH[provider];
  const env = envOverride ?? process.env;

  // 1. Check env vars (explicit override, CI use case)
  for (const envVar of auth.envVars) {
    if (env[envVar]) {
      return { provider, ready: true, method: 'env-var', envVar, cliFound: isCommandInPath(auth.command) };
    }
  }

  // 2. Check config file for stored API key
  if (configApiKey) {
    return { provider, ready: true, method: 'config-file', cliFound: isCommandInPath(auth.command) };
  }

  // 3. Check CLI binary in PATH (login-based auth assumed)
  if (isCommandInPath(auth.command)) {
    return {
      provider,
      ready: true,
      method: 'cli-installed',
      cliFound: true,
      hint: [
        `Auth not verified. To confirm:`,
        `  1. Log in: ${auth.loginHint}`,
        `  2. Set API key: ${auth.apiKeyHint}`,
        `  3. Store key: beat agents config set ${provider} apiKey <key>`,
      ].join('\n'),
    };
  }

  // 4. Nothing configured
  return {
    provider,
    ready: false,
    method: 'none',
    cliFound: false,
    hint: [
      `Agent '${provider}' not configured. Either:`,
      `  1. Log in: ${auth.loginHint}`,
      `  2. Set API key: ${auth.apiKeyHint}`,
      `  3. Store key: beat agents config set ${provider} apiKey <key>`,
    ].join('\n'),
  };
}

/**
 * Check if a command exists in PATH using `which`
 * Separated for testability (can be mocked)
 */
export function isCommandInPath(command: string): boolean {
  const result = spawnSync('which', [command], { stdio: 'ignore' });
  return result.status === 0;
}

/**
 * Mask an API key for display: show first 3 + last 3 chars
 */
export function maskApiKey(key: string): string {
  if (key.length <= 8) return '***';
  return `${key.slice(0, 3)}...${key.slice(-3)}`;
}

/**
 * Agent adapter interface — abstracts agent-specific CLI interactions
 *
 * ARCHITECTURE: Each agent implementation knows how to:
 * 1. Build the correct CLI command and args
 * 2. Strip environment variables that cause nesting issues
 * 3. Spawn and manage the agent process
 *
 * Pattern: Strategy pattern — swap implementations without changing callers
 */
export interface AgentAdapter {
  /** Which provider this adapter handles */
  readonly provider: AgentProvider;

  /**
   * Spawn an agent process for the given prompt
   * @param prompt - The task prompt to execute
   * @param workingDirectory - Directory to run in
   * @param taskId - Optional task ID for identification
   * @param model - Optional model override (per-task model overrides agent config model)
   * @param orchestratorId - Optional orchestration ID for sub-task attribution (v1.3.0)
   * @param jsonSchema - Optional JSON schema string for structured output (v1.4.0, Claude only)
   * @returns Process handle with PID, or error
   */
  spawn(
    prompt: string,
    workingDirectory: string,
    taskId?: string,
    model?: string,
    orchestratorId?: string,
    jsonSchema?: string,
  ): Result<{ process: ChildProcess; pid: number }>;

  /**
   * Kill an agent process by PID
   * @param pid - Process ID to kill
   * @returns Success or error
   */
  kill(pid: number): Result<void>;

  /**
   * Clean up resources (kill timeouts, etc.)
   */
  dispose(): void;
}

/**
 * Agent registry — provides access to agent adapters by provider name
 *
 * ARCHITECTURE: Central lookup for agent adapters
 * Pattern: Service locator scoped to agents only
 * Rationale: WorkerPool resolves the correct adapter per task
 */
export interface AgentRegistry {
  /**
   * Get an adapter for the specified provider
   * @returns The adapter, or error if provider not registered
   */
  get(provider: AgentProvider): Result<AgentAdapter>;

  /**
   * Check if a provider is registered
   */
  has(provider: AgentProvider): boolean;

  /**
   * List all registered provider names (sorted)
   */
  list(): readonly AgentProvider[];

  /**
   * Clean up all adapter resources
   */
  dispose(): void;
}
