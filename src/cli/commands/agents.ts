/**
 * CLI commands: beat agents list | check | config | refresh-base-prompt
 *
 * ARCHITECTURE: Uses static AGENT_PROVIDERS for listing,
 * checkAgentAuth() for auth status, and agent config storage for key management.
 */

import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
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
      const ollamaFound = isCommandInPath('ollama');
      const ollamaStatus = ollamaFound ? ui.cyan('[found]') : '[not found]';
      ui.info(`  ${ui.dim(`runtime: ${agentConfig.runtime} — ollama CLI ${ollamaStatus}`)}`);
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

  // Probe connectivity when a URL/auth/proxy field is changed and non-empty
  if ((key === 'baseUrl' || key === 'apiKey' || key === 'proxy') && value !== '') {
    const config = loadAgentConfig(agent);
    const effectiveBaseUrl = key === 'baseUrl' ? value : config.baseUrl;
    if (effectiveBaseUrl) {
      const effectiveApiKey = key === 'apiKey' ? value : config.apiKey;
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
    const config = loadAgentConfig(agent);
    if (!config.baseUrl) ui.note('proxy requires baseUrl to be set', 'Warning');
    if (!config.apiKey) ui.note('proxy requires apiKey to be set', 'Warning');
    if (!config.model) ui.note('proxy requires model to be set', 'Warning');
  }

  // Warn about mutual exclusivity between runtime and proxy
  if (key === 'runtime' && value !== '') {
    const config = loadAgentConfig(agent);
    if (config.proxy) ui.note('runtime and proxy are mutually exclusive — runtime takes precedence', 'Warning');
  }
  if (key === 'proxy' && value !== '') {
    const config = loadAgentConfig(agent);
    if (config.runtime) ui.note('runtime and proxy are mutually exclusive — runtime takes precedence', 'Warning');
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

/**
 * beat agents refresh-base-prompt [agent]
 *
 * DESIGN: Certain agents (currently Gemini) replace rather than append the system prompt
 * via GEMINI_SYSTEM_MD. To simulate "append" behaviour we cache the agent's native base
 * prompt and prepend it to any per-task systemPrompt at runtime. This command seeds or
 * refreshes that cache by running the agent CLI with GEMINI_WRITE_SYSTEM_MD set so it
 * writes its native prompt to a known path, then records the export timestamp in a
 * companion .meta.json file for staleness tracking.
 *
 * Only Gemini requires this currently. Other agents (Claude, Codex) support native
 * append semantics and do not need a cached base prompt.
 */
export async function refreshBasePrompt(agent?: string): Promise<void> {
  // Default to gemini; other agents don't need a base-prompt cache
  const targetAgent = agent ?? 'gemini';

  if (!isAgentProvider(targetAgent)) {
    ui.error(`Unknown agent: "${targetAgent}". Available agents: ${AGENT_PROVIDERS.join(', ')}`);
    process.exit(1);
  }

  if (targetAgent !== 'gemini') {
    ui.info(
      `${targetAgent} uses native system-prompt append — no base-prompt cache needed. Only gemini requires refresh-base-prompt.`,
    );
    process.exit(0);
  }

  const cacheDir = path.join(os.homedir(), '.autobeat', 'system-prompts');
  const baseCachePath = path.join(cacheDir, 'gemini-base.md');
  const metaPath = path.join(cacheDir, 'gemini-base.meta.json');

  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });

  ui.step(`Exporting Gemini base system prompt...`);
  ui.info(`Target: ${baseCachePath}`);

  // Spawn gemini with GEMINI_WRITE_SYSTEM_MD to trigger native prompt export.
  // The `-p ""` (empty prompt) or `--prompt ""` plus immediate exit minimises actual work.
  // We use spawnSync so we can inspect the exit code and verify the file was written.
  const result = spawnSync('gemini', ['--yolo', '--prompt', ''], {
    env: {
      ...process.env,
      GEMINI_WRITE_SYSTEM_MD: baseCachePath,
      // Disable sandbox so Docker/Podman is not required
      GEMINI_SANDBOX: 'false',
    },
    timeout: 30_000,
    // Suppress the agent's own stdout/stderr during export — we only care about the file
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  if (result.error) {
    ui.error(`Failed to spawn gemini CLI: ${result.error.message}`);
    ui.info(
      'Ensure the gemini CLI is installed and in your PATH (npm install -g @google/generative-ai-cli or similar).',
    );
    process.exit(1);
  }

  // Verify the file was actually written — the env var may be silently ignored by some
  // gemini CLI versions
  if (!existsSync(baseCachePath)) {
    const stderrOutput = result.stderr ? result.stderr.toString().trim() : '';

    ui.error(
      'gemini CLI exited but gemini-base.md was not written. Your Gemini CLI version may not support GEMINI_WRITE_SYSTEM_MD.',
    );
    if (stderrOutput) {
      ui.info(`gemini stderr: ${stderrOutput.slice(0, 400)}`);
    }
    ui.info('Manual workaround: copy the gemini system prompt text into ~/.autobeat/system-prompts/gemini-base.md');
    process.exit(1);
  }

  // Read the exported content for display purposes
  const exportedContent = readFileSync(baseCachePath, 'utf8');

  // Write companion metadata so gemini-adapter.ts can check staleness
  const meta = {
    exportedAt: new Date().toISOString(),
    exportedAtMs: Date.now(),
    source: 'refresh-base-prompt',
    geminiCliExit: result.status ?? 0,
  };
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });

  ui.success(`Base prompt exported: ${baseCachePath}`);
  ui.info(`Size: ${exportedContent.length} chars`);
  ui.info(`Metadata: ${metaPath}`);
  ui.info('The gemini-base.md cache is now used for GEMINI_SYSTEM_MD injection when systemPrompt is set on a task.');
  process.exit(0);
}
