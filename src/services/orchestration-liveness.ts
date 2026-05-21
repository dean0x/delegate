/**
 * Shared orchestration liveness check utility.
 *
 * DECISION (2026-04-10): Extracted so RecoveryManager.failZombieRunningOrchestrations
 * and the dashboard liveness fetcher use identical logic. Diverging implementations
 * would cause the dashboard to show 'live' for orchestrations recovery has already marked dead.
 *
 * Liveness is determined by tracing:
 *   orchestration → loop → most-recent-iteration → task → worker → liveness check
 *
 * All workers are tmux-session-based. isOrchestratorProcessAlive is used only for
 * interactive mode orchestrators, which use real PIDs.
 *
 * Conservative: 'unknown' (broken chain) leaves the row alone — false positives marking
 * live orchestrations as zombies are worse than false negatives the user cleans manually.
 */

import type { Orchestration, TaskId } from '../core/domain.js';
import type { LoopRepository, TaskRepository, WorkerRepository } from '../core/interfaces.js';

export type Liveness = 'live' | 'dead' | 'unknown';

export interface LivenessDeps {
  readonly loopRepo: LoopRepository;
  readonly taskRepo: TaskRepository;
  readonly workerRepo: WorkerRepository;
  /**
   * PID-based liveness check for interactive mode orchestrators.
   * Interactive orchestrators use real PIDs (not pid=0 sentinel).
   */
  readonly isOrchestratorProcessAlive: (pid: number) => boolean;
  /**
   * Tmux session liveness check for all worker processes.
   * Pass () => false when tmuxSessionManager is unavailable.
   */
  readonly isTmuxSessionAlive: (sessionName: string) => boolean;
}

/**
 * Determine liveness of a RUNNING orchestration by following the chain:
 * orchestration → loop → most-recent-iteration → task → worker → liveness check.
 *
 * Returns:
 * - 'live'    — worker process/session is alive
 * - 'dead'    — worker process/session is not alive (zombie)
 * - 'unknown' — chain is broken (no loopId, no iteration, no task, no worker)
 *               Conservative: caller should leave these rows alone.
 */
export async function checkOrchestrationLiveness(orchestration: Orchestration, deps: LivenessDeps): Promise<Liveness> {
  // Interactive mode: PID-based liveness (no loop chain)
  if (orchestration.mode === 'interactive') {
    if (!orchestration.pid) return 'unknown';
    return deps.isOrchestratorProcessAlive(orchestration.pid) ? 'live' : 'dead';
  }

  // No loop assigned yet (PLANNING state or create failed before loop was set)
  if (!orchestration.loopId) return 'unknown';

  // Get the most recent iteration for the loop
  const iterationsResult = await deps.loopRepo.getIterations(orchestration.loopId, 1);
  if (!iterationsResult.ok || iterationsResult.value.length === 0) return 'unknown';

  const iteration = iterationsResult.value[0];

  // Iteration must be running and have a task
  if (!iteration.taskId || iteration.status !== 'running') return 'unknown';

  // Look up the task for worker info
  const taskResult = await deps.taskRepo.findById(iteration.taskId as TaskId);
  if (!taskResult.ok || !taskResult.value || !taskResult.value.workerId) return 'unknown';

  // Look up the worker registration for liveness data
  const workerResult = deps.workerRepo.findByTaskId(iteration.taskId as TaskId);
  if (!workerResult.ok || !workerResult.value) return 'unknown';

  const worker = workerResult.value;

  // Phase 4: All workers are tmux-session-based. If sessionName is missing,
  // treat as dead — this is a legacy/corrupted row (no session to check).
  if (!worker.sessionName) return 'unknown';
  return deps.isTmuxSessionAlive(worker.sessionName) ? 'live' : 'dead';
}
