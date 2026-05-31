/**
 * CLI command: beat init — Interactive first-time setup
 *
 * ARCHITECTURE: Three layers — types/DI, core logic (runInit), CLI entry (initCommand).
 * All interactive prompts injected via InitDeps for testability without vi.mock().
 * stderr-only output (stdout reserved for MCP protocol).
 */

import * as p from '@clack/prompts';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
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
  /**
   * Configure Stop hooks for supported agent CLIs (claude, codex).
   * Optional: if not provided, hook configuration is skipped silently.
   */
  readonly configureHooks?: (agent: AgentProvider) => readonly HookConfigResult[];
}

/** Result of a single agent hook configuration attempt. */
export type HookConfigResult =
  | {
      readonly agentType: 'claude' | 'codex';
      readonly ok: true;
      /** true if already present (no-op) */
      readonly alreadyPresent?: boolean;
      /** Warning message (e.g., config dir not found) */
      readonly warning?: string;
    }
  | {
      readonly agentType: 'claude' | 'codex';
      readonly ok: false;
      readonly error: string;
    };

/**
 * Agent-specific skill install directories.
 */
export const AGENT_SKILL_DIRS: Readonly<Record<AgentProvider, readonly string[]>> = Object.freeze({
  claude: ['.claude/skills/autobeat'],
  codex: ['.agents/skills/autobeat'],
});

// ============================================================================
// Hook Configuration
// ============================================================================

/**
 * Config file paths for agent hook configuration.
 */
export const AGENT_HOOK_CONFIG_PATHS: Readonly<Record<'claude' | 'codex', string>> = Object.freeze({
  claude: path.join(homedir(), '.claude', 'settings.json'),
  codex: path.join(homedir(), '.codex', 'hooks.json'),
});

/**
 * The Stop hook entry to inject into agent config files.
 *
 * DESIGN DECISION: autobeat-stop-hook is registered as an npm bin entry so
 * it is available on PATH after `npm install -g autobeat`. Both Claude Code
 * and Codex CLI support a "command" type hook that invokes a shell command.
 */
const STOP_HOOK_COMMAND = 'autobeat-stop-hook';

/** Deps for hook configuration (injectable for testing). */
export interface HookConfigDeps {
  readonly readFile: (filePath: string) => string | null;
  readonly writeFile: (filePath: string, content: string) => void;
  readonly renameFile: (from: string, to: string) => void;
  readonly ensureDir: (dirPath: string) => void;
  readonly fileExists: (filePath: string) => boolean;
  readonly unlinkFile: (filePath: string) => void;
}

/** Read and parse an existing agent config file, returning an empty object if absent or unreadable. */
function readExistingConfig(
  configPath: string,
  agentType: 'claude' | 'codex',
  deps: HookConfigDeps,
): Result<Record<string, unknown>, string> {
  if (!deps.fileExists(configPath)) return ok({});
  const raw = deps.readFile(configPath);
  if (raw === null) return ok({});
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return ok(parsed as Record<string, unknown>);
    }
    return ok({});
  } catch {
    return err(`Failed to parse ${agentType} config at ${configPath}: invalid JSON`);
  }
}

/** Copy the config file to `<configPath>.bak` if no backup exists yet. */
function backupIfNeeded(configPath: string, deps: HookConfigDeps): void {
  if (!deps.fileExists(configPath)) return;
  const backupPath = configPath + '.bak';
  if (deps.fileExists(backupPath)) return;
  const original = deps.readFile(configPath);
  if (original !== null) {
    deps.writeFile(backupPath, original);
  }
}

