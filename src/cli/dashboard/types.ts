/**
 * Dashboard type definitions
 * ARCHITECTURE: Shared types for the terminal dashboard (Phase 1)
 * All types are immutable (readonly)
 */

import type {
  ActivityEntry,
  Channel,
  ChannelId,
  ChannelMessage,
  Loop,
  LoopId,
  LoopIteration,
  Orchestration,
  OrchestratorChild,
  OrchestratorId,
  Pipeline,
  PipelineId,
  Schedule,
  ScheduleId,
  Task,
  TaskId,
  TaskUsage,
} from '../../core/domain.js';
import type {
  ChannelRepository,
  ChannelService,
  LoopRepository,
  LoopService,
  OrchestrationRepository,
  OrchestrationService,
  PipelineRepository,
  ScheduleExecution,
  ScheduleRepository,
  ScheduleService,
  TaskManager,
  TaskRepository,
} from '../../core/interfaces.js';
import type { Liveness } from '../../services/orchestration-liveness.js';

/**
 * Mutation services passed to the dashboard for cancel/delete/pause/resume operations.
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
  readonly loopRepo: LoopRepository;
  readonly taskRepo: TaskRepository;
  readonly scheduleRepo: ScheduleRepository;
  /** Pipeline repository for delete operations (cancel is driven via task cancellation cascade) */
  readonly pipelineRepo?: PipelineRepository;
  /** Channel service for pause/resume/destroy operations */
  readonly channelService?: ChannelService;
  /** Channel repository for direct queries in channel detail view */
  readonly channelRepo?: ChannelRepository;
}

export type PanelId = 'tasks' | 'loops' | 'schedules' | 'orchestrations' | 'pipelines' | 'channels';

/**
 * Return target for task detail view.
 * Plain string: return to main view.
 * Object variant: return to a specific orchestration or loop detail (for D3 drill-through).
 *
 * D3 drill-through: Enter on a child row in orchestration detail opens the child's
 * task detail with returnTo = { kind: 'orchestrations', entityId, originalReturnTo }.
 * Esc from that task detail returns to the same orchestration detail, which in turn
 * returns to main per originalReturnTo.
 */
export type DetailReturnTarget =
  | 'main'
  | {
      readonly kind: 'orchestrations';
      readonly entityId: OrchestratorId;
      readonly originalReturnTo: 'main';
    }
  | {
      readonly kind: 'loops';
      readonly entityId: LoopId;
      readonly originalReturnTo: 'main';
    };

/**
 * Top-level view state — main overview or entity detail drill-down.
 * Each detail variant carries the branded ID for its entity type, making
 * illegal cross-type ID usage unrepresentable at compile time.
 *
 * Tasks variant uses DetailReturnTarget to support D3 drill-through.
 */
export type ViewState =
  | { readonly kind: 'main' }
  | {
      readonly kind: 'detail';
      readonly entityType: 'loops';
      readonly entityId: LoopId;
      readonly returnTo: 'main';
    }
  | {
      readonly kind: 'detail';
      readonly entityType: 'tasks';
      readonly entityId: TaskId;
      readonly returnTo: DetailReturnTarget;
    }
  | {
      readonly kind: 'detail';
      readonly entityType: 'schedules';
      readonly entityId: ScheduleId;
      readonly returnTo: 'main';
    }
  | {
      readonly kind: 'detail';
      readonly entityType: 'orchestrations';
      readonly entityId: OrchestratorId;
      readonly returnTo: 'main';
    }
  | {
      readonly kind: 'detail';
      readonly entityType: 'pipelines';
      readonly entityId: PipelineId;
      readonly returnTo: 'main';
    }
  | {
      readonly kind: 'detail';
      readonly entityType: 'channels';
      readonly entityId: ChannelId;
      readonly returnTo: 'main';
    };

/**
 * Navigation state for the main panel grid
 *
 * v1.3.0 (D3 drill-through): orchestrationChildSelectedTaskId and
 * orchestrationChildPage track which child row is highlighted when viewing
 * an orchestration detail, and which page of children is shown.
 * Selection is by taskId (stable across refetches).
 *
 * DECISION (Dashboard Layout Overhaul): activityFocused and activitySelectedIndex
 * removed. The Activity feed is now a non-interactive tile in the top row —
 * Tab cycles only among entity browser panels.
 */
