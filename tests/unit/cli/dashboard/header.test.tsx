/**
 * Tests for Header component and buildHealthSummary logic.
 * Tests behavior (visible output), not rendering internals.
 */

import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { Header } from '../../../../src/cli/dashboard/components/header.js';
import type { DashboardData, ViewState } from '../../../../src/cli/dashboard/types.js';

// ============================================================================
// Test fixtures
// ============================================================================

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
// Header rendering
// ============================================================================

describe('Header', () => {
  describe('version display', () => {
    it('renders the app name and version', () => {
      const { lastFrame } = render(<Header version="1.2.3" data={null} refreshedAt={null} error={null} />);
      expect(lastFrame()).toContain('Autobeat v1.2.3');
    });
  });

  describe('timestamp display', () => {
    it('shows "—" when refreshedAt is null', () => {
      const { lastFrame } = render(<Header version="0.0.1" data={null} refreshedAt={null} error={null} />);
      expect(lastFrame()).toContain('—');
    });

    it('shows HH:MM timestamp when refreshedAt is set', () => {
      // Date with known hours/minutes: 14:30 UTC
      const refreshedAt = new Date('2024-01-15T14:30:00.000Z');
      const { lastFrame } = render(<Header version="0.0.1" data={null} refreshedAt={refreshedAt} error={null} />);
      // Matches "HH:MM" pattern — exact value depends on locale, so just check digits are present
      expect(lastFrame()).toMatch(/\d{2}:\d{2}/);
    });
  });

  describe('quit hint', () => {
    it('always shows quit hint', () => {
      const { lastFrame } = render(<Header version="0.0.1" data={null} refreshedAt={null} error={null} />);
      expect(lastFrame()).toContain('q=quit');
    });
  });

  describe('error display', () => {
    it('shows nothing extra when error is null', () => {
      const { lastFrame } = render(<Header version="0.0.1" data={null} refreshedAt={null} error={null} />);
      expect(lastFrame()).not.toContain('DB error');
    });

    it('shows error message when error is provided', () => {
      const { lastFrame } = render(
        <Header version="0.0.1" data={null} refreshedAt={null} error="connection refused" />,
      );
      expect(lastFrame()).toContain('DB error');
      expect(lastFrame()).toContain('connection refused');
    });

    it('truncates error messages longer than 80 characters', () => {
      const longError = 'x'.repeat(100);
      const { lastFrame } = render(<Header version="0.0.1" data={null} refreshedAt={null} error={longError} />);
      const frame = lastFrame() ?? '';
      expect(frame).toContain('...');
      // Should not contain the full 100-char string
      expect(frame).not.toContain(longError);
    });
  });

  describe('health summary — null data', () => {
    it('shows "—" when data is null', () => {
      const { lastFrame } = render(<Header version="0.0.1" data={null} refreshedAt={null} error={null} />);
      expect(lastFrame()).toContain('—');
    });
  });
});

// ============================================================================
// buildHealthSummary — tested via Header rendering
// ============================================================================

