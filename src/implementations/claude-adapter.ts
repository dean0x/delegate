/**
 * Claude Code agent adapter implementation
 *
 * ARCHITECTURE: Claude-specific logic on top of BaseAgentAdapter.
 * Includes prompt transformation for short commands and nesting prevention.
 */

import { AgentProvider } from '../core/agents.js';
import { Configuration } from '../core/configuration.js';
import { BaseAgentAdapter } from './base-agent-adapter.js';

export class ClaudeAdapter extends BaseAgentAdapter {
  readonly provider: AgentProvider = 'claude';

  private readonly baseArgs: readonly string[];

  constructor(config: Configuration, claudeCommand = 'claude') {
    super(config, claudeCommand);
    this.baseArgs = Object.freeze(['--print', '--dangerously-skip-permissions', '--output-format', 'json']);
  }

  protected buildArgs(prompt: string): readonly string[] {
    return [...this.baseArgs, prompt];
  }

  protected get envPrefixesToStrip(): readonly string[] {
    // CRITICAL: Strip all Claude Code nesting indicators to prevent rejection
    // Workers are independent Claude Code instances, not nested sessions
    return ['CLAUDECODE', 'CLAUDE_CODE_'];
  }

  /**
   * Make prompt more explicit if it looks like a simple command.
   * Short prompts without action verbs are ambiguous to Claude Code.
   */
  protected transformPrompt(prompt: string): string {
    const lower = prompt.toLowerCase();
    const hasActionVerb =
      lower.includes('run') ||
      lower.includes('execute') ||
      lower.includes('perform') ||
      lower.includes('bash') ||
      lower.includes('command');

    if (!hasActionVerb && prompt.split(' ').length <= 3) {
      return `Execute the following bash command: ${prompt}`;
    }

    return prompt;
  }
}
