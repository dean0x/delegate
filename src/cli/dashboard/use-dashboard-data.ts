/**
 * Dashboard data polling hook
 * ARCHITECTURE: Encapsulates all data-fetching logic — pure hook, no UI
 * Pattern: Custom hook with interval polling, stale-on-error semantics
 *
 * Key exports:
 *  - useDashboardData: React hook for polling (used by App)
 *  - fetchAllData: Pure async function (exported for testing)
 *  - buildEntityCounts: Pure function (exported for testing)
 *  - POLL_INTERVAL_BY_VIEW: Per-view poll cadence (exported for testing)
 *
 * Per-view poll cadence (Phase B):
 *  - main:      1 000 ms — summary metrics update once per second
 *  - workspace:   750 ms — live task output needs snappier refresh
 *  - detail:    2 000 ms — single-entity view; slower cadence reduces DB pressure
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { OrchestratorStatus, TaskId } from '../../core/domain.js';
import type { Result } from '../../core/result.js';
import { err, ok } from '../../core/result.js';
import { checkOrchestrationLiveness, type Liveness } from '../../services/orchestration-liveness.js';
import type { ReadOnlyContext } from '../read-only-context.js';
import { buildActivityFeed } from './activity-feed.js';
import type { DashboardData, DetailExtra, EntityCounts, ViewState } from './types.js';
import { ORCHESTRATION_CHILDREN_PAGE_SIZE } from './views/orchestration-detail.js';

export interface UseDashboardDataResult {
  readonly data: DashboardData | null;
  readonly error: string | null;
  readonly refreshedAt: Date | null;
  readonly refreshNow: () => void;
}

/** Page tracking for orchestration detail pagination (D3 drill-through) */
export interface OrchestratorPageState {
  /** 0-based page number for orchestration detail children */
  readonly orchestrationChildPage: number;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Maximum number of items fetched per entity panel.
 * When the true total exceeds this limit, the UI shows a truncation notice.
 */
export const FETCH_LIMIT = 50;

/**
 * Per-view poll interval in milliseconds.
 * DECISION (Phase B): Different views have different freshness requirements.
 *  - main: 1 000 ms — summary metrics; one-second granularity is sufficient
 *  - workspace: 750 ms — live task output benefits from snappier refresh
 *  - detail: 2 000 ms — single-entity view; slower cadence reduces DB pressure
 */
export const POLL_INTERVAL_BY_VIEW: Readonly<Record<'main' | 'workspace' | 'detail', number>> = {
  main: 1_000,
  workspace: 750,
  detail: 2_000,
};

/**
 * Check if a process is alive by sending signal 0 (existence check, no signal sent).
 * EPERM means the process exists but we lack permission — treated as alive.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// ============================================================================
// Liveness cache
// ============================================================================

/**
 * Per-orchestration liveness cache entry.
 * TTL: 4 seconds — processes don't die faster than the dashboard can react.
 */
interface LivenessCacheEntry {
  readonly result: Liveness;
  readonly timestamp: number;
}

const LIVENESS_CACHE_TTL_MS = 4_000;

/**
 * Unwrap an array of Results from a settled Promise.all call.
 * Returns ok with the first failed label+message, or ok with all values.
 * Designed for the parallel-fetch pattern in fetchAllData.
 */
function unwrapAll(
  labels: readonly string[],
  results: readonly Result<unknown, Error>[],
): Result<readonly unknown[], string> {
  const values: unknown[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r.ok) return err(`${labels[i]} fetch failed: ${r.error.message}`);
    values.push(r.value);
  }
  return ok(values);
}

// ============================================================================
// Pure helper functions (exported for unit testing)
// ============================================================================

/**
 * Build an EntityCounts object from a status→count map.
 * Total is summed from byStatus values.
 */
export function buildEntityCounts(byStatus: Record<string, number>): EntityCounts {
  const total = Object.values(byStatus).reduce((sum, n) => sum + n, 0);
  return { total, byStatus };
}

