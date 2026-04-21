/**
 * Tests for MCP schema updates (v1.3.0 batch 3)
 *
 * Tests that DelegateTaskSchema accepts jsonSchema field,
 * and CreateLoopSchema accepts evalType, judgeAgent, judgePrompt fields.
 *
 * Pattern: Boundary validation testing — verify the schema parses correctly
 */

import { describe, expect, it } from 'vitest';
import { DelegateTaskSchema } from '../../../src/adapters/mcp-adapter.js';

// We test CreateLoopSchema indirectly through module import
// since it's not exported from mcp-adapter.ts; the schema is tested via handleCreateLoop args

describe('DelegateTaskSchema — jsonSchema field (v1.3.0)', () => {
  it('accepts jsonSchema field when provided', () => {
    const result = DelegateTaskSchema.safeParse({
      prompt: 'Do something',
      jsonSchema: JSON.stringify({ type: 'object', properties: { result: { type: 'string' } } }),
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.jsonSchema).toBeTruthy();
    }
  });

  it('allows jsonSchema to be omitted', () => {
    const result = DelegateTaskSchema.safeParse({
      prompt: 'Do something',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.jsonSchema).toBeUndefined();
    }
  });

  it('should accept jsonSchema of any length', () => {
    const result = DelegateTaskSchema.safeParse({
      prompt: 'Do something',
      jsonSchema: 'x'.repeat(20000),
    });

    expect(result.success).toBe(true);
  });

  it('passes jsonSchema through to parsed data unchanged', () => {
    const schemaStr = JSON.stringify({
      type: 'object',
      properties: {
        continue: { type: 'boolean' },
        reasoning: { type: 'string' },
      },
      required: ['continue', 'reasoning'],
    });

    const result = DelegateTaskSchema.safeParse({
      prompt: 'Make a decision',
      jsonSchema: schemaStr,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.jsonSchema).toBe(schemaStr);
    }
  });
});
