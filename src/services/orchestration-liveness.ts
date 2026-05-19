/**
 * Shared orchestration liveness check utility
 *
 * DECISION (2026-04-10): Shared liveness chain trace extracted into its own utility
 * so RecoveryManager.failZombieRunningOrchestrations and the dashboard's liveness
 * fetcher use IDENTICAL logic. Without extraction, the two implementations could
 * drift, causing the dashboard to show 'live' for an orchestration that recovery
 * has already marked dead.
 *
 * Liveness is determined by tracing:
 *   orchestration → loop → most-recent-iteration → task → worker → liveness check
 *
 * Phase 3: Workers may be tmux-session-based (pid=0 sentinel). When isTmuxSessionAlive
 * is provided and the worker has sessionName set, session liveness is used instead of
 * PID check. Without isTmuxSessionAlive, tmux workers conservatively report 'unknown'.
 *
 * Conservative: 'unknown' results (broken chain) leave the row alone — false positives
 * marking live orchestrations as zombies would be far worse than false negatives
 * leaving zombies for the user to clean manually via the dashboard.
 */

import type { Orchestration, TaskId } from '../core/domain.js';
import type { LoopRepository, TaskRepository, WorkerRepository } from '../core/interfaces.js';

export type Liveness = 'live' | 'dead' | 'unknown';

export interface LivenessDeps {
  readonly loopRepo: LoopRepository;
  readonly taskRepo: TaskRepository;
  readonly workerRepo: WorkerRepository;
  readonly isProcessAlive: (pid: number) => boolean;
  /**
   * Phase 3: Optional tmux session liveness check.
   * When provided, workers with pid=0 and a sessionName use this instead of isProcessAlive.
   * When omitted, tmux workers (pid=0) conservatively return 'unknown' — the caller
   * leaves the row alone rather than risk a false-positive zombie detection.
   */
  readonly isTmuxSessionAlive?: (sessionName: string) => boolean;
}

/**
 * Determine liveness of a RUNNING orchestration by following the chain:
 * orchestration → loop → most-recent-iteration → task → worker → liveness check.
 *
 * Returns:
 * - 'live'    — worker process/session is alive
 * - 'dead'    — worker process/session is not alive (zombie)
 * - 'unknown' — chain is broken (no loopId, no iteration, no task, no worker)
 *               or tmux worker without isTmuxSessionAlive provided
 *               Conservative: caller should leave these rows alone.
 */
export async function checkOrchestrationLiveness(orchestration: Orchestration, deps: LivenessDeps): Promise<Liveness> {
  // Interactive mode: PID-based liveness (no loop chain)
  if (orchestration.mode === 'interactive') {
    if (!orchestration.pid) return 'unknown';
    return deps.isProcessAlive(orchestration.pid) ? 'live' : 'dead';
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

  // Phase 3: Tmux workers use pid=0 as sentinel — PID check is meaningless.
  // Use session liveness when available; conservatively return 'unknown' when not.
  if (worker.pid === 0) {
    if (!worker.sessionName || !deps.isTmuxSessionAlive) return 'unknown';
    return deps.isTmuxSessionAlive(worker.sessionName) ? 'live' : 'dead';
  }

  // PID-based liveness check for process workers
  return deps.isProcessAlive(worker.ownerPid) ? 'live' : 'dead';
}
