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
    taskRepository.findAll(50),
    loopRepository.findAll(50),
    scheduleRepository.findAll(50),
    orchestrationRepository.findAll(50),
    taskRepository.countByStatus(),
    loopRepository.countByStatus(),
    scheduleRepository.countByStatus(),
    orchestrationRepository.countByStatus(),
  ]);

  // Unwrap each result — unwrapOrErr returns the value or a labeled error string
  const tasksU = unwrapOrErr('Tasks', tasksResult);
  if (!tasksU.ok) return err(tasksU.error);
  const loopsU = unwrapOrErr('Loops', loopsResult);
  if (!loopsU.ok) return err(loopsU.error);
  const schedulesU = unwrapOrErr('Schedules', schedulesResult);
  if (!schedulesU.ok) return err(schedulesU.error);
  const orchestrationsU = unwrapOrErr('Orchestrations', orchestrationsResult);
  if (!orchestrationsU.ok) return err(orchestrationsU.error);
  const taskCountsU = unwrapOrErr('Task counts', taskCountsResult);
  if (!taskCountsU.ok) return err(taskCountsU.error);
  const loopCountsU = unwrapOrErr('Loop counts', loopCountsResult);
  if (!loopCountsU.ok) return err(loopCountsU.error);
  const scheduleCountsU = unwrapOrErr('Schedule counts', scheduleCountsResult);
  if (!scheduleCountsU.ok) return err(scheduleCountsU.error);
  const orchestrationCountsU = unwrapOrErr('Orchestration counts', orchestrationCountsResult);
  if (!orchestrationCountsU.ok) return err(orchestrationCountsU.error);

  // Fetch detail extras if in detail view (best-effort — errors yield undefined)
  let detailExtra: DetailExtra = {};
  if (viewState.kind === 'detail') {
    detailExtra = await fetchDetailExtra(ctx, viewState);
  }

  return ok({
    tasks: tasksU.value,
    loops: loopsU.value,
    schedules: schedulesU.value,
    orchestrations: orchestrationsU.value,
    taskCounts: buildEntityCounts(taskCountsU.value),
    loopCounts: buildEntityCounts(loopCountsU.value),
    scheduleCounts: buildEntityCounts(scheduleCountsU.value),
    orchestrationCounts: buildEntityCounts(orchestrationCountsU.value),
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
