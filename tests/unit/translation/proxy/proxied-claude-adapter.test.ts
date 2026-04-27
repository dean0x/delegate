/**
 * Tests for ProxiedClaudeAdapter — Claude adapter that routes through translation proxy.
 *
 * ARCHITECTURE: Tests the resolveBaseUrl override behavior without spawning real processes.
 * Uses a test subclass to expose the protected method, avoiding child_process mock issues
 * with vitest isolate: false (prior test files in this directory load child_process unmocked).
 *
 * Full spawn integration (args, env, flags) is tested in agent-adapters.test.ts which
 * has its own child_process mock established before any imports.
 */
import { describe, expect, it } from 'vitest';
import type { AgentConfig, Configuration } from '../../../../src/core/configuration.js';
import { ProxiedClaudeAdapter } from '../../../../src/translation/proxy/proxied-claude-adapter.js';

/**
 * Expose protected methods for testing.
 * DECISION: Subclass exposure chosen over child_process mocking due to isolate:false constraint.
 */
class TestableProxiedClaudeAdapter extends ProxiedClaudeAdapter {
  testResolveBaseUrl(agentConfig: AgentConfig): Record<string, string> {
    return this.resolveBaseUrl(agentConfig);
  }

  testResolveModel(agentConfig: AgentConfig, taskModel?: string): string | undefined {
    return this.resolveModel(agentConfig, taskModel);
  }

  testResolveAuth(agentConfig: AgentConfig) {
    return this.resolveAuth(agentConfig);
  }
}

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
  it('has provider = claude', () => {
    const adapter = new ProxiedClaudeAdapter(testConfig, 9876);
    expect(adapter.provider).toBe('claude');
  });

  it('resolveBaseUrl returns ANTHROPIC_BASE_URL pointing to proxy port', () => {
    const adapter = new TestableProxiedClaudeAdapter(testConfig, 9876);
    const env = adapter.testResolveBaseUrl({});
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:9876');
  });

  it('resolveBaseUrl injects CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1', () => {
    const adapter = new TestableProxiedClaudeAdapter(testConfig, 9876);
    const env = adapter.testResolveBaseUrl({});
    expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe('1');
  });

  it('resolveBaseUrl ignores config-level baseUrl — proxy URL takes precedence', () => {
    const adapter = new TestableProxiedClaudeAdapter(testConfig, 12345);
    const env = adapter.testResolveBaseUrl({ baseUrl: 'https://custom.api.com' });
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:12345');
  });

  it('resolveBaseUrl returns exactly two entries (base URL + beta disable)', () => {
    const adapter = new TestableProxiedClaudeAdapter(testConfig, 9876);
    const env = adapter.testResolveBaseUrl({});
    expect(Object.keys(env)).toHaveLength(2);
    expect(Object.keys(env).sort()).toEqual(['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS']);
  });

  it('uses the exact port passed to constructor', () => {
    const adapter1 = new TestableProxiedClaudeAdapter(testConfig, 3000);
    const adapter2 = new TestableProxiedClaudeAdapter(testConfig, 54321);
    expect(adapter1.testResolveBaseUrl({}).ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:3000');
    expect(adapter2.testResolveBaseUrl({}).ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:54321');
  });

  it('resolveModel suppresses config model — proxy handles model mapping', () => {
    const adapter = new TestableProxiedClaudeAdapter(testConfig, 9876);
    expect(adapter.testResolveModel({ model: 'deepseek-ai/deepseek-r1' })).toBeUndefined();
  });

  it('resolveModel preserves per-task model override', () => {
    const adapter = new TestableProxiedClaudeAdapter(testConfig, 9876);
    expect(adapter.testResolveModel({ model: 'deepseek-ai/deepseek-r1' }, 'claude-sonnet-4-20250514')).toBe(
      'claude-sonnet-4-20250514',
    );
  });

  it('resolveModel returns undefined when no config model and no task model', () => {
    const adapter = new TestableProxiedClaudeAdapter(testConfig, 9876);
    expect(adapter.testResolveModel({})).toBeUndefined();
  });

  it('resolveAuth suppresses backend API key — proxy handles auth', () => {
    const adapter = new TestableProxiedClaudeAdapter(testConfig, 9876);
    const result = adapter.testResolveAuth({ apiKey: 'nvapi-some-nvidia-key' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.injectedEnv).toEqual({});
    }
  });

  it('resolveAuth returns empty env even with no config key', () => {
    const adapter = new TestableProxiedClaudeAdapter(testConfig, 9876);
    const result = adapter.testResolveAuth({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.injectedEnv).toEqual({});
    }
  });
});
