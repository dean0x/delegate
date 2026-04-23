/**
 * Tests for ProxiedClaudeAdapter — Claude adapter that routes through translation proxy
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Configuration } from '../../../../src/core/configuration.js';
import { ProxiedClaudeAdapter } from '../../../../src/translation/proxy/proxied-claude-adapter.js';

// Mock child_process.spawn so no real processes are spawned
vi.mock('child_process', () => ({
  spawn: vi.fn().mockReturnValue({
    pid: 12345,
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
  }),
  spawnSync: vi.fn(),
  ChildProcess: vi.fn(),
}));

// Mock isCommandInPath to return true so adapter doesn't fail at binary check
vi.mock('../../../../src/core/agents.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../src/core/agents.js')>();
  return {
    ...original,
    isCommandInPath: vi.fn().mockReturnValue(true),
  };
});

const testConfig: Configuration = {
  maxOutputBuffer: 10485760,
  timeout: 300000,
  killGracePeriodMs: 5000,
  cpuCoresReserved: 1,
  memoryReserve: 2684354560,
  logLevel: 'info',
  maxListenersPerEvent: 100,
  maxTotalSubscriptions: 1000,
  resourceMonitorIntervalMs: 5000,
  minSpawnDelayMs: 10000,
  settlingWindowMs: 15000,
  fileStorageThresholdBytes: 102400,
  outputFlushIntervalMs: 1000,
  retryInitialDelayMs: 1000,
  retryMaxDelayMs: 30000,
  taskRetentionDays: 7,
  defaultAgent: 'claude',
};

describe('ProxiedClaudeAdapter', () => {
  let mockSpawn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const { spawn } = await import('child_process');
    mockSpawn = vi.mocked(spawn);
    mockSpawn.mockReturnValue({
      pid: 12345,
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('has provider = claude', () => {
    const adapter = new ProxiedClaudeAdapter(testConfig, 9876);
    expect(adapter.provider).toBe('claude');
  });

  it('injects ANTHROPIC_BASE_URL pointing to proxy port', () => {
    const adapter = new ProxiedClaudeAdapter(testConfig, 9876);
    const result = adapter.spawn({
      prompt: 'Hello',
      workingDirectory: '/tmp',
    });
    expect(result.ok).toBe(true);
    const callEnv = mockSpawn.mock.calls[0][2]?.env as Record<string, string>;
    expect(callEnv.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:9876');
  });

  it('injects CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 when proxy is active', () => {
    const adapter = new ProxiedClaudeAdapter(testConfig, 9876);
    adapter.spawn({ prompt: 'Hello', workingDirectory: '/tmp' });
    const callEnv = mockSpawn.mock.calls[0][2]?.env as Record<string, string>;
    expect(callEnv.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe('1');
  });

  it('does not use config-level baseUrl — proxy URL takes precedence', () => {
    // Even if there were a config-level baseUrl, the proxy adapter always uses the proxy port
    const adapter = new ProxiedClaudeAdapter(testConfig, 12345);
    adapter.spawn({ prompt: 'Test', workingDirectory: '/tmp' });
    const callEnv = mockSpawn.mock.calls[0][2]?.env as Record<string, string>;
    expect(callEnv.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:12345');
  });

  it('preserves all standard Claude adapter behaviors (print, skip-permissions flags)', () => {
    const adapter = new ProxiedClaudeAdapter(testConfig, 9876);
    adapter.spawn({ prompt: 'Test prompt', workingDirectory: '/tmp' });
    const callArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(callArgs).toContain('--print');
    expect(callArgs).toContain('--dangerously-skip-permissions');
    expect(callArgs).toContain('--output-format');
    expect(callArgs).toContain('json');
  });

  it('passes model arg when provided', () => {
    const adapter = new ProxiedClaudeAdapter(testConfig, 9876);
    adapter.spawn({ prompt: 'Test', workingDirectory: '/tmp', model: 'claude-opus-4-5' });
    const callArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(callArgs).toContain('--model');
    expect(callArgs).toContain('claude-opus-4-5');
  });
});
