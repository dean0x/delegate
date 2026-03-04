/**
 * CLI command: beat agents list
 *
 * ARCHITECTURE: Displays available agent providers and their descriptions.
 * Uses the static AGENT_PROVIDERS list — no bootstrap needed.
 */

import { AGENT_DESCRIPTIONS, AGENT_PROVIDERS, DEFAULT_AGENT } from '../../core/agents.js';
import * as ui from '../ui.js';

export async function listAgents(): Promise<void> {
  ui.step('Available Agents');

  ui.info(`${'Name'.padEnd(10)} Description`);
  for (const provider of AGENT_PROVIDERS) {
    const suffix = provider === DEFAULT_AGENT ? ' [default]' : '';
    process.stderr.write(`  ${provider.padEnd(10)} ${AGENT_DESCRIPTIONS[provider]}${suffix}\n`);
  }

  ui.info('');
  ui.info('Usage: beat run "prompt" --agent <name>');
  process.exit(0);
}
