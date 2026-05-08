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
import { AgentAdapter, AgentProvider, type InteractiveSpawnOptions, SpawnOptions } from '../core/agents.js';
import { AutobeatError, ErrorCode } from '../core/errors.js';
import { ProcessSpawner } from '../core/interfaces.js';
import { err, Result } from '../core/result.js';

export class ProcessSpawnerAdapter implements AgentAdapter {
  readonly provider: AgentProvider;

  constructor(
    private readonly spawner: ProcessSpawner,
    provider: AgentProvider = 'claude',
  ) {
    this.provider = provider;
  }

  spawn(options: SpawnOptions): Result<{ process: ChildProcess; pid: number }> {
    return this.spawner.spawn(options);
  }

  spawnInteractive(_options: InteractiveSpawnOptions): Result<{ process: ChildProcess; pid: number }> {
    return err(
      new AutobeatError(ErrorCode.INVALID_OPERATION, 'ProcessSpawnerAdapter does not support interactive mode'),
    );
  }

  kill(pid: number): Result<void> {
    return this.spawner.kill(pid);
  }

  dispose(): void {
    // ProcessSpawner interface does not define dispose — nothing to clean up
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  cleanup(_taskId: string): void {
    // ProcessSpawner does not write task-scoped files — nothing to clean up
  }
}
