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
import type { Result } from '../../core/result.js';
import { err, ok } from '../../core/result.js';
import type { ReadOnlyContext } from '../read-only-context.js';
import type { DashboardData, DetailExtra, EntityCounts, ViewState } from './types.js';

export interface UseDashboardDataResult {
  readonly data: DashboardData | null;
  readonly error: string | null;
  readonly refreshedAt: Date | null;
  readonly refreshNow: () => void;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Maximum number of items fetched per entity panel.
 * When the true total exceeds this limit, the UI shows a truncation notice.
 */
export const FETCH_LIMIT = 50;

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
 */
export async function fetchAllData(ctx: ReadOnlyContext, viewState: ViewState): Promise<Result<DashboardData, string>> {
  const { taskRepository, loopRepository, scheduleRepository, orchestrationRepository } = ctx;

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
  const detailExtra: DetailExtra = viewState.kind === 'detail' ? await fetchDetailExtra(ctx, viewState) : {};

  return ok({
    tasks: tasks.value,
    loops: loops.value,
    schedules: schedules.value,
    orchestrations: orchestrations.value,
    taskCounts: buildEntityCounts(taskCounts.value),
    loopCounts: buildEntityCounts(loopCounts.value),
    scheduleCounts: buildEntityCounts(scheduleCounts.value),
    orchestrationCounts: buildEntityCounts(orchestrationCounts.value),
    ...detailExtra,
  });
}

/**
 * Fetch detail-view extras (iterations for loops, execution history for schedules).
 * Accepts the narrowed detail variant so branded IDs flow without unsafe casts.
 * Returns empty DetailExtra on any error — dashboard degrades gracefully.
 */
async function fetchDetailExtra(
  ctx: ReadOnlyContext,
  detail: Extract<ViewState, { readonly kind: 'detail' }>,
): Promise<DetailExtra> {
  if (detail.entityType === 'loops') {
    const result = await ctx.loopRepository.getIterations(detail.entityId, 50);
    return { iterations: result.ok ? result.value : undefined };
  }

  if (detail.entityType === 'schedules') {
    const result = await ctx.scheduleRepository.getExecutionHistory(detail.entityId, 50);
    return { executions: result.ok ? result.value : undefined };
  }

  // tasks and orchestrations don't have dedicated extra data at this phase
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
 */
export function useDashboardData(ctx: ReadOnlyContext, viewState: ViewState): UseDashboardDataResult {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);

  // Prevent setState after unmount or shutdown
  const closing = useRef(false);

  // Always holds the latest viewState — updated synchronously before each render
  const viewStateRef = useRef(viewState);
  viewStateRef.current = viewState;

  // Guard against overlapping in-flight fetches caused by slow SQLite under load
  const fetching = useRef(false);

  // Stable fetch function — ctx is the only dep; viewState is read via ref
  const doFetch = useCallback(async (): Promise<void> => {
    if (fetching.current) return;
    fetching.current = true;
    try {
      const result = await fetchAllData(ctx, viewStateRef.current);

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

    // Initial fetch immediately on mount
    void doFetch();

    // Poll every 1 second
    const intervalId = setInterval(() => {
      void doFetch();
    }, 1_000);

    return () => {
      closing.current = true;
      clearInterval(intervalId);
    };
  }, [doFetch]);

  const refreshNow = useCallback(() => {
    void doFetch();
  }, [doFetch]);

  return { data, error, refreshedAt, refreshNow };
}