/**
 * Fetch all dashboard data in parallel.
 * Returns a Result<DashboardData> — on any repository error, returns the error message.
 * For detail extras (iterations, executions), errors are handled gracefully (undefined).
 * @param ctx - Read-only repository context
 * @param viewState - Current view to fetch extras for
 * @param childPage - 0-based page number for orchestration detail children (default: 0)
 * @param livenessCache - Per-tick memoization map; callers pass a stable ref for caching
 */
export async function fetchAllData(
  ctx: ReadOnlyContext,
  viewState: ViewState,
  childPage = 0,
  livenessCache?: Map<string, LivenessCacheEntry>,
): Promise<Result<DashboardData, string>> {
  const {
    taskRepository,
    loopRepository,
    scheduleRepository,
    orchestrationRepository,
    workerRepository,
    pipelineRepository,
  } = ctx;

  // Parallel fetch: entity lists + status counts
  const rawResults = await Promise.all([
    taskRepository.findAll(FETCH_LIMIT),
    loopRepository.findAll(FETCH_LIMIT),
    scheduleRepository.findAll(FETCH_LIMIT),
    orchestrationRepository.findAll(FETCH_LIMIT),
    pipelineRepository.findAll(FETCH_LIMIT),
    taskRepository.countByStatus(),
    loopRepository.countByStatus(),
    scheduleRepository.countByStatus(),
    orchestrationRepository.countByStatus(),
    pipelineRepository.countByStatus(),
  ]);

  // Unwrap all results — any failure returns a labeled error string
  const unwrapped = unwrapAll(
    [
      'Tasks',
      'Loops',
      'Schedules',
      'Orchestrations',
      'Pipelines',
      'Task counts',
      'Loop counts',
      'Schedule counts',
      'Orchestration counts',
      'Pipeline counts',
    ],
    rawResults,
  );
  if (!unwrapped.ok) return err(unwrapped.error);

  // Cast from unknown[] — each position matches the Promise.all order above
  type TaskList = Awaited<ReturnType<typeof taskRepository.findAll>> extends Result<infer V, Error> ? V : never;
  type LoopList = Awaited<ReturnType<typeof loopRepository.findAll>> extends Result<infer V, Error> ? V : never;
  type ScheduleList = Awaited<ReturnType<typeof scheduleRepository.findAll>> extends Result<infer V, Error> ? V : never;
  type OrchList =
    Awaited<ReturnType<typeof orchestrationRepository.findAll>> extends Result<infer V, Error> ? V : never;
  type PipelineList = Awaited<ReturnType<typeof pipelineRepository.findAll>> extends Result<infer V, Error> ? V : never;
  type StatusMap = Record<string, number>;

  const [
    tasks,
    loops,
    schedules,
    orchestrations,
    pipelines,
    taskCounts,
    loopCounts,
    scheduleCounts,
    orchestrationCounts,
    pipelineCounts,
  ] = unwrapped.value as [
    TaskList,
    LoopList,
    ScheduleList,
    OrchList,
    PipelineList,
    StatusMap,
    StatusMap,
    StatusMap,
    StatusMap,
    StatusMap,
  ];

  // Fetch detail extras if in detail view (best-effort — errors yield undefined)
  const detailExtra: DetailExtra = viewState.kind === 'detail' ? await fetchDetailExtra(ctx, viewState, childPage) : {};

  // Compute liveness for RUNNING orchestrations — parallel with TTL cache.
  // Processes don't die faster than the dashboard reacts, so a 4-second cache
  // avoids up to 150 sequential SQLite hits/s (50 orchestrations × 3 sub-queries).
  const now = Date.now();
  const cache = livenessCache ?? new Map<string, LivenessCacheEntry>();
  const livenessDeps = {
    loopRepo: loopRepository,
    taskRepo: taskRepository,
    workerRepo: workerRepository,
    isProcessAlive,
  };

  const livenessEntries = await Promise.all(
    orchestrations.map(async (orch) => {
      if (orch.status === OrchestratorStatus.RUNNING) {
        // Check TTL cache first
        const cached = cache.get(orch.id);
        if (cached && now - cached.timestamp < LIVENESS_CACHE_TTL_MS) {
          return [orch.id, cached.result] as const;
        }
        try {
          const result = await checkOrchestrationLiveness(orch, livenessDeps);
          cache.set(orch.id, { result, timestamp: now });
          return [orch.id, result] as const;
        } catch {
          return [orch.id, 'unknown' as Liveness] as const;
        }
      }
      if (orch.status === OrchestratorStatus.PLANNING && !orch.loopId) {
        // PLANNING with no loopId — orphan indicator
        return [orch.id, 'unknown' as Liveness] as const;
      }
      return null;
    }),
  );

  const orchestrationLiveness: Record<string, Liveness> = {};
  for (const entry of livenessEntries) {
    if (entry) orchestrationLiveness[entry[0]] = entry[1];
  }

  // Main-view metrics extras — fetched in parallel when viewing the metrics dashboard
  let metricsExtras: Pick<
    DashboardData,
    'costRollup24h' | 'topOrchestrationsByCost' | 'throughputStats' | 'activityFeed'
  > = {};

  if (viewState.kind === 'main') {
    metricsExtras = await fetchMetricsExtras(ctx);
  }

  // Workspace-view extras — fetched when viewing workspace
  let workspaceExtras: Pick<DashboardData, 'workspaceData'> = {};

  if (viewState.kind === 'workspace') {
    workspaceExtras = await fetchWorkspaceExtras(ctx, viewState.orchestrationId, orchestrations);
  }

  return ok({
    tasks,
    loops,
    schedules,
    orchestrations,
    pipelines,
    taskCounts: buildEntityCounts(taskCounts),
    loopCounts: buildEntityCounts(loopCounts),
    scheduleCounts: buildEntityCounts(scheduleCounts),
    orchestrationCounts: buildEntityCounts(orchestrationCounts),
    pipelineCounts: buildEntityCounts(pipelineCounts),
    orchestrationLiveness,
    ...detailExtra,
    ...metricsExtras,
    ...workspaceExtras,
  });
}

