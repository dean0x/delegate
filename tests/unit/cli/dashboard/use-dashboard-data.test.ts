/**
 * Tests for dashboard data fetching logic
 * ARCHITECTURE: Tests the core fetch behavior via the exported buildDashboardData function,
 * and separately tests hook integration using ink-testing-library.
 * Pattern: Test behavior (data transformation, error handling) not rendering internals.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ViewState } from '../../../../src/cli/dashboard/types.js';
import {
  buildEntityCounts,
  FETCH_LIMIT,
  fetchAllData,
  POLL_INTERVAL_BY_VIEW,
} from '../../../../src/cli/dashboard/use-dashboard-data.js';
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
  const taskRepo = {
    ...makeMockRepo(),
    getThroughputStats: vi
      .fn()
      .mockResolvedValue(ok({ tasksPerHour: 0, loopsPerHour: 0, successRate: 0, avgDurationMs: 0 })),
    findUpdatedSince: vi.fn().mockResolvedValue(ok([])),
  };
  const loopRepo = {
    ...makeMockRepo(),
    getIterations: vi.fn().mockResolvedValue(ok([])),
    findUpdatedSince: vi.fn().mockResolvedValue(ok([])),
  };
  const scheduleRepo = {
    ...makeMockRepo(),
    getExecutionHistory: vi.fn().mockResolvedValue(ok([])),
    findUpdatedSince: vi.fn().mockResolvedValue(ok([])),
  };
  const orchestrationRepo = {
    ...makeMockRepo(),
    findUpdatedSince: vi.fn().mockResolvedValue(ok([])),
    getOrchestratorChildren: vi.fn().mockResolvedValue(ok([])),
    countOrchestratorChildren: vi.fn().mockResolvedValue(ok(0)),
  };
  const usageRepo = {
    sumGlobal: vi.fn().mockResolvedValue(
      ok({
        taskId: '' as never,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        totalCostUsd: 0,
        capturedAt: 0,
      }),
    ),
    topOrchestrationsByCost: vi.fn().mockResolvedValue(ok([])),
    get: vi.fn().mockResolvedValue(ok(null)),
    save: vi.fn().mockResolvedValue(ok(undefined)),
    sumByOrchestrationId: vi.fn().mockResolvedValue(
      ok({
        taskId: '' as never,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        totalCostUsd: 0,
        capturedAt: 0,
      }),
    ),
    sumByLoopId: vi.fn().mockResolvedValue(
      ok({
        taskId: '' as never,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        totalCostUsd: 0,
        capturedAt: 0,
      }),
    ),
  };

  const pipelineRepo = {
    ...makeMockRepo(),
    findUpdatedSince: vi.fn().mockResolvedValue(ok([])),
  };

  return {
    taskRepository: taskRepo as unknown as ReadOnlyContext['taskRepository'],
    loopRepository: loopRepo as unknown as ReadOnlyContext['loopRepository'],
    scheduleRepository: scheduleRepo as unknown as ReadOnlyContext['scheduleRepository'],
    orchestrationRepository: orchestrationRepo as unknown as ReadOnlyContext['orchestrationRepository'],
    pipelineRepository: pipelineRepo as unknown as ReadOnlyContext['pipelineRepository'],
    outputRepository: {} as ReadOnlyContext['outputRepository'],
    usageRepository: usageRepo as unknown as ReadOnlyContext['usageRepository'],
    workerRepository: {
      findAll: vi.fn().mockResolvedValue(ok([])),
    } as unknown as ReadOnlyContext['workerRepository'],
    close: vi.fn(),
    ...overrides,
  };
}

const MAIN_VIEW: ViewState = { kind: 'main' };

// ============================================================================
// POLL_INTERVAL_BY_VIEW — per-view cadence
// ============================================================================

describe('POLL_INTERVAL_BY_VIEW', () => {
  it('main view polls at 1 000 ms', () => {
    expect(POLL_INTERVAL_BY_VIEW.main).toBe(1_000);
  });

  it('workspace view polls at 750 ms (faster than main for live output)', () => {
    expect(POLL_INTERVAL_BY_VIEW.workspace).toBe(750);
    expect(POLL_INTERVAL_BY_VIEW.workspace).toBeLessThan(POLL_INTERVAL_BY_VIEW.main);
  });

  it('detail view polls at 2 000 ms (slower to reduce DB pressure)', () => {
    expect(POLL_INTERVAL_BY_VIEW.detail).toBe(2_000);
    expect(POLL_INTERVAL_BY_VIEW.detail).toBeGreaterThan(POLL_INTERVAL_BY_VIEW.main);
  });
});

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
    expect(result.value.pipelines).toEqual([]);
    expect(result.value.taskCounts.total).toBe(0);
    expect(result.value.loopCounts.total).toBe(0);
    expect(result.value.pipelineCounts.total).toBe(0);
  });

  it('calls findAll(FETCH_LIMIT) on all repositories', async () => {
    const ctx = makeCtx();
    await fetchAllData(ctx, MAIN_VIEW);

    expect(ctx.taskRepository.findAll).toHaveBeenCalledWith(FETCH_LIMIT);
    expect(ctx.loopRepository.findAll).toHaveBeenCalledWith(FETCH_LIMIT);
    expect(ctx.scheduleRepository.findAll).toHaveBeenCalledWith(FETCH_LIMIT);
    expect(ctx.orchestrationRepository.findAll).toHaveBeenCalledWith(FETCH_LIMIT);
    expect(ctx.pipelineRepository.findAll).toHaveBeenCalledWith(FETCH_LIMIT);
  });

  it('calls countByStatus on all repositories', async () => {
    const ctx = makeCtx();
    await fetchAllData(ctx, MAIN_VIEW);

    expect(ctx.taskRepository.countByStatus).toHaveBeenCalled();
    expect(ctx.loopRepository.countByStatus).toHaveBeenCalled();
    expect(ctx.scheduleRepository.countByStatus).toHaveBeenCalled();
    expect(ctx.orchestrationRepository.countByStatus).toHaveBeenCalled();
    expect(ctx.pipelineRepository.countByStatus).toHaveBeenCalled();
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
      getThroughputStats: vi
        .fn()
        .mockResolvedValue(ok({ tasksPerHour: 0, loopsPerHour: 0, successRate: 0, avgDurationMs: 0 })),
      findUpdatedSince: vi.fn().mockResolvedValue(ok([])),
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
      findUpdatedSince: vi.fn().mockResolvedValue(ok([])),
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

  it('does not fetch loop iterations (getIterations) when in main view', async () => {
    const loopRepo = {
      findAll: vi.fn().mockResolvedValue(ok([])),
      countByStatus: vi.fn().mockResolvedValue(ok({})),
      getIterations: vi.fn().mockResolvedValue(ok([])),
      findUpdatedSince: vi.fn().mockResolvedValue(ok([])),
    };
    const ctx = makeCtx({
      loopRepository: loopRepo as unknown as ReadOnlyContext['loopRepository'],
    });

    await fetchAllData(ctx, MAIN_VIEW);

    // getIterations is for detail view only — should not be called in main view
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

  it('fetches orchestration children with correct childPage offset when in orchestration detail view', async () => {
    const orchestrationRepo = {
      findAll: vi.fn().mockResolvedValue(ok([])),
      countByStatus: vi.fn().mockResolvedValue(ok({})),
      findUpdatedSince: vi.fn().mockResolvedValue(ok([])),
      getOrchestratorChildren: vi.fn().mockResolvedValue(ok([])),
      countOrchestratorChildren: vi.fn().mockResolvedValue(ok(0)),
    };
    const ctx = makeCtx({
      orchestrationRepository: orchestrationRepo as unknown as ReadOnlyContext['orchestrationRepository'],
    });

    const detailView: ViewState = { kind: 'detail', entityType: 'orchestrations', entityId: 'orch-abc' };
    await fetchAllData(ctx, detailView, 2); // childPage = 2

    // Should pass offset = 2 * PAGE_SIZE to getOrchestratorChildren
    expect(orchestrationRepo.getOrchestratorChildren).toHaveBeenCalledWith(
      'orch-abc',
      expect.any(Number), // PAGE_SIZE
      expect.any(Number), // offset = 2 * PAGE_SIZE
    );
    const [, , offset] = orchestrationRepo.getOrchestratorChildren.mock.calls[0];
    expect(offset).toBeGreaterThan(0); // non-zero for page 2
  });

  it('fetches orchestration children with offset 0 on first page', async () => {
    const orchestrationRepo = {
      findAll: vi.fn().mockResolvedValue(ok([])),
      countByStatus: vi.fn().mockResolvedValue(ok({})),
      findUpdatedSince: vi.fn().mockResolvedValue(ok([])),
      getOrchestratorChildren: vi.fn().mockResolvedValue(ok([])),
      countOrchestratorChildren: vi.fn().mockResolvedValue(ok(0)),
    };
    const ctx = makeCtx({
      orchestrationRepository: orchestrationRepo as unknown as ReadOnlyContext['orchestrationRepository'],
    });

    const detailView: ViewState = { kind: 'detail', entityType: 'orchestrations', entityId: 'orch-p0' };
    await fetchAllData(ctx, detailView, 0); // default page 0

    const [, , offset] = orchestrationRepo.getOrchestratorChildren.mock.calls[0];
    expect(offset).toBe(0);
  });

  it('also calls countOrchestratorChildren in orchestration detail view', async () => {
    const orchestrationRepo = {
      findAll: vi.fn().mockResolvedValue(ok([])),
      countByStatus: vi.fn().mockResolvedValue(ok({})),
      findUpdatedSince: vi.fn().mockResolvedValue(ok([])),
      getOrchestratorChildren: vi.fn().mockResolvedValue(ok([])),
      countOrchestratorChildren: vi.fn().mockResolvedValue(ok(42)),
    };
    const ctx = makeCtx({
      orchestrationRepository: orchestrationRepo as unknown as ReadOnlyContext['orchestrationRepository'],
    });

    const detailView: ViewState = { kind: 'detail', entityType: 'orchestrations', entityId: 'orch-cnt' };
    const result = await fetchAllData(ctx, detailView);

    expect(orchestrationRepo.countOrchestratorChildren).toHaveBeenCalledWith('orch-cnt');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.orchestrationChildrenTotal).toBe(42);
  });
});

// ============================================================================
// Liveness cache — TTL-based memoization
// ============================================================================

describe('fetchAllData — orchestration liveness caching', () => {
  it('calls liveness check once per orchestration when cache is empty', async () => {
    const { OrchestratorStatus: Status } = await import('../../../../src/core/domain.js');
    const orch = { id: 'orch-1', status: Status.RUNNING, loopId: undefined };

    const orchestrationRepo = {
      findAll: vi.fn().mockResolvedValue(ok([orch])),
      countByStatus: vi.fn().mockResolvedValue(ok({})),
      findUpdatedSince: vi.fn().mockResolvedValue(ok([])),
      getOrchestratorChildren: vi.fn().mockResolvedValue(ok([])),
      countOrchestratorChildren: vi.fn().mockResolvedValue(ok(0)),
    };
    const loopRepo = {
      findAll: vi.fn().mockResolvedValue(ok([])),
      countByStatus: vi.fn().mockResolvedValue(ok({})),
      getIterations: vi.fn().mockResolvedValue(ok([])),
      findUpdatedSince: vi.fn().mockResolvedValue(ok([])),
    };
    const ctx = makeCtx({
      orchestrationRepository: orchestrationRepo as unknown as ReadOnlyContext['orchestrationRepository'],
      loopRepository: loopRepo as unknown as ReadOnlyContext['loopRepository'],
    });

    const cache = new Map();
    await fetchAllData(ctx, MAIN_VIEW, 0, cache);

    // loopId is undefined — chain is broken so returns 'unknown' immediately without DB hits
    // but the cache should still record the result
    expect(cache.size).toBe(1);
    expect(cache.get('orch-1')).toBeDefined();
    expect(cache.get('orch-1').result).toBe('unknown');
  });

  it('serves cached liveness result without hitting repositories on second call within TTL', async () => {
    const { OrchestratorStatus: Status } = await import('../../../../src/core/domain.js');
    const orch = { id: 'orch-cache', status: Status.RUNNING, loopId: 'loop-1' };

    const orchestrationRepo = {
      findAll: vi.fn().mockResolvedValue(ok([orch])),
      countByStatus: vi.fn().mockResolvedValue(ok({})),
      findUpdatedSince: vi.fn().mockResolvedValue(ok([])),
      getOrchestratorChildren: vi.fn().mockResolvedValue(ok([])),
      countOrchestratorChildren: vi.fn().mockResolvedValue(ok(0)),
    };
    const loopRepo = {
      findAll: vi.fn().mockResolvedValue(ok([])),
      countByStatus: vi.fn().mockResolvedValue(ok({})),
      getIterations: vi.fn().mockResolvedValue(ok([])),
      findUpdatedSince: vi.fn().mockResolvedValue(ok([])),
    };
    const ctx = makeCtx({
      orchestrationRepository: orchestrationRepo as unknown as ReadOnlyContext['orchestrationRepository'],
      loopRepository: loopRepo as unknown as ReadOnlyContext['loopRepository'],
    });

    // Pre-populate the cache with a fresh entry — simulates a prior tick within TTL
    const cache = new Map([['orch-cache', { result: 'live' as const, timestamp: Date.now() }]]);

    const result = await fetchAllData(ctx, MAIN_VIEW, 0, cache);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should return 'live' from cache — no loop repo hits for liveness
    expect(result.value.orchestrationLiveness?.['orch-cache']).toBe('live');
    // getIterations should NOT be called since liveness was served from cache
    expect(loopRepo.getIterations).not.toHaveBeenCalled();
  });

  it('does not populate liveness for non-RUNNING orchestrations', async () => {
    const { OrchestratorStatus: Status } = await import('../../../../src/core/domain.js');
    const orch = { id: 'orch-done', status: Status.COMPLETED, loopId: 'loop-1' };

    const orchestrationRepo = {
      findAll: vi.fn().mockResolvedValue(ok([orch])),
      countByStatus: vi.fn().mockResolvedValue(ok({})),
      findUpdatedSince: vi.fn().mockResolvedValue(ok([])),
      getOrchestratorChildren: vi.fn().mockResolvedValue(ok([])),
      countOrchestratorChildren: vi.fn().mockResolvedValue(ok(0)),
    };
    const ctx = makeCtx({
      orchestrationRepository: orchestrationRepo as unknown as ReadOnlyContext['orchestrationRepository'],
    });

    const cache = new Map();
    const result = await fetchAllData(ctx, MAIN_VIEW, 0, cache);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // COMPLETED orchestration should have no liveness entry
    expect(result.value.orchestrationLiveness?.['orch-done']).toBeUndefined();
    // Cache should be empty — no liveness computed for completed orch
    expect(cache.size).toBe(0);
  });
});
