/**
 * Tests for tool name mapping middleware
 */
import { describe, expect, it } from 'vitest';
import type { CanonicalRequest, CanonicalResponse } from '../../../../src/translation/ir.js';
import { ToolNameMappingMiddleware } from '../../../../src/translation/middleware/tool-name-mapping.js';

describe('ToolNameMappingMiddleware', () => {
  it('passes through tool names shorter than 64 chars unchanged', () => {
    const middleware = new ToolNameMappingMiddleware();
    const request: CanonicalRequest = {
      model: 'gpt-4o',
      messages: [],
      maxTokens: 1024,
      stream: false,
      tools: [
        { name: 'get_weather', description: 'Get weather', inputSchema: {} },
        { name: 'search_web', description: 'Search web', inputSchema: {} },
      ],
    };
    const processed = middleware.processRequest!(request);
    expect(processed.tools![0].name).toBe('get_weather');
    expect(processed.tools![1].name).toBe('search_web');
  });

  it('passes through 64-char name unchanged', () => {
    const middleware = new ToolNameMappingMiddleware();
    const name64 = 'a'.repeat(64);
    const request: CanonicalRequest = {
      model: 'gpt-4o',
      messages: [],
      maxTokens: 1024,
      stream: false,
      tools: [{ name: name64, inputSchema: {} }],
    };
    const processed = middleware.processRequest!(request);
    expect(processed.tools![0].name).toBe(name64);
  });

  it('truncates names longer than 64 chars with SHA256 suffix', () => {
    const middleware = new ToolNameMappingMiddleware();
    const longName = 'a_very_long_tool_name_that_exceeds_the_sixty_four_character_limit_by_a_lot';
    expect(longName.length).toBeGreaterThan(64);

    const request: CanonicalRequest = {
      model: 'gpt-4o',
      messages: [],
      maxTokens: 1024,
      stream: false,
      tools: [{ name: longName, inputSchema: {} }],
    };
    const processed = middleware.processRequest!(request);
    const truncatedName = processed.tools![0].name;
    expect(truncatedName.length).toBeLessThanOrEqual(64);
    expect(truncatedName).toContain('_');
    // Format: first 53 chars + _ + 10 char SHA256 prefix
    expect(truncatedName.length).toBe(64);
  });

  it('reverse-maps truncated name back to original in response', () => {
    const middleware = new ToolNameMappingMiddleware();
    const longName = 'a_very_long_tool_name_that_exceeds_the_sixty_four_character_limit_for_openai';

    // First process the request (builds the mapping)
    const request: CanonicalRequest = {
      model: 'gpt-4o',
      messages: [],
      maxTokens: 1024,
      stream: false,
      tools: [{ name: longName, inputSchema: {} }],
    };
    middleware.processRequest!(request);

    // Now process a response with the truncated name
    const processedReq = middleware.processRequest!(request);
    const truncatedName = processedReq.tools![0].name;

    const response: CanonicalResponse = {
      id: 'msg_1',
      model: 'gpt-4o',
      content: [{ type: 'tool_use', id: 'tc_1', name: truncatedName, input: {} }],
      stopReason: 'tool_use',
      usage: { inputTokens: 10, outputTokens: 20 },
    };
    const processedResponse = middleware.processResponse!(response);
    const toolUse = processedResponse.content[0];
    if (toolUse.type === 'tool_use') {
      expect(toolUse.name).toBe(longName);
    } else {
      expect(false).toBe(true); // Should be tool_use
    }
  });

  it('multiple truncated names maintain uniqueness', () => {
    const middleware = new ToolNameMappingMiddleware();
    const longName1 = 'namespace_moduleA_submoduleB_functionC_veryLongSuffix_that_exceeds_limit';
    const longName2 = 'namespace_moduleA_submoduleB_functionD_differentSuffix_that_exceeds_limit';

    const request: CanonicalRequest = {
      model: 'gpt-4o',
      messages: [],
      maxTokens: 1024,
      stream: false,
      tools: [
        { name: longName1, inputSchema: {} },
        { name: longName2, inputSchema: {} },
      ],
    };
    const processed = middleware.processRequest!(request);
    const name1 = processed.tools![0].name;
    const name2 = processed.tools![1].name;
    // Names should be different even with same prefix
    expect(name1).not.toBe(name2);
    expect(name1.length).toBeLessThanOrEqual(64);
    expect(name2.length).toBeLessThanOrEqual(64);
  });

  it('returns original request unchanged if no tools', () => {
    const middleware = new ToolNameMappingMiddleware();
    const request: CanonicalRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      maxTokens: 512,
      stream: false,
    };
    const processed = middleware.processRequest!(request);
    expect(processed.tools).toBeUndefined();
  });

  it('returns original response unchanged if no tool_use blocks', () => {
    const middleware = new ToolNameMappingMiddleware();
    const response: CanonicalResponse = {
      id: 'msg_1',
      model: 'gpt-4o',
      content: [{ type: 'text', text: 'hello' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    const processed = middleware.processResponse!(response);
    expect(processed.content[0].type).toBe('text');
  });

  it('does not re-map names that fit within 64 chars', () => {
    const middleware = new ToolNameMappingMiddleware();
    const shortName = 'short_name';
    const request: CanonicalRequest = {
      model: 'gpt-4o',
      messages: [],
      maxTokens: 512,
      stream: false,
      tools: [{ name: shortName, inputSchema: {} }],
    };
    const processed = middleware.processRequest!(request);
    const response: CanonicalResponse = {
      id: 'msg_1',
      model: 'gpt-4o',
      content: [{ type: 'tool_use', id: 'tc_1', name: shortName, input: {} }],
      stopReason: 'tool_use',
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    const processedResponse = middleware.processResponse!(response);
    const toolUse = processedResponse.content[0];
    if (toolUse.type === 'tool_use') {
      expect(toolUse.name).toBe(shortName);
    }
  });

  it('handles stream events with tool names', () => {
    const middleware = new ToolNameMappingMiddleware();
    const longName = 'a_very_long_tool_name_that_exceeds_the_sixty_four_character_limit_by_a_lot';
    const request: CanonicalRequest = {
      model: 'gpt-4o',
      messages: [],
      maxTokens: 1024,
      stream: true,
      tools: [{ name: longName, inputSchema: {} }],
    };
    const processed = middleware.processRequest!(request);
    const truncatedName = processed.tools![0].name;

    // Stream event with truncated name should be reverse-mapped
    const event = middleware.processStreamEvent!({
      type: 'tool_call_start',
      index: 0,
      id: 'tc_1',
      name: truncatedName,
    });
    if (event && event.type === 'tool_call_start') {
      expect(event.name).toBe(longName);
    } else {
      expect(false).toBe(true);
    }
  });
});
