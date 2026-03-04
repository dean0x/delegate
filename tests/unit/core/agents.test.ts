/**
 * Agent types tests (v0.5.0)
 *
 * ARCHITECTURE: Tests the AgentProvider type system, constants, and type guard.
 * Pattern: Behavioral tests for boundary validation
 */

import { describe, expect, it } from 'vitest';
import { AGENT_PROVIDERS, DEFAULT_AGENT, isAgentProvider } from '../../../src/core/agents';

describe('Agent Types (v0.5.0)', () => {
  describe('AGENT_PROVIDERS constant', () => {
    it('should contain all three supported agents', () => {
      expect(AGENT_PROVIDERS).toEqual(['claude', 'codex', 'gemini']);
    });

    it('should be frozen (immutable)', () => {
      expect(Object.isFrozen(AGENT_PROVIDERS)).toBe(true);
    });

    it('should have exactly 3 providers', () => {
      expect(AGENT_PROVIDERS.length).toBe(3);
    });
  });

  describe('DEFAULT_AGENT constant', () => {
    it('should be claude', () => {
      expect(DEFAULT_AGENT).toBe('claude');
    });

    it('should be a valid agent provider', () => {
      expect(isAgentProvider(DEFAULT_AGENT)).toBe(true);
    });
  });

  describe('isAgentProvider type guard', () => {
    it('should return true for all valid providers', () => {
      for (const provider of AGENT_PROVIDERS) {
        expect(isAgentProvider(provider)).toBe(true);
      }
    });

    it('should return false for unknown provider names', () => {
      expect(isAgentProvider('gpt4')).toBe(false);
      expect(isAgentProvider('chatgpt')).toBe(false);
      expect(isAgentProvider('copilot')).toBe(false);
      expect(isAgentProvider('cursor')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isAgentProvider('')).toBe(false);
    });

    it('should return false for case-mismatched names', () => {
      expect(isAgentProvider('Claude')).toBe(false);
      expect(isAgentProvider('CODEX')).toBe(false);
      expect(isAgentProvider('Gemini')).toBe(false);
    });

    it('should return false for provider names with extra whitespace', () => {
      expect(isAgentProvider(' claude')).toBe(false);
      expect(isAgentProvider('claude ')).toBe(false);
      expect(isAgentProvider(' claude ')).toBe(false);
    });
  });
});
