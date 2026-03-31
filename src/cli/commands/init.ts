/**
 * CLI command: beat init — Interactive first-time setup
 *
 * ARCHITECTURE: Three layers — types/DI, core logic (runInit), CLI entry (initCommand).
 * All interactive prompts injected via InitDeps for testability without vi.mock().
 * stderr-only output (stdout reserved for MCP protocol).
 */

import * as p from '@clack/prompts';
import { cpSync, existsSync, rmSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { AgentAuthStatus, AgentProvider } from '../../core/agents.js';
import { AGENT_DESCRIPTIONS, AGENT_PROVIDERS, checkAgentAuth, isAgentProvider } from '../../core/agents.js';
import { CONFIG_FILE_PATH, loadAgentConfig, loadConfigFile, saveConfigValue } from '../../core/configuration.js';
import { err, ok, type Result } from '../../core/result.js';
import * as ui from '../ui.js';

// ============================================================================
// Types
// ============================================================================

export type InitResult =
  | {
      readonly code: 0;
      readonly agent: AgentProvider;
      readonly status: AgentAuthStatus;
      readonly skillPaths?: readonly string[];
    }
  | { readonly code: 0; readonly reason: string }
  | { readonly code: 1; readonly reason: string };

export interface InitOptions {
  readonly agent?: string;
  readonly yes?: boolean;
  readonly installSkills?: boolean;
  readonly skillsAgents?: string;
}

export interface InitDeps {
  readonly checkAuth: (provider: AgentProvider) => AgentAuthStatus;
  readonly loadConfig: () => Record<string, unknown>;
  readonly saveConfig: (key: string, value: unknown) => { ok: true } | { ok: false; error: string };
  readonly selectAgent: (statuses: readonly AgentAuthStatus[]) => Promise<AgentProvider | 'cancelled'>;
  readonly confirmReconfigure: (existingAgent: AgentProvider) => Promise<boolean | 'cancelled'>;
  readonly isTTY: boolean;
  readonly confirmSkillInstall?: () => Promise<boolean | 'cancelled'>;
  readonly selectSkillAgents?: (defaultAgent: AgentProvider) => Promise<readonly AgentProvider[] | 'cancelled'>;
  readonly copySkills?: (agents: readonly AgentProvider[], projectRoot: string) => Result<readonly string[], string>;
  readonly skillsExist?: (agents: readonly AgentProvider[], projectRoot: string) => boolean;
  readonly confirmSkillUpdate?: () => Promise<boolean | 'cancelled'>;
  readonly getProjectRoot?: () => string;
}

/**
 * Agent-specific skill install directories.
 * Gemini installs to both its own dir and the shared .agents dir.
 */
export const AGENT_SKILL_DIRS: Readonly<Record<AgentProvider, readonly string[]>> = Object.freeze({
  claude: ['.claude/skills/autobeat'],
  codex: ['.agents/skills/autobeat'],
  gemini: ['.gemini/skills/autobeat', '.agents/skills/autobeat'],
});

// ============================================================================
// Arg Parsing
// ============================================================================

export function parseInitArgs(args: readonly string[]): InitOptions {
  const options: { agent?: string; yes?: boolean; installSkills?: boolean; skillsAgents?: string } = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--agent=')) {
      options.agent = arg.slice('--agent='.length) || undefined;
    } else if (arg === '--agent' || arg === '-a') {
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        options.agent = next;
        i++;
      }
    } else if (arg === '--yes' || arg === '-y') {
      options.yes = true;
    } else if (arg === '--install-skills') {
      options.installSkills = true;
    } else if (arg.startsWith('--skills-agents=')) {
      options.skillsAgents = arg.slice('--skills-agents='.length) || undefined;
    } else if (arg === '--skills-agents') {
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        options.skillsAgents = next;
        i++;
      }
    }
  }

  return options;
}

// ============================================================================
// Skill Install Logic
// ============================================================================

