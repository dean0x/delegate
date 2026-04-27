/**
 * Tests for url-probe utility
 *
 * Tests both real loopback HTTP servers (for protocol-level behavior) and
 * DI requestFn mocks (for network-level errors that can't be replicated locally).
 */

import * as http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { UrlProbeOptions } from '../../../src/utils/url-probe.js';
import { probeUrl } from '../../../src/utils/url-probe.js';

// ---------------------------------------------------------------------------
// Helpers — real loopback HTTP server
// ---------------------------------------------------------------------------

function makeServer(
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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('probeUrl', () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    for (const srv of servers) {
      await closeServer(srv);
    }
    servers.length = 0;
  });

  // -------------------------------------------------------------------------
  // Basic probe tests (loopback server)
  // -------------------------------------------------------------------------

  it('returns ok severity for reachable URL (200)', async () => {
    const { server, port } = await makeServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    servers.push(server);

    const result = await probeUrl(`http://127.0.0.1:${port}`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.severity).toBe('ok');
    expect(result.value.reachable).toBe(true);
    expect(result.value.statusCode).toBe(200);
    expect(result.value.message).toMatch(/reachable/i);
  });

  it('returns ok severity for HTTP 405 (HEAD not allowed — server exists)', async () => {
    const { server, port } = await makeServer((_req, res) => {
      res.writeHead(405);
      res.end();
    });
    servers.push(server);

    const result = await probeUrl(`http://127.0.0.1:${port}`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.severity).toBe('ok');
    expect(result.value.statusCode).toBe(405);
  });

  it('returns warning severity for 301 redirect with Location header', async () => {
    const { server, port } = await makeServer((_req, res) => {
      res.writeHead(301, { Location: 'https://new-host.example.com/v1' });
      res.end();
    });
    servers.push(server);

    const result = await probeUrl(`http://127.0.0.1:${port}`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.severity).toBe('warning');
    expect(result.value.reachable).toBe(true);
    expect(result.value.message).toContain('new-host.example.com');
  });

  it('returns warning severity for 401 on base probe', async () => {
    const { server, port } = await makeServer((_req, res) => {
      res.writeHead(401);
      res.end();
    });
    servers.push(server);

    const result = await probeUrl(`http://127.0.0.1:${port}`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.severity).toBe('warning');
    expect(result.value.reachable).toBe(true);
    expect(result.value.message).toMatch(/authentication/i);
  });

  it('returns warning severity for 404', async () => {
    const { server, port } = await makeServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    servers.push(server);

    const result = await probeUrl(`http://127.0.0.1:${port}`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.severity).toBe('warning');
    expect(result.value.message).toContain('404');
  });

  it('returns warning severity for 429 rate limited', async () => {
    const { server, port } = await makeServer((_req, res) => {
      res.writeHead(429);
      res.end();
    });
    servers.push(server);

    const result = await probeUrl(`http://127.0.0.1:${port}`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.severity).toBe('warning');
    expect(result.value.reachable).toBe(true);
    expect(result.value.message).toMatch(/rate.limit/i);
  });

  it('returns warning severity for 500', async () => {
    const { server, port } = await makeServer((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    servers.push(server);

    const result = await probeUrl(`http://127.0.0.1:${port}`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.severity).toBe('warning');
    expect(result.value.reachable).toBe(true);
    expect(result.value.message).toContain('500');
  });

  it('returns error severity for ECONNREFUSED (port with no listener)', async () => {
    // Use an ephemeral server then close it to get a free port
    const { server, port } = await makeServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    await closeServer(server);
    // Port is now free — connecting should get ECONNREFUSED

    const result = await probeUrl(`http://127.0.0.1:${port}`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.severity).toBe('error');
    expect(result.value.reachable).toBe(false);
    expect(result.value.message).toMatch(/connection refused/i);
  });

  it('returns error severity on timeout (server that never responds + short timeout)', async () => {
    const { server, port } = await makeServer((_req, _res) => {
      // Intentionally never respond
    });
    servers.push(server);

    const result = await probeUrl(`http://127.0.0.1:${port}`, { timeoutMs: 300 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.severity).toBe('error');
    expect(result.value.reachable).toBe(false);
    expect(result.value.message).toMatch(/no response|timed? ?out/i);
  });

  it('returns err (Result error) for malformed URL', async () => {
    const result = await probeUrl('not-a-url');

    expect(result.ok).toBe(false);
  });

  it('returns err for file:// URL scheme', async () => {
    const result = await probeUrl('file:///etc/passwd');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/unsupported.*scheme|file:/i);
  });

  it('returns err for ftp:// URL scheme', async () => {
    const result = await probeUrl('ftp://example.com/data');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/unsupported.*scheme|ftp:/i);
  });

  it('durationMs is always > 0', async () => {
    const { server, port } = await makeServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    servers.push(server);

    const result = await probeUrl(`http://127.0.0.1:${port}`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.durationMs).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // DI requestFn mocks for network-level errors
  // -------------------------------------------------------------------------

  it('returns error severity for DNS failure (ENOTFOUND via requestFn DI)', async () => {
    const requestFn: UrlProbeOptions['requestFn'] = (_options, callback) => {
      const req = new http.ClientRequest('http://fake');
      process.nextTick(() => {
        const err = Object.assign(new Error('getaddrinfo ENOTFOUND no-such-host.invalid'), {
          code: 'ENOTFOUND',
        });
        req.emit('error', err);
      });
      if (callback) {
        // won't be called
      }
      return req;
    };

    const result = await probeUrl('http://no-such-host.invalid', { requestFn });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.severity).toBe('error');
    expect(result.value.reachable).toBe(false);
    expect(result.value.message).toMatch(/resolve hostname|no-such-host/i);
  });

  it('returns error severity for TLS error (CERT_HAS_EXPIRED via requestFn DI)', async () => {
    const requestFn: UrlProbeOptions['requestFn'] = (_options, callback) => {
      const req = new http.ClientRequest('http://fake');
      process.nextTick(() => {
        const err = Object.assign(new Error('certificate has expired'), {
          code: 'CERT_HAS_EXPIRED',
        });
        req.emit('error', err);
      });
      if (callback) {
        // won't be called
      }
      return req;
    };

    const result = await probeUrl('http://tls-test.invalid', { requestFn });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.severity).toBe('error');
    expect(result.value.reachable).toBe(false);
    expect(result.value.message).toMatch(/TLS|SSL|cert/i);
  });

  it('handles unexpected non-ErrnoException error gracefully', async () => {
    const requestFn: UrlProbeOptions['requestFn'] = (_options, _callback) => {
      const req = new http.ClientRequest('http://fake');
      process.nextTick(() => {
        req.emit('error', new Error('Unexpected internal error'));
      });
      return req;
    };

    const result = await probeUrl('http://unknown-error.invalid', { requestFn });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.severity).toBe('error');
    expect(result.value.reachable).toBe(false);
    expect(result.value.message).toContain('Unexpected internal error');
  });

  // -------------------------------------------------------------------------
  // Deep probe tests (with apiKey)
  // -------------------------------------------------------------------------

  it('deep probe returns ok severity for authenticated endpoint (HEAD 200, GET /models 200)', async () => {
    let requestCount = 0;

    const { server, port } = await makeServer((req, res) => {
      requestCount++;
      if (req.method === 'HEAD') {
        res.writeHead(200);
        res.end();
      } else if (req.method === 'GET' && req.url === '/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    servers.push(server);

    const result = await probeUrl(`http://127.0.0.1:${port}`, { apiKey: 'test-api-key' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.severity).toBe('ok');
    expect(result.value.reachable).toBe(true);
    expect(requestCount).toBe(2); // HEAD + GET /models
  });

  it('deep probe returns error severity for 401 on /models (invalid API key)', async () => {
    const { server, port } = await makeServer((req, res) => {
      if (req.method === 'HEAD') {
        res.writeHead(200);
        res.end();
      } else if (req.method === 'GET') {
        res.writeHead(401);
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    servers.push(server);

    const result = await probeUrl(`http://127.0.0.1:${port}`, { apiKey: 'invalid-key' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.severity).toBe('error');
    expect(result.value.message).toMatch(/API key.*rejected|rejected.*API key/i);
  });

  it('deep probe returns error severity for 403 on /models (insufficient permissions)', async () => {
    const { server, port } = await makeServer((req, res) => {
      if (req.method === 'HEAD') {
        res.writeHead(200);
        res.end();
      } else if (req.method === 'GET') {
        res.writeHead(403);
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    servers.push(server);

    const result = await probeUrl(`http://127.0.0.1:${port}`, { apiKey: 'restricted-key' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.severity).toBe('error');
    expect(result.value.message).toMatch(/permission/i);
  });

  it('deep probe returns warning severity for 404 on /models', async () => {
    const { server, port } = await makeServer((req, res) => {
      if (req.method === 'HEAD') {
        res.writeHead(200);
        res.end();
      } else if (req.method === 'GET') {
        res.writeHead(404);
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    servers.push(server);

    const result = await probeUrl(`http://127.0.0.1:${port}`, { apiKey: 'test-api-key' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.severity).toBe('warning');
  });

  it('deep probe is skipped when no apiKey provided (verify via request counter)', async () => {
    let requestCount = 0;

    const { server, port } = await makeServer((_req, res) => {
      requestCount++;
      res.writeHead(200);
      res.end();
    });
    servers.push(server);

    await probeUrl(`http://127.0.0.1:${port}`); // no apiKey

    expect(requestCount).toBe(1); // only HEAD, no GET /models
  });

  it('deep probe network failure sets deepProbeWarning on the returned result', async () => {
    // HEAD (first call) succeeds; GET /models (second call) fails with ENOTFOUND.
    // We use a stateful requestFn counter that returns different behaviour per call.
    let callCount = 0;

    const { server, port } = await makeServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    servers.push(server);

    // Real HEAD goes to the loopback server; DI requestFn intercepts only GET /models.
    // We override requestFn to proxy the first call to the real http.request and
    // error-inject on the second call.
    const realRequestFn = http.request;
    const requestFn: UrlProbeOptions['requestFn'] = (options, callback) => {
      callCount++;
      if (callCount === 1) {
        // First call is HEAD — proxy to real loopback server
        return realRequestFn(options, callback);
      }
      // Second call is GET /models — inject a network error
      const req = new http.ClientRequest(`http://127.0.0.1:${port}`);
      process.nextTick(() => {
        req.emit('error', Object.assign(new Error('getaddrinfo ENOTFOUND models-endpoint'), { code: 'ENOTFOUND' }));
      });
      return req;
    };

    const result = await probeUrl(`http://127.0.0.1:${port}`, { apiKey: 'test-key', requestFn });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Base HEAD probe result is returned (200 = ok)
    expect(result.value.severity).toBe('ok');
    expect(result.value.statusCode).toBe(200);
    // deepProbeWarning surfaces the GET /models network error
    expect(result.value.deepProbeWarning).toBeDefined();
    expect(result.value.deepProbeWarning).toMatch(/deep probe|GET \/models/i);
  });

  it('deep probe is skipped when base probe fails (ECONNREFUSED)', async () => {
    // Close a server to get a free port that will ECONNREFUSED
    const { server, port } = await makeServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    await closeServer(server);

    const result = await probeUrl(`http://127.0.0.1:${port}`, { apiKey: 'test-api-key' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Should still return an error result (from base probe), not crash
    expect(result.value.severity).toBe('error');
    expect(result.value.reachable).toBe(false);
  });
});
