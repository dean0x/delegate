/**
 * Google Gemini CLI agent adapter implementation
 *
 * ARCHITECTURE: Gemini-specific CLI flags on top of BaseAgentAdapter.
 * Uses --prompt for non-interactive (headless) mode and --yolo for auto-accept.
 */

import { AgentProvider } from '../core/agents.js';
import { Configuration } from '../core/configuration.js';
import { BaseAgentAdapter } from './base-agent-adapter.js';

export class GeminiAdapter extends BaseAgentAdapter {
  readonly provider: AgentProvider = 'gemini';

  constructor(config: Configuration, geminiCommand = 'gemini') {
    super(config, geminiCommand);
  }

  // jsonSchema parameter accepted but ignored — Gemini CLI does not support structured output
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected buildArgs(prompt: string, model?: string, _jsonSchema?: string): readonly string[] {
    const modelArgs: string[] = model ? ['--model', model] : [];
    return ['--yolo', ...modelArgs, '--prompt', prompt];
  }

  protected get additionalEnv(): Record<string, string> {
    // --yolo enables Docker sandbox by default; disable it so Docker/Podman isn't required.
    // Users who want sandbox can set GEMINI_SANDBOX=true in their environment.
    return { GEMINI_SANDBOX: 'false' };
  }

  protected get envPrefixesToStrip(): readonly string[] {
    // ARCHITECTURE: No known Gemini CLI nesting indicators.
    // IMPORTANT: Must NOT strip GEMINI_API_KEY — required for authentication.
    return [];
  }
}
