/**
 * Agent Adapter Tests — Claude, Codex
 *
 * ARCHITECTURE: Tests the provider identity, resolveRuntime, and dispose
 * behavior for each agent adapter. Spawn/kill tests are removed since
 * process-based spawning is replaced by tmux (buildTmuxCommand tests live
 * in build-tmux-command.test.ts).
 *
 * Pattern: child_process.spawnSync is mocked for isCommandInPath checks.
 */

import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../../../src/core/configuration';
import { _testSetConfigDir, saveAgentConfig } from '../../../src/core/configuration';
import { ClaudeAdapter } from '../../../src/implementations/claude-adapter';
import { CodexAdapter } from '../../../src/implementations/codex-adapter';

// Mock child_process.spawn
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  ChildProcess: vi.fn(),
}));

// Mock isCommandInPath from agents.ts (used by resolveAuth in base-agent-adapter)
vi.mock('../../../src/core/agents', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/core/agents')>();
  return {
    ...original,
    isCommandInPath: vi.fn().mockReturnValue(true), // Default: CLI found
  };
});

import { isCommandInPath } from '../../../src/core/agents';

const mockIsCommandInPath = vi.mocked(isCommandInPath);

/** Minimal config for adapter construction */
const testConfig = {
  maxOutputBuffer: 10485760,
  timeout: 300000,
  killGracePeriodMs: 5000,
  cpuCoresReserved: 1,
  memoryReserve: 536870912,
  logLevel: 'info' as const,
  maxListenersPerEvent: 50,
  maxTotalSubscriptions: 500,
};

describe('ClaudeAdapter', () => {
  let adapter: ClaudeAdapter;
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsCommandInPath.mockReturnValue(true);
    adapter = new ClaudeAdapter(testConfig, 'claude');
  });
  afterEach(() => adapter.dispose());

  it('should have provider set to claude', () => {
    expect(adapter.provider).toBe('claude');
  });

  it('dispose() is a no-op without throwing', () => {
    expect(() => adapter.dispose()).not.toThrow();
  });

  it('cleanup() is a no-op without throwing', () => {
    expect(() => adapter.cleanup('task-1')).not.toThrow();
  });
});

describe('CodexAdapter', () => {
  let adapter: CodexAdapter;
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsCommandInPath.mockReturnValue(true);
    adapter = new CodexAdapter(testConfig, 'codex');
  });
  afterEach(() => adapter.dispose());

  it('should have provider set to codex', () => {
    expect(adapter.provider).toBe('codex');
  });

  it('dispose() is a no-op without throwing', () => {
    expect(() => adapter.dispose()).not.toThrow();
  });
});

// ─── Ollama Runtime Integration Tests ────────────────────────────────────────
// Tests for resolveRuntime() — shared configuration resolution used by buildTmuxCommand.
// Placed here (not a separate file) to share the module registry mocks established
// above — isolate:false means each new vi.mock() call creates a new fn instance
// that breaks imports already captured in other test files.

function callResolveRuntime(adapter: ClaudeAdapter | CodexAdapter, config: AgentConfig, taskModel?: string) {
  return (adapter as unknown as { resolveRuntime(c: AgentConfig, m?: string): unknown }).resolveRuntime(
    config,
    taskModel,
  );
}

describe('resolveRuntime', () => {
  let testDir: string;
  let restoreConfig: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsCommandInPath.mockReturnValue(true);
    testDir = path.join(tmpdir(), `autobeat-runtime-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    restoreConfig = _testSetConfigDir(testDir);
  });

  afterEach(() => {
    restoreConfig();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns ok(null) when runtime is not set', () => {
    const adapter = new ClaudeAdapter(testConfig);
    const result = callResolveRuntime(adapter, {});
    expect(result).toEqual({ ok: true, value: null });
    adapter.dispose();
  });

  it('returns ollama config when runtime is ollama for claude', () => {
    const adapter = new ClaudeAdapter(testConfig);
    const result = callResolveRuntime(adapter, { runtime: 'ollama' as const });
    expect(result).toMatchObject({
      ok: true,
      value: {
        command: 'ollama',
        suppressModel: true,
        suppressAuth: true,
        suppressBaseUrl: true,
      },
    });
    adapter.dispose();
  });

  it('returns ollama config when runtime is ollama for codex', () => {
    const adapter = new CodexAdapter(testConfig);
    const result = callResolveRuntime(adapter, { runtime: 'ollama' as const });
    expect(result).toMatchObject({ ok: true, value: { command: 'ollama' } });
    adapter.dispose();
  });

  it('uses taskModel over agentConfig.model in prependArgs', () => {
    const adapter = new ClaudeAdapter(testConfig);
    const result = callResolveRuntime(adapter, { runtime: 'ollama' as const, model: 'config-model' }, 'task-model') as {
      ok: true;
      value: { prependArgs: readonly string[] };
    };
    expect(result.ok).toBe(true);
    expect(result.value.prependArgs).toContain('task-model');
    expect(result.value.prependArgs).not.toContain('config-model');
    adapter.dispose();
  });

  it('uses agentConfig.model when no taskModel provided', () => {
    const adapter = new ClaudeAdapter(testConfig);
    const result = callResolveRuntime(adapter, {
      runtime: 'ollama' as const,
      model: 'config-model',
    }) as { ok: true; value: { prependArgs: readonly string[] } };
    expect(result.ok).toBe(true);
    expect(result.value.prependArgs).toContain('config-model');
    adapter.dispose();
  });

  it('omits --model from prependArgs when neither model source is set', () => {
    const adapter = new ClaudeAdapter(testConfig);
    const result = callResolveRuntime(adapter, { runtime: 'ollama' as const }) as {
      ok: true;
      value: { prependArgs: readonly string[] };
    };
    expect(result.ok).toBe(true);
    expect(result.value.prependArgs).not.toContain('--model');
    adapter.dispose();
  });

  it('returns err for unsupported runtime', () => {
    const adapter = new ClaudeAdapter(testConfig);
    // biome-ignore lint/suspicious/noExplicitAny: testing with an intentionally invalid runtime
    const result = callResolveRuntime(adapter, { runtime: 'unsupported' as any }) as {
      ok: false;
      error: { code: string };
    };
    expect(result.ok).toBe(false);
    adapter.dispose();
  });
});
