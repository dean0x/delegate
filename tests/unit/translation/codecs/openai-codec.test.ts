/**
 * Tests for the OpenAI codec (target codec — sends to/receives from OpenAI)
 */
import { describe, expect, it } from 'vitest';
import { OpenAICodec } from '../../../../src/translation/codecs/openai-codec.js';
import type { CanonicalRequest } from '../../../../src/translation/ir.js';

describe('OpenAICodec', () => {
  const codec = new OpenAICodec();

  // ==========================================
  // serializeRequest
  // ==========================================

  describe('serializeRequest', () => {
    it('serializes a basic request', () => {
      const canonical: CanonicalRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        maxTokens: 1024,
        stream: false,
      };
      const result = codec.serializeRequest(canonical);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const raw = result.value as Record<string, unknown>;
      expect(raw['model']).toBe('gpt-4o');
      expect(raw['max_tokens']).toBe(1024);
      expect(raw['stream']).toBe(false);
    });

    it('converts system blocks to system message', () => {
      const canonical: CanonicalRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        maxTokens: 1024,
        stream: false,
        system: [{ type: 'text', text: 'You are helpful' }],
      };
      const result = codec.serializeRequest(canonical);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const raw = result.value as Record<string, unknown>;
      const messages = raw['messages'] as Array<Record<string, unknown>>;
      expect(messages[0]['role']).toBe('system');
      expect(messages[0]['content']).toBe('You are helpful');
      expect(messages[1]['role']).toBe('user');
    });

    it('wraps tools in function format', () => {
      const canonical: CanonicalRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Use tool' }] }],
        maxTokens: 1024,
        stream: false,
        tools: [
          {
            name: 'get_weather',
            description: 'Get weather',
            inputSchema: { type: 'object', properties: { location: { type: 'string' } } },
          },
        ],
      };
      const result = codec.serializeRequest(canonical);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const raw = result.value as Record<string, unknown>;
      const tools = raw['tools'] as Array<Record<string, unknown>>;
      expect(tools[0]['type']).toBe('function');
      const func = tools[0]['function'] as Record<string, unknown>;
      expect(func['name']).toBe('get_weather');
      expect(func['description']).toBe('Get weather');
      expect(func['parameters']).toEqual({
        type: 'object',
        properties: { location: { type: 'string' } },
      });
    });

    it('converts tool_use content to tool_calls message', () => {
      const canonical: CanonicalRequest = {
        model: 'gpt-4o',
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tc_1',
                name: 'get_weather',
                input: { location: 'Paris' },
              },
            ],
          },
        ],
        maxTokens: 1024,
        stream: false,
      };
      const result = codec.serializeRequest(canonical);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const raw = result.value as Record<string, unknown>;
      const messages = raw['messages'] as Array<Record<string, unknown>>;
      expect(messages[0]['role']).toBe('assistant');
      const toolCalls = messages[0]['tool_calls'] as Array<Record<string, unknown>>;
      expect(toolCalls[0]['id']).toBe('tc_1');
      const func = toolCalls[0]['function'] as Record<string, unknown>;
      expect(func['name']).toBe('get_weather');
      expect(func['arguments']).toBe(JSON.stringify({ location: 'Paris' }));
    });

    it('converts tool_result content to tool message', () => {
      const canonical: CanonicalRequest = {
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                toolUseId: 'tc_1',
                content: [{ type: 'text', text: 'Paris is sunny' }],
              },
            ],
          },
        ],
        maxTokens: 1024,
        stream: false,
      };
      const result = codec.serializeRequest(canonical);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const raw = result.value as Record<string, unknown>;
      const messages = raw['messages'] as Array<Record<string, unknown>>;
      expect(messages[0]['role']).toBe('tool');
      expect(messages[0]['tool_call_id']).toBe('tc_1');
      expect(messages[0]['content']).toBe('Paris is sunny');
    });

    it('maps maxTokens to max_tokens', () => {
      const canonical: CanonicalRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
        maxTokens: 2048,
        stream: false,
      };
      const result = codec.serializeRequest(canonical);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const raw = result.value as Record<string, unknown>;
      expect(raw['max_tokens']).toBe(2048);
    });

    it('maps thinking budget > 10000 to reasoning_effort "high"', () => {
      const canonical: CanonicalRequest = {
        model: 'o3',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Think' }] }],
        maxTokens: 16000,
        stream: false,
        thinking: { budgetTokens: 15000 },
      };
      const result = codec.serializeRequest(canonical);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const raw = result.value as Record<string, unknown>;
      expect(raw['reasoning_effort']).toBe('high');
    });

    it('maps thinking budget 3001-10000 to reasoning_effort "medium"', () => {
      const canonical: CanonicalRequest = {
        model: 'o3',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Think' }] }],
        maxTokens: 16000,
        stream: false,
        thinking: { budgetTokens: 5000 },
      };
      const result = codec.serializeRequest(canonical);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const raw = result.value as Record<string, unknown>;
      expect(raw['reasoning_effort']).toBe('medium');
    });

    it('maps thinking budget <= 3000 to reasoning_effort "low"', () => {
      const canonical: CanonicalRequest = {
        model: 'o3',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Think' }] }],
        maxTokens: 16000,
        stream: false,
        thinking: { budgetTokens: 1000 },
      };
      const result = codec.serializeRequest(canonical);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const raw = result.value as Record<string, unknown>;
      expect(raw['reasoning_effort']).toBe('low');
    });

    it('maps stopSequences to stop', () => {
      const canonical: CanonicalRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
        maxTokens: 512,
        stream: false,
        stopSequences: ['STOP', 'END'],
      };
      const result = codec.serializeRequest(canonical);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const raw = result.value as Record<string, unknown>;
      expect(raw['stop']).toEqual(['STOP', 'END']);
    });

    it('drops topK silently', () => {
      const canonical: CanonicalRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
        maxTokens: 512,
        stream: false,
        topK: 50,
      };
      const result = codec.serializeRequest(canonical);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const raw = result.value as Record<string, unknown>;
      expect(raw['top_k']).toBeUndefined();
    });

    it('truncates metadata.userId to 64 chars and maps to user', () => {
      const longUserId = 'u'.repeat(100);
      const canonical: CanonicalRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
        maxTokens: 512,
        stream: false,
        metadata: { userId: longUserId },
      };
      const result = codec.serializeRequest(canonical);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const raw = result.value as Record<string, unknown>;
      expect(typeof raw['user']).toBe('string');
      expect((raw['user'] as string).length).toBe(64);
    });

    it('passes short metadata.userId as user', () => {
      const canonical: CanonicalRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
        maxTokens: 512,
        stream: false,
        metadata: { userId: 'user123' },
      };
      const result = codec.serializeRequest(canonical);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const raw = result.value as Record<string, unknown>;
      expect(raw['user']).toBe('user123');
    });

    it('adds stream_options when streaming', () => {
      const canonical: CanonicalRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
        maxTokens: 512,
        stream: true,
      };
      const result = codec.serializeRequest(canonical);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const raw = result.value as Record<string, unknown>;
      expect(raw['stream_options']).toEqual({ include_usage: true });
    });

    it('does not add stream_options when not streaming', () => {
      const canonical: CanonicalRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
        maxTokens: 512,
        stream: false,
      };
      const result = codec.serializeRequest(canonical);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const raw = result.value as Record<string, unknown>;
      expect(raw['stream_options']).toBeUndefined();
    });

    it('serializes base64 image content', () => {
      const canonical: CanonicalRequest = {
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', mediaType: 'image/png', data: 'abc123' },
              },
            ],
          },
        ],
        maxTokens: 512,
        stream: false,
      };
      const result = codec.serializeRequest(canonical);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const raw = result.value as Record<string, unknown>;
      const messages = raw['messages'] as Array<Record<string, unknown>>;
      const content = messages[0]['content'] as Array<Record<string, unknown>>;
      expect(content[0]['type']).toBe('image_url');
      const imageUrl = content[0]['image_url'] as Record<string, unknown>;
      expect(imageUrl['url']).toBe('data:image/png;base64,abc123');
    });
  });

  // ==========================================
  // parseResponse
  // ==========================================

  describe('parseResponse', () => {
    it('parses a simple text response', () => {
      const raw = {
        id: 'chatcmpl-abc123',
        model: 'gpt-4o',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Hello world',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      };
      const result = codec.parseResponse(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.id).toBe('chatcmpl-abc123');
      expect(result.value.stopReason).toBe('end_turn');
      expect(result.value.content).toHaveLength(1);
      const content = result.value.content[0];
      expect(content.type).toBe('text');
      if (content.type === 'text') {
        expect(content.text).toBe('Hello world');
      }
      expect(result.value.usage.inputTokens).toBe(10);
      expect(result.value.usage.outputTokens).toBe(5);
    });

    it('handles null content (content_filter or empty)', () => {
      const raw = {
        id: 'chatcmpl-abc123',
        model: 'gpt-4o',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
            },
            finish_reason: 'content_filter',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
      };
      const result = codec.parseResponse(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.stopReason).toBe('content_filter');
      expect(result.value.content).toHaveLength(0);
    });

    it('parses tool_calls into tool_use blocks', () => {
      const raw = {
        id: 'chatcmpl-abc123',
        model: 'gpt-4o',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: '{"location":"Paris"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 },
      };
      const result = codec.parseResponse(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.stopReason).toBe('tool_use');
      const toolUse = result.value.content[0];
      expect(toolUse.type).toBe('tool_use');
      if (toolUse.type === 'tool_use') {
        expect(toolUse.id).toBe('call_1');
        expect(toolUse.name).toBe('get_weather');
        expect(toolUse.input).toEqual({ location: 'Paris' });
      }
    });

    it('handles malformed tool_calls arguments gracefully', () => {
      const raw = {
        id: 'chatcmpl-abc123',
        model: 'gpt-4o',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'my_tool',
                    arguments: 'INVALID JSON {{{',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 },
      };
      const result = codec.parseResponse(raw);
      // Should handle gracefully - either as error or empty input
      // The codec returns ok with empty input rather than failing
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const toolUse = result.value.content[0];
      expect(toolUse.type).toBe('tool_use');
      if (toolUse.type === 'tool_use') {
        // Malformed JSON results in empty input
        expect(toolUse.input).toEqual({});
      }
    });

    it('parses refusal into refusal block', () => {
      const raw = {
        id: 'chatcmpl-abc123',
        model: 'gpt-4o',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              refusal: 'I cannot help with that.',
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
      const result = codec.parseResponse(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const refusal = result.value.content[0];
      expect(refusal.type).toBe('refusal');
      if (refusal.type === 'refusal') {
        expect(refusal.refusal).toBe('I cannot help with that.');
      }
    });

    it('parses reasoning_content into thinking block', () => {
      const raw = {
        id: 'chatcmpl-abc123',
        model: 'o3',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Final answer',
              reasoning_content: 'I need to think about this...',
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 50, total_tokens: 60 },
      };
      const result = codec.parseResponse(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // thinking should come first
      expect(result.value.content[0].type).toBe('thinking');
      if (result.value.content[0].type === 'thinking') {
        expect(result.value.content[0].thinking).toBe('I need to think about this...');
      }
      expect(result.value.content[1].type).toBe('text');
    });

    it('maps finish_reason "stop" to "end_turn"', () => {
      const raw = {
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [{ message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      };
      const result = codec.parseResponse(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.stopReason).toBe('end_turn');
    });

    it('maps finish_reason "length" to "max_tokens"', () => {
      const raw = {
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [{ message: { role: 'assistant', content: 'Hi' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 5, completion_tokens: 100, total_tokens: 105 },
      };
      const result = codec.parseResponse(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.stopReason).toBe('max_tokens');
    });

    it('maps finish_reason "content_filter" to "content_filter"', () => {
      const raw = {
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [{ message: { role: 'assistant', content: null }, finish_reason: 'content_filter' }],
        usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
      };
      const result = codec.parseResponse(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.stopReason).toBe('content_filter');
    });

    it('parses cached_tokens into cacheReadInputTokens', () => {
      const raw = {
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [{ message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_tokens_details: { cached_tokens: 80 },
        },
      };
      const result = codec.parseResponse(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.usage.cacheReadInputTokens).toBe(80);
    });

    it('returns error for non-object input', () => {
      const result = codec.parseResponse(null);
      expect(result.ok).toBe(false);
    });

    it('returns error for missing choices', () => {
      const raw = {
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      };
      const result = codec.parseResponse(raw);
      expect(result.ok).toBe(false);
    });
  });

  // ==========================================
  // Stream parser
  // ==========================================

  describe('createStreamParser', () => {
    it('yields message_start on first chunk with role', () => {
      const parser = codec.createStreamParser();
      const chunk = {
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: '' },
            finish_reason: null,
          },
        ],
      };
      const events = parser.processChunk(chunk);
      expect(events.some((e) => e.type === 'message_start')).toBe(true);
    });

    it('yields content events for text delta', () => {
      const parser = codec.createStreamParser();

      // First chunk (role)
      parser.processChunk({
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      });

      // Text delta chunk
      const textChunk = {
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }],
      };
      const events = parser.processChunk(textChunk);
      expect(events.some((e) => e.type === 'content_delta')).toBe(true);
      const delta = events.find((e) => e.type === 'content_delta');
      if (delta && delta.type === 'content_delta') {
        expect(delta.text).toBe('hello');
      }
    });

    it('emits content_start before first text delta', () => {
      const parser = codec.createStreamParser();

      // First chunk (role)
      parser.processChunk({
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      });

      // Text delta
      const events = parser.processChunk({
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }],
      });

      expect(events.some((e) => e.type === 'content_start')).toBe(true);
    });

    it('does not repeat content_start for subsequent text deltas', () => {
      const parser = codec.createStreamParser();
      parser.processChunk({
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      });
      // First text
      parser.processChunk({
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }],
      });
      // Second text
      const events = parser.processChunk({
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null }],
      });
      expect(events.filter((e) => e.type === 'content_start')).toHaveLength(0);
    });

    it('yields tool_call_start on tool call delta', () => {
      const parser = codec.createStreamParser();
      parser.processChunk({
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      });

      const events = parser.processChunk({
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      expect(events.some((e) => e.type === 'tool_call_start')).toBe(true);
    });

    it('accumulates tool arguments across deltas', () => {
      const parser = codec.createStreamParser();
      parser.processChunk({
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      });
      parser.processChunk({
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', type: 'function', function: { name: 'my_tool', arguments: '{"key' } },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      const events = parser.processChunk({
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '":"val"}' } }],
            },
            finish_reason: null,
          },
        ],
      });
      expect(events.some((e) => e.type === 'tool_call_delta')).toBe(true);
    });

    it('emits message_stop on finish_reason', () => {
      const parser = codec.createStreamParser();
      parser.processChunk({
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      });
      parser.processChunk({
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
      });
      const events = parser.processChunk({
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      });
      expect(events.some((e) => e.type === 'message_stop')).toBe(true);
    });

    it('emits usage event for usage chunk', () => {
      const parser = codec.createStreamParser();
      const events = parser.processChunk({
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      expect(events.some((e) => e.type === 'usage')).toBe(true);
    });

    it('closes tool call block on finish_reason=tool_calls', () => {
      const parser = codec.createStreamParser();
      parser.processChunk({
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      });
      parser.processChunk({
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', type: 'function', function: { name: 'my_tool', arguments: '{}' } },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      const events = parser.processChunk({
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      });
      expect(events.some((e) => e.type === 'tool_call_stop')).toBe(true);
      expect(events.some((e) => e.type === 'message_stop')).toBe(true);
    });

    it('flush returns empty array', () => {
      const parser = codec.createStreamParser();
      expect(parser.flush()).toEqual([]);
    });
  });
});
