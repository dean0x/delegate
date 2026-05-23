/**
 * Mock agent test doubles for multi-agent support testing
 *
 * ARCHITECTURE: Provides mock AgentAdapter and helper to create
 * AgentRegistry instances for tmux-compatible worker pool tests.
 */

import { vi } from 'vitest';
import type { AgentAdapter, AgentRegistry } from '../../src/core/agents';
import { ok } from '../../src/core/result';
import { InMemoryAgentRegistry } from '../../src/implementations/agent-registry';

/**
 * Create a tmux-compatible mock AgentAdapter for integration tests.
 * buildTmuxCommand() returns a valid config so EventDrivenWorkerPool.spawn() succeeds.
 */
export function createMockTmuxAgentAdapter(): AgentAdapter {
  return {
    provider: 'claude',
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
 * Use this for all tests that exercise the tmux-backed worker pool.
 */
export function createTmuxAgentRegistry(): AgentRegistry {
  return new InMemoryAgentRegistry([createMockTmuxAgentAdapter()]);
}
