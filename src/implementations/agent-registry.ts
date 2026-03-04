/**
 * In-memory agent registry implementation
 *
 * ARCHITECTURE: Central lookup for agent adapters by provider name.
 * Phase 1 registers only Claude; Phase 2 will register all configured agents.
 *
 * Pattern: Map-based registry with Result returns for safe lookup
 */

import { AgentAdapter, AgentProvider, AgentRegistry } from '../core/agents.js';
import { agentNotFound } from '../core/errors.js';
import { err, ok, Result } from '../core/result.js';

export class InMemoryAgentRegistry implements AgentRegistry {
  private readonly adapters: Map<AgentProvider, AgentAdapter>;

  constructor(adapters: readonly AgentAdapter[]) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.provider, adapter]));
  }

  get(provider: AgentProvider): Result<AgentAdapter> {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      const available = this.list();
      return err(agentNotFound(provider, available));
    }
    return ok(adapter);
  }

  has(provider: AgentProvider): boolean {
    return this.adapters.has(provider);
  }

  list(): readonly AgentProvider[] {
    return Object.freeze([...this.adapters.keys()].sort());
  }

  dispose(): void {
    for (const adapter of this.adapters.values()) {
      adapter.dispose();
    }
    this.adapters.clear();
  }
}
