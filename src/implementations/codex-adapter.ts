/**
 * OpenAI Codex CLI agent adapter implementation
 *
 * ARCHITECTURE: Codex-specific CLI flags on top of BaseAgentAdapter.
 * Uses --full-auto for interactive tmux execution.
 */

import { AgentProvider } from '../core/agents.js';
import { Configuration } from '../core/configuration.js';
import { BaseAgentAdapter } from './base-agent-adapter.js';

export class CodexAdapter extends BaseAgentAdapter {
  readonly provider: AgentProvider = 'codex';

  constructor(config: Configuration, codexCommand = 'codex') {
    super(config, codexCommand);
  }

  protected override buildTmuxArgs(model?: string): readonly string[] {
    const modelArgs: string[] = model ? ['--model', model] : [];
    // DECISION: Interactive tmux mode — no --quiet, no prompt in args.
    // Output is captured via the Stop hook; --quiet is only for non-tmux invocations.
    return ['--full-auto', ...modelArgs];
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
