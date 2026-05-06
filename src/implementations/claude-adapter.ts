/**
 * Claude Code agent adapter implementation
 *
 * ARCHITECTURE: Claude-specific logic on top of BaseAgentAdapter.
 * Handles nesting prevention (strips CLAUDE_CODE_* env vars) and
 * injects CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS when a baseUrl is active.
 */

import { AgentProvider } from '../core/agents.js';
import { AgentConfig, Configuration } from '../core/configuration.js';
import { BaseAgentAdapter } from './base-agent-adapter.js';

export class ClaudeAdapter extends BaseAgentAdapter {
  readonly provider: AgentProvider = 'claude';

  private readonly baseArgs: readonly string[];

  constructor(config: Configuration, claudeCommand = 'claude') {
    super(config, claudeCommand);
    this.baseArgs = Object.freeze(['--print', '--dangerously-skip-permissions', '--output-format', 'json']);
  }

  protected buildArgs(prompt: string, model?: string, jsonSchema?: string): readonly string[] {
    const modelArgs: string[] = model ? ['--model', model] : [];
    const schemaArgs: string[] = jsonSchema ? ['--json-schema', jsonSchema] : [];
    return [...this.baseArgs, ...modelArgs, ...schemaArgs, '--', prompt];
  }

  protected buildInteractiveArgs(prompt: string, model?: string): readonly string[] {
    const modelArgs: string[] = model ? ['--model', model] : [];
    return ['--dangerously-skip-permissions', ...modelArgs, '--', prompt];
  }

  protected get envPrefixesToStrip(): readonly string[] {
    // Strip CLAUDE_CODE_* prefix vars (e.g., CLAUDE_CODE_ENTRYPOINT)
    return ['CLAUDE_CODE_'];
  }

  protected get envExactMatchesToStrip(): readonly string[] {
    // Exact match for CLAUDECODE — avoids over-stripping CLAUDECODE_SESSION etc.
    return ['CLAUDECODE'];
  }

  /**
   * DECISION: Uses --append-system-prompt (not --system-prompt) to preserve Claude Code's
   * default system prompt (tool definitions, safety instructions). --system-prompt replaces
   * the built-in system prompt entirely, losing tool access and permission grants.
   */
  protected getSystemPromptConfig(
    systemPrompt: string,
    _path: string,
  ): { args: readonly string[]; env: Record<string, string>; prependToPrompt: boolean } {
    return { args: ['--append-system-prompt', systemPrompt], env: {}, prependToPrompt: false };
  }

  /**
   * Override resolveBaseUrl to also inject CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1
   * when a baseUrl is active (prevents proxy failures from experimental beta headers).
   *
   * CLAUDE_CODE_ vars are stripped from process.env before spawn, so injecting here
   * (after stripping) ensures the value reaches the child process.
   * The parent env ANTHROPIC_BASE_URL is preserved via cleanEnv if already set.
   */
  protected resolveBaseUrl(agentConfig: AgentConfig): Record<string, string> {
    const baseUrlEnv = super.resolveBaseUrl(agentConfig);

    // Determine if a baseUrl is active (from config or user env)
    const hasBaseUrl = Object.keys(baseUrlEnv).length > 0 || Boolean(process.env.ANTHROPIC_BASE_URL);

    if (hasBaseUrl) {
      // Auto-disable experimental betas to prevent proxy failures
      return { ...baseUrlEnv, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1' };
    }

    return baseUrlEnv;
  }
}
