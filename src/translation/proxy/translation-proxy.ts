/**
 * HTTP translation proxy server.
 *
 * ARCHITECTURE: Listens locally on a random port, receives Anthropic Messages API
 * requests from Claude Code, translates them to OpenAI Chat Completions format,
 * forwards to the target backend, translates the response back, and returns it
 * to Claude Code.
 *
 * Security invariants:
 * 1. NEVER forwards inbound x-api-key to the target. Uses config.targetApiKey only.
 * 2. Strips ALL anthropic-* headers before forwarding.
 * 3. Never includes API keys in error messages or logs.
 *
 * Routes:
 * - POST /v1/messages         — full request/response translation
 * - POST /v1/messages/count_tokens — token counting (approximate)
 */
import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';
import type { Logger } from '../../core/interfaces.js';
import { err, ok, type Result } from '../../core/result.js';
import type { FormatCodec } from '../codec.js';
import type { TranslationMiddleware } from '../middleware/middleware.js';
import { runRequestMiddleware, runResponseMiddleware } from '../middleware/middleware.js';
import { LineBuffer } from './line-buffer.js';
import { StreamTranslator } from './stream-translator.js';

export interface TranslationProxyConfig {
  readonly targetBaseUrl: string;
  readonly targetApiKey: string;
  readonly targetModel: string;
  readonly sourceCodec: FormatCodec;
  readonly targetCodec: FormatCodec;
  readonly middlewares: readonly TranslationMiddleware[];
  readonly logger: Logger;
}

const MAX_BODY_BYTES = 50 * 1024 * 1024; // 50MB
const CONNECT_TIMEOUT_MS = 30_000;
const NONSTREAM_TIMEOUT_MS = 300_000;
const STREAM_IDLE_TIMEOUT_MS = 60_000;
const FORCE_CLOSE_TIMEOUT_MS = 5_000;

interface AnthropicErrorResponse {
  type: 'error';
  error: {
    type: string;
    message: string;
  };
}

function buildErrorResponse(type: string, message: string): AnthropicErrorResponse {
  return { type: 'error', error: { type, message } };
}

function mapStatusToErrorType(status: number): string {
  switch (status) {
    case 401:
      return 'authentication_error';
    case 403:
      return 'permission_error';
    case 429:
      return 'rate_limit_error';
    case 400:
      return 'invalid_request_error';
    default:
      return 'api_error';
  }
}

function stripAnthropicHeaders(inbound: http.IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(inbound)) {
    const lk = key.toLowerCase();
    // Strip anthropic-specific headers and auth headers
    if (
      lk.startsWith('anthropic-') ||
      lk === 'x-api-key' ||
      lk === 'authorization' ||
      lk === 'host' ||
      lk === 'content-length' ||
      lk === 'transfer-encoding' ||
      lk === 'connection'
    ) {
      continue;
    }
    if (typeof value === 'string') {
      result[key] = value;
    } else if (Array.isArray(value)) {
      result[key] = value.join(', ');
    }
  }
  return result;
}

async function readBody(req: http.IncomingMessage): Promise<Result<Buffer>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let resolved = false;

    req.on('data', (chunk: Buffer) => {
      if (resolved) {
        // Already resolved as too-large — drain remaining data silently
        return;
      }
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        resolved = true;
        // Drain remaining data so we can still send the response
        req.resume();
        resolve(err(new Error('Request body too large')));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (!resolved) {
        resolved = true;
        resolve(ok(Buffer.concat(chunks)));
      }
    });

    req.on('error', (e) => {
      if (!resolved) {
        resolved = true;
        resolve(err(e));
      }
    });
  });
}