/**
 * Fetch metrics-view extras in parallel (cost, throughput, activity feed).
 * All failures are handled gracefully — errors yield undefined for that field.
 * Best-effort: dashboard degrades without crashing if any query fails.
 */
async function fetchMetricsExtras(
  ctx: ReadOnlyContext,
): Promise<Pick<DashboardData, 'costRollup24h' | 'topOrchestrationsByCost' | 'throughputStats' | 'activityFeed'>> {
  const nowMs = Date.now();
  const since24h = nowMs - 24 * 3600 * 1000;
  const since1h = nowMs - 3600 * 1000;

  const [
    costRollupResult,
    topOrchsResult,
    throughputResult,
    recentTasksResult,
    recentLoopsResult,
    recentOrchsResult,
    recentSchedsResult,
    recentPipelinesResult,
  ] = await Promise.all([
    ctx.usageRepository.sumGlobal(since24h),
    ctx.usageRepository.topOrchestrationsByCost(since24h, 3),
    ctx.taskRepository.getThroughputStats(3600 * 1000),
    ctx.taskRepository.findUpdatedSince(since1h, 50),
    ctx.loopRepository.findUpdatedSince(since1h, 50),
    ctx.orchestrationRepository.findUpdatedSince(since1h, 50),
    ctx.scheduleRepository.findUpdatedSince(since1h, 50),
    ctx.pipelineRepository.findUpdatedSince(since1h, 50),
  ]);

  const activityFeed = buildActivityFeed({
    tasks: recentTasksResult.ok ? recentTasksResult.value : [],
    loops: recentLoopsResult.ok ? recentLoopsResult.value : [],
    orchestrations: recentOrchsResult.ok ? recentOrchsResult.value : [],
    schedules: recentSchedsResult.ok ? recentSchedsResult.value : [],
    pipelines: recentPipelinesResult.ok ? recentPipelinesResult.value : [],
    limit: 50,
  });

  return {
    costRollup24h: costRollupResult.ok ? costRollupResult.value : undefined,
    topOrchestrationsByCost: topOrchsResult.ok ? topOrchsResult.value : undefined,
    throughputStats: throughputResult.ok ? throughputResult.value : undefined,
    activityFeed,
  };
}

