/**
 * Mock agent test doubles for multi-agent support testing
 *
 * ARCHITECTURE: Provides mock AgentAdapter and helper to create
 * AgentRegistry instances from ProcessSpawner (backward compat).
 */

import type { ProcessSpawner } from '../../src/core/interfaces';
import { InMemoryAgentRegistry } from '../../src/implementations/agent-registry';
import { ProcessSpawnerAdapter } from '../../src/implementations/process-spawner-adapter';

/**
 * Create an AgentRegistry from a ProcessSpawner (backward compatibility)
 * Wraps the spawner in a ProcessSpawnerAdapter registered as 'claude'
 */
export function createAgentRegistryFromSpawner(spawner: ProcessSpawner): AgentRegistry {
  const adapter = new ProcessSpawnerAdapter(spawner);
  return new InMemoryAgentRegistry([adapter]);
}
