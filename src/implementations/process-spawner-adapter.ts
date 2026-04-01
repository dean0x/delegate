/**
 * Compatibility adapter: wraps a ProcessSpawner as an AgentAdapter
 *
 * ARCHITECTURE: Enables backward compatibility during the migration from
 * ProcessSpawner to AgentAdapter. Used when a ProcessSpawner is injected
 * via BootstrapOptions (e.g., for tests using MockProcessSpawner).
 *
 * This adapter will be removed once all tests migrate to mock AgentAdapters.
 */

import { ChildProcess } from 'child_process';
import { AgentAdapter, AgentProvider } from '../core/agents.js';
import { ProcessSpawner } from '../core/interfaces.js';
import { Result } from '../core/result.js';

export class ProcessSpawnerAdapter implements AgentAdapter {
  readonly provider: AgentProvider;

  constructor(
    private readonly spawner: ProcessSpawner,
    provider: AgentProvider = 'claude',
  ) {
    this.provider = provider;
  }

  spawn(
    prompt: string,
    workingDirectory: string,
    taskId?: string,
    model?: string,
  ): Result<{ process: ChildProcess; pid: number }> {
    return this.spawner.spawn(prompt, workingDirectory, taskId, model);
  }

  kill(pid: number): Result<void> {
    return this.spawner.kill(pid);
  }

  dispose(): void {
    // ProcessSpawner may or may not have dispose
    if ('dispose' in this.spawner && typeof this.spawner.dispose === 'function') {
      (this.spawner as { dispose: () => void }).dispose();
    }
  }
}
