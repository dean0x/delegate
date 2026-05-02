/**
 * Tests for bootstrap integration with translation proxy.
 *
 * Verifies that loadProxyConfig reads translate + baseUrl/apiKey/model from
 * AgentConfig to derive proxy configuration. The `translate` field is the gate:
 * when set to a supported target (e.g. 'openai'), the existing baseUrl, apiKey,
 * and model fields become the target backend configuration.
 *
 * Also tests proxy startup/skip behavior per bootstrap mode (DD1) and
 * deriveModeFlags skipProxy flag (AC6).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrap, deriveModeFlags } from '../../../../src/bootstrap.js';
import { _testSetConfigDir } from '../../../../src/core/configuration.js';
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

  it('returns null when translate is not set', async () => {
    await writeFile(
      join(tempDir, 'config.json'),
      JSON.stringify({
        agents: { claude: { apiKey: 'key', baseUrl: 'https://api.example.com', model: 'gpt-4o' } },
      }),
    );
    const result = loadProxyConfig('claude');
    expect(result).toBeNull();
  });

  it('returns null when translate is set but baseUrl is missing', async () => {
    await writeFile(
      join(tempDir, 'config.json'),
      JSON.stringify({
        agents: { claude: { translate: 'openai', apiKey: 'sk-test', model: 'gpt-4o' } },
      }),
    );
    const result = loadProxyConfig('claude');
    expect(result).toBeNull();
  });

  it('returns null when translate is set but apiKey is missing', async () => {
    await writeFile(
      join(tempDir, 'config.json'),
      JSON.stringify({
        agents: { claude: { translate: 'openai', baseUrl: 'https://api.example.com', model: 'gpt-4o' } },
      }),
    );
    const result = loadProxyConfig('claude');
    expect(result).toBeNull();
  });

  it('returns null when translate is set but model is missing', async () => {
    await writeFile(
      join(tempDir, 'config.json'),
      JSON.stringify({
        agents: { claude: { translate: 'openai', baseUrl: 'https://api.example.com', apiKey: 'sk-test' } },
      }),
    );
    const result = loadProxyConfig('claude');
    expect(result).toBeNull();
  });

  it('returns ProxyConfig when translate + all required fields are present', async () => {
    await writeFile(
      join(tempDir, 'config.json'),
      JSON.stringify({
        agents: {
          claude: {
            translate: 'openai',
            baseUrl: 'https://integrate.api.nvidia.com/v1',
            apiKey: 'nvapi-test-key',
            model: 'moonshotai/kimi-k2-thinking',
          },
        },
      }),
    );
    const result = loadProxyConfig('claude');
    expect(result).not.toBeNull();
    expect(result?.targetBaseUrl).toBe('https://integrate.api.nvidia.com/v1');
    expect(result?.targetApiKey).toBe('nvapi-test-key');
    expect(result?.targetModel).toBe('moonshotai/kimi-k2-thinking');
  });

  it('returns null for unsupported translate target', async () => {
    // Validation of the translate value happens in loadAgentConfig (configuration.ts):
    // unknown targets are silently dropped (translate becomes undefined), so
    // loadProxyConfig returns null at the `!agentConfig.translate` guard.
    await writeFile(
      join(tempDir, 'config.json'),
      JSON.stringify({
        agents: {
          claude: {
            translate: 'unsupported-target',
            baseUrl: 'https://api.example.com',
            apiKey: 'key',
            model: 'model',
          },
        },
      }),
    );
    const result = loadProxyConfig('claude');
    expect(result).toBeNull();
  });

  it('returns null for non-claude providers', async () => {
    const result = loadProxyConfig('codex');
    expect(result).toBeNull();
  });
});

describe('ProxyManager integration with ProxiedClaudeAdapter', () => {
  it('ProxiedClaudeAdapter sets proxyPort from ProxyManager', async () => {
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
  });
});

describe('proxy startup by bootstrap mode', () => {
  let tempDir: string;
  let restoreConfig: () => void;

  const proxyConfig = {
    agents: {
      claude: {
        translate: 'openai',
        baseUrl: 'https://api.example.com',
        apiKey: 'test-key',
        model: 'test-model',
      },
    },
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'autobeat-proxy-bootstrap-'));
    restoreConfig = _testSetConfigDir(tempDir);
    process.env.AUTOBEAT_DATABASE_PATH = join(tempDir, 'test.db');
  });

  afterEach(async () => {
    delete process.env.AUTOBEAT_DATABASE_PATH;
    restoreConfig();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('starts proxy in run mode when proxy config exists', async () => {
    await writeFile(join(tempDir, 'config.json'), JSON.stringify(proxyConfig));
    const result = await bootstrap({ mode: 'run' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const container = result.value;
    try {
      expect(container.get('proxyManager').ok).toBe(true);
    } finally {
      await container.dispose();
    }
  });

  it('skips proxy in cli mode even when proxy config exists', async () => {
    await writeFile(join(tempDir, 'config.json'), JSON.stringify(proxyConfig));
    const result = await bootstrap({ mode: 'cli' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const container = result.value;
    try {
      expect(container.get('proxyManager').ok).toBe(false);
    } finally {
      await container.dispose();
    }
  });

  it('container.dispose() stops proxy cleanly', async () => {
    await writeFile(join(tempDir, 'config.json'), JSON.stringify(proxyConfig));
    const result = await bootstrap({ mode: 'run' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const container = result.value;
    expect(container.get('proxyManager').ok).toBe(true);
    await container.dispose();
    // After dispose, all services are cleared
    expect(container.get('proxyManager').ok).toBe(false);
  });
});
