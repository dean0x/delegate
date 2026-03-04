/**
 * InMemoryAgentRegistry Tests
 *
 * ARCHITECTURE: Tests the registry's core operations: register, get, has, list, dispose.
 * Pattern: Behavioral tests with mock AgentAdapters
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentProvider } from '../../../src/core/agents';
import { ok } from '../../../src/core/result';
import { InMemoryAgentRegistry } from '../../../src/implementations/agent-registry';

function createMockAdapter(provider: AgentProvider): AgentAdapter {
  return {
    provider,
    spawn: vi.fn().mockReturnValue(ok({ process: {}, pid: 1234 })),
    kill: vi.fn().mockReturnValue(ok(undefined)),
    dispose: vi.fn(),
  };
}

describe('InMemoryAgentRegistry', () => {
  let claudeAdapter: AgentAdapter;
  let codexAdapter: AgentAdapter;
  let geminiAdapter: AgentAdapter;
  let registry: InMemoryAgentRegistry;

  beforeEach(() => {
    claudeAdapter = createMockAdapter('claude');
    codexAdapter = createMockAdapter('codex');
    geminiAdapter = createMockAdapter('gemini');
    registry = new InMemoryAgentRegistry([claudeAdapter, codexAdapter, geminiAdapter]);
  });

  afterEach(() => {
    registry.dispose();
  });

  describe('get', () => {
    it('should return the adapter for a registered provider', () => {
      const result = registry.get('claude');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.provider).toBe('claude');
      }
    });

    it('should return the correct adapter for each registered provider', () => {
      for (const provider of ['claude', 'codex', 'gemini'] as const) {
        const result = registry.get(provider);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.provider).toBe(provider);
        }
      }
    });

    it('should return error for unregistered provider', () => {
      const emptyRegistry = new InMemoryAgentRegistry([]);
      const result = emptyRegistry.get('claude');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('not found');
      }
    });
  });

  describe('has', () => {
    it('should return true for registered providers', () => {
      expect(registry.has('claude')).toBe(true);
      expect(registry.has('codex')).toBe(true);
      expect(registry.has('gemini')).toBe(true);
    });

    it('should return false for unregistered provider in empty registry', () => {
      const emptyRegistry = new InMemoryAgentRegistry([]);
      expect(emptyRegistry.has('claude')).toBe(false);
    });
  });

  describe('list', () => {
    it('should return all registered provider names sorted', () => {
      const providers = registry.list();

      expect(providers).toEqual(['claude', 'codex', 'gemini']);
    });

    it('should return empty array for empty registry', () => {
      const emptyRegistry = new InMemoryAgentRegistry([]);
      expect(emptyRegistry.list()).toEqual([]);
    });

    it('should return frozen array', () => {
      const providers = registry.list();
      expect(Object.isFrozen(providers)).toBe(true);
    });
  });

  describe('dispose', () => {
    it('should call dispose on all adapters', () => {
      registry.dispose();

      expect(claudeAdapter.dispose).toHaveBeenCalledOnce();
      expect(codexAdapter.dispose).toHaveBeenCalledOnce();
      expect(geminiAdapter.dispose).toHaveBeenCalledOnce();
    });

    it('should clear all adapters after dispose', () => {
      registry.dispose();

      expect(registry.has('claude')).toBe(false);
      expect(registry.list()).toEqual([]);
    });
  });

  describe('constructor', () => {
    it('should register adapters from constructor array', () => {
      const singleRegistry = new InMemoryAgentRegistry([claudeAdapter]);

      expect(singleRegistry.has('claude')).toBe(true);
      expect(singleRegistry.has('codex')).toBe(false);
      expect(singleRegistry.list()).toEqual(['claude']);
    });
  });
});