function sendError(res: http.ServerResponse, status: number, type: string, message: string): void {
  const body = JSON.stringify(buildErrorResponse(type, message));
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export class TranslationProxy {
  private server: http.Server | null = null;

  constructor(private readonly config: TranslationProxyConfig) {}

  async start(): Promise<Result<{ port: number }>> {
    return new Promise((resolve) => {
      // ARCHITECTURE EXCEPTION: Using plain HTTP (not HTTPS) for the local server.
      // This server binds exclusively to 127.0.0.1 (loopback) and is only
      // reachable by processes on the same machine. TLS would add unnecessary
      // certificate management overhead for a local-only service. Outbound
      // connections to the target backend DO use HTTPS (see requestFn selection).
      const server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          this.config.logger.error('Unhandled proxy error', e instanceof Error ? e : undefined, {
            message: msg,
          });
          if (!res.headersSent) {
            sendError(res, 500, 'api_error', 'Internal proxy error');
          }
        });
      });

      server.on('error', (e) => {
        resolve(err(e));
      });

      server.listen(0, '127.0.0.1', () => {
        this.server = server;
        const addr = server.address() as { port: number };
        resolve(ok({ port: addr.port }));
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }

      const forceClose = setTimeout(() => {
        this.server?.closeAllConnections?.();
        resolve();
      }, FORCE_CLOSE_TIMEOUT_MS);

      this.server.close(() => {
        clearTimeout(forceClose);
        resolve();
      });
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url ?? '';
    const method = req.method ?? 'GET';

    // Only handle POST
    if (method !== 'POST') {
      sendError(res, 405, 'invalid_request_error', 'Method not allowed');
      return;
    }

    // Token counting endpoint
    if (url === '/v1/messages/count_tokens') {
      await this.handleCountTokens(req, res);
      return;
    }

    // Main messages endpoint
    if (url === '/v1/messages') {
      await this.handleMessages(req, res);
      return;
    }

    sendError(res, 404, 'invalid_request_error', `Unknown endpoint: ${url}`);
  }

  private async handleCountTokens(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const bodyResult = await readBody(req);
    if (!bodyResult.ok) {
      if (bodyResult.error.message === 'Request body too large') {
        sendError(res, 413, 'invalid_request_error', 'Request body too large');
        return;
      }
      sendError(res, 400, 'invalid_request_error', 'Failed to read request body');
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyResult.value.toString());
    } catch {
      sendError(res, 400, 'invalid_request_error', 'Invalid JSON');
      return;
    }

    // Approximate token count: sum of all text content chars / 4
    let chars = 0;
    if (parsed && typeof parsed === 'object') {
      const r = parsed as Record<string, unknown>;
      const messages = r['messages'] as Array<Record<string, unknown>> | undefined;
      if (messages) {
        for (const msg of messages) {
          const content = msg['content'];
          if (typeof content === 'string') {
            chars += content.length;
          } else if (Array.isArray(content)) {
            for (const block of content) {
              const b = block as Record<string, unknown>;
              if (typeof b['text'] === 'string') {
                chars += (b['text'] as string).length;
              }
            }
          }
        }
      }
      if (typeof r['system'] === 'string') {
        chars += (r['system'] as string).length;
      }
    }

    const inputTokens = Math.max(1, Math.ceil(chars / 4));
    const body = JSON.stringify({ input_tokens: inputTokens });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  private async handleMessages(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Read and validate body
    const bodyResult = await readBody(req);
    if (!bodyResult.ok) {
      if (bodyResult.error.message === 'Request body too large') {
        sendError(res, 413, 'invalid_request_error', 'Request body too large');
        return;
      }
      sendError(res, 400, 'invalid_request_error', 'Failed to read request body');
      return;
    }

    let rawRequest: unknown;
    try {
      rawRequest = JSON.parse(bodyResult.value.toString());
    } catch {
      sendError(res, 400, 'invalid_request_error', 'Invalid JSON');
      return;
    }

    // Parse source request
    const parseResult = this.config.sourceCodec.parseRequest(rawRequest);
    if (!parseResult.ok) {
      sendError(res, 400, 'invalid_request_error', parseResult.error.message);
      return;
    }

    // Override model with target model
    const canonicalRequest = {
      ...parseResult.value,
      model: this.config.targetModel,
    };

    // Run request middleware
    const processedRequest = runRequestMiddleware(this.config.middlewares, canonicalRequest);

    // Serialize for target
    const serializeResult = this.config.targetCodec.serializeRequest(processedRequest);
    if (!serializeResult.ok) {
      sendError(res, 500, 'api_error', 'Failed to serialize request');
      return;
    }

    const targetBody = JSON.stringify(serializeResult.value);
    const targetUrl = new URL('/v1/chat/completions', this.config.targetBaseUrl);

    // Build outbound headers (strip anthropic-specific, set auth)
    const outboundHeaders = stripAnthropicHeaders(req.headers);
    outboundHeaders['Authorization'] = `Bearer ${this.config.targetApiKey}`;
    outboundHeaders['Content-Type'] = 'application/json';
    outboundHeaders['Content-Length'] = String(Buffer.byteLength(targetBody));

    const isStreaming = processedRequest.stream;

    if (isStreaming) {
      await this.handleStreamingRequest(req, res, targetUrl, outboundHeaders, targetBody, processedRequest);
    } else {
      await this.handleNonStreamingRequest(req, res, targetUrl, outboundHeaders, targetBody, processedRequest);
    }
  }

  private async handleNonStreamingRequest(
    inboundReq: http.IncomingMessage,
    res: http.ServerResponse,
    targetUrl: URL,
    outboundHeaders: Record<string, string>,
    targetBody: string,
    processedRequest: ReturnType<typeof runRequestMiddleware>,
  ): Promise<void> {
    const abort = new AbortController();
    const connectTimeout = setTimeout(() => abort.abort(), CONNECT_TIMEOUT_MS);
    const responseTimeout = setTimeout(() => abort.abort(), NONSTREAM_TIMEOUT_MS);

    // Abort on client disconnect
    inboundReq.on('close', () => abort.abort());

    return new Promise<void>((resolve) => {
      const requestFn = targetUrl.protocol === 'https:' ? https.request : http.request;

      const outbound = requestFn(
        {
          hostname: targetUrl.hostname,
          port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
          path: targetUrl.pathname,
          method: 'POST',
          headers: outboundHeaders,
          signal: abort.signal,
        },
        (backendRes) => {
          clearTimeout(connectTimeout);

          const statusCode = backendRes.statusCode ?? 500;
          const contentType = backendRes.headers['content-type'] ?? '';

          if (statusCode >= 400) {
            const errChunks: Buffer[] = [];
            backendRes.on('data', (chunk: Buffer) => errChunks.push(chunk));
            backendRes.on('end', () => {
              clearTimeout(responseTimeout);
              const errorType = mapStatusToErrorType(statusCode);
              sendError(res, statusCode, errorType, 'Backend returned error');
              resolve();
            });
            return;
          }

          const chunks: Buffer[] = [];
          backendRes.on('data', (chunk: Buffer) => chunks.push(chunk));
          backendRes.on('end', () => {
            clearTimeout(responseTimeout);

            const body = Buffer.concat(chunks).toString();
            let rawResponse: unknown;
            try {
              rawResponse = JSON.parse(body);
            } catch {
              sendError(res, 502, 'api_error', 'Backend returned invalid JSON');
              resolve();
              return;
            }

            const parseResult = this.config.targetCodec.parseResponse(rawResponse);
            if (!parseResult.ok) {
              sendError(res, 502, 'api_error', 'Failed to parse backend response');
              resolve();
              return;
            }

            const processedResponse = runResponseMiddleware(this.config.middlewares, parseResult.value);

            const serializeResult = this.config.sourceCodec.serializeResponse(processedResponse);
            if (!serializeResult.ok) {
              sendError(res, 500, 'api_error', 'Failed to serialize response');
              resolve();
              return;
            }

            const responseBody = JSON.stringify(serializeResult.value);
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(responseBody),
            });
            res.end(responseBody);
            resolve();
          });
        },
      );

      outbound.on('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(connectTimeout);
        clearTimeout(responseTimeout);
        if (abort.signal.aborted) {
          if (!res.headersSent) {
            sendError(res, 499, 'api_error', 'Request cancelled');
          }
        } else {
          if (!res.headersSent) {
            const msg = e.code === 'ECONNREFUSED' ? 'Backend connection refused' : 'Backend connection error';
            sendError(res, 502, 'api_error', msg);
          }
        }
        resolve();
      });

      outbound.write(targetBody);
      outbound.end();
    });
  }

  private async handleStreamingRequest(
    inboundReq: http.IncomingMessage,
    res: http.ServerResponse,
    targetUrl: URL,
    outboundHeaders: Record<string, string>,
    targetBody: string,
    processedRequest: ReturnType<typeof runRequestMiddleware>,
  ): Promise<void> {
    const abort = new AbortController();
    const connectTimeout = setTimeout(() => abort.abort(), CONNECT_TIMEOUT_MS);

    let streamIdleTimer: ReturnType<typeof setTimeout> | null = null;
    const resetIdleTimer = () => {
      if (streamIdleTimer) clearTimeout(streamIdleTimer);
      streamIdleTimer = setTimeout(() => abort.abort(), STREAM_IDLE_TIMEOUT_MS);
    };

    inboundReq.on('close', () => abort.abort());

    const translator = new StreamTranslator(
      this.config.sourceCodec.createStreamSerializer(),
      this.config.targetCodec.createStreamParser(),
      this.config.middlewares,
    );
    const lineBuffer = new LineBuffer();

    return new Promise<void>((resolve) => {
      const requestFn = targetUrl.protocol === 'https:' ? https.request : http.request;

      const outbound = requestFn(
        {
          hostname: targetUrl.hostname,
          port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
          path: targetUrl.pathname,
          method: 'POST',
          headers: outboundHeaders,
          signal: abort.signal,
        },
        (backendRes) => {
          clearTimeout(connectTimeout);

          const statusCode = backendRes.statusCode ?? 500;
          const contentType = backendRes.headers['content-type'] ?? '';

          if (statusCode >= 400) {
            const errChunks: Buffer[] = [];
            backendRes.on('data', (chunk: Buffer) => errChunks.push(chunk));
            backendRes.on('end', () => {
              if (streamIdleTimer) clearTimeout(streamIdleTimer);
              const errorType = mapStatusToErrorType(statusCode);
              if (!res.headersSent) {
                sendError(res, statusCode, errorType, 'Backend returned error');
              }
              resolve();
            });
            return;
          }

          // Check if backend returned JSON when we expected SSE (non-streaming fallback)
          const isJsonFallback = contentType.includes('application/json') && !contentType.includes('event-stream');

          if (isJsonFallback) {
            // Non-streaming fallback: parse as JSON response
            const chunks: Buffer[] = [];
            backendRes.on('data', (chunk: Buffer) => chunks.push(chunk));
            backendRes.on('end', () => {
              if (streamIdleTimer) clearTimeout(streamIdleTimer);

              let rawResponse: unknown;
              try {
                rawResponse = JSON.parse(Buffer.concat(chunks).toString());
              } catch {
                if (!res.headersSent) sendError(res, 502, 'api_error', 'Backend returned invalid JSON');
                resolve();
                return;
              }

              const parseResult = this.config.targetCodec.parseResponse(rawResponse);
              if (!parseResult.ok) {
                if (!res.headersSent) sendError(res, 502, 'api_error', 'Failed to parse backend response');
                resolve();
                return;
              }

              const processedResponse = runResponseMiddleware(this.config.middlewares, parseResult.value);
              const serializeResult = this.config.sourceCodec.serializeResponse(processedResponse);
              if (!serializeResult.ok) {
                if (!res.headersSent) sendError(res, 500, 'api_error', 'Failed to serialize response');
                resolve();
                return;
              }

              const responseBody = JSON.stringify(serializeResult.value);
              res.writeHead(200, {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(responseBody),
              });
              res.end(responseBody);
              resolve();
            });
            return;
          }

          // Start SSE response
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });

          resetIdleTimer();

          backendRes.on('data', (chunk: Buffer) => {
            resetIdleTimer();
            const text = chunk.toString('utf-8');
            const lines = lineBuffer.feed(text);

            for (const line of lines) {
              const sseLines = translator.processLine(line);
              for (const sseLine of sseLines) {
                res.write(sseLine + '\n');
              }
            }
          });

          backendRes.on('end', () => {
            if (streamIdleTimer) clearTimeout(streamIdleTimer);

            // Flush remaining
            const flushLines = translator.flush();
            for (const sseLine of flushLines) {
              res.write(sseLine + '\n');
            }

            res.end();
            resolve();
          });

          backendRes.on('error', () => {
            if (streamIdleTimer) clearTimeout(streamIdleTimer);
            res.end();
            resolve();
          });
        },
      );

      outbound.on('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(connectTimeout);
        if (streamIdleTimer) clearTimeout(streamIdleTimer);

        if (!res.headersSent) {
          const msg = e.code === 'ECONNREFUSED' ? 'Backend connection refused' : 'Backend connection error';
          sendError(res, 502, 'api_error', msg);
        } else {
          res.end();
        }
        resolve();
      });

      outbound.write(targetBody);
      outbound.end();
    });
  }
}