/** Write `content` atomically to `configPath` via a `.tmp` + rename pair. */
function atomicWriteConfig(
  configPath: string,
  content: string,
  agentType: 'claude' | 'codex',
  deps: HookConfigDeps,
): Result<void, string> {
  const tmpPath = configPath + '.tmp';
  try {
    deps.writeFile(tmpPath, content);
  } catch (e) {
    return err(`Failed to write ${agentType} config (tmp): ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    deps.renameFile(tmpPath, configPath);
  } catch (e) {
    // Best-effort delete of the orphaned .tmp file.
    try {
      deps.unlinkFile(tmpPath);
    } catch {
      /* ignore */
    }
    return err(`Failed to write ${agentType} config (rename): ${e instanceof Error ? e.message : String(e)}`);
  }
  return ok(undefined);
}

/** Narrows an unknown value to an object with a `hooks` array (Stop hook group entry shape). */
function isHookGroupEntry(x: unknown): x is { hooks: unknown[] } {
  return typeof x === 'object' && x !== null && Array.isArray((x as Record<string, unknown>).hooks);
}

/** Narrows an unknown value to a command hook entry with `type` and `command` fields. */
function isCommandHookEntry(x: unknown): x is { type: string; command: string } {
  if (typeof x !== 'object' || x === null) return false;
  const h = x as Record<string, unknown>;
  return typeof h.type === 'string' && typeof h.command === 'string';
}

/** Return true if `autobeat-stop-hook` is already registered in the Stop hooks array. */
function hasStopHookCommand(stopHookEntries: unknown[]): boolean {
  return stopHookEntries.some(
    (entry) =>
      isHookGroupEntry(entry) &&
      entry.hooks.some((h) => isCommandHookEntry(h) && h.type === 'command' && h.command === STOP_HOOK_COMMAND),
  );
}

/**
 * Deep-merge a Stop hook entry into an agent's config file.
 *
 * Idempotent: if `autobeat-stop-hook` is already present in the hooks array,
 * returns Ok without modifying the file.
 *
 * Creates a `.bak` backup before first modification.
 * Writes atomically via `.tmp` + rename.
 *
 * @param agentType - 'claude' | 'codex'
 * @param configPath - Absolute path to the config file
 * @param deps - Injectable file system dependencies
 */
export function configureAgentHook(
  agentType: 'claude' | 'codex',
  configPath: string,
  deps: HookConfigDeps,
): Result<void, string> {
  const configDir = path.dirname(configPath);
  try {
    deps.ensureDir(configDir);
  } catch (e) {
    return err(`Failed to create ${agentType} config directory: ${e instanceof Error ? e.message : String(e)}`);
  }

  const existingResult = readExistingConfig(configPath, agentType, deps);
  if (!existingResult.ok) return existingResult;
  const existing = existingResult.value;

  const existingHooks =
    typeof existing.hooks === 'object' && existing.hooks !== null && !Array.isArray(existing.hooks)
      ? (existing.hooks as Record<string, unknown>)
      : {};
  const stopHooks = Array.isArray(existingHooks.Stop) ? (existingHooks.Stop as unknown[]) : [];

  if (hasStopHookCommand(stopHooks)) return ok(undefined);

  backupIfNeeded(configPath, deps);

  const newHookEntry = { hooks: [{ type: 'command', command: STOP_HOOK_COMMAND }] };
  const updatedHooks = { ...existingHooks, Stop: [...stopHooks, newHookEntry] };
  const updated = { ...existing, hooks: updatedHooks };
  const content = JSON.stringify(updated, null, 2) + '\n';

  return atomicWriteConfig(configPath, content, agentType, deps);
}

/**
 * Production implementation of HookConfigDeps using real filesystem.
 */
export function createDefaultHookConfigDeps(): HookConfigDeps {
  return {
    readFile(filePath: string): string | null {
      try {
        return readFileSync(filePath, 'utf-8');
      } catch {
        return null;
      }
    },
    writeFile(filePath: string, content: string): void {
      writeFileSync(filePath, content, { encoding: 'utf-8', mode: 0o600 });
    },
    renameFile(from: string, to: string): void {
      renameSync(from, to);
    },
    ensureDir(dirPath: string): void {
      mkdirSync(dirPath, { recursive: true, mode: 0o700 });
    },
    fileExists(filePath: string): boolean {
      return existsSync(filePath);
    },
    unlinkFile(filePath: string): void {
      rmSync(filePath);
    },
  };
}

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
 * Deduplicates paths so multiple agents writing the same dir are idempotent.
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

/**
 * Run skill install if applicable, configure hooks, then return the success InitResult.
 * `runSkills` controls whether skill install is attempted (differs between paths).
 */
async function finalizeInit(
  agent: AgentProvider,
  status: AgentAuthStatus,
  runSkills: boolean,
  options: InitOptions,
  deps: InitDeps,
): Promise<InitResult> {
  if (runSkills) {
    const skillResult = await runSkillInstall(agent, options, deps);
    if (skillResult.code === 1) return skillResult;
    if ('skillPaths' in skillResult) {
      runHookConfigure(agent, deps);
      return { code: 0, agent, status, skillPaths: skillResult.skillPaths };
    }
  }
  runHookConfigure(agent, deps);
  return { code: 0, agent, status };
}

export async function runInit(options: InitOptions, deps: InitDeps): Promise<InitResult> {
  const config = deps.loadConfig();
  const existingAgent =
    typeof config.defaultAgent === 'string' && isAgentProvider(config.defaultAgent) ? config.defaultAgent : undefined;

  // Non-interactive path: --agent flag
  if (options.agent) {
    if (!isAgentProvider(options.agent)) {
      return { code: 1, reason: `Unknown agent: "${options.agent}". Available agents: ${AGENT_PROVIDERS.join(', ')}` };
    }

    const saveResult = deps.saveConfig('defaultAgent', options.agent);
    if (!saveResult.ok) {
      return { code: 1, reason: saveResult.error };
    }

    const status = deps.checkAuth(options.agent);
    return finalizeInit(options.agent, status, !!(options.installSkills && deps.copySkills), options, deps);
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

  const saveResult = deps.saveConfig('defaultAgent', selected);
  if (!saveResult.ok) {
    return { code: 1, reason: saveResult.error };
  }

  const status = statuses.find((s) => s.provider === selected);
  if (!status) {
    return { code: 1, reason: `Internal error: no auth status for '${selected}'` };
  }

  return finalizeInit(selected, status, !!deps.confirmSkillInstall, options, deps);
}

type SkillInstallResult =
  | { code: 0; skillPaths: readonly string[] }
  | { code: 0; reason: string }
  | { code: 1; reason: string };

type AgentResolution =
  | { resolved: true; agents: readonly AgentProvider[] }
  | { resolved: false; result: SkillInstallResult };

/**
 * Resolve the list of target agents for skill install.
 * Returns the resolved agent list, or an early-exit SkillInstallResult (skip/cancel/error).
 */
async function resolveTargetAgents(
  defaultAgent: AgentProvider,
  options: InitOptions,
  deps: InitDeps,
): Promise<AgentResolution> {
  if (options.skillsAgents) {
    // Non-interactive: explicit --skills-agents
    const parsed = parseSkillsAgents(options.skillsAgents);
    if (!parsed.ok) return { resolved: false, result: { code: 1, reason: parsed.error } };
    return { resolved: true, agents: parsed.value };
  }

  if (options.installSkills && !deps.isTTY) {
    // Non-interactive without --skills-agents: install for default agent only
    return { resolved: true, agents: [defaultAgent] };
  }

  if (deps.selectSkillAgents) {
    // Interactive: confirm then select agents
    const confirmResult = await deps.confirmSkillInstall?.();
    if (confirmResult === 'cancelled') {
      return { resolved: false, result: { code: 0, reason: 'Skills install cancelled.' } };
    }
    if (!confirmResult) {
      return { resolved: false, result: { code: 0, reason: 'Skills install skipped.' } };
    }

    const selectedAgents = await deps.selectSkillAgents(defaultAgent);
    if (selectedAgents === 'cancelled') {
      return { resolved: false, result: { code: 0, reason: 'Skills install cancelled.' } };
    }
    return { resolved: true, agents: selectedAgents };
  }

  // No skill deps available — skip silently
  return { resolved: false, result: { code: 0, reason: 'Skills install skipped.' } };
}

/**
 * Skill install sub-flow — shared between interactive and non-interactive paths.
 * Returns an InitResult fragment: either skillPaths on success, a reason on skip, or error.
 */
async function runSkillInstall(
  defaultAgent: AgentProvider,
  options: InitOptions,
  deps: InitDeps,
): Promise<SkillInstallResult> {
  const projectRoot = deps.getProjectRoot?.() ?? process.cwd();

  const resolution = await resolveTargetAgents(defaultAgent, options, deps);
  if (!resolution.resolved) return resolution.result;
  const { agents } = resolution;

  if (agents.length === 0) {
    return { code: 0, reason: 'No agents selected for skills.' };
  }

  // Check for existing skills
  if (deps.skillsExist?.(agents, projectRoot) && !options.yes && deps.confirmSkillUpdate) {
    const updateResult = await deps.confirmSkillUpdate();
    if (updateResult === 'cancelled') {
      return { code: 0, reason: 'Skills update cancelled.' };
    }
    if (!updateResult) {
      return { code: 0, reason: 'Skills unchanged.' };
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

/**
 * Configure Stop hooks for both Claude and Codex CLIs.
 * Fires and logs warnings — never fails init on hook configuration errors.
 * Hook config failures are non-fatal: the agent selection itself succeeded.
 */
function runHookConfigure(agent: AgentProvider, deps: InitDeps): void {
  if (!deps.configureHooks) return;
  const results = deps.configureHooks(agent);
  for (const result of results) {
    if (!result.ok) {
      ui.info(`Hook configuration for ${result.agentType}: ${result.error}`);
    } else if (result.warning) {
      ui.info(`Hook configuration for ${result.agentType}: ${result.warning}`);
    }
  }
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

    configureHooks(agent: AgentProvider): readonly HookConfigResult[] {
      return defaultConfigureHooks(agent);
    },
  };
}

/**
 * Configure Stop hooks for both Claude Code and Codex CLI config files.
 *
 * Both agents are always configured regardless of which default agent was
 * selected, because a user may run both CLIs on the same machine. If a CLI
 * config directory is not present, the configuration is skipped with a
 * warning rather than failing init.
 *
 * For Codex: emits a warning in the HookConfigResult when configuration succeeds
 * because Codex CLI requires explicit trust approval for hook commands on first run.
 */
export function defaultConfigureHooks(_agent: AgentProvider): readonly HookConfigResult[] {
  // Both CLIs are always configured regardless of which agent was selected,
  // because a user may run both on the same machine. _agent reserved for future extensibility.
  const deps = createDefaultHookConfigDeps();
  const results: HookConfigResult[] = [];

  for (const agentType of ['claude', 'codex'] as const) {
    const configPath = AGENT_HOOK_CONFIG_PATHS[agentType];
    const configDir = path.dirname(configPath);

    // Skip if agent CLI config directory doesn't exist (CLI not installed)
    if (!deps.fileExists(configDir)) {
      results.push({
        agentType,
        ok: true,
        warning: `${agentType} config directory not found (${configDir}) — skipped. Install the ${agentType} CLI first.`,
      });
      continue;
    }

    const configResult = configureAgentHook(agentType, configPath, deps);
    if (!configResult.ok) {
      results.push({ agentType, ok: false, error: configResult.error });
    } else if (agentType === 'codex') {
      results.push({
        agentType,
        ok: true,
        warning:
          'Codex may require you to approve the autobeat-stop-hook on first run. Run `codex` and accept the hook trust prompt.',
      });
    } else {
      results.push({ agentType, ok: true });
    }
  }

  return results;
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
