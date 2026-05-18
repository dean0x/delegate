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
  checkAgentAuth,
  isAgentProvider,
  isCommandInPath,
  maskApiKey,
} from '../../core/agents.js';
import {
  isRuntimeSupportedForAgent,
  loadAgentConfig,
  loadConfiguration,
  PROXY_TARGETS,
  RUNTIME_AGENT_SUPPORT,
  RUNTIME_TARGETS,
  type Runtime,
  resetAgentConfig,
  saveAgentConfig,
} from '../../core/configuration.js';
import { probeUrl } from '../../utils/url-probe.js';
import * as ui from '../ui.js';

export async function listAgents(): Promise<void> {
  const config = loadConfiguration();
  const lines: string[] = [];
  for (const provider of AGENT_PROVIDERS) {
    const suffix = provider === config.defaultAgent ? ' [default]' : '';
    lines.push(`${provider.padEnd(10)} ${AGENT_DESCRIPTIONS[provider]}${suffix}`);
  }
  ui.note(lines.join('\n'), 'Available Agents');

  if (!config.defaultAgent) {
    ui.info('No default agent set. Run: beat init');
  }
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

    let badge: string;
    if (status.method === 'cli-installed') {
      badge = ui.yellow('[check auth]');
    } else if (status.ready) {
      badge = ui.cyan('[ready]');
    } else {
      badge = '[action needed]';
    }
    ui.step(`${provider.padEnd(10)} ${cliStatus.padEnd(8)} ${authDesc.padEnd(40)} ${badge}`);

    if (status.hint && (status.method === 'cli-installed' || !status.ready)) {
      const hintLines = status.hint.split('\n').slice(1); // Skip the header line
      for (const line of hintLines) {
        ui.info(`  ${ui.dim(line)}`);
      }
    }

    if (agentConfig.runtime) {
      const runtimeFound = isCommandInPath(agentConfig.runtime);
      const runtimeStatus = runtimeFound ? ui.cyan('[found]') : '[not found]';
      ui.info(`  ${ui.dim(`runtime: ${agentConfig.runtime} — ${agentConfig.runtime} CLI ${runtimeStatus}`)}`);
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
    ui.error('Usage: beat agents config set <agent> <apiKey|baseUrl|model|proxy|runtime> <value>');
    process.exit(1);
  }

  if (!isAgentProvider(agent)) {
    ui.error(`Unknown agent: "${agent}". Available agents: ${AGENT_PROVIDERS.join(', ')}`);
    process.exit(1);
  }

  if (key !== 'apiKey' && key !== 'baseUrl' && key !== 'model' && key !== 'proxy' && key !== 'runtime') {
    ui.error(`Unknown config key: "${key}". Valid keys: apiKey, baseUrl, model, proxy, runtime`);
    process.exit(1);
  }

  // Shell history warning only for apiKey (not baseUrl/model which are not secrets)
  if (key === 'apiKey') {
    ui.note(
      'API keys passed as CLI arguments may be stored in shell history. Consider using an environment variable instead.',
      'Warning',
    );
  }

  // Validate proxy is a supported target (empty string clears)
  if (key === 'proxy' && value !== '') {
    if (!(PROXY_TARGETS as readonly string[]).includes(value)) {
      ui.error(`Unsupported proxy target: "${value}". Supported values: ${PROXY_TARGETS.join(', ')}`);
      process.exit(1);
    }
  }

  // Validate runtime is a supported target (empty string clears)
  if (key === 'runtime' && value !== '') {
    if (!(RUNTIME_TARGETS as readonly string[]).includes(value)) {
      ui.error(`Unsupported runtime: "${value}". Supported values: ${RUNTIME_TARGETS.join(', ')}`);
      process.exit(1);
    }
    // Check agent-runtime compatibility
    if (!isRuntimeSupportedForAgent(value as Runtime, agent)) {
      ui.error(
        `Runtime '${value}' does not support agent '${agent}'. ` +
          `Supported agents: ${RUNTIME_AGENT_SUPPORT[value as Runtime].join(', ')}`,
      );
      process.exit(1);
    }
  }

  // Validate baseUrl is a well-formed absolute URL before saving
  if (key === 'baseUrl' && value !== '') {
    try {
      new URL(value);
    } catch {
      ui.error(`Invalid baseUrl: "${value}" is not a valid URL. Example: https://proxy.example.com/v1`);
      process.exit(1);
    }
  }

  const result = saveAgentConfig(agent, key, value);
  if (!result.ok) {
    ui.error(result.error);
    process.exit(1);
  }

  if (key === 'apiKey') {
    ui.success(`${agent}.${key} saved (${maskApiKey(value)})`);
  } else {
    ui.success(`${agent}.${key} saved: ${value}`);
  }

  const updatedConfig = loadAgentConfig(agent);

  // Probe connectivity when a URL/auth/proxy field is changed and non-empty
  if ((key === 'baseUrl' || key === 'apiKey' || key === 'proxy') && value !== '') {
    const effectiveBaseUrl = key === 'baseUrl' ? value : updatedConfig.baseUrl;
    if (effectiveBaseUrl) {
      const effectiveApiKey = key === 'apiKey' ? value : updatedConfig.apiKey;
      const probeResult = await probeUrl(effectiveBaseUrl, {
        apiKey: effectiveApiKey,
        timeoutMs: 5000,
      });
      if (probeResult.ok) {
        const probe = probeResult.value;
        if (probe.severity === 'ok') {
          ui.success(`Connectivity check passed (${probe.durationMs}ms)`);
        } else {
          ui.note(probe.message, 'Connectivity');
        }
      }
    }
  }

  // Warn when proxy is set but required fields are missing
  if (key === 'proxy' && value !== '') {
    if (!updatedConfig.baseUrl) ui.note('proxy requires baseUrl to be set', 'Warning');
    if (!updatedConfig.apiKey) ui.note('proxy requires apiKey to be set', 'Warning');
    if (!updatedConfig.model) ui.note('proxy requires model to be set', 'Warning');
  }

  // Warn about mutual exclusivity between runtime and proxy
  if (key === 'runtime' && value !== '') {
    if (updatedConfig.proxy) ui.note('runtime and proxy are mutually exclusive — runtime takes precedence', 'Warning');
  }
  if (key === 'proxy' && value !== '') {
    if (updatedConfig.runtime)
      ui.note('runtime and proxy are mutually exclusive — runtime takes precedence', 'Warning');
  }

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

    const config = loadAgentConfig(p);
    const auth = AGENT_AUTH[p];

    const parts: string[] = [];
    if (config.apiKey) {
      parts.push(`apiKey: ${maskApiKey(config.apiKey)} (env var: ${auth.envVars[0]})`);
    }
    if (config.baseUrl) {
      parts.push(`baseUrl: ${config.baseUrl}`);
    }
    if (config.model) {
      parts.push(`model: ${config.model}`);
    }
    if (config.proxy) {
      parts.push(`proxy: ${config.proxy}`);
    }
    if (config.runtime) {
      parts.push(`runtime: ${config.runtime}`);
    }

    if (parts.length > 0) {
      lines.push(`${p.padEnd(10)} ${parts.join(' | ')}`);
    } else {
      lines.push(`${p.padEnd(10)} ${ui.dim('(no stored config)')}`);
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

  const result = resetAgentConfig(agent);
  if (!result.ok) {
    ui.error(result.error);
    process.exit(1);
  }

  ui.success(`${agent} config cleared`);
  process.exit(0);
}