describe('buildHealthSummary (via Header)', () => {
  function renderSummary(data: DashboardData): string {
    const { lastFrame } = render(<Header version="0.0.1" data={data} refreshedAt={null} error={null} />);
    return lastFrame() ?? '';
  }

  it('shows "idle" when all counts are zero', () => {
    const frame = renderSummary(makeData());
    expect(frame).toContain('idle');
  });

  it('shows running count for running tasks', () => {
    const frame = renderSummary(makeData({ taskCounts: { total: 2, byStatus: { running: 2 } } }));
    expect(frame).toContain('●2 run');
  });

  it('shows running count aggregated across entity types', () => {
    // 1 running task + 1 running loop + 1 running orchestration = 3
    const frame = renderSummary(
      makeData({
        taskCounts: { total: 1, byStatus: { running: 1 } },
        loopCounts: { total: 1, byStatus: { running: 1 } },
        orchestrationCounts: { total: 1, byStatus: { running: 1 } },
      }),
    );
    expect(frame).toContain('●3 run');
  });

  it('treats active schedules as running', () => {
    const frame = renderSummary(
      makeData({
        scheduleCounts: { total: 1, byStatus: { active: 2 } },
      }),
    );
    expect(frame).toContain('●2 run');
  });

  it('treats planning orchestrations as running', () => {
    const frame = renderSummary(
      makeData({
        orchestrationCounts: { total: 1, byStatus: { planning: 1 } },
      }),
    );
    expect(frame).toContain('●1 run');
  });

  it('shows queued count for queued tasks', () => {
    const frame = renderSummary(makeData({ taskCounts: { total: 3, byStatus: { queued: 3 } } }));
    expect(frame).toContain('○3 queue');
  });

  it('treats paused loops as queued', () => {
    const frame = renderSummary(makeData({ loopCounts: { total: 1, byStatus: { paused: 1 } } }));
    expect(frame).toContain('○1 queue');
  });

  it('treats paused schedules as queued', () => {
    const frame = renderSummary(makeData({ scheduleCounts: { total: 1, byStatus: { paused: 1 } } }));
    expect(frame).toContain('○1 queue');
  });

  it('shows failed count for failed tasks', () => {
    const frame = renderSummary(makeData({ taskCounts: { total: 1, byStatus: { failed: 1 } } }));
    expect(frame).toContain('✗1 fail');
  });

  it('shows failed count aggregated across entity types', () => {
    // 1 failed task + 1 cancelled schedule + 1 failed orchestration = 3
    const frame = renderSummary(
      makeData({
        taskCounts: { total: 1, byStatus: { failed: 1 } },
        scheduleCounts: { total: 1, byStatus: { cancelled: 1 } },
        orchestrationCounts: { total: 1, byStatus: { failed: 1 } },
      }),
    );
    expect(frame).toContain('✗3 fail');
  });

  it('shows all three categories when each has values', () => {
    const frame = renderSummary(
      makeData({
        taskCounts: { total: 5, byStatus: { running: 1, queued: 2, failed: 2 } },
      }),
    );
    expect(frame).toContain('●1 run');
    expect(frame).toContain('○2 queue');
    expect(frame).toContain('✗2 fail');
  });

  it('omits categories with zero count', () => {
    // Only running — no queued or failed
    const frame = renderSummary(makeData({ taskCounts: { total: 1, byStatus: { running: 1 } } }));
    expect(frame).not.toContain('queue');
    expect(frame).not.toContain('fail');
  });

  it('includes running pipelines in the running count (Phase B)', () => {
    const frame = renderSummary(
      makeData({
        pipelineCounts: { total: 2, byStatus: { running: 2 } },
      }),
    );
    expect(frame).toContain('●2 run');
  });

  it('includes pending pipelines in the queued count (Phase B)', () => {
    const frame = renderSummary(
      makeData({
        pipelineCounts: { total: 1, byStatus: { pending: 1 } },
      }),
    );
    expect(frame).toContain('○1 queue');
  });

  it('includes failed and cancelled pipelines in the failed count (Phase B)', () => {
    const frame = renderSummary(
      makeData({
        pipelineCounts: { total: 3, byStatus: { failed: 2, cancelled: 1 } },
      }),
    );
    expect(frame).toContain('✗3 fail');
  });

  it('aggregates pipelines with other entity types in health summary', () => {
    const frame = renderSummary(
      makeData({
        taskCounts: { total: 1, byStatus: { running: 1 } },
        pipelineCounts: { total: 2, byStatus: { running: 1, failed: 1 } },
      }),
    );
    // 1 task running + 1 pipeline running = 2 total running
    expect(frame).toContain('●2 run');
    expect(frame).toContain('✗1 fail');
  });
});

// ============================================================================
// Breadcrumb (viewKind prop) — Phase E
// ============================================================================

describe('Header — viewKind breadcrumb', () => {
  it('renders [M] Metrics when viewKind is main', () => {
    const view: ViewState = { kind: 'main' };
    const { lastFrame } = render(
      <Header version="1.0.0" data={null} refreshedAt={null} error={null} viewKind={view.kind} />,
    );
    expect(lastFrame()).toContain('[M]');
    expect(lastFrame()).toContain('Metrics');
  });

  it('renders [W] Workspace when viewKind is workspace', () => {
    const view: ViewState = { kind: 'workspace' };
    const { lastFrame } = render(
      <Header version="1.0.0" data={null} refreshedAt={null} error={null} viewKind={view.kind} />,
    );
    expect(lastFrame()).toContain('[W]');
    expect(lastFrame()).toContain('Workspace');
  });

  it('renders [D] Detail when viewKind is detail', () => {
    const view: ViewState = { kind: 'main' }; // use 'main' but pass 'detail' manually
    const { lastFrame } = render(
      <Header version="1.0.0" data={null} refreshedAt={null} error={null} viewKind="detail" />,
    );
    expect(lastFrame()).toContain('[D]');
    expect(lastFrame()).toContain('Detail');
  });

  it('does not crash when viewKind is not provided (backward compat)', () => {
    const { lastFrame } = render(<Header version="1.0.0" data={null} refreshedAt={null} error={null} />);
    expect(lastFrame()).toContain('Autobeat v1.0.0');
  });
});
