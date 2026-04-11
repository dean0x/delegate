/**
 * Unit tests for parseClaudeUsage
 * ARCHITECTURE: Pure-function tests — no I/O, no DB, no spies.
 * Pattern: Input/output verification with edge cases at every guard boundary.
 */

import { describe, expect, it } from 'vitest';
import type { TaskOutput } from '../../../src/core/domain.js';
import { parseClaudeUsage } from '../../../src/services/usage-parser.js';

// Minimal valid Claude JSON result message
const makeOutput = (stdout: string[]): TaskOutput => ({
  stdout,
  stderr: [],
  totalSize: stdout.join('').length,
});

const validResultJson = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'result',
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 5,
    },
    total_cost_usd: 0.001234,
    model: 'claude-3-5-sonnet-20241022',
    ...overrides,
  });

describe('parseClaudeUsage', () => {
  describe('happy path', () => {
    it('parses a minimal valid result JSON at end of stdout', () => {
      const output = makeOutput([validResultJson()]);
      const result = parseClaudeUsage(output, undefined);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).not.toBeNull();

      const usage = result.value!;
      expect(usage.inputTokens).toBe(100);
      expect(usage.outputTokens).toBe(50);
      expect(usage.cacheCreationInputTokens).toBe(10);
      expect(usage.cacheReadInputTokens).toBe(5);
      expect(usage.totalCostUsd).toBeCloseTo(0.001234);
      expect(usage.model).toBe('claude-3-5-sonnet-20241022');
    });

    it('parses result JSON embedded in multi-chunk output', () => {
      const prefix = 'Some output text\nMore output\n';
      const output = makeOutput([prefix, validResultJson()]);
      const result = parseClaudeUsage(output, undefined);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).not.toBeNull();
      expect(result.value!.inputTokens).toBe(100);
    });

    it('takes the LAST result JSON when multiple are present', () => {
      const first = JSON.stringify({
        type: 'result',
        usage: { input_tokens: 1, output_tokens: 1 },
        total_cost_usd: 0.0001,
      });
      const second = JSON.stringify({
        type: 'result',
        usage: { input_tokens: 999, output_tokens: 888 },
        total_cost_usd: 5.5,
      });
      const output = makeOutput([first, '\n', second]);
      const result = parseClaudeUsage(output, undefined);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).not.toBeNull();
      expect(result.value!.inputTokens).toBe(999);
      expect(result.value!.outputTokens).toBe(888);
    });

    it('falls back to task model when result JSON has no model field', () => {
      const json = JSON.stringify({
        type: 'result',
        usage: { input_tokens: 100, output_tokens: 50 },
        total_cost_usd: 0.001,
      });
      const output = makeOutput([json]);
      const result = parseClaudeUsage(output, 'claude-3-haiku-20240307');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).not.toBeNull();
      expect(result.value!.model).toBe('claude-3-haiku-20240307');
    });

    it('defaults cache tokens to 0 when absent', () => {
      const json = JSON.stringify({
        type: 'result',
        usage: { input_tokens: 10, output_tokens: 5 },
        total_cost_usd: 0.0001,
      });
      const output = makeOutput([json]);
      const result = parseClaudeUsage(output, undefined);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).not.toBeNull();
      expect(result.value!.cacheCreationInputTokens).toBe(0);
      expect(result.value!.cacheReadInputTokens).toBe(0);
    });

    it('returns ok(null) for non-claude / plain text output', () => {
      const output = makeOutput(['Just plain stdout text\nNo JSON here\n']);
      const result = parseClaudeUsage(output, undefined);

      expect(result.ok).toBe(true);
      expect(result.value).toBeNull();
    });
  });

  describe('empty / missing output', () => {
    it('returns ok(null) for empty stdout array', () => {
      const output = makeOutput([]);
      const result = parseClaudeUsage(output, undefined);

      expect(result.ok).toBe(true);
      expect(result.value).toBeNull();
    });

    it('returns ok(null) for stdout chunks that are all empty strings', () => {
      const output = makeOutput(['', '', '']);
      const result = parseClaudeUsage(output, undefined);

      expect(result.ok).toBe(true);
      expect(result.value).toBeNull();
    });
  });

  describe('malformed JSON', () => {
    it('returns ok(null) when JSON is truncated', () => {
      const output = makeOutput(['{"type":"result", "usage": {']);
      const result = parseClaudeUsage(output, undefined);

      expect(result.ok).toBe(true);
      expect(result.value).toBeNull();
    });

    it('returns ok(null) when type is not "result"', () => {
      const json = JSON.stringify({
        type: 'assistant',
        usage: { input_tokens: 100, output_tokens: 50 },
        total_cost_usd: 0.001,
      });
      const output = makeOutput([json]);
      const result = parseClaudeUsage(output, undefined);

      expect(result.ok).toBe(true);
      expect(result.value).toBeNull();
    });

    it('returns ok(null) when usage field is missing', () => {
      const json = JSON.stringify({ type: 'result', total_cost_usd: 0.001 });
      const output = makeOutput([json]);
      const result = parseClaudeUsage(output, undefined);

      expect(result.ok).toBe(true);
      expect(result.value).toBeNull();
    });

    it('returns ok(null) when total_cost_usd is missing', () => {
      const json = JSON.stringify({
        type: 'result',
        usage: { input_tokens: 100, output_tokens: 50 },
      });
      const output = makeOutput([json]);
      const result = parseClaudeUsage(output, undefined);

      expect(result.ok).toBe(true);
      expect(result.value).toBeNull();
    });
  });

  describe('bounds validation', () => {
    it('returns ok(null) when cost is negative', () => {
      const output = makeOutput([validResultJson({ total_cost_usd: -1 })]);
      const result = parseClaudeUsage(output, undefined);

      expect(result.ok).toBe(true);
      expect(result.value).toBeNull();
    });

    it('returns ok(null) when cost exceeds MAX_COST_USD (>$1000)', () => {
      const output = makeOutput([validResultJson({ total_cost_usd: 1001 })]);
      const result = parseClaudeUsage(output, undefined);

      expect(result.ok).toBe(true);
      expect(result.value).toBeNull();
    });

    it('returns ok(null) when input_tokens is negative', () => {
      const output = makeOutput([
        validResultJson({
          usage: {
            input_tokens: -1,
            output_tokens: 50,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        }),
      ]);
      const result = parseClaudeUsage(output, undefined);

      expect(result.ok).toBe(true);
      expect(result.value).toBeNull();
    });

    it('accepts cost exactly at MAX_COST_USD ($1000)', () => {
      const output = makeOutput([validResultJson({ total_cost_usd: 1000 })]);
      const result = parseClaudeUsage(output, undefined);

      // Boundary: $1000 is accepted (>$1000 is rejected)
      expect(result.ok).toBe(true);
      expect(result.value).not.toBeNull();
    });

    it('returns ok(null) when token counts are non-numeric', () => {
      const output = makeOutput([
        validResultJson({
          usage: {
            input_tokens: 'lots',
            output_tokens: 50,
          },
        }),
      ]);
      const result = parseClaudeUsage(output, undefined);

      expect(result.ok).toBe(true);
      expect(result.value).toBeNull();
    });
  });

  describe('placeholder taskId', () => {
    it('returns a usage record with empty taskId placeholder', () => {
      const output = makeOutput([validResultJson()]);
      const result = parseClaudeUsage(output, undefined);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).not.toBeNull();
      // Caller (UsageCaptureHandler) replaces this with the real task ID
      expect(result.value!.taskId).toBe('');
    });
  });
});
