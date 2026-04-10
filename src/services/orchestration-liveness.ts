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
 *   orchestration → loop → most-recent-iteration → task → worker.ownerPid → process.kill(pid, 0)
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
}

/**
 * Determine liveness of a RUNNING orchestration by following the chain:
 * orchestration → loop → most-recent-iteration → task → worker → PID check.
 *
 * Returns:
 * - 'live'    — worker PID is alive
 * - 'dead'    — worker PID is not alive (zombie)
 * - 'unknown' — chain is broken (no loopId, no iteration, no task, no worker)
 *               Conservative: caller should leave these rows alone.
 */
export async function checkOrchestrationLiveness(
  orchestration: Orchestration,
  deps: LivenessDeps,
): Promise<Liveness> {
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

  // Look up the worker registration for the PID
  const workerResult = deps.workerRepo.findByTaskId(iteration.taskId as TaskId);
  if (!workerResult.ok || !workerResult.value) return 'unknown';

  // PID liveness check
  return deps.isProcessAlive(workerResult.value.ownerPid) ? 'live' : 'dead';
}
