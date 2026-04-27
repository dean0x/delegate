/**
 * Keyboard navigation constants shared across all handler modules.
 */

import { LoopStatus, OrchestratorStatus, PipelineStatus, ScheduleStatus, TaskStatus } from '../../../core/domain.js';
import type { PanelId } from '../types.js';

/** Ordered panel cycle for Tab navigation */
export const PANEL_ORDER: readonly PanelId[] = ['tasks', 'loops', 'schedules', 'orchestrations', 'pipelines'];

/** Per-panel filter cycles — each panel only includes its valid statuses */
export const FILTER_CYCLES: Record<PanelId, readonly (string | null)[]> = {
  tasks: [null, 'queued', 'running', 'completed', 'failed', 'cancelled'],
  loops: [null, 'running', 'paused', 'completed', 'failed', 'cancelled'],
  schedules: [null, 'active', 'paused', 'completed', 'cancelled', 'expired'],
  orchestrations: [null, 'planning', 'running', 'completed', 'failed', 'cancelled'],
  pipelines: [null, 'pending', 'running', 'completed', 'failed', 'cancelled'],
};

/** Map of digit keys 1–5 to their corresponding panel IDs */
export const PANEL_JUMP_KEYS: Record<string, PanelId> = {
  '1': 'tasks',
  '2': 'loops',
  '3': 'schedules',
  '4': 'orchestrations',
  '5': 'pipelines',
};

/** Terminal statuses per panel — used by both 'c' (cancel guard) and 'd' (delete gate) handlers */
export const TERMINAL_STATUSES: {
  orchestrations: OrchestratorStatus[];
  loops: LoopStatus[];
  tasks: TaskStatus[];
  schedules: ScheduleStatus[];
  pipelines: PipelineStatus[];
} = {
  orchestrations: [OrchestratorStatus.COMPLETED, OrchestratorStatus.FAILED, OrchestratorStatus.CANCELLED],
  loops: [LoopStatus.COMPLETED, LoopStatus.FAILED, LoopStatus.CANCELLED],
  tasks: [TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED],
  schedules: [ScheduleStatus.COMPLETED, ScheduleStatus.CANCELLED, ScheduleStatus.EXPIRED],
  pipelines: [PipelineStatus.COMPLETED, PipelineStatus.FAILED, PipelineStatus.CANCELLED],
};

/** Conservative upper bound for detail scroll when caller does not provide content length */
export const DETAIL_SCROLL_MAX_DEFAULT = 200;
