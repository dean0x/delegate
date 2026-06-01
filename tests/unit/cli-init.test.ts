/**
 * Tests for `beat init` command
 *
 * ARCHITECTURE: Tests runInit() and parseInitArgs() with injected deps.
 * No vi.mock() — all interactive prompts are plain function injections via InitDeps.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { HookConfigDeps, HookConfigResult, InitDeps, InitOptions } from '../../src/cli/commands/init';
import {
  AGENT_HOOK_CONFIG_PATHS,
  AGENT_SKILL_DIRS,
  configureAgentHook,
  defaultSkillsExist,
  getSkillTargetDirs,
  parseInitArgs,
  parseSkillsAgents,
  runInit,
} from '../../src/cli/commands/init';
import type { AgentAuthStatus, AgentProvider } from '../../src/core/agents';
import { AGENT_PROVIDERS } from '../../src/core/agents';

// ============================================================================
// Test Helpers
// ============================================================================

function makeStatus(provider: AgentProvider, ready: boolean): AgentAuthStatus {
  return {
    provider,
    ready,
    method: ready ? 'env-var' : 'none',
    cliFound: ready,
    hint: ready ? undefined : `Agent '${provider}' not configured.`,
  };
}

function makeDeps(overrides: Partial<InitDeps> = {}): InitDeps {
  return {
    checkAuth: (provider) => makeStatus(provider, true),
    loadConfig: () => ({}),
    saveConfig: () => ({ ok: true }),
    selectAgent: async () => 'claude',
    confirmReconfigure: async () => true,
    isTTY: true,
    ...overrides,
  };
}

function makeSkillDeps(overrides: Partial<InitDeps> = {}): InitDeps {
  return makeDeps({
    confirmSkillInstall: async () => true,
    selectSkillAgents: async () => ['claude'],
    copySkills: () => ({ ok: true, value: ['/project/.claude/skills/autobeat'] }),
    skillsExist: () => false,
    confirmSkillUpdate: async () => true,
    ...overrides,
  });
}

// ============================================================================
// parseInitArgs
// ============================================================================

describe('parseInitArgs', () => {
  it('should parse --agent flag', () => {
    expect(parseInitArgs(['--agent', 'claude'])).toEqual({ agent: 'claude' });
  });

  it('should parse -a shorthand', () => {
    expect(parseInitArgs(['-a', 'codex'])).toEqual({ agent: 'codex' });
  });

  it('should parse --yes flag', () => {
    expect(parseInitArgs(['--yes'])).toEqual({ yes: true });
  });

  it('should parse -y shorthand', () => {
    expect(parseInitArgs(['-y'])).toEqual({ yes: true });
  });

  it('should return empty options for empty args', () => {
    expect(parseInitArgs([])).toEqual({});
  });

  it('should ignore --agent without a value', () => {
    expect(parseInitArgs(['--agent'])).toEqual({});
  });

  it('should ignore --agent when next arg is a flag', () => {
    expect(parseInitArgs(['--agent', '--yes'])).toEqual({ yes: true });
  });

  it('should parse --agent=value syntax', () => {
    expect(parseInitArgs(['--agent=claude'])).toEqual({ agent: 'claude' });
  });

  it('should parse combined flags', () => {
    expect(parseInitArgs(['-a', 'codex', '-y'])).toEqual({ agent: 'codex', yes: true });
  });

  it('should parse --install-skills flag', () => {
    expect(parseInitArgs(['--install-skills'])).toEqual({ installSkills: true });
  });

  it('should parse --skills-agents flag', () => {
    expect(parseInitArgs(['--skills-agents', 'claude,codex'])).toEqual({ skillsAgents: 'claude,codex' });
  });

  it('should parse --skills-agents=value syntax', () => {
    expect(parseInitArgs(['--skills-agents=claude,codex'])).toEqual({ skillsAgents: 'claude,codex' });
  });

  it('should parse combined --agent --install-skills --skills-agents', () => {
    expect(parseInitArgs(['--agent', 'claude', '--install-skills', '--skills-agents', 'claude,codex'])).toEqual({
      agent: 'claude',
      installSkills: true,
      skillsAgents: 'claude,codex',
    });
  });
});

// ============================================================================
// parseSkillsAgents
// ============================================================================

describe('parseSkillsAgents', () => {
  it('should parse valid single agent', () => {
    const result = parseSkillsAgents('claude');
    expect(result).toEqual({ ok: true, value: ['claude'] });
  });

  it('should parse valid comma-separated agents', () => {
    const result = parseSkillsAgents('claude,codex');
    expect(result).toEqual({ ok: true, value: ['claude', 'codex'] });
  });

  it('should trim whitespace', () => {
    const result = parseSkillsAgents('claude , codex');
    expect(result).toEqual({ ok: true, value: ['claude', 'codex'] });
  });

  it('should reject unknown agent', () => {
    const result = parseSkillsAgents('claude,gpt4');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('gpt4');
  });

  it('should filter empty strings', () => {
    const result = parseSkillsAgents('claude,,codex');
    expect(result).toEqual({ ok: true, value: ['claude', 'codex'] });
  });
});

// ============================================================================
// runInit — Non-interactive (--agent flag)
// ============================================================================

describe('runInit — non-interactive', () => {
  it('should save valid agent and return code 0', async () => {
    let savedKey: string | undefined;
    let savedValue: unknown;
    const deps = makeDeps({
      saveConfig(key, value) {
        savedKey = key;
        savedValue = value;
        return { ok: true };
      },
    });

    const result = await runInit({ agent: 'claude' }, deps);

    expect(result).toEqual({ code: 0, agent: 'claude', status: expect.objectContaining({ provider: 'claude' }) });
    expect(savedKey).toBe('defaultAgent');
    expect(savedValue).toBe('claude');
  });

  it('should reject invalid agent name', async () => {
    const deps = makeDeps();
    const result = await runInit({ agent: 'gpt4' }, deps);

    expect(result).toMatchObject({ code: 1 });
    expect('reason' in result && result.reason).toContain('Unknown agent');
    expect('reason' in result && result.reason).toContain('gpt4');
  });

  it('should return code 1 on save failure', async () => {
    const deps = makeDeps({
      saveConfig: () => ({ ok: false, error: 'Disk full' }),
    });

    const result = await runInit({ agent: 'codex' }, deps);

    expect(result).toEqual({ code: 1, reason: 'Disk full' });
  });

  it('should accept all valid providers', async () => {
    for (const provider of AGENT_PROVIDERS) {
      const deps = makeDeps();
      const result = await runInit({ agent: provider }, deps);
      expect(result).toEqual({ code: 0, agent: provider, status: expect.objectContaining({ provider }) });
    }
  });
});

// ============================================================================
// runInit — Non-TTY guard
// ============================================================================

describe('runInit — non-TTY', () => {
  it('should return error with hint when no --agent and not TTY', async () => {
    const deps = makeDeps({ isTTY: false });
    const result = await runInit({}, deps);

    expect(result).toMatchObject({ code: 1 });
    expect('reason' in result && result.reason).toContain('No TTY');
    expect('reason' in result && result.reason).toContain('--agent');
  });

  it('should work non-interactively even without TTY when --agent is provided', async () => {
    const deps = makeDeps({ isTTY: false });
    const result = await runInit({ agent: 'claude' }, deps);

    expect(result).toEqual({ code: 0, agent: 'claude', status: expect.objectContaining({ provider: 'claude' }) });
  });
});

// ============================================================================
// runInit — Interactive
// ============================================================================

describe('runInit — interactive', () => {
  it('should prompt to reconfigure when defaultAgent already set', async () => {
    let confirmCalled = false;
    let confirmArg: AgentProvider | undefined;

    const deps = makeDeps({
      loadConfig: () => ({ defaultAgent: 'claude' }),
      async confirmReconfigure(existing) {
        confirmCalled = true;
        confirmArg = existing;
        return true;
      },
    });

    await runInit({}, deps);

    expect(confirmCalled).toBe(true);
    expect(confirmArg).toBe('claude');
  });

  it('should skip reconfigure prompt with --yes', async () => {
    let confirmCalled = false;

    const deps = makeDeps({
      loadConfig: () => ({ defaultAgent: 'claude' }),
      async confirmReconfigure() {
        confirmCalled = true;
        return true;
      },
    });

    await runInit({ yes: true }, deps);

    expect(confirmCalled).toBe(false);
  });

  it('should return "Configuration unchanged" when user declines reconfigure', async () => {
    const deps = makeDeps({
      loadConfig: () => ({ defaultAgent: 'claude' }),
      confirmReconfigure: async () => false,
    });

    const result = await runInit({}, deps);

    expect(result).toEqual({ code: 0, reason: 'Configuration unchanged.' });
  });

  it('should return "Setup cancelled" when user cancels confirm', async () => {
    const deps = makeDeps({
      loadConfig: () => ({ defaultAgent: 'claude' }),
      confirmReconfigure: async () => 'cancelled',
    });

    const result = await runInit({}, deps);

    expect(result).toEqual({ code: 0, reason: 'Setup cancelled.' });
  });

  it('should return "Setup cancelled" when user cancels select', async () => {
    const deps = makeDeps({
      selectAgent: async () => 'cancelled',
    });

    const result = await runInit({}, deps);

    expect(result).toEqual({ code: 0, reason: 'Setup cancelled.' });
  });

  it('should save selected agent and return code 0', async () => {
    let savedAgent: unknown;

    const deps = makeDeps({
      selectAgent: async () => 'codex',
      saveConfig(key, value) {
        if (key === 'defaultAgent') savedAgent = value;
        return { ok: true };
      },
    });

    const result = await runInit({}, deps);

    expect(result).toEqual({ code: 0, agent: 'codex', status: expect.objectContaining({ provider: 'codex' }) });
    expect(savedAgent).toBe('codex');
  });

  it('should pass auth statuses to selectAgent', async () => {
    let receivedStatuses: readonly AgentAuthStatus[] = [];

    const deps = makeDeps({
      checkAuth: (provider) => makeStatus(provider, provider === 'claude'),
      async selectAgent(statuses) {
        receivedStatuses = statuses;
        return 'claude';
      },
    });

    await runInit({}, deps);

    expect(receivedStatuses).toHaveLength(AGENT_PROVIDERS.length);
    const claudeStatus = receivedStatuses.find((s) => s.provider === 'claude');
    const codexStatus = receivedStatuses.find((s) => s.provider === 'codex');
    expect(claudeStatus?.ready).toBe(true);
    expect(codexStatus?.ready).toBe(false);
  });

  it('should handle save failure in interactive mode', async () => {
    const deps = makeDeps({
      selectAgent: async () => 'codex',
      saveConfig: () => ({ ok: false, error: 'Permission denied' }),
    });

    const result = await runInit({}, deps);

    expect(result).toEqual({ code: 1, reason: 'Permission denied' });
  });
});

// ============================================================================
// runInit — Skill Install (interactive)
// ============================================================================

describe('runInit — skill install (interactive)', () => {
  it('should install skills after agent selection', async () => {
    let copiedAgents: readonly AgentProvider[] | undefined;
    let copiedRoot: string | undefined;

    const deps = makeSkillDeps({
      copySkills(agents, projectRoot) {
        copiedAgents = agents;
        copiedRoot = projectRoot;
        return { ok: true, value: ['/project/.claude/skills/autobeat'] };
      },
    });

    const result = await runInit({}, deps);

    expect(result).toMatchObject({ code: 0, agent: 'claude' });
    expect('skillPaths' in result && result.skillPaths).toEqual(['/project/.claude/skills/autobeat']);
    expect(copiedAgents).toEqual(['claude']);
    expect(copiedRoot).toBe(process.cwd());
  });

  it('should pass default agent to selectSkillAgents', async () => {
    let receivedDefault: AgentProvider | undefined;

    const deps = makeSkillDeps({
      selectAgent: async () => 'codex',
      async selectSkillAgents(defaultAgent) {
        receivedDefault = defaultAgent;
        return ['codex'];
      },
    });

    await runInit({}, deps);

    expect(receivedDefault).toBe('codex');
  });

  it('should skip skill install when user declines confirm', async () => {
    let copyCalled = false;

    const deps = makeSkillDeps({
      confirmSkillInstall: async () => false,
      copySkills() {
        copyCalled = true;
        return { ok: true, value: [] };
      },
    });

    const result = await runInit({}, deps);

    expect(copyCalled).toBe(false);
    expect(result).toMatchObject({ code: 0, agent: 'claude' });
    expect('skillPaths' in result).toBe(false);
  });

  it('should handle cancelled skill agent selection', async () => {
    const deps = makeSkillDeps({
      selectSkillAgents: async () => 'cancelled',
    });

    const result = await runInit({}, deps);

    // Agent selection succeeded, skill cancelled — returns agent result without skills
    expect(result).toMatchObject({ code: 0, agent: 'claude' });
    expect('skillPaths' in result).toBe(false);
  });

  it('should handle cancelled skill confirm', async () => {
    const deps = makeSkillDeps({
      confirmSkillInstall: async () => 'cancelled',
    });

    const result = await runInit({}, deps);

    expect(result).toMatchObject({ code: 0, agent: 'claude' });
    expect('skillPaths' in result).toBe(false);
  });

  it('should prompt for update when skills already exist', async () => {
    let updatePrompted = false;

    const deps = makeSkillDeps({
      skillsExist: () => true,
      async confirmSkillUpdate() {
        updatePrompted = true;
        return true;
      },
    });

    const result = await runInit({}, deps);

    expect(updatePrompted).toBe(true);
    expect(result).toMatchObject({ code: 0, agent: 'claude', skillPaths: expect.any(Array) });
  });

  it('should skip update when user declines', async () => {
    let copyCalled = false;

    const deps = makeSkillDeps({
      skillsExist: () => true,
      confirmSkillUpdate: async () => false,
      copySkills() {
        copyCalled = true;
        return { ok: true, value: [] };
      },
    });

    const result = await runInit({}, deps);

    expect(copyCalled).toBe(false);
    expect(result).toMatchObject({ code: 0, agent: 'claude' });
  });

  it('should install for multiple agents', async () => {
    let copiedAgents: readonly AgentProvider[] | undefined;

    const deps = makeSkillDeps({
      selectSkillAgents: async () => ['claude', 'codex'],
      copySkills(agents) {
        copiedAgents = agents;
        return {
          ok: true,
          value: ['/project/.claude/skills/autobeat', '/project/.agents/skills/autobeat'],
        };
      },
    });

    const result = await runInit({}, deps);

    expect(copiedAgents).toEqual(['claude', 'codex']);
    expect('skillPaths' in result && result.skillPaths).toHaveLength(2);
  });

  it('should return error when copy fails', async () => {
    const deps = makeSkillDeps({
      copySkills: () => ({ ok: false, error: 'EACCES: permission denied' }),
    });

    const result = await runInit({}, deps);

    expect(result).toEqual({ code: 1, reason: 'EACCES: permission denied' });
  });
});

// ============================================================================
// runInit — Skill Install (non-interactive)
// ============================================================================

describe('runInit — skill install (non-interactive)', () => {
  it('should install skills with --agent --install-skills', async () => {
    let copiedAgents: readonly AgentProvider[] | undefined;

    const deps = makeSkillDeps({
      isTTY: false,
      copySkills(agents) {
        copiedAgents = agents;
        return { ok: true, value: ['/project/.claude/skills/autobeat'] };
      },
    });

    const result = await runInit({ agent: 'claude', installSkills: true }, deps);

    expect(copiedAgents).toEqual(['claude']);
    expect(result).toMatchObject({ code: 0, agent: 'claude', skillPaths: ['/project/.claude/skills/autobeat'] });
  });

  it('should install for explicit agents with --skills-agents', async () => {
    let copiedAgents: readonly AgentProvider[] | undefined;

    const deps = makeSkillDeps({
      isTTY: false,
      copySkills(agents) {
        copiedAgents = agents;
        return { ok: true, value: ['/project/.claude/skills/autobeat', '/project/.agents/skills/autobeat'] };
      },
    });

    const result = await runInit({ agent: 'claude', installSkills: true, skillsAgents: 'claude,codex' }, deps);

    expect(copiedAgents).toEqual(['claude', 'codex']);
    expect(result).toMatchObject({ code: 0, agent: 'claude', skillPaths: expect.any(Array) });
  });

  it('should reject invalid --skills-agents', async () => {
    const deps = makeSkillDeps({ isTTY: false });

    const result = await runInit({ agent: 'claude', installSkills: true, skillsAgents: 'claude,gpt4' }, deps);

    expect(result).toMatchObject({ code: 1 });
    expect('reason' in result && result.reason).toContain('gpt4');
  });

  it('should not install skills without --install-skills', async () => {
    let copyCalled = false;

    const deps = makeSkillDeps({
      isTTY: false,
      copySkills() {
        copyCalled = true;
        return { ok: true, value: [] };
      },
    });

    const result = await runInit({ agent: 'claude' }, deps);

    expect(copyCalled).toBe(false);
    expect(result).toMatchObject({ code: 0, agent: 'claude' });
    expect('skillPaths' in result).toBe(false);
  });

  it('should auto-update with --yes when skills exist', async () => {
    let updatePrompted = false;
    let copyCalled = false;

    const deps = makeSkillDeps({
      isTTY: false,
      skillsExist: () => true,
      async confirmSkillUpdate() {
        updatePrompted = true;
        return true;
      },
      copySkills() {
        copyCalled = true;
        return { ok: true, value: ['/project/.claude/skills/autobeat'] };
      },
    });

    const result = await runInit({ agent: 'claude', installSkills: true, yes: true }, deps);

    // --yes skips the update prompt
    expect(updatePrompted).toBe(false);
    expect(copyCalled).toBe(true);
    expect(result).toMatchObject({ code: 0, agent: 'claude', skillPaths: expect.any(Array) });
  });
});

// ============================================================================
// AGENT_SKILL_DIRS
// ============================================================================

describe('AGENT_SKILL_DIRS', () => {
  it('should map Claude to .claude/skills/autobeat', () => {
    expect(AGENT_SKILL_DIRS.claude).toEqual(['.claude/skills/autobeat']);
  });

  it('should map Codex to .agents/skills/autobeat', () => {
    expect(AGENT_SKILL_DIRS.codex).toEqual(['.agents/skills/autobeat']);
  });

  it('should have non-empty entries for all providers', () => {
    for (const provider of AGENT_PROVIDERS) {
      expect(AGENT_SKILL_DIRS[provider].length).toBeGreaterThan(0);
    }
  });
});

// ============================================================================
// getSkillTargetDirs
// ============================================================================

describe('getSkillTargetDirs', () => {
  it('should return correct absolute path for single agent', () => {
    const dirs = getSkillTargetDirs(['claude'], '/project');
    expect(dirs).toEqual(['/project/.claude/skills/autobeat']);
  });

  it('should deduplicate when two agents share the same dir', () => {
    const dirs = getSkillTargetDirs(['claude', 'codex'], '/project');
    expect(dirs).toHaveLength(2);
    expect(dirs).toContain('/project/.claude/skills/autobeat');
    expect(dirs).toContain('/project/.agents/skills/autobeat');
  });

  it('should return 2 unique dirs for all supported agents', () => {
    const dirs = getSkillTargetDirs(['claude', 'codex'], '/project');
    expect(dirs).toHaveLength(2);
    expect(new Set(dirs).size).toBe(2);
  });

  it('should return empty array for empty agents', () => {
    expect(getSkillTargetDirs([], '/project')).toEqual([]);
  });
});

// ============================================================================
// defaultSkillsExist
// ============================================================================

describe('defaultSkillsExist', () => {
  it('should return false for non-existent project path', () => {
    expect(defaultSkillsExist(['claude'], '/nonexistent/path/that/does/not/exist')).toBe(false);
  });
});

// ============================================================================
// configureAgentHook
// ============================================================================

let hookTmpDir = '';

beforeAll(() => {
  hookTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-init-hook-'));
});

afterAll(() => {
  if (hookTmpDir) {
    try {
      fs.rmSync(hookTmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

afterEach(() => {
  // Clean per-test subdirs
  try {
    const entries = fs.readdirSync(hookTmpDir);
    for (const entry of entries) {
      const full = path.join(hookTmpDir, entry);
      if (fs.statSync(full).isDirectory()) {
        fs.rmSync(full, { recursive: true, force: true });
      } else {
        fs.unlinkSync(full);
      }
    }
  } catch {
    /* ignore */
  }
});

