/**
 * Agent types tests (v0.5.0)
 *
 * ARCHITECTURE: Tests the AgentProvider type system, constants, and type guard.
 * Pattern: Behavioral tests for boundary validation
 */

import { describe, expect, it } from 'vitest';
import {
  AGENT_AUTH,
  AGENT_PROVIDERS,
  checkAgentAuth,
  isAgentProvider,
  maskApiKey,
  resolveDefaultAgent,
} from '../../../src/core/agents';
import { AutobeatError, ErrorCode } from '../../../src/core/errors';

describe('Agent Types (v0.5.0)', () => {
  describe('AGENT_PROVIDERS constant', () => {
    it('should contain all supported agents', () => {
      expect(AGENT_PROVIDERS).toEqual(['claude', 'codex']);
    });

    it('should be frozen (immutable)', () => {
      expect(Object.isFrozen(AGENT_PROVIDERS)).toBe(true);
    });

    it('should have exactly 2 providers', () => {
      expect(AGENT_PROVIDERS.length).toBe(2);
    });
  });

  describe('resolveDefaultAgent', () => {
    it('should return task agent when provided', () => {
      const result = resolveDefaultAgent('codex', 'claude');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe('codex');
    });

    it('should return config default when no task agent', () => {
      const result = resolveDefaultAgent(undefined, 'codex');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe('codex');
    });

    it('should return error when neither is set', () => {
      const result = resolveDefaultAgent(undefined, undefined);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(AutobeatError);
        expect((result.error as AutobeatError).code).toBe(ErrorCode.INVALID_INPUT);
        expect(result.error.message).toContain('No agent specified');
        expect(result.error.message).toContain('beat init');
        expect(result.error.message).toContain('beat config set defaultAgent');
        expect(result.error.message).toContain('--agent <agent> on the command');
      }
    });

    it('should prefer task agent over config default', () => {
      const result = resolveDefaultAgent('codex', 'claude');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe('codex');
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
      expect(isAgentProvider('Codex')).toBe(false);
    });

    it('should return false for provider names with extra whitespace', () => {
      expect(isAgentProvider(' claude')).toBe(false);
      expect(isAgentProvider('claude ')).toBe(false);
      expect(isAgentProvider(' claude ')).toBe(false);
    });
  });

  describe('AGENT_AUTH constant', () => {
    it('should define auth config for all providers', () => {
      for (const provider of AGENT_PROVIDERS) {
        const auth = AGENT_AUTH[provider];
        expect(auth).toBeDefined();
        expect(auth.envVars.length).toBeGreaterThan(0);
        expect(auth.command).toBeTruthy();
        expect(auth.loginHint).toBeTruthy();
        expect(auth.apiKeyHint).toBeTruthy();
      }
    });

    it('should map correct env vars per provider', () => {
      expect(AGENT_AUTH.claude.envVars).toContain('ANTHROPIC_API_KEY');
      expect(AGENT_AUTH.codex.envVars).toContain('OPENAI_API_KEY');
    });

    it('should map correct CLI commands per provider', () => {
      expect(AGENT_AUTH.claude.command).toBe('claude');
      expect(AGENT_AUTH.codex.command).toBe('codex');
    });

    it('should be frozen (immutable)', () => {
      expect(Object.isFrozen(AGENT_AUTH)).toBe(true);
    });
  });

  describe('checkAgentAuth', () => {
    it('should return ready with env-var method when env var is set', () => {
      const env = { ANTHROPIC_API_KEY: 'sk-test-key' };
      const status = checkAgentAuth('claude', undefined, env);

      expect(status.ready).toBe(true);
      expect(status.method).toBe('env-var');
      expect(status.envVar).toBe('ANTHROPIC_API_KEY');
    });

    it('should return ready with config-file method when config has API key', () => {
      // Pass empty env to avoid picking up real env vars
      const status = checkAgentAuth('codex', 'sk-stored-key', {});

      expect(status.ready).toBe(true);
      expect(status.method).toBe('config-file');
    });

    it('should prefer env var over config file', () => {
      const env = { OPENAI_API_KEY: 'sk-env-key' };
      const status = checkAgentAuth('codex', 'sk-config-key', env);

      expect(status.ready).toBe(true);
      expect(status.method).toBe('env-var');
      expect(status.envVar).toBe('OPENAI_API_KEY');
    });

    it('should return provider and cliFound fields', () => {
      const env = { ANTHROPIC_API_KEY: 'sk-test' };
      const status = checkAgentAuth('claude', undefined, env);

      expect(status.provider).toBe('claude');
      expect(typeof status.cliFound).toBe('boolean');
    });

    it('should include actionable hint when not ready', () => {
      // Empty env, no config, likely no CLI in PATH in test env
      const status = checkAgentAuth('codex', undefined, {});
      if (!status.ready) {
        expect(status.hint).toContain('codex auth login');
        expect(status.hint).toContain('OPENAI_API_KEY');
        expect(status.hint).toContain('beat agents config set');
      }
    });

    it('should return all three hint options when not configured', () => {
      const status = checkAgentAuth('codex', undefined, {});
      if (!status.ready) {
        expect(status.hint).toContain('Log in:');
        expect(status.hint).toContain('Set API key:');
        expect(status.hint).toContain('Store key:');
      }
    });
  });

  describe('maskApiKey', () => {
    it('should mask middle of long keys', () => {
      expect(maskApiKey('sk-1234567890abcdef')).toBe('sk-...def');
    });

    it('should return *** for short keys', () => {
      expect(maskApiKey('short')).toBe('***');
      expect(maskApiKey('12345678')).toBe('***');
    });

    it('should handle keys just above threshold', () => {
      expect(maskApiKey('123456789')).toBe('123...789');
    });
  });
});
