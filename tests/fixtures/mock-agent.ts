/**
 * Mock agent test doubles for multi-agent support testing
 *
 * ARCHITECTURE: Provides mock AgentAdapter and helper to create
 * AgentRegistry instances from ProcessSpawner (backward compat) or
 * tmux-compatible mocks for Phase 3 worker pool tests.
 */

import { vi } from 'vitest';
import type { AgentAdapter, AgentRegistry } from '../../src/core/agents';
import type { ProcessSpawner } from '../../src/core/interfaces';
import { ok } from '../../src/core/result';
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

/**
 * Create a tmux-compatible mock AgentAdapter for integration tests.
 * buildTmuxCommand() returns a valid config so EventDrivenWorkerPool.spawn() succeeds.
 */
export function createMockTmuxAgentAdapter(): AgentAdapter {
  return {
    provider: 'claude',
    spawn: vi.fn(),
    spawnInteractive: vi.fn(),
    kill: vi.fn(),
    dispose: vi.fn(),
    cleanup: vi.fn(),
    buildTmuxCommand: vi
      .fn()
      .mockImplementation((options: { taskId?: string; prompt?: string; sessionsDir?: string }) =>
        ok({
          config: {
            name: `beat-${options.taskId ?? 'task-unknown'}`,
            command: 'claude',
            cwd: '/tmp',
            taskId: options.taskId ?? 'task-unknown',
            sessionsDir: options.sessionsDir ?? '/tmp/sessions',
            agent: 'claude' as const,
            agentArgs: [],
          },
          prompt: options.prompt ?? 'do stuff',
        }),
      ),
  } satisfies AgentAdapter;
}

/**
 * Create an AgentRegistry with a tmux-compatible mock adapter.
 * Use this instead of createAgentRegistryFromSpawner when testing
 * against the Phase 3 tmux-backed worker pool.
 */
export function createTmuxAgentRegistry(): AgentRegistry {
  return new InMemoryAgentRegistry([createMockTmuxAgentAdapter()]);
}
