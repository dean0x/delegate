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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected buildArgs(prompt: string, model?: string, _jsonSchema?: string): readonly string[] {
    const modelArgs: string[] = model ? ['--model', model] : [];
    return ['--quiet', '--full-auto', ...modelArgs, '--', prompt];
  }

  protected get envPrefixesToStrip(): readonly string[] {
    // ARCHITECTURE: No known Codex CLI nesting indicators.
    // Auth uses OPENAI_API_KEY (not CODEX_*), so stripping is unnecessary.
    return [];
  }
}
