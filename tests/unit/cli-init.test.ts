/**
 * Tests for `beat init` command
 *
 * ARCHITECTURE: Tests runInit() and parseInitArgs() with injected deps.
 * No vi.mock() — all interactive prompts are plain function injections via InitDeps.
 */

import { describe, expect, it } from 'vitest';
import type { InitDeps, InitOptions } from '../../src/cli/commands/init';
import {
  AGENT_SKILL_DIRS,
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
          value: [
            '/project/.claude/skills/autobeat',
            '/project/.agents/skills/autobeat',
          ],
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

  it('should return 2 unique dirs for all agents', () => {
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
