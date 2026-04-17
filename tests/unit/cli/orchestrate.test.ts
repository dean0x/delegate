/**
 * Unit tests for orchestrate CLI arg parsing
 * ARCHITECTURE: Tests pure arg parsing functions
 */

import { describe, expect, it } from 'vitest';
import { parseOrchestrateCreateArgs } from '../../../src/cli/commands/orchestrate.js';

describe('parseOrchestrateCreateArgs - Unit Tests', () => {
  describe('basic goal parsing', () => {
    it('should parse a single-word goal', () => {
      const result = parseOrchestrateCreateArgs(['deploy']);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.goal).toBe('deploy');
      expect(result.value.kind).toBe('create');
      expect(result.value.foreground).toBe(false);
    });

    it('should parse a multi-word goal', () => {
      const result = parseOrchestrateCreateArgs(['Build', 'the', 'auth', 'system']);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.goal).toBe('Build the auth system');
    });

    it('should parse a quoted goal', () => {
      const result = parseOrchestrateCreateArgs(['Build a new authentication system']);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.goal).toBe('Build a new authentication system');
    });

    it('should return error for empty args', () => {
      const result = parseOrchestrateCreateArgs([]);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('goal is required');
    });
  });

  describe('flag parsing', () => {
    it('should parse --foreground flag', () => {
      const result = parseOrchestrateCreateArgs(['goal', '--foreground']);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.foreground).toBe(true);
    });

    it('should parse -f shorthand', () => {
      const result = parseOrchestrateCreateArgs(['-f', 'goal']);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.foreground).toBe(true);
    });

    it('should parse --working-directory', () => {
      const result = parseOrchestrateCreateArgs(['goal', '--working-directory', '/workspace']);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.workingDirectory).toBe('/workspace');
    });

    it('should parse -w shorthand', () => {
      const result = parseOrchestrateCreateArgs(['goal', '-w', '/workspace']);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.workingDirectory).toBe('/workspace');
    });

    it('should parse --agent', () => {
      const result = parseOrchestrateCreateArgs(['goal', '--agent', 'claude']);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.agent).toBe('claude');
    });

    it('should reject unknown agent', () => {
      const result = parseOrchestrateCreateArgs(['goal', '--agent', 'gpt4']);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('Unknown agent');
    });

    it('should parse --max-depth', () => {
      const result = parseOrchestrateCreateArgs(['goal', '--max-depth', '5']);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.maxDepth).toBe(5);
    });

    it('should reject invalid max-depth', () => {
      const result = parseOrchestrateCreateArgs(['goal', '--max-depth', '0']);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('--max-depth must be 1-10');
    });

    it('should parse --max-workers', () => {
      const result = parseOrchestrateCreateArgs(['goal', '--max-workers', '10']);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.maxWorkers).toBe(10);
    });

    it('should reject invalid max-workers', () => {
      const result = parseOrchestrateCreateArgs(['goal', '--max-workers', '25']);

      expect(result.ok).toBe(false);
    });

    it('should parse --max-iterations', () => {
      const result = parseOrchestrateCreateArgs(['goal', '--max-iterations', '100']);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.maxIterations).toBe(100);
    });

    it('should reject invalid max-iterations', () => {
      const result = parseOrchestrateCreateArgs(['goal', '--max-iterations', '500']);

      expect(result.ok).toBe(false);
    });

    it('should reject unknown flags', () => {
      const result = parseOrchestrateCreateArgs(['goal', '--unknown']);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('Unknown flag');
    });
  });

  describe('combined flags', () => {
    it('should parse all flags together', () => {
      const result = parseOrchestrateCreateArgs([
        'Build auth',
        '-w',
        '/workspace',
        '-a',
        'claude',
        '--max-depth',
        '5',
        '--max-workers',
        '10',
        '--max-iterations',
        '100',
        '--foreground',
      ]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.goal).toBe('Build auth');
      expect(result.value.workingDirectory).toBe('/workspace');
      expect(result.value.agent).toBe('claude');
      expect(result.value.maxDepth).toBe(5);
      expect(result.value.maxWorkers).toBe(10);
      expect(result.value.maxIterations).toBe(100);
      expect(result.value.foreground).toBe(true);
    });
  });

  describe('--system-prompt flag', () => {
    it('should parse --system-prompt with a plain string value', () => {
      const result = parseOrchestrateCreateArgs(['deploy', '--system-prompt', 'Always respond in JSON']);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.systemPrompt).toBe('Always respond in JSON');
    });

    it('should parse --system-prompt with a dash-prefixed value (no startsWith check)', () => {
      // The orchestrate parser uses next === undefined (not startsWith('-')), so dash-prefixed
      // values must be accepted.
      const result = parseOrchestrateCreateArgs(['deploy', '--system-prompt', '--special instructions']);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.systemPrompt).toBe('--special instructions');
    });

    it('should leave systemPrompt undefined when not specified', () => {
      const result = parseOrchestrateCreateArgs(['deploy']);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.systemPrompt).toBeUndefined();
    });

    it('should reject --system-prompt with no value', () => {
      const result = parseOrchestrateCreateArgs(['deploy', '--system-prompt']);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('--system-prompt');
    });

    it('should parse --system-prompt alongside other flags', () => {
      const result = parseOrchestrateCreateArgs([
        'Build auth',
        '--system-prompt',
        'Be concise',
        '-a',
        'claude',
        '--foreground',
      ]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.goal).toBe('Build auth');
      expect(result.value.systemPrompt).toBe('Be concise');
      expect(result.value.agent).toBe('claude');
      expect(result.value.foreground).toBe(true);
    });
  });
});
