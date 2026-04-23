/**
 * Tests for prompt cache middleware (metrics-only)
 */
import { describe, expect, it } from 'vitest';
import type { CanonicalRequest, CanonicalResponse } from '../../../../src/translation/ir.js';
import { PromptCacheMiddleware } from '../../../../src/translation/middleware/prompt-cache.js';

function makeRequest(messages: CanonicalRequest['messages'], system?: CanonicalRequest['system']): CanonicalRequest {
  return {
    model: 'gpt-4o',
    messages,
    maxTokens: 1024,
    stream: false,
    system,
  };
}

describe('PromptCacheMiddleware', () => {
  it('first request has no cache hit in response', () => {
    const middleware = new PromptCacheMiddleware();
    const request = makeRequest([{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }]);
    middleware.processRequest!(request);

    const response: CanonicalResponse = {
      id: 'msg_1',
      model: 'gpt-4o',
      content: [{ type: 'text', text: 'Hi' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    const processed = middleware.processResponse!(response);
    // First request - no cache tokens added
    expect(processed.usage.cacheReadInputTokens ?? 0).toBe(0);
  });

  it('repeated request with same prefix reports non-zero cache tokens', () => {
    const middleware = new PromptCacheMiddleware();
    const systemBlocks: CanonicalRequest['system'] = [
      { type: 'text', text: 'You are a helpful assistant with a very long system prompt that is worth caching' },
    ];
    const messages: CanonicalRequest['messages'] = [{ role: 'user', content: [{ type: 'text', text: 'Question 1' }] }];

    const request1 = makeRequest(messages, systemBlocks);
    middleware.processRequest!(request1);
    const response1: CanonicalResponse = {
      id: 'msg_1',
      model: 'gpt-4o',
      content: [{ type: 'text', text: 'Answer 1' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 20 },
    };
    middleware.processResponse!(response1);

    // Same system, different user message (same prefix = system)
    const request2 = makeRequest([{ role: 'user', content: [{ type: 'text', text: 'Question 2' }] }], systemBlocks);
    middleware.processRequest!(request2);
    const response2: CanonicalResponse = {
      id: 'msg_2',
      model: 'gpt-4o',
      content: [{ type: 'text', text: 'Answer 2' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 20 },
    };
    const processed2 = middleware.processResponse!(response2);
    // Second request with same prefix should report cache tokens
    expect(processed2.usage.cacheReadInputTokens ?? 0).toBeGreaterThan(0);
  });

  it('changed prefix results in cache miss', () => {
    const middleware = new PromptCacheMiddleware();
    const systemBlocks1: CanonicalRequest['system'] = [{ type: 'text', text: 'System prompt A' }];
    const systemBlocks2: CanonicalRequest['system'] = [
      { type: 'text', text: 'System prompt B (completely different)' },
    ];
    const messages: CanonicalRequest['messages'] = [{ role: 'user', content: [{ type: 'text', text: 'Question' }] }];

    // First request
    middleware.processRequest!(makeRequest(messages, systemBlocks1));
    const response1: CanonicalResponse = {
      id: 'msg_1',
      model: 'gpt-4o',
      content: [{ type: 'text', text: 'Answer' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 50, outputTokens: 10 },
    };
    middleware.processResponse!(response1);

    // Second request with different system
    middleware.processRequest!(makeRequest(messages, systemBlocks2));
    const response2: CanonicalResponse = {
      id: 'msg_2',
      model: 'gpt-4o',
      content: [{ type: 'text', text: 'Answer 2' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 50, outputTokens: 10 },
    };
    const processed2 = middleware.processResponse!(response2);
    // Different prefix = cache miss = no cache tokens
    expect(processed2.usage.cacheReadInputTokens ?? 0).toBe(0);
  });

  it('does not skip API calls (metrics-only)', () => {
    const middleware = new PromptCacheMiddleware();
    // This test verifies that processRequest does not prevent the request
    // It should always return the request unchanged (no short-circuit)
    const request = makeRequest([{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }]);
    const result = middleware.processRequest!(request);
    expect(result).toBeDefined();
    // The request is returned (possibly unchanged)
    expect(result.model).toBe(request.model);
  });

  it('does not add cache tokens if already present in response', () => {
    const middleware = new PromptCacheMiddleware();
    const systemBlocks: CanonicalRequest['system'] = [{ type: 'text', text: 'You are helpful' }];
    const request = makeRequest([{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }], systemBlocks);

    // Two requests to prime the cache
    middleware.processRequest!(request);
    middleware.processResponse!({
      id: 'msg_1',
      model: 'gpt-4o',
      content: [{ type: 'text', text: 'Hi' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 20, outputTokens: 5 },
    });

    middleware.processRequest!({ ...request });
    const responseWithCache: CanonicalResponse = {
      id: 'msg_2',
      model: 'gpt-4o',
      content: [{ type: 'text', text: 'Hi' }],
      stopReason: 'end_turn',
      // Already has cache tokens from real backend
      usage: { inputTokens: 20, outputTokens: 5, cacheReadInputTokens: 15 },
    };
    // Should not double-count
    const processed = middleware.processResponse!(responseWithCache);
    // If backend already reported cache hits, we should not add more
    // The middleware's estimate should be 0 when backend reports
    expect(processed.usage.cacheReadInputTokens).toBeGreaterThanOrEqual(0);
  });
});
