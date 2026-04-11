/**
 * Dashboard data polling hook
 * ARCHITECTURE: Encapsulates all data-fetching logic — pure hook, no UI
 * Pattern: Custom hook with interval polling, stale-on-error semantics
 *
 * Key exports:
 *  - useDashboardData: React hook for polling (used by App)
 *  - fetchAllData: Pure async function (exported for testing)
 *  - buildEntityCounts: Pure function (exported for testing)
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
 * Unwrap a single labeled Result.
 * Returns the value directly or a string error tagged with the label.
 *
 * @example
 *   const tasks = unwrapOrErr('Tasks', tasksResult);
 *   if (!tasks.ok) return err(tasks.error);
 */
function unwrapOrErr<T>(label: string, result: Result<T, Error>): Result<T, string> {
  return result.ok ? ok(result.value) : err(`${label} fetch failed: ${result.error.message}`);
}

/**
 * Fetch all dashboard data in parallel.
 * Returns a Result<DashboardData> — on any repository error, returns the error message.
 * For detail extras (iterations, executions), errors are handled gracefully (undefined).
 * @param childPage - 0-based page number for orchestration detail children (default: 0)
 */
export async function fetchAllData(
  ctx: ReadOnlyContext,
  viewState: ViewState,
  childPage = 0,
): Promise<Result<DashboardData, string>> {
  const { taskRepository, loopRepository, scheduleRepository, orchestrationRepository, workerRepository } = ctx;

  // Parallel fetch: entity lists + status counts
  const [
    tasksResult,
    loopsResult,
    schedulesResult,
    orchestrationsResult,
    taskCountsResult,
    loopCountsResult,
    scheduleCountsResult,
    orchestrationCountsResult,
  ] = await Promise.all([
    taskRepository.findAll(FETCH_LIMIT),
    loopRepository.findAll(FETCH_LIMIT),
    scheduleRepository.findAll(FETCH_LIMIT),
    orchestrationRepository.findAll(FETCH_LIMIT),
    taskRepository.countByStatus(),
    loopRepository.countByStatus(),
    scheduleRepository.countByStatus(),
    orchestrationRepository.countByStatus(),
  ]);

  // Unwrap each result — any failure returns a labeled error string
  const tasks = unwrapOrErr('Tasks', tasksResult);
  if (!tasks.ok) return err(tasks.error);
  const loops = unwrapOrErr('Loops', loopsResult);
  if (!loops.ok) return err(loops.error);
  const schedules = unwrapOrErr('Schedules', schedulesResult);
  if (!schedules.ok) return err(schedules.error);
  const orchestrations = unwrapOrErr('Orchestrations', orchestrationsResult);
  if (!orchestrations.ok) return err(orchestrations.error);
  const taskCounts = unwrapOrErr('Task counts', taskCountsResult);
  if (!taskCounts.ok) return err(taskCounts.error);
  const loopCounts = unwrapOrErr('Loop counts', loopCountsResult);
  if (!loopCounts.ok) return err(loopCounts.error);
  const scheduleCounts = unwrapOrErr('Schedule counts', scheduleCountsResult);
  if (!scheduleCounts.ok) return err(scheduleCounts.error);
  const orchestrationCounts = unwrapOrErr('Orchestration counts', orchestrationCountsResult);
  if (!orchestrationCounts.ok) return err(orchestrationCounts.error);

  // Fetch detail extras if in detail view (best-effort — errors yield undefined)
  const detailExtra: DetailExtra = viewState.kind === 'detail' ? await fetchDetailExtra(ctx, viewState, childPage) : {};

  // Compute liveness for RUNNING orchestrations (best-effort — errors yield 'unknown')
  const orchestrationLiveness: Record<string, Liveness> = {};
  for (const orch of orchestrations.value) {
    if (orch.status === OrchestratorStatus.RUNNING) {
      try {
        const liveness = await checkOrchestrationLiveness(orch, {
          loopRepo: loopRepository,
          taskRepo: taskRepository,
          workerRepo: workerRepository,
          isProcessAlive,
        });
        orchestrationLiveness[orch.id] = liveness;
      } catch {
        orchestrationLiveness[orch.id] = 'unknown';
      }
    } else if (orch.status === OrchestratorStatus.PLANNING && !orch.loopId) {
      // PLANNING with no loopId — orphan indicator
      orchestrationLiveness[orch.id] = 'unknown';
    }
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
    workspaceExtras = await fetchWorkspaceExtras(ctx, viewState.orchestrationId, orchestrations.value);
  }

  return ok({
    tasks: tasks.value,
    loops: loops.value,
    schedules: schedules.value,
    orchestrations: orchestrations.value,
    taskCounts: buildEntityCounts(taskCounts.value),
    loopCounts: buildEntityCounts(loopCounts.value),
    scheduleCounts: buildEntityCounts(scheduleCounts.value),
    orchestrationCounts: buildEntityCounts(orchestrationCounts.value),
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
  ] = await Promise.all([
    ctx.usageRepository.sumGlobal(since24h),
    ctx.usageRepository.topOrchestrationsByCost(since24h, 3),
    ctx.taskRepository.getThroughputStats(3600 * 1000),
    ctx.taskRepository.findUpdatedSince(since1h, 50),
    ctx.loopRepository.findUpdatedSince(since1h, 50),
    ctx.orchestrationRepository.findUpdatedSince(since1h, 50),
    ctx.scheduleRepository.findUpdatedSince(since1h, 50),
  ]);

  const activityFeed = buildActivityFeed({
    tasks: recentTasksResult.ok ? recentTasksResult.value : [],
    loops: recentLoopsResult.ok ? recentLoopsResult.value : [],
    orchestrations: recentOrchsResult.ok ? recentOrchsResult.value : [],
    schedules: recentSchedsResult.ok ? recentSchedsResult.value : [],
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
 * Custom hook that polls all repositories every 1s.
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

  // Stable fetch function — ctx is the only dep; viewState and childPage are read via refs
  const doFetch = useCallback(async (): Promise<void> => {
    if (fetching.current) return;
    fetching.current = true;
    try {
      const result = await fetchAllData(ctx, viewStateRef.current, childPageRef.current);

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

  useEffect(() => {
    closing.current = false;

    // Initial fetch immediately on mount. Also re-runs when orchestrationChildPage
    // changes so PgUp/PgDn in orchestration detail produces an immediate fetch
    // with the new page (otherwise the ref-read pattern would lag by one poll
    // tick because setNav schedules the re-render asynchronously).
    void doFetch();

    // Poll every 1 second
    const intervalId = setInterval(() => {
      void doFetch();
    }, 1_000);

    return () => {
      closing.current = true;
      clearInterval(intervalId);
    };
  }, [doFetch, orchestrationChildPage]);

  const refreshNow = useCallback(() => {
    void doFetch();
  }, [doFetch]);

  return { data, error, refreshedAt, refreshNow };
}