/**
 * Fetch workspace-view extras: children of focused orchestration + cost aggregate.
 * Best-effort — errors yield undefined for workspaceData.
 *
 * Orchestration resolution order:
 * 1. explicit orchestrationId from view state (if set and found)
 * 2. first running orchestration by updated_at DESC (already sorted by findAll)
 */
async function fetchWorkspaceExtras(
  ctx: ReadOnlyContext,
  explicitOrchId: string | undefined,
  orchestrations: readonly import('../../core/domain.js').Orchestration[],
): Promise<Pick<DashboardData, 'workspaceData'>> {
  try {
    // Resolve focused orchestration
    let focusedOrchestration: import('../../core/domain.js').Orchestration | undefined;

    if (explicitOrchId) {
      focusedOrchestration = orchestrations.find((o) => o.id === explicitOrchId);
    }

    if (!focusedOrchestration) {
      // Fall back to first running orchestration, then first orchestration
      focusedOrchestration = orchestrations.find((o) => o.status === OrchestratorStatus.RUNNING) ?? orchestrations[0];
    }

    if (!focusedOrchestration) {
      return {}; // No orchestrations — workspaceData undefined
    }

    const orchId = focusedOrchestration.id;

    // Fetch children and cost aggregate in parallel
    const [childrenResult, costResult] = await Promise.all([
      ctx.orchestrationRepository.getOrchestratorChildren(orchId, 20),
      ctx.usageRepository.sumByOrchestrationId(orchId),
    ]);

    if (!childrenResult.ok) {
      return {}; // Degrade gracefully
    }

    const children = childrenResult.value;
    const childTaskIds = children.map((c) => c.taskId);
    const childTaskStatuses = new Map<(typeof children)[number]['taskId'], string>(
      children.map((c) => [c.taskId, c.status] as [typeof c.taskId, string]),
    );

    const ZERO_USAGE = {
      taskId: TaskId(''),
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalCostUsd: 0,
      capturedAt: 0,
    };

    const costAggregate = costResult.ok ? costResult.value : ZERO_USAGE;

    return {
      workspaceData: {
        focusedOrchestration,
        children,
        childTaskIds,
        childTaskStatuses,
        costAggregate,
      },
    };
  } catch {
    return {}; // Best-effort — dashboard degrades without crashing
  }
}

/**
 * Fetch detail-view extras (iterations for loops, execution history for schedules).
 * Phase E adds orchestration-specific extras: children list + cost aggregate.
 * D3 drill-through (v1.3.0): accepts childPage for paginated orchestration children.
 * Accepts the narrowed detail variant so branded IDs flow without unsafe casts.
 * Returns empty DetailExtra on any error — dashboard degrades gracefully.
 */
async function fetchDetailExtra(
  ctx: ReadOnlyContext,
  detail: Extract<ViewState, { readonly kind: 'detail' }>,
  childPage = 0,
): Promise<DetailExtra> {
  if (detail.entityType === 'loops') {
    const result = await ctx.loopRepository.getIterations(detail.entityId, 50);
    return { iterations: result.ok ? result.value : undefined };
  }

  if (detail.entityType === 'schedules') {
    const result = await ctx.scheduleRepository.getExecutionHistory(detail.entityId, 50);
    return { executions: result.ok ? result.value : undefined };
  }

  if (detail.entityType === 'orchestrations') {
    // D3 drill-through: paginated fetch + count + cost aggregate in parallel
    const [childrenResult, countResult, costResult] = await Promise.all([
      ctx.orchestrationRepository.getOrchestratorChildren(
        detail.entityId,
        ORCHESTRATION_CHILDREN_PAGE_SIZE,
        childPage * ORCHESTRATION_CHILDREN_PAGE_SIZE,
      ),
      ctx.orchestrationRepository.countOrchestratorChildren(detail.entityId),
      ctx.usageRepository.sumByOrchestrationId(detail.entityId),
    ]);
    return {
      orchestrationChildren: childrenResult.ok ? childrenResult.value : undefined,
      orchestrationChildrenTotal: countResult.ok ? countResult.value : undefined,
      orchestrationCostAggregate: costResult.ok ? costResult.value : undefined,
    };
  }

  // tasks don't have dedicated extra data
  return {};
}

