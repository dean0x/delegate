/**
 * Tests for prompt cache middleware (metrics-only)
 */
import { describe, expect, it } from 'vitest';
import type { CanonicalRequest, CanonicalResponse } from '../../../../src/translation/ir.js';
import { PromptCacheMiddleware, type PromptCacheState } from '../../../../src/translation/middleware/prompt-cache.js';

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
    // Backend reported 15 cache tokens — middleware must preserve this exact value,
    // not add its own estimate on top.
    expect(processed.usage.cacheReadInputTokens).toBe(15);
  });

  it('shared state enables cache hit detection across middleware instances', () => {
    const sharedState: PromptCacheState = { lastPrefixHash: null };
    const systemBlocks: CanonicalRequest['system'] = [
      { type: 'text', text: 'You are a helpful assistant with a very long system prompt that is worth caching' },
    ];

    // Instance 1: prime the shared state
    const mw1 = new PromptCacheMiddleware(sharedState);
    mw1.processRequest!(makeRequest([{ role: 'user', content: [{ type: 'text', text: 'Question 1' }] }], systemBlocks));
    mw1.processResponse!({
      id: 'msg_1',
      model: 'gpt-4o',
      content: [{ type: 'text', text: 'Answer 1' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 50, outputTokens: 10 },
    });

    // Instance 2: fresh per-request instance, same shared state
    const mw2 = new PromptCacheMiddleware(sharedState);
    mw2.processRequest!(makeRequest([{ role: 'user', content: [{ type: 'text', text: 'Question 2' }] }], systemBlocks));
    const result = mw2.processResponse!({
      id: 'msg_2',
      model: 'gpt-4o',
      content: [{ type: 'text', text: 'Answer 2' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 50, outputTokens: 10 },
    });

    expect(result.usage.cacheReadInputTokens).toBeGreaterThan(0);
    expect(sharedState.lastPrefixHash).not.toBeNull();
  });

  it('without shared state, separate instances cannot detect cache hits', () => {
    const systemBlocks: CanonicalRequest['system'] = [
      { type: 'text', text: 'You are a helpful assistant with a very long system prompt that is worth caching' },
    ];

    // Instance 1: default isolated state
    const mw1 = new PromptCacheMiddleware();
    mw1.processRequest!(makeRequest([{ role: 'user', content: [{ type: 'text', text: 'Question 1' }] }], systemBlocks));
    mw1.processResponse!({
      id: 'msg_1',
      model: 'gpt-4o',
      content: [{ type: 'text', text: 'Answer 1' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 50, outputTokens: 10 },
    });

    // Instance 2: different default state — cannot see mw1's lastPrefixHash
    const mw2 = new PromptCacheMiddleware();
    mw2.processRequest!(makeRequest([{ role: 'user', content: [{ type: 'text', text: 'Question 2' }] }], systemBlocks));
    const result = mw2.processResponse!({
      id: 'msg_2',
      model: 'gpt-4o',
      content: [{ type: 'text', text: 'Answer 2' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 50, outputTokens: 10 },
    });

    // No shared state → no cache hit
    expect(result.usage.cacheReadInputTokens ?? 0).toBe(0);
  });

  it('shared state reflects changed prefix (no false cache hit)', () => {
    const sharedState: PromptCacheState = { lastPrefixHash: null };

    // Instance 1: system prompt A
    const mw1 = new PromptCacheMiddleware(sharedState);
    mw1.processRequest!(
      makeRequest([{ role: 'user', content: [{ type: 'text', text: 'Q' }] }], [{ type: 'text', text: 'System A' }]),
    );
    mw1.processResponse!({
      id: 'msg_1',
      model: 'gpt-4o',
      content: [{ type: 'text', text: 'A' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 30, outputTokens: 5 },
    });

    // Instance 2: system prompt B — different prefix
    const mw2 = new PromptCacheMiddleware(sharedState);
    mw2.processRequest!(
      makeRequest([{ role: 'user', content: [{ type: 'text', text: 'Q' }] }], [{ type: 'text', text: 'System B' }]),
    );
    const result = mw2.processResponse!({
      id: 'msg_2',
      model: 'gpt-4o',
      content: [{ type: 'text', text: 'A' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 30, outputTokens: 5 },
    });

    // Prefix changed → no cache hit
    expect(result.usage.cacheReadInputTokens ?? 0).toBe(0);
  });
});
