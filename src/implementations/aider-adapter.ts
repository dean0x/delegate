/**
 * Aider agent adapter implementation
 *
 * ARCHITECTURE: Aider-specific CLI flags on top of BaseAgentAdapter.
 * Uses --yes-always for auto-accept, --no-git to prevent direct commits,
 * and --message to pass the prompt.
 */

import { AgentProvider } from '../core/agents.js';
import { Configuration } from '../core/configuration.js';
import { BaseAgentAdapter } from './base-agent-adapter.js';

export class AiderAdapter extends BaseAgentAdapter {
  readonly provider: AgentProvider = 'aider';

  constructor(config: Configuration, aiderCommand = 'aider') {
    super(config, aiderCommand);
  }

  protected buildArgs(prompt: string): readonly string[] {
    return ['--yes-always', '--no-git', '--message', prompt];
  }

  protected get envPrefixesToStrip(): readonly string[] {
    // ARCHITECTURE: No known Aider nesting indicators.
    // Auth uses OPENAI_API_KEY/ANTHROPIC_API_KEY (not AIDER_*).
    // AIDER_* vars are user config (model, etc.) and should be preserved.
    return [];
  }
}
