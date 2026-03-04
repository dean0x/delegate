/**
 * CLI command: beat agents list
 *
 * ARCHITECTURE: Displays available agent providers and their descriptions.
 * Uses the static AGENT_PROVIDERS list — no bootstrap needed.
 */

import { AGENT_PROVIDERS, AgentProvider } from '../../core/agents.js';
import * as ui from '../ui.js';

/** Agent descriptions keyed by provider name */
const AGENT_DESCRIPTIONS: Record<AgentProvider, string> = {
  claude: 'Claude Code (Anthropic)',
  codex: 'Codex CLI (OpenAI)',
  gemini: 'Gemini CLI (Google)',
  aider: 'Aider',
};

/** Agent CLI commands keyed by provider name */
const AGENT_COMMANDS: Record<AgentProvider, string> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  aider: 'aider',
};

export async function listAgents(): Promise<void> {
  ui.step('Available Agents');

  const lines: string[] = [];
  for (const provider of AGENT_PROVIDERS) {
    const isDefault = provider === 'claude';
    const suffix = isDefault ? ' [default]' : '';
    lines.push(
      `  ${provider.padEnd(10)} ${AGENT_COMMANDS[provider].padEnd(10)} ${AGENT_DESCRIPTIONS[provider]}${suffix}`,
    );
  }

  ui.info(`${'Name'.padEnd(10)} ${'Command'.padEnd(10)} Description`);
  for (const line of lines) {
    process.stderr.write(`${line}\n`);
  }

  ui.info('');
  ui.info('Usage: beat run "prompt" --agent <name>');
  process.exit(0);
}
