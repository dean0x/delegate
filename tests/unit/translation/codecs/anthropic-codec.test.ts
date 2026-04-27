/**
 * Tests for the Anthropic codec (source codec — receives from Claude Code)
 */
import { describe, expect, it } from 'vitest';
import { AnthropicCodec } from '../../../../src/translation/codecs/anthropic-codec.js';
import type { CanonicalContent, CanonicalRequest, CanonicalResponse } from '../../../../src/translation/ir.js';

describe('AnthropicCodec', () => {
  const codec = new AnthropicCodec();

  // ==========================================
  // parseRequest
  // ==========================================

  describe('parseRequest', () => {
    it('parses a simple text message request', () => {
      const raw = {
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 1024,
        stream: false,
      };
      const result = codec.parseRequest(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.model).toBe('claude-3-5-sonnet-20241022');
      expect(result.value.maxTokens).toBe(1024);
      expect(result.value.stream).toBe(false);
      expect(result.value.messages).toHaveLength(1);
      expect(result.value.messages[0].role).toBe('user');
      expect(result.value.messages[0].content).toHaveLength(1);
      const content = result.value.messages[0].content[0];
      expect(content.type).toBe('text');
      if (content.type === 'text') {
        expect(content.text).toBe('Hello');
      }
    });

    it('normalizes string content to text content block', () => {
      const raw = {
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: 'Just a string' }],
        max_tokens: 512,
      };
      const result = codec.parseRequest(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const content = result.value.messages[0].content[0];
      expect(content.type).toBe('text');
      if (content.type === 'text') {
        expect(content.text).toBe('Just a string');
      }
    });

    it('preserves array content blocks', () => {
      const raw = {
        model: 'claude-3-5-sonnet-20241022',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'First' },
              { type: 'text', text: 'Second' },
            ],
          },
        ],
        max_tokens: 256,
      };
      const result = codec.parseRequest(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.messages[0].content).toHaveLength(2);
    });

    it('parses multi-turn conversation', () => {
      const raw = {
        model: 'claude-3-5-sonnet-20241022',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there' },
          { role: 'user', content: 'How are you?' },
        ],
        max_tokens: 512,
      };
      const result = codec.parseRequest(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.messages).toHaveLength(3);
      expect(result.value.messages[1].role).toBe('assistant');
    });

    it('parses system prompt as array of system blocks', () => {
      const raw = {
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 512,
        system: [{ type: 'text', text: 'You are helpful', cache_control: { type: 'ephemeral' } }],
      };
      const result = codec.parseRequest(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.system).toHaveLength(1);
      expect(result.value.system![0].text).toBe('You are helpful');
      expect(result.value.system![0].cacheControl?.type).toBe('ephemeral');
    });

    it('parses string system to system blocks array', () => {
      const raw = {
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 512,
        system: 'You are a helpful assistant',
      };
      const result = codec.parseRequest(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.system).toHaveLength(1);
      expect(result.value.system![0].text).toBe('You are a helpful assistant');
    });

    it('parses tools with input_schema mapping', () => {
      const raw = {
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: 'Use a tool' }],
        max_tokens: 512,
        tools: [
          {
            name: 'get_weather',
            description: 'Get weather for a location',
            input_schema: {
              type: 'object',
              properties: { location: { type: 'string' } },
              required: ['location'],
            },
          },
        ],
      };
      const result = codec.parseRequest(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.tools).toHaveLength(1);
      expect(result.value.tools![0].name).toBe('get_weather');
      expect(result.value.tools![0].inputSchema).toBeDefined();
      expect(result.value.tools![0].inputSchema.type).toBe('object');
    });

    it('maps tool_choice type "any" to "required"', () => {
      const raw = {
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: 'Use a tool' }],
        max_tokens: 512,
        tools: [{ name: 'my_tool', input_schema: {} }],
        tool_choice: { type: 'any' },
      };
      const result = codec.parseRequest(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.toolChoice?.type).toBe('required');
    });

    it('maps tool_choice type "tool" to "specific"', () => {
      const raw = {
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: 'Use a specific tool' }],
        max_tokens: 512,
        tools: [{ name: 'my_tool', input_schema: {} }],
        tool_choice: { type: 'tool', name: 'my_tool' },
      };
      const result = codec.parseRequest(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.toolChoice?.type).toBe('specific');
      expect(result.value.toolChoice?.name).toBe('my_tool');
    });

    it('maps tool_choice type "auto" to "auto"', () => {
      const raw = {
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: 'Use tools' }],
        max_tokens: 512,
        tool_choice: { type: 'auto' },
      };
      const result = codec.parseRequest(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.toolChoice?.type).toBe('auto');
    });

    it('parses thinking with budget_tokens mapping', () => {
      const raw = {
        model: 'claude-3-7-sonnet-20250219',
        messages: [{ role: 'user', content: 'Think hard' }],
        max_tokens: 16000,
        thinking: { type: 'enabled', budget_tokens: 10000 },
      };
      const result = codec.parseRequest(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.thinking?.budgetTokens).toBe(10000);
    });

    it('parses stop_sequences', () => {
      const raw = {
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 512,
        stop_sequences: ['STOP', 'END'],
      };
      const result = codec.parseRequest(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.stopSequences).toEqual(['STOP', 'END']);
    });

    it('parses temperature and top_p', () => {
      const raw = {
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 512,
        temperature: 0.7,
        top_p: 0.9,
      };
      const result = codec.parseRequest(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.temperature).toBe(0.7);
      expect(result.value.topP).toBe(0.9);
    });

    it('defaults stream to false when not provided', () => {
      const raw = {
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 512,
      };
      const result = codec.parseRequest(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.stream).toBe(false);
    });

    it('returns error for missing model', () => {
      const raw = {
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 512,
      };
      const result = codec.parseRequest(raw);
      expect(result.ok).toBe(false);
    });

    it('returns error for missing messages', () => {
      const raw = {
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 512,
      };
      const result = codec.parseRequest(raw);
      expect(result.ok).toBe(false);
    });

    it('returns error for missing max_tokens', () => {
      const raw = {
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: 'Hello' }],
      };
      const result = codec.parseRequest(raw);
      expect(result.ok).toBe(false);
    });

    it('returns error for non-object input', () => {
      const result = codec.parseRequest(null);
      expect(result.ok).toBe(false);
    });

    it('parses tool_result messages', () => {
      const raw = {
        model: 'claude-3-5-sonnet-20241022',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tc_1',
                content: [{ type: 'text', text: 'The result is 42' }],
              },
            ],
          },
        ],
        max_tokens: 512,
      };
      const result = codec.parseRequest(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const content = result.value.messages[0].content[0];
      expect(content.type).toBe('tool_result');
      if (content.type === 'tool_result') {
        expect(content.toolUseId).toBe('tc_1');
        expect(content.content).toHaveLength(1);
      }
    });
  });

  // ==========================================
  // serializeResponse
  // ==========================================

  describe('serializeResponse', () => {
    it('serializes a text response', () => {
      const canonical: CanonicalResponse = {
        id: 'msg_abc123',
        model: 'gpt-4o',
        content: [{ type: 'text', text: 'Hello world' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      };
      const result = codec.serializeResponse(canonical);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const raw = result.value as Record<string, unknown>;
      expect(raw['type']).toBe('message');
      expect(raw['role']).toBe('assistant');
      expect(Array.isArray(raw['content'])).toBe(true);
      const content = raw['content'] as Array<Record<string, unknown>>;
      expect(content[0]['type']).toBe('text');
      expect(content[0]['text']).toBe('Hello world');
    });

    it('synthesizes ID with msg_proxy_ prefix', () => {
      const canonical: CanonicalResponse = {
        id: 'chatcmpl-abc123',
        model: 'gpt-4o',
        content: [{ type: 'text', text: 'Hello' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      };
      const result = codec.serializeResponse(canonical);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const raw = result.value as Record<string, unknown>;
      expect(raw['id']).toBe('msg_proxy_chatcmpl-abc123');
    });

    it('maps stop reason end_turn to stop_reason', () => {
      const canonical: CanonicalResponse = {
        id: 'msg_1',
        model: 'gpt-4o',
        content: [{ type: 'text', text: 'Done' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      };
      const result = codec.serializeResponse(canonical);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const raw = result.value as Record<string, unknown>;
      expect(raw['stop_reason']).toBe('end_turn');
    });

    it('maps stop reason tool_use correctly', () => {
      const canonical: CanonicalResponse = {
        id: 'msg_1',
        model: 'gpt-4o',
        content: [{ type: 'tool_use', id: 'tc_1', name: 'my_tool', input: {} }],
        stopReason: 'tool_use',
        usage: { inputTokens: 10, outputTokens: 20 },
      };
      const result = codec.serializeResponse(canonical);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const raw = result.value as Record<string, unknown>;
      expect(raw['stop_reason']).toBe('tool_use');
    });

    it('serializes tool_use content block', () => {
      const canonical: CanonicalResponse = {
        id: 'msg_1',
        model: 'gpt-4o',
        content: [{ type: 'tool_use', id: 'tc_1', name: 'my_tool', input: { key: 'val' } }],
        stopReason: 'tool_use',
        usage: { inputTokens: 10, outputTokens: 20 },
      };
      const result = codec.serializeResponse(canonical);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const raw = result.value as Record<string, unknown>;
      const content = raw['content'] as Array<Record<string, unknown>>;
      expect(content[0]['type']).toBe('tool_use');
      expect(content[0]['id']).toBe('tc_1');
      expect(content[0]['name']).toBe('my_tool');
      expect(content[0]['input']).toEqual({ key: 'val' });
    });

    it('serializes thinking content block', () => {
      const canonical: CanonicalResponse = {
        id: 'msg_1',
        model: 'claude-3-7-sonnet',
        content: [
          { type: 'thinking', thinking: 'Let me think...', signature: 'sig123' },
          { type: 'text', text: 'Done' },
        ],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 100 },
      };
      const result = codec.serializeResponse(canonical);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const raw = result.value as Record<string, unknown>;
      const content = raw['content'] as Array<Record<string, unknown>>;
      expect(content[0]['type']).toBe('thinking');
      expect(content[0]['thinking']).toBe('Let me think...');
      expect(content[0]['signature']).toBe('sig123');
    });

    it('serializes usage with Anthropic field names', () => {
      const canonical: CanonicalResponse = {
        id: 'msg_1',
        model: 'gpt-4o',
        content: [{ type: 'text', text: 'Hi' }],
        stopReason: 'end_turn',
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 80,
          cacheCreationInputTokens: 20,
        },
      };
      const result = codec.serializeResponse(canonical);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const raw = result.value as Record<string, unknown>;
      const usage = raw['usage'] as Record<string, unknown>;
      expect(usage['input_tokens']).toBe(100);
      expect(usage['output_tokens']).toBe(50);
      expect(usage['cache_read_input_tokens']).toBe(80);
      expect(usage['cache_creation_input_tokens']).toBe(20);
    });
  });

  // ==========================================
  // Stream serializer
  // ==========================================

  describe('createStreamSerializer', () => {
    it('serializes message_start event with named SSE events', () => {
      const serializer = codec.createStreamSerializer();
      const lines = serializer.serialize({ type: 'message_start', id: 'msg_1', model: 'gpt-4o' });
      // Anthropic SSE uses named events
      expect(lines.length).toBeGreaterThan(0);
      const joined = lines.join('\n');
      expect(joined).toContain('event: message_start');
      expect(joined).toContain('"type":"message_start"');
      // The serializer wraps the ID with msg_proxy_ prefix
      expect(joined).toContain('"id":"msg_proxy_msg_1"');
    });

    it('serializes content_delta event', () => {
      const serializer = codec.createStreamSerializer();
      const lines = serializer.serialize({ type: 'content_delta', index: 0, text: 'hello' });
      const joined = lines.join('\n');
      expect(joined).toContain('event: content_block_delta');
      expect(joined).toContain('"text":"hello"');
    });

    it('serializes content_start event', () => {
      const serializer = codec.createStreamSerializer();
      const lines = serializer.serialize({ type: 'content_start', index: 0, contentType: 'text' });
      const joined = lines.join('\n');
      expect(joined).toContain('event: content_block_start');
    });

    it('serializes content_stop event', () => {
      const serializer = codec.createStreamSerializer();
      const lines = serializer.serialize({ type: 'content_stop', index: 0 });
      const joined = lines.join('\n');
      expect(joined).toContain('event: content_block_stop');
    });

    it('serializes message_stop event', () => {
      const serializer = codec.createStreamSerializer();
      const lines = serializer.serialize({ type: 'message_stop', stopReason: 'end_turn' });
      const joined = lines.join('\n');
      expect(joined).toContain('event: message_delta');
      expect(joined).toContain('event: message_stop');
    });

    it('serializes tool_call_start event', () => {
      const serializer = codec.createStreamSerializer();
      const lines = serializer.serialize({
        type: 'tool_call_start',
        index: 0,
        id: 'tc_1',
        name: 'my_tool',
      });
      const joined = lines.join('\n');
      expect(joined).toContain('event: content_block_start');
      expect(joined).toContain('tool_use');
      expect(joined).toContain('my_tool');
    });

    it('serializes tool_call_delta event', () => {
      const serializer = codec.createStreamSerializer();
      const lines = serializer.serialize({
        type: 'tool_call_delta',
        index: 0,
        arguments: '{"key":',
      });
      const joined = lines.join('\n');
      expect(joined).toContain('event: content_block_delta');
      expect(joined).toContain('input_json_delta');
    });

    it('serializes thinking_start event', () => {
      const serializer = codec.createStreamSerializer();
      const lines = serializer.serialize({ type: 'thinking_start', index: 0 });
      const joined = lines.join('\n');
      expect(joined).toContain('event: content_block_start');
      expect(joined).toContain('thinking');
      const data = JSON.parse(lines[1].replace('data: ', '')) as {
        index: number;
        content_block: { type: string };
      };
      expect(data.index).toBe(0);
      expect(data.content_block.type).toBe('thinking');
    });

    it('serializes thinking_delta event', () => {
      const serializer = codec.createStreamSerializer();
      const lines = serializer.serialize({ type: 'thinking_delta', index: 0, thinking: 'thinking...' });
      const joined = lines.join('\n');
      expect(joined).toContain('thinking_delta');
      expect(joined).toContain('index');
    });

    it('serializes thinking_stop event', () => {
      const serializer = codec.createStreamSerializer();
      const lines = serializer.serialize({ type: 'thinking_stop', index: 0 });
      const joined = lines.join('\n');
      expect(joined).toContain('event: content_block_stop');
      const data = JSON.parse(lines[1].replace('data: ', '')) as { index: number };
      expect(data.index).toBe(0);
    });

    it('serializes thinking_delta with non-zero index', () => {
      const serializer = codec.createStreamSerializer();
      const lines = serializer.serialize({ type: 'thinking_delta', index: 2, thinking: 'hmm' });
      const data = JSON.parse(lines[1].replace('data: ', '')) as { index: number };
      expect(data.index).toBe(2);
    });
  });
});
