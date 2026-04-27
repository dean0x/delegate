/**
 * Tests for the translation proxy server
 */

import * as http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../../src/core/interfaces.js';
import { AnthropicCodec } from '../../../../src/translation/codecs/anthropic-codec.js';
import { OpenAICodec } from '../../../../src/translation/codecs/openai-codec.js';
import { TranslationProxy } from '../../../../src/translation/proxy/translation-proxy.js';

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function makeBackend(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port });
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

function makeProxy(targetPort: number, logger: Logger) {
  return new TranslationProxy({
    targetBaseUrl: `http://127.0.0.1:${targetPort}/v1`,
    targetApiKey: 'test-api-key-12345',
    targetModel: 'gpt-4o',
    sourceCodec: new AnthropicCodec(),
    targetCodec: new OpenAICodec(),
    middlewareFactory: () => [],
    logger,
  });
}

describe('TranslationProxy', () => {
  const proxies: TranslationProxy[] = [];
  const backendServers: http.Server[] = [];

  afterEach(async () => {
    for (const proxy of proxies) {
      await proxy.stop();
    }
    proxies.length = 0;
    for (const server of backendServers) {
      await closeServer(server);
    }
    backendServers.length = 0;
  });

  it('starts on a random port and returns port in result', async () => {
    const logger = makeLogger();
    const proxy = makeProxy(9999, logger);
    proxies.push(proxy);

    const result = await proxy.start();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.port).toBeGreaterThan(0);
    expect(result.value.port).toBeLessThanOrEqual(65535);
  });

  it('stops cleanly', async () => {
    const logger = makeLogger();
    const proxy = makeProxy(9999, logger);
    proxies.push(proxy);

    await proxy.start();
    await expect(proxy.stop()).resolves.not.toThrow();
  });

  it('handles non-streaming round trip', async () => {
    let capturedBody = '';
    let capturedHeaders: Record<string, string | string[] | undefined> = {};

    const { server: backend, port: backendPort } = await makeBackend(async (req, res) => {
      capturedBody = await readBody(req);
      capturedHeaders = { ...req.headers };
      const responseBody = {
        id: 'chatcmpl-test123',
        model: 'gpt-4o',
        choices: [
          {
            message: { role: 'assistant', content: 'The answer is 42.' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responseBody));
    });
    backendServers.push(backend);

    const logger = makeLogger();
    const proxy = makeProxy(backendPort, logger);
    proxies.push(proxy);

    const startResult = await proxy.start();
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;
    const { port } = startResult.value;

    // Make a request like Claude Code would
    const requestBody = JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'What is the answer?' }],
      max_tokens: 1024,
      stream: false,
    });

    const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(requestBody),
            'x-api-key': 'claude-api-key',
            'anthropic-version': '2023-06-01',
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
        },
      );
      req.on('error', reject);
      req.write(requestBody);
      req.end();
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.type).toBe('message');
    expect(body.role).toBe('assistant');
    // ID should be proxied
    expect(body.id).toContain('msg_proxy_');
    expect(body.content[0].text).toBe('The answer is 42.');

    // Verify backend received correct headers
    expect(capturedHeaders['authorization']).toBe('Bearer test-api-key-12345');
    // Anthropic headers should be stripped
    expect(capturedHeaders['x-api-key']).toBeUndefined();
    expect(capturedHeaders['anthropic-version']).toBeUndefined();

    // Model should be overridden to targetModel
    const sentBody = JSON.parse(capturedBody);
    expect(sentBody.model).toBe('gpt-4o');
  });

  it('strips anthropic-* headers and sets Authorization', async () => {
    let capturedHeaders: Record<string, string | string[] | undefined> = {};

    const { server: backend, port: backendPort } = await makeBackend(async (req, res) => {
      capturedHeaders = { ...req.headers };
      const responseBody = {
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [{ message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responseBody));
    });
    backendServers.push(backend);

    const logger = makeLogger();
    const proxy = makeProxy(backendPort, logger);
    proxies.push(proxy);

    const startResult = await proxy.start();
    if (!startResult.ok) return;
    const { port } = startResult.value;

    const requestBody = JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 512,
    });

    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(requestBody),
            'x-api-key': 'inbound-key-that-must-never-be-forwarded',
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'some-beta-feature',
          },
        },
        (res) => {
          res.resume();
          res.on('end', resolve);
        },
      );
      req.on('error', reject);
      req.write(requestBody);
      req.end();
    });

    // Anthropic-specific headers should be stripped
    expect(capturedHeaders['x-api-key']).toBeUndefined();
    expect(capturedHeaders['anthropic-version']).toBeUndefined();
    expect(capturedHeaders['anthropic-beta']).toBeUndefined();

    // Authorization should be set from config, not from inbound key
    expect(capturedHeaders['authorization']).toBe('Bearer test-api-key-12345');
    expect(capturedHeaders['authorization']).not.toContain('inbound-key-that-must-never-be-forwarded');
  });

  it('maps 401 backend error to Anthropic authentication_error format', async () => {
    const { server: backend, port: backendPort } = await makeBackend(async (req, res) => {
      await readBody(req);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
    });
    backendServers.push(backend);

    const logger = makeLogger();
    const proxy = makeProxy(backendPort, logger);
    proxies.push(proxy);

    const startResult = await proxy.start();
    if (!startResult.ok) return;
    const { port } = startResult.value;

    const requestBody = JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 512,
    });

    const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/v1/messages',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(requestBody) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
        },
      );
      req.on('error', reject);
      req.write(requestBody);
      req.end();
    });

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error.type).toBe('authentication_error');
    expect(body.error.message).toBe('Invalid API key');
    // Must never include API keys in error messages
    expect(response.body).not.toContain('test-api-key-12345');
  });

  it('maps 429 backend error to Anthropic rate_limit_error format', async () => {
    const { server: backend, port: backendPort } = await makeBackend(async (req, res) => {
      await readBody(req);
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '10' });
      res.end(JSON.stringify({ error: { message: 'Rate limit exceeded' } }));
    });
    backendServers.push(backend);

    const logger = makeLogger();
    const proxy = makeProxy(backendPort, logger);
    proxies.push(proxy);

    const startResult = await proxy.start();
    if (!startResult.ok) return;
    const { port } = startResult.value;

    const requestBody = JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 512,
    });

    const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/v1/messages',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(requestBody) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
        },
      );
      req.on('error', reject);
      req.write(requestBody);
      req.end();
    });

    expect(response.statusCode).toBe(429);
    const body = JSON.parse(response.body);
    expect(body.error.type).toBe('rate_limit_error');
    expect(body.error.message).toBe('Rate limit exceeded');
  });

  it('maps 500 backend error to api_error format', async () => {
    const { server: backend, port: backendPort } = await makeBackend(async (req, res) => {
      await readBody(req);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Internal server error' } }));
    });
    backendServers.push(backend);

    const logger = makeLogger();
    const proxy = makeProxy(backendPort, logger);
    proxies.push(proxy);

    const startResult = await proxy.start();
    if (!startResult.ok) return;
    const { port } = startResult.value;

    const requestBody = JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 512,
    });

    const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/v1/messages',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(requestBody) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
        },
      );
      req.on('error', reject);
      req.write(requestBody);
      req.end();
    });

    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.body);
    expect(body.error.type).toBe('api_error');
    expect(body.error.message).toBe('Internal server error');
  });

  it('forwards non-JSON backend error as raw text', async () => {
    const { server: backend, port: backendPort } = await makeBackend(async (req, res) => {
      await readBody(req);
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bad Gateway: upstream timeout');
    });
    backendServers.push(backend);

    const logger = makeLogger();
    const proxy = makeProxy(backendPort, logger);
    proxies.push(proxy);

    const startResult = await proxy.start();
    if (!startResult.ok) return;
    const { port } = startResult.value;

    const requestBody = JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 512,
    });

    const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/v1/messages',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(requestBody) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
        },
      );
      req.on('error', reject);
      req.write(requestBody);
      req.end();
    });

    expect(response.statusCode).toBe(502);
    const body = JSON.parse(response.body);
    expect(body.error.message).toBe('Bad Gateway: upstream timeout');
  });

  it('falls back to generic message on empty error body', async () => {
    const { server: backend, port: backendPort } = await makeBackend(async (req, res) => {
      await readBody(req);
      res.writeHead(500);
      res.end();
    });
    backendServers.push(backend);

    const logger = makeLogger();
    const proxy = makeProxy(backendPort, logger);
    proxies.push(proxy);

    const startResult = await proxy.start();
    if (!startResult.ok) return;
    const { port } = startResult.value;

    const requestBody = JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 512,
    });

    const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/v1/messages',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(requestBody) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
        },
      );
      req.on('error', reject);
      req.write(requestBody);
      req.end();
    });

    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.body);
    expect(body.error.message).toBe('Backend returned error');
  });

  it('truncates long backend error messages', async () => {
    const longMessage = 'x'.repeat(1000);
    const { server: backend, port: backendPort } = await makeBackend(async (req, res) => {
      await readBody(req);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: longMessage } }));
    });
    backendServers.push(backend);

    const logger = makeLogger();
    const proxy = makeProxy(backendPort, logger);
    proxies.push(proxy);

    const startResult = await proxy.start();
    if (!startResult.ok) return;
    const { port } = startResult.value;

    const requestBody = JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 512,
    });

    const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/v1/messages',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(requestBody) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
        },
      );
      req.on('error', reject);
      req.write(requestBody);
      req.end();
    });

    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.body);
    expect(body.error.message.length).toBeLessThanOrEqual(500);
  });

  it('returns 413 for requests over 50MB', async () => {
    const { server: backend, port: backendPort } = await makeBackend(async (req, res) => {
      await readBody(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    backendServers.push(backend);

    const logger = makeLogger();
    const proxy = makeProxy(backendPort, logger);
    proxies.push(proxy);

    const startResult = await proxy.start();
    if (!startResult.ok) return;
    const { port } = startResult.value;

    // Create a 51MB body
    const largeContent = 'x'.repeat(51 * 1024 * 1024);
    const requestBody = JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: largeContent }],
      max_tokens: 512,
    });

    const response = await new Promise<{ statusCode: number }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(requestBody),
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve({ statusCode: res.statusCode ?? 0 }));
        },
      );
      req.on('error', reject);
      req.write(requestBody);
      req.end();
    });

    expect(response.statusCode).toBe(413);
  }, 15000);

  it('returns token count estimate for /v1/messages/count_tokens', async () => {
    const { server: backend, port: backendPort } = await makeBackend(async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    backendServers.push(backend);

    const logger = makeLogger();
    const proxy = makeProxy(backendPort, logger);
    proxies.push(proxy);

    const startResult = await proxy.start();
    if (!startResult.ok) return;
    const { port } = startResult.value;

    const requestBody = JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'Count my tokens' }],
      max_tokens: 512,
    });

    const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/v1/messages/count_tokens',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(requestBody) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
        },
      );
      req.on('error', reject);
      req.write(requestBody);
      req.end();
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(typeof body.input_tokens).toBe('number');
    expect(body.input_tokens).toBeGreaterThan(0);
  });

  it('handles streaming round trip', async () => {
    const { server: backend, port: backendPort } = await makeBackend(async (req, res) => {
      await readBody(req);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const chunks = [
        {
          id: 'chatcmpl-1',
          model: 'gpt-4o',
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
        },
        {
          id: 'chatcmpl-1',
          model: 'gpt-4o',
          choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
        },
        { id: 'chatcmpl-1', model: 'gpt-4o', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        {
          id: 'chatcmpl-1',
          model: 'gpt-4o',
          choices: [],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        },
      ];

      for (const chunk of chunks) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
    backendServers.push(backend);

    const logger = makeLogger();
    const proxy = makeProxy(backendPort, logger);
    proxies.push(proxy);

    const startResult = await proxy.start();
    if (!startResult.ok) return;
    const { port } = startResult.value;

    const requestBody = JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'Stream me' }],
      max_tokens: 512,
      stream: true,
    });

    const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/v1/messages',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(requestBody) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
        },
      );
      req.on('error', reject);
      req.write(requestBody);
      req.end();
    });

    expect(response.statusCode).toBe(200);
    // Should contain Anthropic SSE format
    expect(response.body).toContain('message_start');
    expect(response.body).toContain('message_stop');
    expect(response.body).toContain('Hello');
  });

  describe('error paths', () => {
    it('returns 405 for non-POST requests', async () => {
      const { server: backend, port: backendPort } = await makeBackend((_req, res) => {
        res.writeHead(200);
        res.end('{}');
      });
      backendServers.push(backend);

      const logger = makeLogger();
      const proxy = makeProxy(backendPort, logger);
      proxies.push(proxy);

      const startResult = await proxy.start();
      if (!startResult.ok) return;
      const { port } = startResult.value;

      const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, path: '/v1/messages', method: 'GET' }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject);
        req.end();
      });

      expect(response.statusCode).toBe(405);
      const body = JSON.parse(response.body);
      expect(body.error.type).toBe('invalid_request_error');
    });

    it('responds 200 to HEAD / health check', async () => {
      const { server: backend, port: backendPort } = await makeBackend((_req, res) => {
        res.writeHead(200);
        res.end('{}');
      });
      backendServers.push(backend);

      const logger = makeLogger();
      const proxy = makeProxy(backendPort, logger);
      proxies.push(proxy);

      const startResult = await proxy.start();
      if (!startResult.ok) return;
      const { port } = startResult.value;

      const response = await new Promise<{ statusCode: number }>((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, path: '/', method: 'HEAD' }, (res) => {
          resolve({ statusCode: res.statusCode ?? 0 });
        });
        req.on('error', reject);
        req.end();
      });

      expect(response.statusCode).toBe(200);
    });

    it('routes /v1/messages?beta=true to messages handler (strips query string)', async () => {
      const { server: backend, port: backendPort } = await makeBackend((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-test',
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
          }),
        );
      });
      backendServers.push(backend);

      const logger = makeLogger();
      const proxy = makeProxy(backendPort, logger);
      proxies.push(proxy);

      const startResult = await proxy.start();
      if (!startResult.ok) return;
      const { port } = startResult.value;

      const body = JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 100,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      });

      const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/v1/messages?beta=true',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'anthropic-version': '2023-06-01',
              'Content-Length': Buffer.byteLength(body),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
          },
        );
        req.on('error', reject);
        req.write(body);
        req.end();
      });

      expect(response.statusCode).toBe(200);
      const parsed = JSON.parse(response.body);
      expect(parsed.type).toBe('message');
      expect(parsed.content[0].text).toBe('Hello');
    });

    it('returns 404 for unknown endpoints', async () => {
      const { server: backend, port: backendPort } = await makeBackend((_req, res) => {
        res.writeHead(200);
        res.end('{}');
      });
      backendServers.push(backend);

      const logger = makeLogger();
      const proxy = makeProxy(backendPort, logger);
      proxies.push(proxy);

      const startResult = await proxy.start();
      if (!startResult.ok) return;
      const { port } = startResult.value;

      const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/v1/unknown-endpoint',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': '2' },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
          },
        );
        req.on('error', reject);
        req.write('{}');
        req.end();
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error.type).toBe('invalid_request_error');
    });

    it('returns 400 for invalid JSON body', async () => {
      const { server: backend, port: backendPort } = await makeBackend((_req, res) => {
        res.writeHead(200);
        res.end('{}');
      });
      backendServers.push(backend);

      const logger = makeLogger();
      const proxy = makeProxy(backendPort, logger);
      proxies.push(proxy);

      const startResult = await proxy.start();
      if (!startResult.ok) return;
      const { port } = startResult.value;

      const invalidJson = 'this is not json at all!!!';

      const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/v1/messages',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(invalidJson),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
          },
        );
        req.on('error', reject);
        req.write(invalidJson);
        req.end();
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error.type).toBe('invalid_request_error');
    });

    it('returns 502 when backend connection is refused', async () => {
      const logger = makeLogger();
      // Point proxy at a port with no server (connection refused)
      const proxy = makeProxy(1, logger);
      proxies.push(proxy);

      const startResult = await proxy.start();
      if (!startResult.ok) return;
      const { port } = startResult.value;

      const requestBody = JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 512,
      });

      const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/v1/messages',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(requestBody) },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
          },
        );
        req.on('error', reject);
        req.write(requestBody);
        req.end();
      });

      expect(response.statusCode).toBe(502);
      const body = JSON.parse(response.body);
      expect(body.error.type).toBe('api_error');
    });

    it('returns 502 when backend returns invalid JSON', async () => {
      const { server: backend, port: backendPort } = await makeBackend((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('this is not valid json!!!');
      });
      backendServers.push(backend);

      const logger = makeLogger();
      const proxy = makeProxy(backendPort, logger);
      proxies.push(proxy);

      const startResult = await proxy.start();
      if (!startResult.ok) return;
      const { port } = startResult.value;

      const requestBody = JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 512,
      });

      const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/v1/messages',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(requestBody) },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
          },
        );
        req.on('error', reject);
        req.write(requestBody);
        req.end();
      });

      expect(response.statusCode).toBe(502);
      const body = JSON.parse(response.body);
      expect(body.error.type).toBe('api_error');
    });
  });

  describe('streaming JSON fallback', () => {
    it('handles backend returning application/json when streaming was requested', async () => {
      // Some backends downgrade streaming and return a JSON completion instead of SSE.
      // The proxy must detect this via Content-Type and translate the JSON response normally.
      const { server: backend, port: backendPort } = await makeBackend(async (req, res) => {
        await readBody(req);
        const responseBody = {
          id: 'chatcmpl-fallback-1',
          model: 'gpt-4o',
          choices: [
            {
              message: { role: 'assistant', content: 'Fallback response.' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        };
        // Return JSON instead of SSE even though the request asked for streaming
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseBody));
      });
      backendServers.push(backend);

      const logger = makeLogger();
      const proxy = makeProxy(backendPort, logger);
      proxies.push(proxy);

      const startResult = await proxy.start();
      if (!startResult.ok) return;
      const { port } = startResult.value;

      // Send a streaming request (stream: true)
      const requestBody = JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 512,
        stream: true,
      });

      const response = await new Promise<{ statusCode: number; body: string; contentType: string }>(
        (resolve, reject) => {
          const req = http.request(
            {
              hostname: '127.0.0.1',
              port,
              path: '/v1/messages',
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(requestBody) },
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
              res.on('end', () =>
                resolve({
                  statusCode: res.statusCode ?? 0,
                  body: Buffer.concat(chunks).toString(),
                  contentType: res.headers['content-type'] ?? '',
                }),
              );
            },
          );
          req.on('error', reject);
          req.write(requestBody);
          req.end();
        },
      );

      // Proxy should translate the JSON fallback as a normal non-streaming response
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.type).toBe('message');
      expect(body.role).toBe('assistant');
      expect(body.content[0].text).toBe('Fallback response.');
    });
  });

  it('preserves path prefix in targetBaseUrl', async () => {
    let capturedUrl = '';
    const { server, port } = await makeBackend((req, res) => {
      capturedUrl = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-1',
          model: 'gpt-4o',
          choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }),
      );
    });
    backendServers.push(server);

    const proxy = new TranslationProxy({
      targetBaseUrl: `http://127.0.0.1:${port}/custom/prefix/v1`,
      targetApiKey: 'test-key',
      targetModel: 'gpt-4o',
      sourceCodec: new AnthropicCodec(),
      targetCodec: new OpenAICodec(),
      middlewareFactory: () => [],
      logger: makeLogger(),
    });
    proxies.push(proxy);
    const startResult = await proxy.start();
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const proxyPort = startResult.value.port;
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: proxyPort,
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body).toString(),
            'x-api-key': 'test',
          },
        },
        (res) => {
          res.resume();
          res.on('end', resolve);
        },
      );
      req.on('error', reject);
      req.end(body);
    });

    expect(capturedUrl).toBe('/custom/prefix/v1/chat/completions');
  });
});
