/**
 * CLI command: beat init — Interactive first-time setup
 *
 * ARCHITECTURE: Three layers — types/DI, core logic (runInit), CLI entry (initCommand).
 * All interactive prompts injected via InitDeps for testability without vi.mock().
 * stderr-only output (stdout reserved for MCP protocol).
 */

import * as p from '@clack/prompts';
import type { AgentAuthStatus, AgentProvider } from '../../core/agents.js';
import { AGENT_DESCRIPTIONS, AGENT_PROVIDERS, checkAgentAuth, isAgentProvider } from '../../core/agents.js';
import { CONFIG_FILE_PATH, loadAgentConfig, loadConfigFile, saveConfigValue } from '../../core/configuration.js';
import * as ui from '../ui.js';

// ============================================================================
// Types
// ============================================================================

export type InitResult =
  | { readonly code: 0; readonly agent: AgentProvider }
  | { readonly code: 0; readonly reason: string }
  | { readonly code: 1; readonly reason: string };

export interface InitOptions {
  readonly agent?: string;
  readonly yes?: boolean;
}

export interface InitDeps {
  readonly checkAuth: (provider: AgentProvider) => AgentAuthStatus;
  readonly loadConfig: () => Record<string, unknown>;
  readonly saveConfig: (key: string, value: unknown) => { ok: true } | { ok: false; error: string };
  readonly selectAgent: (statuses: readonly AgentAuthStatus[]) => Promise<AgentProvider | 'cancelled'>;
  readonly confirmReconfigure: (existingAgent: AgentProvider) => Promise<boolean | 'cancelled'>;
  readonly isTTY: boolean;
}

// ============================================================================
// Arg Parsing
// ============================================================================

export function parseInitArgs(args: readonly string[]): InitOptions {
  const options: { agent?: string; yes?: boolean } = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--agent' || arg === '-a') {
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        options.agent = next;
        i++;
      }
    } else if (arg === '--yes' || arg === '-y') {
      options.yes = true;
    }
  }

  return options;
}

// ============================================================================
// Core Logic
// ============================================================================

export async function runInit(options: InitOptions, deps: InitDeps): Promise<InitResult> {
  const config = deps.loadConfig();
  const existingAgent =
    typeof config.defaultAgent === 'string' && isAgentProvider(config.defaultAgent) ? config.defaultAgent : undefined;

  // Non-interactive path: --agent flag
  if (options.agent) {
    if (!isAgentProvider(options.agent)) {
      return { code: 1, reason: `Unknown agent: "${options.agent}". Available agents: ${AGENT_PROVIDERS.join(', ')}` };
    }

    const result = deps.saveConfig('defaultAgent', options.agent);
    if (!result.ok) {
      return { code: 1, reason: result.error };
    }

    return { code: 0, agent: options.agent };
  }

  // Non-TTY guard
  if (!deps.isTTY) {
    return { code: 1, reason: 'No TTY detected. Use: beat init --agent <agent>' };
  }

  // Interactive path: check if already configured
  if (existingAgent && !options.yes) {
    const confirmed = await deps.confirmReconfigure(existingAgent);
    if (confirmed === 'cancelled') {
      return { code: 0, reason: 'Setup cancelled.' };
    }
    if (!confirmed) {
      return { code: 0, reason: 'Configuration unchanged.' };
    }
  }

  // Detect auth status for all agents
  const statuses = AGENT_PROVIDERS.map((provider) => deps.checkAuth(provider));

  const selected = await deps.selectAgent(statuses);
  if (selected === 'cancelled') {
    return { code: 0, reason: 'Setup cancelled.' };
  }

  const result = deps.saveConfig('defaultAgent', selected);
  if (!result.ok) {
    return { code: 1, reason: result.error };
  }

  return { code: 0, agent: selected };
}

// ============================================================================
// Production Dependencies
// ============================================================================

function authHint(status: AgentAuthStatus): string {
  if (!status.ready) return 'not configured';

  switch (status.method) {
    case 'env-var':
      return 'ready (env var)';
    case 'config-file':
      return 'ready (config)';
    case 'cli-installed':
      return 'CLI found';
    default:
      return 'not configured';
  }
}

export function createDefaultDeps(): InitDeps {
  return {
    checkAuth(provider: AgentProvider): AgentAuthStatus {
      const agentConfig = loadAgentConfig(provider);
      return checkAgentAuth(provider, agentConfig.apiKey);
    },

    loadConfig: loadConfigFile,

    saveConfig: saveConfigValue,

    async selectAgent(statuses: readonly AgentAuthStatus[]): Promise<AgentProvider | 'cancelled'> {
      // Sort: ready agents first
      const sorted = [...statuses].sort((a, b) => {
        if (a.ready && !b.ready) return -1;
        if (!a.ready && b.ready) return 1;
        return 0;
      });

      const result = await p.select({
        message: 'Select your default AI agent:',
        options: sorted.map((s) => ({
          value: s.provider,
          label: `${s.provider} — ${AGENT_DESCRIPTIONS[s.provider]}`,
          hint: authHint(s),
        })),
        initialValue: sorted[0]?.provider,
        output: process.stderr,
      });

      if (p.isCancel(result)) return 'cancelled';
      return result;
    },

    async confirmReconfigure(existingAgent: AgentProvider): Promise<boolean | 'cancelled'> {
      const result = await p.confirm({
        message: `Default agent is already set to '${existingAgent}'. Reconfigure?`,
        output: process.stderr,
      });

      if (p.isCancel(result)) return 'cancelled';
      return result;
    },

    isTTY: process.stderr.isTTY === true,
  };
}

// ============================================================================
// CLI Entry
// ============================================================================

export async function initCommand(args: readonly string[]): Promise<void> {
  const options = parseInitArgs(args);
  const deps = createDefaultDeps();
  const isInteractive = deps.isTTY && !options.agent;

  if (isInteractive) {
    ui.intro('Backbeat Setup');
  }

  const result = await runInit(options, deps);

  if (result.code === 1) {
    ui.error(result.reason);
    process.exit(1);
  }

  if ('agent' in result) {
    const status = deps.checkAuth(result.agent);

    if (isInteractive) {
      if (status.hint && !status.ready) {
        ui.info(status.hint);
      }
      ui.outro(`Default agent set to '${result.agent}'. Config: ${CONFIG_FILE_PATH}`);
    } else {
      ui.success(`Default agent set to '${result.agent}'`);
    }
  } else if (result.reason === 'Setup cancelled.') {
    ui.cancel('Setup cancelled.');
  } else if (deps.isTTY) {
    ui.outro(result.reason);
  } else {
    ui.info(result.reason);
  }

  process.exit(0);
}