/** Build an injectable HookConfigDeps backed by real filesystem in a tmpDir. */
function makeHookDeps(): HookConfigDeps {
  return {
    readFile(filePath: string): string | null {
      try {
        return fs.readFileSync(filePath, 'utf-8');
      } catch {
        return null;
      }
    },
    writeFile(filePath: string, content: string): void {
      fs.writeFileSync(filePath, content, { encoding: 'utf-8' });
    },
    renameFile(from: string, to: string): void {
      fs.renameSync(from, to);
    },
    ensureDir(dirPath: string): void {
      fs.mkdirSync(dirPath, { recursive: true });
    },
    fileExists(filePath: string): boolean {
      return fs.existsSync(filePath);
    },
    unlinkFile(filePath: string): void {
      fs.unlinkSync(filePath);
    },
  };
}

describe('configureAgentHook', () => {
  it('creates config file with Stop hook when it does not exist', () => {
    const configDir = path.join(hookTmpDir, 'claude-create');
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'settings.json');
    const deps = makeHookDeps();

    const result = configureAgentHook('claude', configPath, deps);

    expect(result.ok).toBe(true);
    expect(fs.existsSync(configPath)).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const hooks = config.hooks as Record<string, unknown>;
    const stopHooks = hooks.Stop as unknown[];
    expect(stopHooks).toHaveLength(1);
    const entry = stopHooks[0] as Record<string, unknown>;
    const innerHooks = entry.hooks as unknown[];
    expect(innerHooks[0]).toEqual({ type: 'command', command: 'autobeat-stop-hook' });
  });

  it('merges hook into existing config without overwriting other hooks', () => {
    const configDir = path.join(hookTmpDir, 'claude-merge');
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'settings.json');
    const deps = makeHookDeps();

    // Pre-populate with existing hooks
    const existing = {
      hooks: {
        PreToolUse: [{ hooks: [{ type: 'command', command: 'my-pre-tool' }] }],
      },
      someOtherSetting: 'value',
    };
    fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n');

    const result = configureAgentHook('claude', configPath, deps);

    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    // Original settings preserved
    expect(config.someOtherSetting).toBe('value');
    // Pre-existing hooks preserved
    const hooks = config.hooks as Record<string, unknown>;
    expect(hooks.PreToolUse).toBeDefined();
    // Stop hook added
    const stopHooks = hooks.Stop as unknown[];
    expect(stopHooks).toHaveLength(1);
  });

  it('is idempotent — second call does not duplicate the hook', () => {
    const configDir = path.join(hookTmpDir, 'claude-idempotent');
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'settings.json');
    const deps = makeHookDeps();

    // First call
    configureAgentHook('claude', configPath, deps);
    // Second call
    const result = configureAgentHook('claude', configPath, deps);

    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const hooks = config.hooks as Record<string, unknown>;
    const stopHooks = hooks.Stop as unknown[];
    // Should still be exactly 1 entry
    expect(stopHooks).toHaveLength(1);
  });

  it('creates a .bak backup before first modification', () => {
    const configDir = path.join(hookTmpDir, 'claude-backup');
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'settings.json');
    const deps = makeHookDeps();

    // Pre-populate so there is an original to backup
    const original = { existingSetting: 'original' };
    fs.writeFileSync(configPath, JSON.stringify(original, null, 2) + '\n');

    configureAgentHook('claude', configPath, deps);

    // Backup should exist with original content
    const backupPath = configPath + '.bak';
    expect(fs.existsSync(backupPath)).toBe(true);
    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf-8')) as Record<string, unknown>;
    expect(backup.existingSetting).toBe('original');
  });

  it('does not overwrite existing .bak on repeated calls', () => {
    const configDir = path.join(hookTmpDir, 'claude-backup-no-overwrite');
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'settings.json');
    const deps = makeHookDeps();

    // Write a settings file and take a first backup
    fs.writeFileSync(configPath, JSON.stringify({ version: 1 }) + '\n');
    configureAgentHook('claude', configPath, deps);
    const backupPath = configPath + '.bak';
    const backupAfterFirst = fs.readFileSync(backupPath, 'utf-8');

    // Simulate someone modifying the settings after initial backup
    fs.writeFileSync(configPath, JSON.stringify({ version: 2 }) + '\n');
    configureAgentHook('claude', configPath, deps); // hook already present — no-op

    // Backup should not be overwritten
    const backupAfterSecond = fs.readFileSync(backupPath, 'utf-8');
    expect(backupAfterSecond).toBe(backupAfterFirst);
  });

  it('no .tmp file remains after successful write', () => {
    const configDir = path.join(hookTmpDir, 'claude-atomic');
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'settings.json');
    const deps = makeHookDeps();

    configureAgentHook('claude', configPath, deps);

    expect(fs.existsSync(configPath + '.tmp')).toBe(false);
  });

  it('returns error for invalid JSON in existing config file', () => {
    const configDir = path.join(hookTmpDir, 'claude-invalid-json');
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'settings.json');
    const deps = makeHookDeps();

    fs.writeFileSync(configPath, 'not valid json {{{');

    const result = configureAgentHook('claude', configPath, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('invalid JSON');
    }
  });

  it('works for codex agent type', () => {
    const configDir = path.join(hookTmpDir, 'codex-create');
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'hooks.json');
    const deps = makeHookDeps();

    const result = configureAgentHook('codex', configPath, deps);

    expect(result.ok).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const hooks = config.hooks as Record<string, unknown>;
    expect(hooks.Stop).toBeDefined();
  });

  it('returns err() when writeFile throws — no unhandled exception propagates', () => {
    const configDir = path.join(hookTmpDir, 'claude-write-throws');
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'settings.json');
    const deps: HookConfigDeps = {
      ...makeHookDeps(),
      writeFile(_filePath: string, _content: string): void {
        throw new Error('ENOSPC: no space left on device');
      },
    };

    const result = configureAgentHook('claude', configPath, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('ENOSPC');
    }
  });

  it('returns err() when renameFile throws and leaves no orphaned .tmp', () => {
    const configDir = path.join(hookTmpDir, 'claude-rename-throws');
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'settings.json');

    let writtenTmpPath: string | undefined;
    const realDeps = makeHookDeps();
    const deps: HookConfigDeps = {
      ...realDeps,
      writeFile(filePath: string, content: string): void {
        writtenTmpPath = filePath;
        realDeps.writeFile(filePath, content);
      },
      renameFile(_from: string, _to: string): void {
        throw new Error('EXDEV: cross-device link not permitted');
      },
    };

    const result = configureAgentHook('claude', configPath, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('EXDEV');
    }
    // .tmp file should be deleted on rename failure (no orphaned file)
    if (writtenTmpPath) {
      expect(fs.existsSync(writtenTmpPath)).toBe(false);
    }
  });
});