/**
 * Resolve the skill source directory from the installed package.
 * Works from both dist/ (compiled) and src/ (tsx) contexts.
 */
export function resolveSkillSource(): string {
  const thisFile = fileURLToPath(import.meta.url);
  // From dist/cli/commands/init.js or src/cli/commands/init.ts → package root
  return path.resolve(path.dirname(thisFile), '..', '..', '..', 'skills', 'autobeat');
}

/**
 * Get all target directories for the given agents in the project root.
 * Deduplicates paths (e.g., codex and gemini both write to .agents/).
 */
export function getSkillTargetDirs(agents: readonly AgentProvider[], projectRoot: string): readonly string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];

  for (const agent of agents) {
    for (const relative of AGENT_SKILL_DIRS[agent]) {
      const abs = path.resolve(projectRoot, relative);
      if (!seen.has(abs)) {
        seen.add(abs);
        dirs.push(abs);
      }
    }
  }

  return dirs;
}

/**
 * Check if any skill directories already exist for the given agents.
 */
export function defaultSkillsExist(agents: readonly AgentProvider[], projectRoot: string): boolean {
  const dirs = getSkillTargetDirs(agents, projectRoot);
  return dirs.some((dir) => existsSync(dir));
}

/**
 * Copy skills from the package source to agent-specific directories.
 * Returns all installed paths on success.
 */