export interface NavState {
  readonly focusedPanel: PanelId;
  readonly selectedIndices: Record<PanelId, number>;
  readonly filters: Record<PanelId, string | null>;
  readonly scrollOffsets: Record<PanelId, number>;
  /** TaskId of the currently highlighted child row in orchestration detail (null = first row) */
  readonly orchestrationChildSelectedTaskId: string | null;
  /** 0-based page number within the orchestration detail children list */
  readonly orchestrationChildPage: number;
  /** Whether the output stream panel is visible in task/orchestration detail (#165) */
  readonly detailOutputVisible: boolean;
  /** Whether output auto-tails (true) or is paused for manual scrolling (false) (#165) */
  readonly detailOutputAutoTail: boolean;
  /** Scroll offset when output is in paused mode (#165) */
  readonly detailOutputScrollOffset: number;
  /** iterationNumber of the highlighted row in loop detail (null = first row) (#168) */
  readonly loopIterationSelectedNumber: number | null;
  /**
   * Name of the highlighted member row in channel detail (null = first row).
   * Follows orchestrationChildSelectedTaskId convention for D3-style drill-through.
   */
  readonly channelMemberSelectedName: string | null;
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
 *
 * Metrics view extras (Phase C — v1.3.0):
 * - costRollup24h: aggregated cost/token usage over the last 24 hours
 * - topOrchestrationsByCost: top-N orchestrations by total cost in 24h window
 * - throughputStats: task/loop throughput over a 1-hour window
 * - activityFeed: merged time-sorted activity across all entity kinds
 *
 * Phase B (Dashboard Visibility Overhaul): pipelines and pipelineCounts added
 * to support the entity browser panel with full pipeline visibility.
 */
export interface DashboardData {
  readonly tasks: readonly Task[];
  readonly loops: readonly Loop[];
  readonly schedules: readonly Schedule[];
  readonly orchestrations: readonly Orchestration[];
  readonly pipelines: readonly Pipeline[];
  readonly channels: readonly Channel[];
  readonly taskCounts: EntityCounts;
  readonly loopCounts: EntityCounts;
  readonly scheduleCounts: EntityCounts;
  readonly orchestrationCounts: EntityCounts;
  readonly pipelineCounts: EntityCounts;
  readonly channelCounts: EntityCounts;
  readonly iterations?: readonly LoopIteration[];
  readonly executions?: readonly ScheduleExecution[];
  /** Liveness state per orchestration ID — only populated for RUNNING orchestrations */
  readonly orchestrationLiveness?: Readonly<Record<string, Liveness>>;
  /** Children tasks attributed to the viewed orchestration (Phase E — only in orchestration detail view) */
  readonly orchestrationChildren?: readonly OrchestratorChild[];
  /** Aggregated cost/token usage for the viewed orchestration (Phase E — only in orchestration detail view) */
  readonly orchestrationCostAggregate?: TaskUsage;
  /** Total count of children for pagination (D3 drill-through — only in orchestration detail view) */
  readonly orchestrationChildrenTotal?: number;

  // Metrics view extras (v1.3.0)
  readonly costRollup24h?: TaskUsage;
  readonly topOrchestrationsByCost?: readonly {
    readonly orchestrationId: OrchestratorId;
    readonly totalCost: number;
  }[];
  readonly throughputStats?: {
    readonly tasksPerHour: number;
    readonly loopsPerHour: number;
    readonly successRate: number;
    readonly avgDurationMs: number;
  };
  readonly activityFeed?: readonly ActivityEntry[];
  /** Step tasks fetched by ID for pipeline detail (bypasses FETCH_LIMIT) */
  readonly pipelineStepTasks?: readonly (Task | null)[];
  /** Message summaries for the focused channel in channel detail view */
  readonly channelMessages?: readonly ChannelMessage[];
}

/**
 * Optional detail-view extras — fetched when in detail mode
 * Phase E adds orchestration-specific extras: children list + cost aggregate.
 */
export interface DetailExtra {
  readonly iterations?: readonly LoopIteration[];
  readonly executions?: readonly ScheduleExecution[];
  /** Children tasks attributed to the viewed orchestration (Phase E) */
  readonly orchestrationChildren?: readonly OrchestratorChild[];
  /** Aggregated cost/token usage for the viewed orchestration (Phase E) */
  readonly orchestrationCostAggregate?: TaskUsage;
  /** Total count of children for pagination (D3 drill-through) */
  readonly orchestrationChildrenTotal?: number;
  /** Step tasks fetched by ID for pipeline detail (bypasses FETCH_LIMIT) */
  readonly pipelineStepTasks?: readonly (Task | null)[];
  /** Message summaries for the focused channel in channel detail view */
  readonly channelMessages?: readonly ChannelMessage[];
}
