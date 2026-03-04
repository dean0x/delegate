/**
 * Google Gemini CLI agent adapter implementation
 *
 * ARCHITECTURE: Gemini-specific CLI flags on top of BaseAgentAdapter.
 * Uses -sandbox false for auto-accept mode.
 */

import { AgentProvider } from '../core/agents.js';
import { Configuration } from '../core/configuration.js';
import { BaseAgentAdapter } from './base-agent-adapter.js';

export class GeminiAdapter extends BaseAgentAdapter {
  readonly provider: AgentProvider = 'gemini';

  constructor(config: Configuration, geminiCommand = 'gemini') {
    super(config, geminiCommand);
  }

  protected buildArgs(prompt: string): readonly string[] {
    return ['-sandbox', 'false', prompt];
  }

  protected get envPrefixesToStrip(): readonly string[] {
    // ARCHITECTURE: No known Gemini CLI nesting indicators.
    // IMPORTANT: Must NOT strip GEMINI_API_KEY — required for authentication.
    return [];
  }
}
