/**
 * Tests for `beat init` command
 *
 * ARCHITECTURE: Tests runInit() and parseInitArgs() with injected deps.
 * No vi.mock() — all interactive prompts are plain function injections via InitDeps.
 */

import { describe, expect, it } from 'vitest';
import type { InitDeps, InitOptions } from '../../src/cli/commands/init';
import { parseInitArgs, runInit } from '../../src/cli/commands/init';
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
    expect(parseInitArgs(['-a', 'gemini', '-y'])).toEqual({ agent: 'gemini', yes: true });
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
      selectAgent: async () => 'gemini',
      saveConfig(key, value) {
        if (key === 'defaultAgent') savedAgent = value;
        return { ok: true };
      },
    });

    const result = await runInit({}, deps);

    expect(result).toEqual({ code: 0, agent: 'gemini', status: expect.objectContaining({ provider: 'gemini' }) });
    expect(savedAgent).toBe('gemini');
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
