/**
 * CLI commands: beat agents list | check | config
 *
 * ARCHITECTURE: Uses static AGENT_PROVIDERS for listing,
 * checkAgentAuth() for auth status, and agent config storage for key management.
 */

import {
  AGENT_AUTH,
  AGENT_DESCRIPTIONS,
  AGENT_PROVIDERS,
  AgentProvider,
  checkAgentAuth,
  DEFAULT_AGENT,
  isAgentProvider,
  maskApiKey,
} from '../../core/agents.js';
import { loadAgentConfig, resetAgentConfig, saveAgentConfig } from '../../core/configuration.js';
import * as ui from '../ui.js';

export async function listAgents(): Promise<void> {
  const lines: string[] = [];
  for (const provider of AGENT_PROVIDERS) {
    const suffix = provider === DEFAULT_AGENT ? ' [default]' : '';
    lines.push(`${provider.padEnd(10)} ${AGENT_DESCRIPTIONS[provider]}${suffix}`);
  }
  ui.note(lines.join('\n'), 'Available Agents');

  ui.info('Usage: beat run "prompt" --agent <name>');
  process.exit(0);
}

/**
 * beat agents check — show auth status for all agents
 */
export async function checkAgents(): Promise<void> {
  ui.step('Agent Auth Status');

  const header = `  ${'Agent'.padEnd(10)} ${'CLI'.padEnd(8)} ${'Auth'.padEnd(40)} Status`;
  ui.info(header);

  for (const provider of AGENT_PROVIDERS) {
    const agentConfig = loadAgentConfig(provider);
    const status = checkAgentAuth(provider, agentConfig.apiKey);

    const cliStatus = status.cliFound ? 'found' : '-';
    let authDesc: string;

    switch (status.method) {
      case 'env-var': {
        const key = status.envVar ? process.env[status.envVar] : undefined;
        authDesc = `${status.envVar} set${key ? ` (${maskApiKey(key)})` : ''}`;
        break;
      }
      case 'config-file':
        authDesc = 'API key stored in config';
        break;
      case 'cli-installed':
        authDesc = 'CLI installed (auth not verified)';
        break;
      default:
        authDesc = 'not configured';
    }

    const badge = status.ready ? ui.cyan('[ready]') : '[action needed]';
    ui.step(`${provider.padEnd(10)} ${cliStatus.padEnd(8)} ${authDesc.padEnd(40)} ${badge}`);

    if (!status.ready && status.hint) {
      const hintLines = status.hint.split('\n').slice(1); // Skip the first "not configured" line
      for (const line of hintLines) {
        ui.info(`  ${ui.dim(line)}`);
      }
    }
  }

  process.exit(0);
}

/**
 * beat agents config set <agent> apiKey <value>
 */
export async function agentsConfigSet(
  agent: string | undefined,
  key: string | undefined,
  value: string | undefined,
): Promise<void> {
  if (!agent || !key || !value) {
    ui.error('Usage: beat agents config set <agent> apiKey <value>');
    process.exit(1);
  }

  if (!isAgentProvider(agent)) {
    ui.error(`Unknown agent: "${agent}". Available agents: ${AGENT_PROVIDERS.join(', ')}`);
    process.exit(1);
  }

  if (key !== 'apiKey') {
    ui.error(`Unknown config key: "${key}". Valid keys: apiKey`);
    process.exit(1);
  }

  const result = saveAgentConfig(agent as AgentProvider, key, value);
  if (!result.ok) {
    ui.error(result.error);
    process.exit(1);
  }

  ui.success(`${agent}.${key} saved (${maskApiKey(value)})`);
  process.exit(0);
}

/**
 * beat agents config show [agent]
 */
export async function agentsConfigShow(agent?: string): Promise<void> {
  const providers = agent ? [agent] : [...AGENT_PROVIDERS];
  const lines: string[] = [];

  for (const p of providers) {
    if (!isAgentProvider(p)) {
      ui.error(`Unknown agent: "${p}". Available agents: ${AGENT_PROVIDERS.join(', ')}`);
      process.exit(1);
    }

    const config = loadAgentConfig(p as AgentProvider);
    const auth = AGENT_AUTH[p as AgentProvider];

    if (config.apiKey) {
      lines.push(`${p.padEnd(10)} apiKey: ${maskApiKey(config.apiKey)} (env var: ${auth.envVars[0]})`);
    } else {
      lines.push(`${p.padEnd(10)} ${ui.dim('(no stored key)')}`);
    }
  }

  ui.note(lines.join('\n'), 'Agent Configuration');
  process.exit(0);
}

/**
 * beat agents config reset <agent>
 */
export async function agentsConfigReset(agent: string | undefined): Promise<void> {
  if (!agent) {
    ui.error('Usage: beat agents config reset <agent>');
    process.exit(1);
  }

  if (!isAgentProvider(agent)) {
    ui.error(`Unknown agent: "${agent}". Available agents: ${AGENT_PROVIDERS.join(', ')}`);
    process.exit(1);
  }

  const result = resetAgentConfig(agent as AgentProvider);
  if (!result.ok) {
    ui.error(result.error);
    process.exit(1);
  }

  ui.success(`${agent} config cleared`);
  process.exit(0);
}