// ============================================================================
// runInit — hook configuration integration
// ============================================================================

describe('runInit — hook configuration', () => {
  it('calls configureHooks after successful agent save (non-interactive path)', async () => {
    const hookResults: HookConfigResult[] = [];
    const deps = makeDeps({
      configureHooks: (agent) => {
        hookResults.push({ agentType: 'claude', ok: true });
        void agent;
        return [{ agentType: 'claude', ok: true }];
      },
    });

    const result = await runInit({ agent: 'claude' }, deps);

    expect(result.code).toBe(0);
    expect(hookResults).toHaveLength(1);
  });

  it('calls configureHooks after successful agent selection (interactive path)', async () => {
    const hookResults: HookConfigResult[] = [];
    const deps = makeDeps({
      isTTY: true,
      selectAgent: async () => 'claude',
      configureHooks: () => {
        hookResults.push({ agentType: 'claude', ok: true });
        return [{ agentType: 'claude', ok: true }];
      },
    });

    const result = await runInit({}, deps);

    expect(result.code).toBe(0);
    expect(hookResults).toHaveLength(1);
  });

  it('does not fail init when configureHooks returns an error result', async () => {
    const deps = makeDeps({
      configureHooks: () => [{ agentType: 'claude', ok: false, error: 'Could not write config' }],
    });

    const result = await runInit({ agent: 'claude' }, deps);

    // Init still succeeds — hook errors are non-fatal warnings
    expect(result.code).toBe(0);
  });

  it('silently skips hook configuration when configureHooks is absent', async () => {
    // No configureHooks in deps — should complete without error
    const deps = makeDeps();

    const result = await runInit({ agent: 'claude' }, deps);

    expect(result.code).toBe(0);
  });
});

// ============================================================================
// AGENT_HOOK_CONFIG_PATHS
// ============================================================================

describe('AGENT_HOOK_CONFIG_PATHS', () => {
  it('claude path ends with .claude/settings.json', () => {
    expect(AGENT_HOOK_CONFIG_PATHS.claude).toContain('.claude');
    expect(AGENT_HOOK_CONFIG_PATHS.claude).toMatch(/settings\.json$/);
  });

  it('codex path ends with .codex/hooks.json', () => {
    expect(AGENT_HOOK_CONFIG_PATHS.codex).toContain('.codex');
    expect(AGENT_HOOK_CONFIG_PATHS.codex).toMatch(/hooks\.json$/);
  });
});
