/**
 * Unified cancel/delete dispatch for keyboard handlers.
 *
 * Extracted to eliminate the 3x duplication of entity-kind routing that existed
 * across activity focus, main panel, and workspace cancel/delete blocks.
 */

import type { LoopId, OrchestratorId, PipelineId, ScheduleId, TaskId } from '../../../core/domain.js';
import { LoopStatus, OrchestratorStatus, PipelineStatus, ScheduleStatus, TaskStatus } from '../../../core/domain.js';
import type { DashboardMutationContext } from '../types.js';
import { TERMINAL_STATUSES } from './constants.js';

/**
 * The entity kind routing key — mirrors ActivityEntry['kind'] but is also used
 * for panel-focused cancel/delete where the kind is derived from PanelId.
 */
export type EntityKind = 'task' | 'loop' | 'orchestration' | 'schedule' | 'pipeline';

/**
 * Dispatches cancel to the appropriate service based on entity kind.
 *
 * Design decision: orchestration cancels always cascade (cancelAttributedTasks: true)
 * and loop cancels always cascade (cancelTasks: true). This provides consistent UX
 * across all dashboard views — cancelling an orchestration always stops its child tasks.
 * Previously, main panel cancel did not cascade while activity/workspace did;
 * unified to always-cascade per PR #133 review resolution.
 *
 * Does nothing if the entity is already in a terminal status (no double-cancel).
 */
export async function cancelEntity(
  kind: EntityKind,
  entityId: string,
  entityStatus: string,
  mutations: DashboardMutationContext,
  refreshNow: () => void,
): Promise<void> {
  const reason = 'User cancelled via dashboard';
  try {
    switch (kind) {
      case 'orchestration':
        if (!TERMINAL_STATUSES.orchestrations.includes(entityStatus as OrchestratorStatus)) {
          await mutations.orchestrationService.cancelOrchestration(entityId as OrchestratorId, reason, {
            cancelAttributedTasks: true,
          });
          refreshNow();
        }
        break;
      case 'loop':
        if (!TERMINAL_STATUSES.loops.includes(entityStatus as LoopStatus)) {
          await mutations.loopService.cancelLoop(entityId as LoopId, reason, true);
          refreshNow();
        }
        break;
      case 'task':
        if (!TERMINAL_STATUSES.tasks.includes(entityStatus as TaskStatus)) {
          await mutations.taskManager.cancel(entityId as TaskId, reason);
          refreshNow();
        }
        break;
      case 'schedule':
        if (!TERMINAL_STATUSES.schedules.includes(entityStatus as ScheduleStatus)) {
          await mutations.scheduleService.cancelSchedule(entityId as ScheduleId, reason);
          refreshNow();
        }
        break;
      case 'pipeline':
        // Pipeline cancel is driven by cancelling its current step task (cascade).
        // Direct pipeline cancel not yet supported — silently no-op.
        break;
    }
  } catch {
    // Best-effort: service errors are logged internally by each service.
    // Swallowing here prevents unhandled rejection from crashing the dashboard TUI.
    // The next 1Hz poll will refresh the UI with accurate state regardless.
  }
}

/**
 * Dispatches delete to the appropriate repository based on entity kind.
 *
 * Restricted to terminal statuses — non-terminal entities are silently ignored
 * to prevent accidental data loss on active work.
 */
export async function deleteEntity(
  kind: EntityKind,
  entityId: string,
  entityStatus: string,
  mutations: DashboardMutationContext,
  refreshNow: () => void,
): Promise<void> {
  try {
    switch (kind) {
      case 'orchestration':
        if (TERMINAL_STATUSES.orchestrations.includes(entityStatus as OrchestratorStatus)) {
          await mutations.orchestrationRepo.delete(entityId as OrchestratorId);
          refreshNow();
        }
        break;
      case 'loop':
        if (TERMINAL_STATUSES.loops.includes(entityStatus as LoopStatus)) {
          await mutations.loopRepo.delete(entityId as LoopId);
          refreshNow();
        }
        break;
      case 'task':
        if (TERMINAL_STATUSES.tasks.includes(entityStatus as TaskStatus)) {
          await mutations.taskRepo.delete(entityId as TaskId);
          refreshNow();
        }
        break;
      case 'schedule':
        if (TERMINAL_STATUSES.schedules.includes(entityStatus as ScheduleStatus)) {
          await mutations.scheduleRepo.delete(entityId as ScheduleId);
          refreshNow();
        }
        break;
      case 'pipeline':
        if (TERMINAL_STATUSES.pipelines.includes(entityStatus as PipelineStatus) && mutations.pipelineRepo) {
          await mutations.pipelineRepo.delete(entityId as PipelineId);
          refreshNow();
        }
        break;
    }
  } catch {
    // Best-effort: repo errors are logged internally by each repository.
    // Swallowing here prevents unhandled rejection from crashing the dashboard TUI.
    // The next 1Hz poll will refresh the UI with accurate state regardless.
  }
}
