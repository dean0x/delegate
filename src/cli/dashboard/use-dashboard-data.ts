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
import type { LoopId, ScheduleId } from '../../core/domain.js';
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

  // Unwrap results — on any error, return error string
  if (!tasksResult.ok) return err(`Tasks fetch failed: ${tasksResult.error.message}`);
  if (!loopsResult.ok) return err(`Loops fetch failed: ${loopsResult.error.message}`);
  if (!schedulesResult.ok) return err(`Schedules fetch failed: ${schedulesResult.error.message}`);
  if (!orchestrationsResult.ok) return err(`Orchestrations fetch failed: ${orchestrationsResult.error.message}`);
  if (!taskCountsResult.ok) return err(`Task counts failed: ${taskCountsResult.error.message}`);
  if (!loopCountsResult.ok) return err(`Loop counts failed: ${loopCountsResult.error.message}`);
  if (!scheduleCountsResult.ok) return err(`Schedule counts failed: ${scheduleCountsResult.error.message}`);
  if (!orchestrationCountsResult.ok)
    return err(`Orchestration counts failed: ${orchestrationCountsResult.error.message}`);

  // Fetch detail extras if in detail view (best-effort — errors yield undefined)
  let detailExtra: DetailExtra = {};
  if (viewState.kind === 'detail') {
    detailExtra = await fetchDetailExtra(ctx, viewState.entityType, viewState.entityId);
  }

  return ok({
    tasks: tasksResult.value,
    loops: loopsResult.value,
    schedules: schedulesResult.value,
    orchestrations: orchestrationsResult.value,
    taskCounts: buildEntityCounts(taskCountsResult.value),
    loopCounts: buildEntityCounts(loopCountsResult.value),
    scheduleCounts: buildEntityCounts(scheduleCountsResult.value),
    orchestrationCounts: buildEntityCounts(orchestrationCountsResult.value),
    ...detailExtra,
  });
}

/**
 * Fetch detail-view extras (iterations for loops, execution history for schedules).
 * Returns empty DetailExtra on any error — dashboard degrades gracefully.
 */
async function fetchDetailExtra(ctx: ReadOnlyContext, entityType: string, entityId: string): Promise<DetailExtra> {
  if (entityType === 'loops') {
    const result = await ctx.loopRepository.getIterations(entityId as LoopId, 50);
    return { iterations: result.ok ? result.value : undefined };
  }

  if (entityType === 'schedules') {
    const result = await ctx.scheduleRepository.getExecutionHistory(entityId as ScheduleId, 50);
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
 */
export function useDashboardData(ctx: ReadOnlyContext, viewState: ViewState): UseDashboardDataResult {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);

  // Prevent setState after unmount or shutdown
  const closing = useRef(false);

  // Stable reference to the fetch function — rebuilt only when ctx/viewState changes
  const doFetch = useCallback(async (): Promise<void> => {
    try {
      const result = await fetchAllData(ctx, viewState);

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
    }
  }, [ctx, viewState]);

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
