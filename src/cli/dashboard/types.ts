/**
 * Dashboard type definitions
 * ARCHITECTURE: Shared types for the terminal dashboard (Phase 1)
 * All types are immutable (readonly)
 */

import type {
  Loop,
  LoopId,
  LoopIteration,
  Orchestration,
  OrchestratorId,
  Schedule,
  ScheduleId,
  Task,
  TaskId,
} from '../../core/domain.js';
import type {
  LoopService,
  OrchestrationRepository,
  OrchestrationService,
  ScheduleExecution,
  ScheduleService,
  TaskManager,
} from '../../core/interfaces.js';
import type { Liveness } from '../../services/orchestration-liveness.js';

/**
 * Mutation services passed to the dashboard for cancel/delete operations.
 * DECISION (2026-04-10): The dashboard uses full bootstrap (withServices) because
 * manual cancel/delete keybindings need mutation access. Adds ~200-500ms to
 * dashboard startup but acceptable for interactive launch.
 */
export interface DashboardMutationContext {
  readonly orchestrationService: OrchestrationService;
  readonly loopService: LoopService;
  readonly scheduleService: ScheduleService;
  readonly taskManager: TaskManager;
  readonly orchestrationRepo: OrchestrationRepository;
}

export type PanelId = 'loops' | 'tasks' | 'schedules' | 'orchestrations';

/**
 * Top-level view state — main overview or entity detail drill-down.
 * Each detail variant carries the branded ID for its entity type, making
 * illegal cross-type ID usage unrepresentable at compile time.
 */
export type ViewState =
  | { readonly kind: 'main' }
  | { readonly kind: 'detail'; readonly entityType: 'loops'; readonly entityId: LoopId }
  | { readonly kind: 'detail'; readonly entityType: 'tasks'; readonly entityId: TaskId }
  | { readonly kind: 'detail'; readonly entityType: 'schedules'; readonly entityId: ScheduleId }
  | { readonly kind: 'detail'; readonly entityType: 'orchestrations'; readonly entityId: OrchestratorId };

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
 * - orchestrationLiveness: liveness badges for RUNNING orchestrations
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
  /** Liveness state per orchestration ID — only populated for RUNNING orchestrations */
  readonly orchestrationLiveness?: Readonly<Record<string, Liveness>>;
}

/**
 * Optional detail-view extras — fetched when in detail mode
 */
export interface DetailExtra {
  readonly iterations?: readonly LoopIteration[];
  readonly executions?: readonly ScheduleExecution[];
}
