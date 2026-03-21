/**
 * Lightweight read-only context for CLI query commands
 *
 * Read-only commands (status, logs, list, schedule list/get) only need
 * Database + repositories. This module bypasses full bootstrap() which
 * initializes 15+ components (EventBus, 6 handlers, WorkerPool, AgentRegistry,
 * ResourceMonitor, RecoveryManager, etc.) — saving ~200-500ms per query.
 *
 * NOTE: "Read-only" refers to the command's intent, not DB operations.
 * new Database() runs schema migrations on open, which is a write operation.
 * This is the same behavior as full bootstrap — we just skip the runtime
 * services that query commands never use.
 */

import { loadConfiguration } from '../core/configuration.js';
import type { LoopRepository, OutputRepository, ScheduleRepository, TaskRepository } from '../core/interfaces.js';
import { Result, tryCatch } from '../core/result.js';
import { Database } from '../implementations/database.js';
import { SQLiteLoopRepository } from '../implementations/loop-repository.js';
import { SQLiteOutputRepository } from '../implementations/output-repository.js';
import { SQLiteScheduleRepository } from '../implementations/schedule-repository.js';
import { SQLiteTaskRepository } from '../implementations/task-repository.js';

export interface ReadOnlyContext {
  readonly taskRepository: TaskRepository;
  readonly outputRepository: OutputRepository;
  readonly scheduleRepository: ScheduleRepository;
  readonly loopRepository: LoopRepository;
  close(): void;
}

/**
 * Create a lightweight context with only Database + repositories.
 * No Logger, no EventBus, no Container — just data access.
 */
export function createReadOnlyContext(): Result<ReadOnlyContext> {
  return tryCatch(() => {
    const config = loadConfiguration();
    const database = new Database();
    const taskRepository = new SQLiteTaskRepository(database);
    const outputRepository = new SQLiteOutputRepository(config, database);
    const scheduleRepository = new SQLiteScheduleRepository(database);
    const loopRepository = new SQLiteLoopRepository(database);

    return {
      taskRepository,
      outputRepository,
      scheduleRepository,
      loopRepository,
      close: () => database.close(),
    };
  });
}
