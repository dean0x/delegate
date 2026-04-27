/**
 * Tests for ProxyManager — lifecycle management of TranslationProxy instances
 */
import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../../src/core/interfaces.js';
import type { ProxyConfig } from '../../../../src/translation/proxy/proxy-manager.js';
import { ProxyManager } from '../../../../src/translation/proxy/proxy-manager.js';

/**
 * Create a minimal test logger that captures log calls
 */
function makeTestLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

/**
 * A real HTTP server that acts as a minimal OpenAI-compatible backend.
 * Returns a 200 JSON response for all requests.
 */
function makeOpenAIBackend(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}') as Record<string, unknown>;
        // Return a minimal OpenAI-format response
        const response = {
          id: 'chatcmpl-test',
          object: 'chat.completion',
          model: (parsed.model as string | undefined) ?? 'gpt-4o',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Hello from test backend' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((res2) => {
            server.close(() => res2());
          }),
      });
    });
  });
}

describe('ProxyManager', () => {
  let backend: { url: string; close: () => Promise<void> };
  let manager: ProxyManager;

  beforeEach(async () => {
    backend = await makeOpenAIBackend();
  });

  afterEach(async () => {
    if (manager) {
      await manager.stop();
    }
    await backend.close();
  });

  it('starts and returns a valid local port', async () => {
    const config: ProxyConfig = {
      targetBaseUrl: backend.url,
      targetApiKey: 'test-key',
      targetModel: 'gpt-4o',
    };
    manager = new ProxyManager(config, makeTestLogger());
    const result = await manager.start();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok');
    expect(result.value.port).toBeGreaterThan(0);
    expect(result.value.port).toBeLessThan(65536);
  });

  it('returns proxyUrl in http://127.0.0.1:<port> format', async () => {
    const config: ProxyConfig = {
      targetBaseUrl: backend.url,
      targetApiKey: 'test-key',
      targetModel: 'gpt-4o',
    };
    manager = new ProxyManager(config, makeTestLogger());
    const result = await manager.start();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok');
    expect(result.value.proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('returns same port on repeated calls to start()', async () => {
    const config: ProxyConfig = {
      targetBaseUrl: backend.url,
      targetApiKey: 'test-key',
      targetModel: 'gpt-4o',
    };
    manager = new ProxyManager(config, makeTestLogger());
    const r1 = await manager.start();
    const r2 = await manager.start();
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) throw new Error('Expected ok');
    expect(r1.value.port).toBe(r2.value.port);
  });

  it('stop() is idempotent (no error on double-stop)', async () => {
    const config: ProxyConfig = {
      targetBaseUrl: backend.url,
      targetApiKey: 'test-key',
      targetModel: 'gpt-4o',
    };
    manager = new ProxyManager(config, makeTestLogger());
    await manager.start();
    await expect(manager.stop()).resolves.not.toThrow();
    await expect(manager.stop()).resolves.not.toThrow();
  });

  it('proxyUrl is undefined before start()', () => {
    const config: ProxyConfig = {
      targetBaseUrl: backend.url,
      targetApiKey: 'test-key',
      targetModel: 'gpt-4o',
    };
    manager = new ProxyManager(config, makeTestLogger());
    expect(manager.proxyUrl).toBeUndefined();
  });

  it('proxyUrl is set after start()', async () => {
    const config: ProxyConfig = {
      targetBaseUrl: backend.url,
      targetApiKey: 'test-key',
      targetModel: 'gpt-4o',
    };
    manager = new ProxyManager(config, makeTestLogger());
    await manager.start();
    expect(manager.proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('proxyUrl is cleared after stop()', async () => {
    const config: ProxyConfig = {
      targetBaseUrl: backend.url,
      targetApiKey: 'test-key',
      targetModel: 'gpt-4o',
    };
    manager = new ProxyManager(config, makeTestLogger());
    await manager.start();
    expect(manager.proxyUrl).toBeDefined();
    await manager.stop();
    expect(manager.proxyUrl).toBeUndefined();
  });
});

describe('ProxyManager with loadProxyConfig', () => {
  it('loadProxyConfig returns null when no proxy config', async () => {
    const { loadProxyConfig } = await import('../../../../src/translation/proxy/proxy-manager.js');
    // No config file in test env — should return null
    const result = loadProxyConfig('claude');
    expect(result).toBeNull();
  });
});
