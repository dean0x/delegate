/**
 * Dashboard type definitions
 * ARCHITECTURE: Shared types for the terminal dashboard (Phase 1)
 * All types are immutable (readonly)
 */

import type { Loop, LoopIteration, Orchestration, Schedule, Task } from '../../core/domain.js';
import type { ScheduleExecution } from '../../core/interfaces.js';

export type PanelId = 'loops' | 'tasks' | 'schedules' | 'orchestrations';

/**
 * Top-level view state — main overview or entity detail drill-down
 */
export type ViewState =
  | { readonly kind: 'main' }
  | { readonly kind: 'detail'; readonly entityType: PanelId; readonly entityId: string };

/**
 * Navigation state for the main panel grid
 */
export interface NavState {
  readonly focusedPanel: PanelId;
  readonly selectedIndices: Record<PanelId, number>;
  readonly filters: Record<PanelId, string | null>;
  readonly scrollOffsets: Record<PanelId, number>;
}

/**
 * Count of entities by status string
 */
export type StatusCounts = Record<string, number>;

/**
 * Entity counts for a single panel
 */
export interface EntityCounts {
  readonly total: number;
  readonly byStatus: StatusCounts;
}

/**
 * Full dashboard data snapshot — refreshed on every polling interval.
 * When in detail view, may include extras fetched by fetchDetailExtra():
 * - iterations: LoopIteration[] when viewing a loop detail
 * - executions: ScheduleExecution[] when viewing a schedule detail
 */
export interface DashboardData {
  readonly tasks: readonly Task[];
  readonly loops: readonly Loop[];
  readonly schedules: readonly Schedule[];
  readonly orchestrations: readonly Orchestration[];
  readonly taskCounts: EntityCounts;
  readonly loopCounts: EntityCounts;
  readonly scheduleCounts: EntityCounts;
  readonly orchestrationCounts: EntityCounts;
  readonly iterations?: readonly LoopIteration[];
  readonly executions?: readonly ScheduleExecution[];
}

/**
 * Optional detail-view extras — fetched when in detail mode
 */
export interface DetailExtra {
  readonly iterations?: readonly LoopIteration[];
  readonly executions?: readonly ScheduleExecution[];
}
