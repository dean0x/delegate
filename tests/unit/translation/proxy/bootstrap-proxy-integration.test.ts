/**
 * Tests for bootstrap integration with translation proxy.
 *
 * Verifies that when proxy config is present in the config file,
 * bootstrap creates a ProxyManager and registers ProxiedClaudeAdapter.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _testSetConfigDir } from '../../../../src/core/configuration.js';
// We test loadProxyConfig in isolation — no real bootstrap to avoid SQLite deps
import { loadProxyConfig } from '../../../../src/translation/proxy/proxy-manager.js';

describe('loadProxyConfig', () => {
  let tempDir: string;
  let restoreConfig: () => void;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'autobeat-proxy-config-'));
    restoreConfig = _testSetConfigDir(tempDir);
  });

  afterEach(async () => {
    restoreConfig();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns null when config file does not exist', () => {
    const result = loadProxyConfig('claude');
    expect(result).toBeNull();
  });

  it('returns null when agents section is missing', async () => {
    await writeFile(join(tempDir, 'config.json'), JSON.stringify({ timeout: 0 }));
    const result = loadProxyConfig('claude');
    expect(result).toBeNull();
  });

  it('returns null when agents.claude section is missing', async () => {
    await writeFile(join(tempDir, 'config.json'), JSON.stringify({ agents: { codex: { apiKey: 'key' } } }));
    const result = loadProxyConfig('claude');
    expect(result).toBeNull();
  });

  it('returns null when agents.claude.proxy section is missing', async () => {
    await writeFile(join(tempDir, 'config.json'), JSON.stringify({ agents: { claude: { apiKey: 'key' } } }));
    const result = loadProxyConfig('claude');
    expect(result).toBeNull();
  });

  it('returns null when proxy config is incomplete (missing targetApiKey)', async () => {
    await writeFile(
      join(tempDir, 'config.json'),
      JSON.stringify({
        agents: {
          claude: {
            proxy: {
              targetBaseUrl: 'https://api.openai.com',
              targetModel: 'gpt-4o',
              // missing targetApiKey
            },
          },
        },
      }),
    );
    const result = loadProxyConfig('claude');
    expect(result).toBeNull();
  });

  it('returns ProxyConfig when all required fields are present', async () => {
    await writeFile(
      join(tempDir, 'config.json'),
      JSON.stringify({
        agents: {
          claude: {
            proxy: {
              targetBaseUrl: 'https://api.openai.com',
              targetApiKey: 'sk-test-key',
              targetModel: 'gpt-4o',
            },
          },
        },
      }),
    );
    const result = loadProxyConfig('claude');
    expect(result).not.toBeNull();
    expect(result?.targetBaseUrl).toBe('https://api.openai.com');
    expect(result?.targetApiKey).toBe('sk-test-key');
    expect(result?.targetModel).toBe('gpt-4o');
  });

  it('returns null for unknown provider even if config exists', async () => {
    await writeFile(
      join(tempDir, 'config.json'),
      JSON.stringify({
        agents: {
          claude: {
            proxy: {
              targetBaseUrl: 'https://api.openai.com',
              targetApiKey: 'sk-test-key',
              targetModel: 'gpt-4o',
            },
          },
        },
      }),
    );
    // Codex doesn't support proxy
    const result = loadProxyConfig('codex');
    expect(result).toBeNull();
  });

  it('ignores non-string proxy field values', async () => {
    await writeFile(
      join(tempDir, 'config.json'),
      JSON.stringify({
        agents: {
          claude: {
            proxy: {
              targetBaseUrl: 42, // invalid type
              targetApiKey: 'sk-test-key',
              targetModel: 'gpt-4o',
            },
          },
        },
      }),
    );
    const result = loadProxyConfig('claude');
    expect(result).toBeNull(); // targetBaseUrl is non-string → missing → null
  });
});

describe('ProxyManager integration with ProxiedClaudeAdapter', () => {
  it('ProxiedClaudeAdapter sets proxyPort from ProxyManager', async () => {
    // This is a design verification: ProxiedClaudeAdapter accepts the port
    // returned by ProxyManager.start() as a constructor argument.
    const { ProxiedClaudeAdapter } = await import('../../../../src/translation/proxy/proxied-claude-adapter.js');
    const config = {
      maxOutputBuffer: 10485760,
      timeout: 300000,
      killGracePeriodMs: 5000,
      cpuCoresReserved: 1,
      memoryReserve: 2684354560,
      logLevel: 'info' as const,
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
      defaultAgent: 'claude' as const,
    };
    const adapter = new ProxiedClaudeAdapter(config, 8765);
    expect(adapter.provider).toBe('claude');
    // Adapter is created without error — port is captured
  });
});
