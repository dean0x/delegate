/**
 * Tests for logging middleware
 */
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../../src/core/interfaces.js';
import type { CanonicalRequest, CanonicalResponse } from '../../../../src/translation/ir.js';
import { LoggingMiddleware } from '../../../../src/translation/middleware/logging.js';

function makeLogger(): Logger & {
  debugCalls: Array<[string, Record<string, unknown>?]>;
  infoCalls: Array<[string, Record<string, unknown>?]>;
  warnCalls: Array<[string, Record<string, unknown>?]>;
} {
  const debugCalls: Array<[string, Record<string, unknown>?]> = [];
  const infoCalls: Array<[string, Record<string, unknown>?]> = [];
  const warnCalls: Array<[string, Record<string, unknown>?]> = [];

  return {
    debugCalls,
    infoCalls,
    warnCalls,
    debug: (msg, ctx?) => {
      debugCalls.push([msg, ctx]);
    },
    info: (msg, ctx?) => {
      infoCalls.push([msg, ctx]);
    },
    warn: (msg, ctx?) => {
      warnCalls.push([msg, ctx]);
    },
    error: vi.fn(),
    child: vi.fn(),
  };
}

describe('LoggingMiddleware', () => {
  it('logs model, message count, tool count, and streaming flag on request', () => {
    const logger = makeLogger();
    const middleware = new LoggingMiddleware(logger);

    const request: CanonicalRequest = {
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
      ],
      maxTokens: 1024,
      stream: true,
      tools: [
        { name: 'tool1', inputSchema: {} },
        { name: 'tool2', inputSchema: {} },
      ],
    };
    middleware.processRequest!(request);

    // Should have logged a request
    const allLogs = [...logger.debugCalls, ...logger.infoCalls];
    expect(allLogs.length).toBeGreaterThan(0);

    const allCtx = allLogs.map(([, ctx]) => ctx).filter(Boolean);
    const ctxWithModel = allCtx.find((ctx) => ctx && 'model' in ctx);
    expect(ctxWithModel).toBeDefined();
    expect(ctxWithModel!['model']).toBe('gpt-4o');

    const ctxWithMessages = allCtx.find((ctx) => ctx && 'messageCount' in ctx);
    expect(ctxWithMessages).toBeDefined();
    expect(ctxWithMessages!['messageCount']).toBe(2);

    const ctxWithTools = allCtx.find((ctx) => ctx && 'toolCount' in ctx);
    expect(ctxWithTools).toBeDefined();
    expect(ctxWithTools!['toolCount']).toBe(2);

    const ctxWithStream = allCtx.find((ctx) => ctx && 'streaming' in ctx);
    expect(ctxWithStream).toBeDefined();
    expect(ctxWithStream!['streaming']).toBe(true);
  });

  it('logs stop reason and token counts on response', () => {
    const logger = makeLogger();
    const middleware = new LoggingMiddleware(logger);

    // First process request (sets up context)
    const request: CanonicalRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
      maxTokens: 1024,
      stream: false,
    };
    middleware.processRequest!(request);

    const response: CanonicalResponse = {
      id: 'msg_1',
      model: 'gpt-4o',
      content: [{ type: 'text', text: 'Hello back' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    middleware.processResponse!(response);

    const allLogs = [...logger.debugCalls, ...logger.infoCalls];
    const allCtx = allLogs.map(([, ctx]) => ctx).filter(Boolean);

    const ctxWithStop = allCtx.find((ctx) => ctx && 'stopReason' in ctx);
    expect(ctxWithStop).toBeDefined();
    expect(ctxWithStop!['stopReason']).toBe('end_turn');

    const ctxWithTokens = allCtx.find((ctx) => ctx && 'inputTokens' in ctx);
    expect(ctxWithTokens).toBeDefined();
    expect(ctxWithTokens!['inputTokens']).toBe(10);
    expect(ctxWithTokens!['outputTokens']).toBe(5);
  });

  it('never logs API keys or auth headers', () => {
    const logger = makeLogger();
    const middleware = new LoggingMiddleware(logger);

    const request: CanonicalRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
      maxTokens: 1024,
      stream: false,
    };
    middleware.processRequest!(request);

    // Check that no API key patterns appear in any logged context
    const allLogs = [...logger.debugCalls, ...logger.infoCalls, ...logger.warnCalls];
    const allLogStr = JSON.stringify(allLogs);

    // Should not contain common API key patterns
    expect(allLogStr).not.toMatch(/sk-[a-zA-Z0-9]{10,}/);
    expect(allLogStr).not.toMatch(/Bearer\s+[a-zA-Z0-9-._~+/]+=*/);
    expect(allLogStr).not.toMatch(/x-api-key/i);
    expect(allLogStr).not.toMatch(/authorization/i);
  });

  it('never logs full request or response bodies', () => {
    const logger = makeLogger();
    const middleware = new LoggingMiddleware(logger);

    const request: CanonicalRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'This is a secret message content 1234567890' }] }],
      maxTokens: 1024,
      stream: false,
    };
    middleware.processRequest!(request);

    const allLogs = [...logger.debugCalls, ...logger.infoCalls];
    const allLogStr = JSON.stringify(allLogs);

    // Should not contain the full message content
    expect(allLogStr).not.toContain('This is a secret message content 1234567890');
  });

  it('returns request unchanged', () => {
    const logger = makeLogger();
    const middleware = new LoggingMiddleware(logger);

    const request: CanonicalRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
      maxTokens: 512,
      stream: false,
    };
    const processed = middleware.processRequest!(request);
    expect(processed).toEqual(request);
  });

  it('returns response unchanged', () => {
    const logger = makeLogger();
    const middleware = new LoggingMiddleware(logger);

    const request: CanonicalRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
      maxTokens: 512,
      stream: false,
    };
    middleware.processRequest!(request);

    const response: CanonicalResponse = {
      id: 'msg_1',
      model: 'gpt-4o',
      content: [{ type: 'text', text: 'Hi' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 5, outputTokens: 2 },
    };
    const processed = middleware.processResponse!(response);
    expect(processed).toEqual(response);
  });
});
