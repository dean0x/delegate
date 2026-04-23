/**
 * Type-level tests for the canonical IR types.
 * These are compile-time checks that the discriminated unions work correctly.
 */
import { describe, expect, it } from 'vitest';
import type {
  CanonicalContent,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStopReason,
  CanonicalStreamEvent,
  CanonicalSystemBlock,
  CanonicalToolChoice,
  CanonicalToolDefinition,
  CanonicalUsage,
} from '../../../src/translation/ir.js';

describe('Canonical IR types', () => {
  it('CanonicalContent discriminated union narrows correctly on type field', () => {
    const content: CanonicalContent = { type: 'text', text: 'hello' };
    if (content.type === 'text') {
      expect(content.text).toBe('hello');
    } else {
      // Should not reach here
      expect(false).toBe(true);
    }
  });

  it('CanonicalContent covers all expected variants', () => {
    const text: CanonicalContent = { type: 'text', text: 'hi' };
    const image: CanonicalContent = {
      type: 'image',
      source: { type: 'base64', mediaType: 'image/png', data: 'abc' },
    };
    const toolUse: CanonicalContent = { type: 'tool_use', id: 'id1', name: 'my_tool', input: {} };
    const toolResult: CanonicalContent = { type: 'tool_result', toolUseId: 'id1', content: [] };
    const thinking: CanonicalContent = { type: 'thinking', thinking: 'thought' };
    const redactedThinking: CanonicalContent = { type: 'redacted_thinking' };
    const document: CanonicalContent = {
      type: 'document',
      source: { type: 'base64', mediaType: 'application/pdf', data: 'pdf' },
    };
    const json: CanonicalContent = { type: 'json', data: { key: 'val' } };
    const refusal: CanonicalContent = { type: 'refusal', refusal: 'I cannot do that' };

    expect(text.type).toBe('text');
    expect(image.type).toBe('image');
    expect(toolUse.type).toBe('tool_use');
    expect(toolResult.type).toBe('tool_result');
    expect(thinking.type).toBe('thinking');
    expect(redactedThinking.type).toBe('redacted_thinking');
    expect(document.type).toBe('document');
    expect(json.type).toBe('json');
    expect(refusal.type).toBe('refusal');
  });

  it('CanonicalMessage holds role and content array', () => {
    const msg: CanonicalMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
    };
    expect(msg.role).toBe('user');
    expect(msg.content).toHaveLength(1);
  });

  it('CanonicalSystemBlock has text and optional cacheControl', () => {
    const block: CanonicalSystemBlock = { type: 'text', text: 'You are a helpful assistant' };
    expect(block.text).toBe('You are a helpful assistant');

    const blockWithCache: CanonicalSystemBlock = {
      type: 'text',
      text: 'Cached system',
      cacheControl: { type: 'ephemeral' },
    };
    expect(blockWithCache.cacheControl?.type).toBe('ephemeral');
  });

  it('CanonicalToolDefinition has required fields', () => {
    const tool: CanonicalToolDefinition = {
      name: 'my_tool',
      description: 'A tool',
      inputSchema: { type: 'object', properties: {} },
    };
    expect(tool.name).toBe('my_tool');
    expect(tool.inputSchema).toBeDefined();
  });

  it('CanonicalToolChoice covers all variants', () => {
    const auto: CanonicalToolChoice = { type: 'auto' };
    const required: CanonicalToolChoice = { type: 'required' };
    const none: CanonicalToolChoice = { type: 'none' };
    const specific: CanonicalToolChoice = { type: 'specific', name: 'my_tool' };

    expect(auto.type).toBe('auto');
    expect(required.type).toBe('required');
    expect(none.type).toBe('none');
    expect(specific.name).toBe('my_tool');
  });

  it('CanonicalRequest has all required fields', () => {
    const request: CanonicalRequest = {
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      maxTokens: 1024,
      stream: false,
    };
    expect(request.model).toBeDefined();
    expect(request.messages).toHaveLength(1);
    expect(request.maxTokens).toBe(1024);
    expect(request.stream).toBe(false);
  });

  it('CanonicalResponse has required fields', () => {
    const response: CanonicalResponse = {
      id: 'msg_123',
      model: 'claude-3-5-sonnet-20241022',
      content: [{ type: 'text', text: 'hello' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    expect(response.id).toBeDefined();
    expect(response.stopReason).toBe('end_turn');
  });

  it('CanonicalStopReason accepts null', () => {
    const stopReason: CanonicalStopReason = null;
    expect(stopReason).toBeNull();
  });

  it('CanonicalStreamEvent discriminated union works correctly', () => {
    const events: CanonicalStreamEvent[] = [
      { type: 'message_start', id: 'msg_1', model: 'claude-3' },
      { type: 'content_start', index: 0, contentType: 'text' },
      { type: 'content_delta', index: 0, text: 'hello' },
      { type: 'content_stop', index: 0 },
      { type: 'tool_call_start', index: 1, id: 'tc_1', name: 'tool' },
      { type: 'tool_call_delta', index: 1, arguments: '{"key":' },
      { type: 'tool_call_stop', index: 1, arguments: '{"key":"val"}' },
      { type: 'thinking_delta', thinking: 'thinking...' },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'message_stop', stopReason: 'end_turn' },
    ];
    expect(events).toHaveLength(10);
    expect(events[0].type).toBe('message_start');
    expect(events[9].type).toBe('message_stop');
  });

  it('CanonicalUsage has optional cache and reasoning token fields', () => {
    const usage: CanonicalUsage = {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 80,
      cacheCreationInputTokens: 20,
      reasoningTokens: 100,
    };
    expect(usage.cacheReadInputTokens).toBe(80);
    expect(usage.reasoningTokens).toBe(100);
  });
});
