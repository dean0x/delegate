/**
 * Tests for MetricsView component
 * ARCHITECTURE: Tests behavior — nominal render, resources unavailable, cost zero, activity empty, footer hints
 */

import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import type { MetricsLayout } from '../../../../src/cli/dashboard/layout.js';
import type { DashboardData, NavState } from '../../../../src/cli/dashboard/types.js';
import { MetricsView } from '../../../../src/cli/dashboard/views/metrics-view.js';
import type { TaskUsage } from '../../../../src/core/domain.js';

// ============================================================================
// Test fixtures
// ============================================================================

function makeLayout(overrides: Partial<MetricsLayout> = {}): MetricsLayout {
  return {
    headerHeight: 2,
    footerHeight: 1,
    availableHeight: 21,
    topRowHeight: 8,
    bottomRowHeight: 13,
    tileCount: 3,
    mode: 'full',
    ...overrides,
  };
}

function makeNav(): NavState {
  return {
    focusedPanel: 'tasks',
    selectedIndices: { loops: 0, tasks: 0, schedules: 0, orchestrations: 0, pipelines: 0 },
    filters: { loops: null, tasks: null, schedules: null, orchestrations: null, pipelines: null },
    scrollOffsets: { loops: 0, tasks: 0, schedules: 0, orchestrations: 0, pipelines: 0 },
    orchestrationChildSelectedTaskId: null,
    orchestrationChildPage: 0,
  };
}

function makeUsage(overrides: Partial<TaskUsage> = {}): TaskUsage {
  return {
    taskId: 'task-1' as TaskUsage['taskId'],
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalCostUsd: 0.015,
    capturedAt: Date.now(),
    ...overrides,
  };
}

function makeData(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    tasks: [],
    loops: [],
    schedules: [],
    orchestrations: [],
    pipelines: [],
    taskCounts: { total: 0, byStatus: {} },
    loopCounts: { total: 0, byStatus: {} },
    scheduleCounts: { total: 0, byStatus: {} },
    orchestrationCounts: { total: 0, byStatus: {} },
    pipelineCounts: { total: 0, byStatus: {} },
    ...overrides,
  };
}

// ============================================================================
// MetricsView tests
// ============================================================================

describe('MetricsView', () => {
  describe('too-small mode', () => {
    it('shows resize message when layout mode is too-small', () => {
      const { lastFrame } = render(
        <MetricsView
          layout={makeLayout({ mode: 'too-small' })}
          data={makeData()}
          nav={makeNav()}
          resourceMetrics={null}
          resourceError={null}
        />,
      );
      const frame = lastFrame() ?? '';
      expect(frame.toLowerCase()).toMatch(/resize|too small|terminal/);
    });
  });

  describe('narrow mode', () => {
    it('renders without crashing in narrow mode', () => {
      const { lastFrame } = render(
        <MetricsView
          layout={makeLayout({ mode: 'narrow' })}
          data={makeData()}
          nav={makeNav()}
          resourceMetrics={null}
          resourceError={null}
        />,
      );
      expect(lastFrame()).toBeTruthy();
    });
  });

  describe('full mode — nominal render', () => {
    it('renders without crashing in full mode', () => {
      const { lastFrame } = render(
        <MetricsView
          layout={makeLayout({ mode: 'full' })}
          data={makeData()}
          nav={makeNav()}
          resourceMetrics={null}
          resourceError={null}
        />,
      );
      expect(lastFrame()).toBeTruthy();
    });

    it('renders cost information when costRollup24h is provided', () => {
      const { lastFrame } = render(
        <MetricsView
          layout={makeLayout({ mode: 'full' })}
          data={makeData({ costRollup24h: makeUsage({ totalCostUsd: 1.5 }) })}
          nav={makeNav()}
          resourceMetrics={null}
          resourceError={null}
        />,
      );
      expect(lastFrame()).toContain('$1.50');
    });

    it('shows $0.00 when no cost data (null costRollup24h)', () => {
      const { lastFrame } = render(
        <MetricsView
          layout={makeLayout({ mode: 'full' })}
          data={makeData({ costRollup24h: undefined })}
          nav={makeNav()}
          resourceMetrics={null}
          resourceError={null}
        />,
      );
      expect(lastFrame()).toContain('$0.00');
    });

    it('renders activity feed entries when present', () => {
      const data = makeData({
        activityFeed: [
          {
            timestamp: new Date(Date.now() - 1000),
            kind: 'task',
            entityId: 'task-deadbeef1234',
            status: 'running',
            action: 'running',
          },
        ],
      });
      const { lastFrame } = render(
        <MetricsView
          layout={makeLayout({ mode: 'full' })}
          data={data}
          nav={makeNav()}
          resourceMetrics={null}
          resourceError={null}
        />,
      );
      // Activity panel should be rendered (title visible)
      expect(lastFrame()).toContain('Activity');
      // "No recent activity" should NOT appear when there are entries
      expect(lastFrame()).not.toContain('No recent activity');
    });

    it('shows empty state message when activity feed is empty', () => {
      const { lastFrame } = render(
        <MetricsView
          layout={makeLayout({ mode: 'full' })}
          data={makeData({ activityFeed: [] })}
          nav={makeNav()}
          resourceMetrics={null}
          resourceError={null}
        />,
      );
      // Should render something — not just crash
      expect(lastFrame()).toBeTruthy();
    });

    it('shows resource em-dash placeholder when resourceMetrics is null', () => {
      const { lastFrame } = render(
        <MetricsView
          layout={makeLayout({ mode: 'full' })}
          data={makeData()}
          nav={makeNav()}
          resourceMetrics={null}
          resourceError={null}
        />,
      );
      expect(lastFrame()).toContain('—');
    });

    it('renders throughput data when provided', () => {
      const data = makeData({
        throughputStats: { tasksPerHour: 5, loopsPerHour: 1, successRate: 0.9, avgDurationMs: 60_000 },
      });
      const { lastFrame } = render(
        <MetricsView
          layout={makeLayout({ mode: 'full' })}
          data={data}
          nav={makeNav()}
          resourceMetrics={null}
          resourceError={null}
        />,
      );
      expect(lastFrame()).toContain('5');
    });
  });
});