// ============================================================================
// React hook
// ============================================================================

/**
 * Custom hook that polls all repositories on a per-view cadence.
 *
 * Stale-on-error semantics: if a poll fails, we keep the last successful
 * data and set an error message instead of clearing data.
 *
 * The `closing` ref prevents setState calls after the component unmounts.
 * The `fetching` ref guards against overlapping poll calls: if a fetch is
 * still in flight when the next interval fires, the new call is skipped.
 * The `viewStateRef` captures the latest viewState without being a dep of
 * doFetch — this keeps the polling interval stable across navigations.
 * The `childPageRef` captures the latest orchestrationChildPage in the same way.
 *
 * Phase B (per-view cadence): The poll interval is derived from POLL_INTERVAL_BY_VIEW
 * keyed on viewState.kind. When the view changes, the effect re-runs and sets up a
 * new interval with the appropriate cadence (750ms workspace, 1s main, 2s detail).
 */
export function useDashboardData(
  ctx: ReadOnlyContext,
  viewState: ViewState,
  orchestrationChildPage = 0,
): UseDashboardDataResult {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);

  // Prevent setState after unmount or shutdown
  const closing = useRef(false);

  // Always holds the latest viewState — updated synchronously before each render
  const viewStateRef = useRef(viewState);
  viewStateRef.current = viewState;

  // Always holds the latest child page — updated synchronously before each render
  const childPageRef = useRef(orchestrationChildPage);
  childPageRef.current = orchestrationChildPage;

  // Guard against overlapping in-flight fetches caused by slow SQLite under load
  const fetching = useRef(false);

  // Stable liveness cache — shared across ticks to avoid redundant sub-queries.
  // TTL is enforced inside fetchAllData; the ref keeps the cache alive across renders.
  const livenessCacheRef = useRef<Map<string, LivenessCacheEntry>>(new Map());

  // Stable fetch function — ctx is the only dep; viewState and childPage are read via refs
  const doFetch = useCallback(async (): Promise<void> => {
    if (fetching.current) return;
    fetching.current = true;
    try {
      const result = await fetchAllData(ctx, viewStateRef.current, childPageRef.current, livenessCacheRef.current);

      if (closing.current) return;

      if (!result.ok) {
        setError(result.error);
        // Stale data preserved — do not clear setData
        return;
      }

      setData(result.value);
      setError(null);
      setRefreshedAt(new Date());
    } catch (e) {
      if (!closing.current) {
        const message = e instanceof Error ? e.message : String(e);
        setError(`Unexpected fetch error: ${message}`);
      }
    } finally {
      fetching.current = false;
    }
  }, [ctx]);

  // Per-view poll cadence — derived from POLL_INTERVAL_BY_VIEW keyed on view kind.
  // When the view kind changes the effect re-runs and restarts with the new interval.
  // orchestrationChildPage is included so PgUp/PgDn in orchestration detail
  // produces an immediate fetch with the new page without waiting for the next tick.
  const pollInterval = POLL_INTERVAL_BY_VIEW[viewState.kind];

  useEffect(() => {
    closing.current = false;

    // Initial fetch immediately on mount or cadence change.
    void doFetch();

    const intervalId = setInterval(() => {
      void doFetch();
    }, pollInterval);

    return () => {
      closing.current = true;
      clearInterval(intervalId);
    };
  }, [doFetch, orchestrationChildPage, pollInterval]);

  const refreshNow = useCallback(() => {
    void doFetch();
  }, [doFetch]);

  return { data, error, refreshedAt, refreshNow };
}
