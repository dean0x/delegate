/**
 * Unit tests for beat orchestrate init arg parsing.
 * ARCHITECTURE: Tests parseOrchestrateInitArgs pure function.
 * No I/O, no mocks — pure function tested directly.
 */

import { describe, expect, it } from 'vitest';
import { parseOrchestrateInitArgs } from '../../../src/cli/commands/orchestrate.js';

describe('parseOrchestrateInitArgs', () => {
  describe('basic goal parsing', () => {
    it('parses a single-word goal', () => {
      const result = parseOrchestrateInitArgs(['deploy']);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.goal).toBe('deploy');
      expect(result.value.kind).toBe('init');
    });

    it('parses a multi-word goal (positional args joined)', () => {
      const result = parseOrchestrateInitArgs(['Build', 'the', 'auth', 'system']);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.goal).toBe('Build the auth system');
    });

    it('parses a quoted goal (single string arg)', () => {
      const result = parseOrchestrateInitArgs(['Build a new authentication system']);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.goal).toBe('Build a new authentication system');
    });

    it('returns error for empty args (missing goal)', () => {
      const result = parseOrchestrateInitArgs([]);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('goal is required');
    });
  });

  describe('--working-directory flag', () => {
    it('parses --working-directory', () => {
      const result = parseOrchestrateInitArgs(['goal', '--working-directory', '/workspace']);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.workingDirectory).toBe('/workspace');
    });

    it('parses -w shorthand', () => {
      const result = parseOrchestrateInitArgs(['goal', '-w', '/workspace']);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.workingDirectory).toBe('/workspace');
    });

    it('returns error when --working-directory has no value', () => {
      const result = parseOrchestrateInitArgs(['goal', '--working-directory']);

      expect(result.ok).toBe(false);
    });
  });

  describe('--agent flag', () => {
    it('parses --agent claude', () => {
      const result = parseOrchestrateInitArgs(['goal', '--agent', 'claude']);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.agent).toBe('claude');
    });

    it('parses -a shorthand', () => {
      const result = parseOrchestrateInitArgs(['goal', '-a', 'codex']);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.agent).toBe('codex');
    });

    it('rejects unknown agent', () => {
      const result = parseOrchestrateInitArgs(['goal', '--agent', 'gpt4']);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('Unknown agent');
    });
  });

  describe('--model flag', () => {
    it('parses --model', () => {
      const result = parseOrchestrateInitArgs(['goal', '--model', 'claude-opus-4-5']);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.model).toBe('claude-opus-4-5');
    });

    it('parses -m shorthand', () => {
      const result = parseOrchestrateInitArgs(['goal', '-m', 'o3-mini']);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.model).toBe('o3-mini');
    });
  });

  describe('--max-depth flag', () => {
    it('parses --max-depth', () => {
      const result = parseOrchestrateInitArgs(['goal', '--max-depth', '5']);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.maxDepth).toBe(5);
    });

    it('rejects max-depth below 1', () => {
      const result = parseOrchestrateInitArgs(['goal', '--max-depth', '0']);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('--max-depth must be 1-10');
    });

    it('rejects max-depth above 10', () => {
      const result = parseOrchestrateInitArgs(['goal', '--max-depth', '11']);

      expect(result.ok).toBe(false);
    });
  });

  describe('--max-workers flag', () => {
    it('parses --max-workers', () => {
      const result = parseOrchestrateInitArgs(['goal', '--max-workers', '10']);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.maxWorkers).toBe(10);
    });

    it('rejects max-workers above 20', () => {
      const result = parseOrchestrateInitArgs(['goal', '--max-workers', '25']);

      expect(result.ok).toBe(false);
    });

    it('rejects max-workers below 1', () => {
      const result = parseOrchestrateInitArgs(['goal', '--max-workers', '0']);

      expect(result.ok).toBe(false);
    });
  });

  describe('unknown flags', () => {
    it('rejects --foreground (not supported by init)', () => {
      const result = parseOrchestrateInitArgs(['goal', '--foreground']);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('Unknown flag');
    });

    it('rejects --max-iterations (not supported by init)', () => {
      const result = parseOrchestrateInitArgs(['goal', '--max-iterations', '50']);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('Unknown flag');
    });

    it('rejects --system-prompt (not supported by init)', () => {
      const result = parseOrchestrateInitArgs(['goal', '--system-prompt', 'Be concise']);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('Unknown flag');
    });

    it('rejects unknown flag', () => {
      const result = parseOrchestrateInitArgs(['goal', '--unknown-flag']);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('Unknown flag');
    });
  });

  describe('combined flags', () => {
    it('parses all supported flags together', () => {
      const result = parseOrchestrateInitArgs([
        'Build auth',
        '-w',
        '/workspace',
        '-a',
        'claude',
        '-m',
        'claude-opus-4-5',
        '--max-depth',
        '5',
        '--max-workers',
        '10',
      ]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.goal).toBe('Build auth');
      expect(result.value.workingDirectory).toBe('/workspace');
      expect(result.value.agent).toBe('claude');
      expect(result.value.model).toBe('claude-opus-4-5');
      expect(result.value.maxDepth).toBe(5);
      expect(result.value.maxWorkers).toBe(10);
      expect(result.value.kind).toBe('init');
    });

    it('leaves optional fields undefined when not provided', () => {
      const result = parseOrchestrateInitArgs(['goal']);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.workingDirectory).toBeUndefined();
      expect(result.value.agent).toBeUndefined();
      expect(result.value.model).toBeUndefined();
      expect(result.value.maxDepth).toBeUndefined();
      expect(result.value.maxWorkers).toBeUndefined();
    });
  });
});