export function defaultCopySkills(
  agents: readonly AgentProvider[],
  projectRoot: string,
): Result<readonly string[], string> {
  const source = resolveSkillSource();
  if (!existsSync(source)) {
    return err(`Skill source not found: ${source}`);
  }

  const dirs = getSkillTargetDirs(agents, projectRoot);
  const installed: string[] = [];

  for (const dir of dirs) {
    try {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
      cpSync(source, dir, { recursive: true });
      installed.push(dir);
    } catch (e) {
      return err(`Failed to copy skills to ${dir}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return ok(installed);
}

/**
 * Parse --skills-agents flag value into validated agent providers.
 */
export function parseSkillsAgents(value: string): Result<readonly AgentProvider[], string> {
  const parts = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const part of parts) {
    if (!isAgentProvider(part)) {
      return err(`Unknown agent in --skills-agents: "${part}". Available: ${AGENT_PROVIDERS.join(', ')}`);
    }
  }
  return ok(parts as AgentProvider[]);
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

    const status = deps.checkAuth(options.agent);

    // Non-interactive skill install: --install-skills
    if (options.installSkills && deps.copySkills) {
      const skillResult = await runSkillInstall(options.agent, options, deps);
      if (skillResult.code === 1) return skillResult;
      if ('skillPaths' in skillResult) {
        return { code: 0, agent: options.agent, status, skillPaths: skillResult.skillPaths };
      }
    }

    return { code: 0, agent: options.agent, status };
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

  const status = statuses.find((s) => s.provider === selected);
  if (!status) {
    return { code: 1, reason: `Internal error: no auth status for '${selected}'` };
  }

  // Interactive skill install (only if deps are available)
  if (deps.confirmSkillInstall) {
    const skillResult = await runSkillInstall(selected, options, deps);
    if (skillResult.code === 1) return skillResult;
    if ('skillPaths' in skillResult) {
      return { code: 0, agent: selected, status, skillPaths: skillResult.skillPaths };
    }
  }

  return { code: 0, agent: selected, status };
}

/**
 * Skill install sub-flow — shared between interactive and non-interactive paths.
 * Returns an InitResult fragment: either skillPaths on success, a reason on skip, or error.
 */
async function runSkillInstall(
  defaultAgent: AgentProvider,
  options: InitOptions,
  deps: InitDeps,
): Promise<{ code: 0; skillPaths: readonly string[] } | { code: 0; reason: string } | { code: 1; reason: string }> {
  const projectRoot = deps.getProjectRoot?.() ?? process.cwd();

  // Determine target agents
  let agents: readonly AgentProvider[];

  if (options.skillsAgents) {
    // Non-interactive: explicit --skills-agents
    const parsed = parseSkillsAgents(options.skillsAgents);
    if (!parsed.ok) {
      return { code: 1, reason: parsed.error };
    }
    agents = parsed.value;
  } else if (options.installSkills && !deps.isTTY) {
    // Non-interactive without --skills-agents: install for default agent only
    agents = [defaultAgent];
  } else if (deps.selectSkillAgents) {
    // Interactive: ask which agents
    const confirmResult = await deps.confirmSkillInstall?.();
    if (confirmResult === 'cancelled') {
      return { code: 0, reason: 'Skills install cancelled.' };
    }
    if (!confirmResult) {
      return { code: 0, reason: 'Skills install skipped.' };
    }

    const selectedAgents = await deps.selectSkillAgents(defaultAgent);
    if (selectedAgents === 'cancelled') {
      return { code: 0, reason: 'Skills install cancelled.' };
    }
    agents = selectedAgents;
  } else {
    // No skill deps available — skip silently
    return { code: 0, reason: 'Skills install skipped.' };
  }

  if (agents.length === 0) {
    return { code: 0, reason: 'No agents selected for skills.' };
  }

  // Check for existing skills
  if (deps.skillsExist?.(agents, projectRoot)) {
    if (options.yes) {
      // Auto-update with --yes
    } else if (deps.confirmSkillUpdate) {
      const updateResult = await deps.confirmSkillUpdate();
      if (updateResult === 'cancelled') {
        return { code: 0, reason: 'Skills update cancelled.' };
      }
      if (!updateResult) {
        return { code: 0, reason: 'Skills unchanged.' };
      }
    }
  }

  // Copy skills
  if (!deps.copySkills) {
    return { code: 0, reason: 'Skills install skipped.' };
  }

  const copyResult = deps.copySkills(agents, projectRoot);
  if (!copyResult.ok) {
    return { code: 1, reason: copyResult.error };
  }

  return { code: 0, skillPaths: copyResult.value };
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
      return 'may need login';
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

    async confirmSkillInstall(): Promise<boolean | 'cancelled'> {
      const result = await p.confirm({
        message: 'Install agent skills for autobeat orchestration?',
        initialValue: true,
        output: process.stderr,
      });

      if (p.isCancel(result)) return 'cancelled';
      return result;
    },

    async selectSkillAgents(defaultAgent: AgentProvider): Promise<readonly AgentProvider[] | 'cancelled'> {
      const result = await p.multiselect({
        message: 'Which agents will use autobeat in this project?',
        options: AGENT_PROVIDERS.map((provider) => ({
          value: provider,
          label: `${provider} — ${AGENT_DESCRIPTIONS[provider]}`,
        })),
        initialValues: [defaultAgent],
        required: true,
        output: process.stderr,
      });

      if (p.isCancel(result)) return 'cancelled';
      return result;
    },

    copySkills: defaultCopySkills,
    skillsExist: defaultSkillsExist,
    getProjectRoot: () => process.cwd(),

    async confirmSkillUpdate(): Promise<boolean | 'cancelled'> {
      const result = await p.confirm({
        message: 'Skills already installed. Update to latest version?',
        initialValue: true,
        output: process.stderr,
      });

      if (p.isCancel(result)) return 'cancelled';
      return result;
    },
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
    ui.intro('Autobeat Setup');
  }

  const result = await runInit(options, deps);

  if (result.code === 1) {
    ui.error(result.reason);
    process.exit(1);
  }

  if ('agent' in result) {
    if (result.status.hint) {
      ui.info(result.status.hint);
    }
    if (result.skillPaths && result.skillPaths.length > 0) {
      ui.success('Agent skills installed:');
      for (const skillPath of result.skillPaths) {
        ui.step(`  ${skillPath}`);
      }
    }
    if (isInteractive) {
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
