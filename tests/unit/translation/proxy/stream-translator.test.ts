/**
 * Tests for stream translator
 */
import { describe, expect, it } from 'vitest';
import { AnthropicCodec } from '../../../../src/translation/codecs/anthropic-codec.js';
import { OpenAICodec } from '../../../../src/translation/codecs/openai-codec.js';
import { StreamTranslator } from '../../../../src/translation/proxy/stream-translator.js';

function makeTranslator() {
  const anthropicCodec = new AnthropicCodec();
  const openaiCodec = new OpenAICodec();
  return new StreamTranslator(anthropicCodec.createStreamSerializer(), openaiCodec.createStreamParser(), []);
}

describe('StreamTranslator', () => {
  it('processes a complete text streaming sequence', () => {
    const translator = makeTranslator();

    // First SSE chunk from OpenAI (role)
    const roleChunk = JSON.stringify({
      id: 'chatcmpl-1',
      model: 'gpt-4o',
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    });
    const lines1 = translator.processLine(`data: ${roleChunk}`);
    // Should produce some Anthropic SSE output
    const output1 = lines1.join('\n');
    // message_start event should appear
    expect(output1).toContain('message_start');

    // Text delta
    const textChunk = JSON.stringify({
      id: 'chatcmpl-1',
      model: 'gpt-4o',
      choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
    });
    const lines2 = translator.processLine(`data: ${textChunk}`);
    const output2 = lines2.join('\n');
    expect(output2).toContain('Hello');

    // Finish
    const finishChunk = JSON.stringify({
      id: 'chatcmpl-1',
      model: 'gpt-4o',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    });
    const lines3 = translator.processLine(`data: ${finishChunk}`);
    const output3 = lines3.join('\n');
    expect(output3).toContain('message_stop');
  });

  it('handles [DONE] sentinel gracefully', () => {
    const translator = makeTranslator();
    // [DONE] should not throw or produce garbage output
    const lines = translator.processLine('data: [DONE]');
    expect(Array.isArray(lines)).toBe(true);
    // [DONE] should be a no-op (produce empty or ping)
    expect(lines.length).toBe(0);
  });

  it('ignores event: lines', () => {
    const translator = makeTranslator();
    const lines = translator.processLine('event: message');
    expect(lines).toEqual([]);
  });

  it('ignores comment lines', () => {
    const translator = makeTranslator();
    const lines = translator.processLine(': keep-alive');
    expect(lines).toEqual([]);
  });

  it('ignores empty lines', () => {
    const translator = makeTranslator();
    const lines = translator.processLine('');
    expect(lines).toEqual([]);
  });

  it('processes tool call streaming', () => {
    const translator = makeTranslator();

    // Role chunk
    translator.processLine(
      `data: ${JSON.stringify({
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      })}`,
    );

    // Tool call start
    const toolChunk = JSON.stringify({
      id: 'chatcmpl-1',
      model: 'gpt-4o',
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'my_tool', arguments: '' } }],
          },
          finish_reason: null,
        },
      ],
    });
    const lines = translator.processLine(`data: ${toolChunk}`);
    const output = lines.join('\n');
    expect(output).toContain('tool_use');
  });

  it('flush returns empty array when no pending state', () => {
    const translator = makeTranslator();
    const lines = translator.flush();
    expect(Array.isArray(lines)).toBe(true);
  });

  it('handles invalid JSON in data line gracefully', () => {
    const translator = makeTranslator();
    // Should not throw
    expect(() => translator.processLine('data: INVALID JSON')).not.toThrow();
    const lines = translator.processLine('data: INVALID JSON');
    expect(Array.isArray(lines)).toBe(true);
  });

  it('processes mixed content (text + tool call)', () => {
    const translator = makeTranslator();

    translator.processLine(
      `data: ${JSON.stringify({
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      })}`,
    );

    translator.processLine(
      `data: ${JSON.stringify({
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { content: 'Let me check' }, finish_reason: null }],
      })}`,
    );

    const toolLines = translator.processLine(
      `data: ${JSON.stringify({
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'tool', arguments: '{}' } }],
            },
            finish_reason: null,
          },
        ],
      })}`,
    );
    const output = toolLines.join('\n');
    // Should see content_stop for text block before tool_call_start
    expect(output).toContain('content_block_stop');
  });
});
