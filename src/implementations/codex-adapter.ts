/**
 * OpenAI Codex CLI agent adapter implementation
 *
 * ARCHITECTURE: Codex-specific CLI flags on top of BaseAgentAdapter.
 * Uses --quiet and --full-auto for non-interactive execution.
 */

import { AgentProvider } from '../core/agents.js';
import { Configuration } from '../core/configuration.js';
import { BaseAgentAdapter } from './base-agent-adapter.js';

export class CodexAdapter extends BaseAgentAdapter {
  readonly provider: AgentProvider = 'codex';

  constructor(config: Configuration, codexCommand = 'codex') {
    super(config, codexCommand);
  }

  // jsonSchema parameter accepted but ignored — Codex CLI does not support structured output
  protected buildArgs(prompt: string, model?: string, _jsonSchema?: string): readonly string[] {
    const modelArgs: string[] = model ? ['--model', model] : [];
    return ['--quiet', '--full-auto', ...modelArgs, '--', prompt];
  }

  protected get envPrefixesToStrip(): readonly string[] {
    // ARCHITECTURE: No known Codex CLI nesting indicators.
    // Auth uses OPENAI_API_KEY (not CODEX_*), so stripping is unnecessary.
    return [];
  }

  /**
   * DECISION: Uses -c developer_instructions (not model_instructions_file) to append after
   * the default system prompt and preserve AGENTS.md. model_instructions_file replaces
   * AGENTS.md entirely, which would break project-level configuration.
   * Ref: codex#7296 — developer_instructions is appended, not replaced.
   */
  protected getSystemPromptConfig(
    systemPrompt: string,
    _path: string,
  ): { args: readonly string[]; env: Record<string, string>; prependToPrompt: boolean } {
    return { args: ['-c', `developer_instructions=${systemPrompt}`], env: {}, prependToPrompt: false };
  }
}
