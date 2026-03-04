/**
 * Core agent abstraction types for multi-agent support (v0.5.0)
 *
 * ARCHITECTURE: Defines the agent provider type system, adapter interface,
 * and registry interface. All agent interactions go through these abstractions.
 *
 * Pattern: Discriminated union for providers, interface-based DI for adapters
 * Rationale: Enables pluggable agent backends without changing core task logic
 */

import { ChildProcess } from 'child_process';
import { Result } from './result.js';

/**
 * Supported agent providers
 * Each provider corresponds to a CLI-based coding agent
 */
export type AgentProvider = 'claude' | 'codex' | 'gemini' | 'aider';

/**
 * All valid agent providers as a readonly array
 * Used for validation and iteration
 */
export const AGENT_PROVIDERS: readonly AgentProvider[] = Object.freeze([
  'claude',
  'codex',
  'gemini',
  'aider',
] as const);

/**
 * Default agent when none is specified
 * ARCHITECTURE: Ensures backward compatibility — existing tasks always use Claude
 */
export const DEFAULT_AGENT: AgentProvider = 'claude';

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
  aider: 'Aider',
});

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
   * @returns Process handle with PID, or error
   */
  spawn(prompt: string, workingDirectory: string, taskId?: string): Result<{ process: ChildProcess; pid: number }>;

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
