/**
 * Tests for dashboard data fetching logic
 * ARCHITECTURE: Tests the core fetch behavior via the exported buildDashboardData function,
 * and separately tests hook integration using ink-testing-library.
 * Pattern: Test behavior (data transformation, error handling) not rendering internals.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ViewState } from '../../../../src/cli/dashboard/types.js';
import { buildEntityCounts, FETCH_LIMIT, fetchAllData } from '../../../../src/cli/dashboard/use-dashboard-data.js';
import type { ReadOnlyContext } from '../../../../src/cli/read-only-context.js';
import { err, ok } from '../../../../src/core/result.js';

// ============================================================================
// Test helpers
// ============================================================================

function makeMockRepo(overrides: Record<string, unknown> = {}): {
  findAll: ReturnType<typeof vi.fn>;
  countByStatus: ReturnType<typeof vi.fn>;
  getIterations?: ReturnType<typeof vi.fn>;
  getExecutionHistory?: ReturnType<typeof vi.fn>;
} {
  return {
    findAll: vi.fn().mockResolvedValue(ok([])),
    countByStatus: vi.fn().mockResolvedValue(ok({})),
    ...overrides,
  };
}

function makeCtx(overrides: Partial<ReadOnlyContext> = {}): ReadOnlyContext {
  const taskRepo = makeMockRepo();
  const loopRepo = {
    ...makeMockRepo(),
    getIterations: vi.fn().mockResolvedValue(ok([])),
  };
  const scheduleRepo = {
    ...makeMockRepo(),
    getExecutionHistory: vi.fn().mockResolvedValue(ok([])),
  };
  const orchestrationRepo = makeMockRepo();

  return {
    taskRepository: taskRepo as unknown as ReadOnlyContext['taskRepository'],
    loopRepository: loopRepo as unknown as ReadOnlyContext['loopRepository'],
    scheduleRepository: scheduleRepo as unknown as ReadOnlyContext['scheduleRepository'],
    orchestrationRepository: orchestrationRepo as unknown as ReadOnlyContext['orchestrationRepository'],
    outputRepository: {} as ReadOnlyContext['outputRepository'],
    close: vi.fn(),
    ...overrides,
  };
}

const MAIN_VIEW: ViewState = { kind: 'main' };

// ============================================================================
// buildEntityCounts
// ============================================================================

describe('buildEntityCounts', () => {
  it('returns zero total for empty counts', () => {
    const result = buildEntityCounts({});
    expect(result.total).toBe(0);
    expect(result.byStatus).toEqual({});
  });

  it('sums all status counts for total', () => {
    const result = buildEntityCounts({ running: 3, completed: 7 });
    expect(result.total).toBe(10);
    expect(result.byStatus).toEqual({ running: 3, completed: 7 });
  });

  it('handles single status', () => {
    const result = buildEntityCounts({ active: 5 });
    expect(result.total).toBe(5);
  });
});

// ============================================================================
// fetchAllData
// ============================================================================

describe('fetchAllData', () => {
  it('returns populated data on success', async () => {
    const ctx = makeCtx();
    const result = await fetchAllData(ctx, MAIN_VIEW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.tasks).toEqual([]);
    expect(result.value.loops).toEqual([]);
    expect(result.value.schedules).toEqual([]);
    expect(result.value.orchestrations).toEqual([]);
    expect(result.value.taskCounts.total).toBe(0);
    expect(result.value.loopCounts.total).toBe(0);
  });

  it('calls findAll(FETCH_LIMIT) on all repositories', async () => {
    const ctx = makeCtx();
    await fetchAllData(ctx, MAIN_VIEW);

    expect(ctx.taskRepository.findAll).toHaveBeenCalledWith(FETCH_LIMIT);
    expect(ctx.loopRepository.findAll).toHaveBeenCalledWith(FETCH_LIMIT);
    expect(ctx.scheduleRepository.findAll).toHaveBeenCalledWith(FETCH_LIMIT);
    expect(ctx.orchestrationRepository.findAll).toHaveBeenCalledWith(FETCH_LIMIT);
  });

  it('calls countByStatus on all repositories', async () => {
    const ctx = makeCtx();
    await fetchAllData(ctx, MAIN_VIEW);

    expect(ctx.taskRepository.countByStatus).toHaveBeenCalled();
    expect(ctx.loopRepository.countByStatus).toHaveBeenCalled();
    expect(ctx.scheduleRepository.countByStatus).toHaveBeenCalled();
    expect(ctx.orchestrationRepository.countByStatus).toHaveBeenCalled();
  });

  it('returns error when task findAll fails', async () => {
    const taskRepo = {
      findAll: vi.fn().mockResolvedValue(err(new Error('DB error'))),
      countByStatus: vi.fn().mockResolvedValue(ok({})),
    };
    const ctx = makeCtx({
      taskRepository: taskRepo as unknown as ReadOnlyContext['taskRepository'],
    });

    const result = await fetchAllData(ctx, MAIN_VIEW);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('DB error');
  });

  it('returns error when countByStatus fails', async () => {
    const taskRepo = {
      findAll: vi.fn().mockResolvedValue(ok([])),
      countByStatus: vi.fn().mockResolvedValue(err(new Error('count error'))),
    };
    const ctx = makeCtx({
      taskRepository: taskRepo as unknown as ReadOnlyContext['taskRepository'],
    });

    const result = await fetchAllData(ctx, MAIN_VIEW);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('count error');
  });

  it('builds correct entityCounts from status counts', async () => {
    const taskRepo = {
      findAll: vi.fn().mockResolvedValue(ok([])),
      countByStatus: vi.fn().mockResolvedValue(ok({ running: 3, completed: 7 })),
    };
    const ctx = makeCtx({
      taskRepository: taskRepo as unknown as ReadOnlyContext['taskRepository'],
    });

    const result = await fetchAllData(ctx, MAIN_VIEW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.taskCounts.total).toBe(10);
    expect(result.value.taskCounts.byStatus).toEqual({ running: 3, completed: 7 });
  });

  it('fetches loop iterations when in loop detail view', async () => {
    const loopRepo = {
      findAll: vi.fn().mockResolvedValue(ok([])),
      countByStatus: vi.fn().mockResolvedValue(ok({})),
      getIterations: vi.fn().mockResolvedValue(ok([])),
    };
    const ctx = makeCtx({
      loopRepository: loopRepo as unknown as ReadOnlyContext['loopRepository'],
    });

    const detailView: ViewState = { kind: 'detail', entityType: 'loops', entityId: 'loop-123' };
    await fetchAllData(ctx, detailView);

    expect(loopRepo.getIterations).toHaveBeenCalledWith('loop-123', 50);
  });

  it('fetches schedule execution history when in schedule detail view', async () => {
    const scheduleRepo = {
      findAll: vi.fn().mockResolvedValue(ok([])),
      countByStatus: vi.fn().mockResolvedValue(ok({})),
      getExecutionHistory: vi.fn().mockResolvedValue(ok([])),
    };
    const ctx = makeCtx({
      scheduleRepository: scheduleRepo as unknown as ReadOnlyContext['scheduleRepository'],
    });

    const detailView: ViewState = { kind: 'detail', entityType: 'schedules', entityId: 'sched-456' };
    await fetchAllData(ctx, detailView);

    expect(scheduleRepo.getExecutionHistory).toHaveBeenCalledWith('sched-456', 50);
  });

  it('does not fetch extra data when in main view', async () => {
    const loopRepo = {
      findAll: vi.fn().mockResolvedValue(ok([])),
      countByStatus: vi.fn().mockResolvedValue(ok({})),
      getIterations: vi.fn().mockResolvedValue(ok([])),
    };
    const ctx = makeCtx({
      loopRepository: loopRepo as unknown as ReadOnlyContext['loopRepository'],
    });

    await fetchAllData(ctx, MAIN_VIEW);

    expect(loopRepo.getIterations).not.toHaveBeenCalled();
  });

  it('gracefully handles missing iterations on loop repo error', async () => {
    const loopRepo = {
      findAll: vi.fn().mockResolvedValue(ok([])),
      countByStatus: vi.fn().mockResolvedValue(ok({})),
      getIterations: vi.fn().mockResolvedValue(err(new Error('iterations unavailable'))),
    };
    const ctx = makeCtx({
      loopRepository: loopRepo as unknown as ReadOnlyContext['loopRepository'],
    });

    const detailView: ViewState = { kind: 'detail', entityType: 'loops', entityId: 'loop-999' };
    const result = await fetchAllData(ctx, detailView);

    // Should still succeed — iterations are best-effort
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.iterations).toBeUndefined();
  });
});
