/**
 * Unified cancel/delete/pause/resume dispatch for keyboard handlers.
 *
 * Extracted to eliminate duplication of entity-kind routing across cancel/delete/pause/resume blocks.
 */

import type { ChannelId, LoopId, OrchestratorId, PipelineId, ScheduleId, TaskId } from '../../../core/domain.js';
import { ChannelStatus, LoopStatus, OrchestratorStatus, PipelineStatus, ScheduleStatus, TaskStatus } from '../../../core/domain.js';
import type { DashboardData, DashboardMutationContext } from '../types.js';
import { TERMINAL_STATUSES } from './constants.js';

/**
 * The entity kind routing key — mirrors ActivityEntry['kind'] but is also used
 * for panel-focused cancel/delete/pause/resume where the kind is derived from PanelId.
 */
export type EntityKind = 'task' | 'loop' | 'orchestration' | 'schedule' | 'pipeline' | 'channel';

/**
 * Dispatches cancel to the appropriate service based on entity kind.
 *
 * Design decision: orchestration cancels always cascade (cancelAttributedTasks: true)
 * and loop cancels always cascade (cancelTasks: true). This provides consistent UX
 * across all dashboard views — cancelling an orchestration always stops its child tasks.
 * Unified to always-cascade per PR #133 review resolution.
 *
 * Does nothing if the entity is already in a terminal status (no double-cancel).
 */
export async function cancelEntity(
  kind: EntityKind,
  entityId: string,
  entityStatus: string,
  mutations: DashboardMutationContext,
  refreshNow: () => void,
  data?: DashboardData | null,
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
      case 'pipeline': {
        if (TERMINAL_STATUSES.pipelines.includes(entityStatus as PipelineStatus)) break;
        const pipeline = data?.pipelines.find((p) => p.id === entityId);
        if (pipeline) {
          for (const stepTaskId of pipeline.stepTaskIds) {
            if (stepTaskId === null) continue;
            await mutations.taskManager.cancel(stepTaskId, reason);
          }
          refreshNow();
        }
        break;
      }
      case 'channel':
        // Channel destroy (not cancel) — skip if already destroyed/completed
        if (
          entityStatus !== ChannelStatus.DESTROYED &&
          entityStatus !== ChannelStatus.COMPLETED &&
          mutations.channelService
        ) {
          await mutations.channelService.destroyChannel(entityId as ChannelId, 'user-requested');
          refreshNow();
        }
        break;
    }
  } catch {
    // Best-effort: service errors are logged internally by each service.
    // Swallowing here prevents unhandled rejection from crashing the dashboard TUI.
    // The next 1Hz poll will refresh the UI with accurate state regardless.
  }
}

/**
 * Dispatches pause or resume to the appropriate service based on entity kind and status.
 *
 * Only schedules and loops support pause/resume. Other entity kinds are silently ignored.
 * Schedule: ACTIVE → pause, PAUSED → resume.
 * Loop: RUNNING → pause, PAUSED → resume.
 * Terminal statuses and non-pauseable kinds are no-ops.
 */
export async function pauseOrResumeEntity(
  kind: EntityKind,
  entityId: string,
  entityStatus: string,
  mutations: DashboardMutationContext,
  refreshNow: () => void,
): Promise<void> {
  try {
    switch (kind) {
      case 'schedule':
        if (entityStatus === ScheduleStatus.ACTIVE) {
          await mutations.scheduleService.pauseSchedule(entityId as ScheduleId);
          refreshNow();
        } else if (entityStatus === ScheduleStatus.PAUSED) {
          await mutations.scheduleService.resumeSchedule(entityId as ScheduleId);
          refreshNow();
        }
        break;
      case 'loop':
        if (entityStatus === LoopStatus.RUNNING) {
          await mutations.loopService.pauseLoop(entityId as LoopId);
          refreshNow();
        } else if (entityStatus === LoopStatus.PAUSED) {
          await mutations.loopService.resumeLoop(entityId as LoopId);
          refreshNow();
        }
        break;
      case 'channel':
        if (entityStatus === ChannelStatus.ACTIVE && mutations.channelService) {
          await mutations.channelService.pauseChannel(entityId as ChannelId);
          refreshNow();
        } else if (entityStatus === ChannelStatus.PAUSED && mutations.channelService) {
          await mutations.channelService.resumeChannel(entityId as ChannelId);
          refreshNow();
        }
        break;
      default:
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
      case 'channel':
        // Only delete destroyed/completed channels
        if (
          (entityStatus === ChannelStatus.DESTROYED || entityStatus === ChannelStatus.COMPLETED) &&
          mutations.channelRepo
        ) {
          await mutations.channelRepo.delete(entityId as ChannelId);
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
