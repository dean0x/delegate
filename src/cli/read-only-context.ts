/**
 * Lightweight read-only context for CLI query commands
 *
 * Read-only commands (status, logs, list, schedule list/status) only need
 * Database + repositories. This module bypasses full bootstrap() which
 * initializes 15+ components (EventBus, 6 handlers, WorkerPool, AgentRegistry,
 * ResourceMonitor, RecoveryManager, etc.) — saving ~200-500ms per query.
 *
 * NOTE: "Read-only" refers to the command's intent, not DB operations.
 * new Database() runs schema migrations on open, which is a write operation.
 * This is the same behavior as full bootstrap — we just skip the runtime
 * services that query commands never use.
 *
 * NOTE: The dashboard upgraded to withServices() (src/cli/dashboard/index.tsx)
 * to enable cancel/delete keybindings. This context is now used only by
 * lighter query commands (status, logs, list, etc.) that do not need mutations.
 */

import { loadConfiguration } from '../core/configuration.js';
import type {
  LoopRepository,
  OrchestrationRepository,
  OutputRepository,
  ScheduleRepository,
  TaskRepository,
  WorkerRepository,
} from '../core/interfaces.js';
import { Result, tryCatch } from '../core/result.js';
import { Database } from '../implementations/database.js';
import { SQLiteLoopRepository } from '../implementations/loop-repository.js';
import { SQLiteOrchestrationRepository } from '../implementations/orchestration-repository.js';
import { SQLiteOutputRepository } from '../implementations/output-repository.js';
import { SQLiteScheduleRepository } from '../implementations/schedule-repository.js';
import { SQLiteTaskRepository } from '../implementations/task-repository.js';
import { SQLiteWorkerRepository } from '../implementations/worker-repository.js';

export interface ReadOnlyContext {
  readonly taskRepository: TaskRepository;
  readonly outputRepository: OutputRepository;
  readonly scheduleRepository: ScheduleRepository;
  readonly loopRepository: LoopRepository;
  readonly orchestrationRepository: OrchestrationRepository;
  readonly workerRepository: WorkerRepository;
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
    const orchestrationRepository = new SQLiteOrchestrationRepository(database);
    const workerRepository = new SQLiteWorkerRepository(database);

    return {
      taskRepository,
      outputRepository,
      scheduleRepository,
      loopRepository,
      orchestrationRepository,
      workerRepository,
      close: () => database.close(),
    };
  });
}
