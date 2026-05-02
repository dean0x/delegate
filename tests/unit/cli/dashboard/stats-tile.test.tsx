/**
 * Tests for StatsTile component
 * ARCHITECTURE: Tests behavior — title, cost/token/duration formatting, cache rows, top entries
 */

import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { StatsTile } from '../../../../src/cli/dashboard/components/stats-tile.js';
import type { TaskUsage } from '../../../../src/core/domain.js';
import { OrchestratorId } from '../../../../src/core/domain.js';

// ============================================================================
// Test fixtures
// ============================================================================

function makeUsage(overrides: Partial<TaskUsage> = {}): TaskUsage {
  return {
    taskId: 'task-abc12345678' as TaskUsage['taskId'],
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalCostUsd: 0,
    capturedAt: Date.now(),
    ...overrides,
  };
}

const DEFAULT_STATS = {
  tasksPerHour: 0,
  loopsPerHour: 0,
  successRate: 0,
  avgDurationMs: 0,
};

// ============================================================================
// StatsTile tests
// ============================================================================

describe('StatsTile', () => {
  describe('title', () => {
    it('renders "Stats" title text', () => {
      const { lastFrame } = render(<StatsTile costRollup24h={makeUsage()} top={[]} stats={DEFAULT_STATS} />);
      expect(lastFrame()).toContain('Stats');
    });
  });

  describe('cost formatting', () => {
    it('renders cost as $X.XX format', () => {
      const { lastFrame } = render(
        <StatsTile costRollup24h={makeUsage({ totalCostUsd: 1.23 })} top={[]} stats={DEFAULT_STATS} />,
      );
      expect(lastFrame()).toContain('$1.23');
    });

    it('renders zero cost as $0.00', () => {
      const { lastFrame } = render(
        <StatsTile costRollup24h={makeUsage({ totalCostUsd: 0 })} top={[]} stats={DEFAULT_STATS} />,
      );
      expect(lastFrame()).toContain('$0.00');
    });

    it('renders fractional cent cost with two decimal places', () => {
      const { lastFrame } = render(
        <StatsTile costRollup24h={makeUsage({ totalCostUsd: 0.05 })} top={[]} stats={DEFAULT_STATS} />,
      );
      expect(lastFrame()).toContain('$0.05');
    });
  });

  describe('token formatting', () => {
    it('renders small token counts as plain integers', () => {
      const { lastFrame } = render(
        <StatsTile costRollup24h={makeUsage({ inputTokens: 500, outputTokens: 200 })} top={[]} stats={DEFAULT_STATS} />,
      );
      const frame = lastFrame() ?? '';
      expect(frame).toContain('500');
      expect(frame).toContain('200');
    });

    it('renders K suffix for thousands', () => {
      const { lastFrame } = render(
        <StatsTile
          costRollup24h={makeUsage({ inputTokens: 1500, outputTokens: 2000 })}
          top={[]}
          stats={DEFAULT_STATS}
        />,
      );
      const frame = lastFrame() ?? '';
      expect(frame).toContain('1.5K');
      expect(frame).toContain('2.0K');
    });

    it('renders M suffix for millions', () => {
      const { lastFrame } = render(
        <StatsTile
          costRollup24h={makeUsage({ inputTokens: 2_300_000, outputTokens: 1_000_000 })}
          top={[]}
          stats={DEFAULT_STATS}
        />,
      );
      const frame = lastFrame() ?? '';
      expect(frame).toContain('2.3M');
      expect(frame).toContain('1.0M');
    });
  });

  describe('cache rows', () => {
    it('hides cache create row when cacheCreationInputTokens is zero', () => {
      const { lastFrame } = render(
        <StatsTile costRollup24h={makeUsage({ cacheCreationInputTokens: 0 })} top={[]} stats={DEFAULT_STATS} />,
      );
      expect(lastFrame()).not.toContain('Cache create');
    });

    it('shows cache create row when cacheCreationInputTokens is non-zero', () => {
      const { lastFrame } = render(
        <StatsTile costRollup24h={makeUsage({ cacheCreationInputTokens: 1000 })} top={[]} stats={DEFAULT_STATS} />,
      );
      expect(lastFrame()).toContain('Cache create');
    });

    it('hides cache read row when cacheReadInputTokens is zero', () => {
      const { lastFrame } = render(
        <StatsTile costRollup24h={makeUsage({ cacheReadInputTokens: 0 })} top={[]} stats={DEFAULT_STATS} />,
      );
      expect(lastFrame()).not.toContain('Cache read');
    });

    it('shows cache read row when cacheReadInputTokens is non-zero', () => {
      const { lastFrame } = render(
        <StatsTile costRollup24h={makeUsage({ cacheReadInputTokens: 5000 })} top={[]} stats={DEFAULT_STATS} />,
      );
      expect(lastFrame()).toContain('Cache read');
    });

    it('shows both cache rows when both are non-zero', () => {
      const { lastFrame } = render(
        <StatsTile
          costRollup24h={makeUsage({ cacheCreationInputTokens: 1000, cacheReadInputTokens: 5000 })}
          top={[]}
          stats={DEFAULT_STATS}
        />,
      );
      const frame = lastFrame() ?? '';
      expect(frame).toContain('Cache create');
      expect(frame).toContain('Cache read');
    });
  });

  describe('duration formatting', () => {
    it('renders seconds duration', () => {
      const { lastFrame } = render(
        <StatsTile costRollup24h={makeUsage()} top={[]} stats={{ ...DEFAULT_STATS, avgDurationMs: 45_000 }} />,
      );
      expect(lastFrame()).toContain('45s');
    });

    it('renders minutes and seconds duration', () => {
      const { lastFrame } = render(
        <StatsTile costRollup24h={makeUsage()} top={[]} stats={{ ...DEFAULT_STATS, avgDurationMs: 150_000 }} />,
      );
      expect(lastFrame()).toContain('2m 30s');
    });

    it('renders hours duration', () => {
      const { lastFrame } = render(
        <StatsTile costRollup24h={makeUsage()} top={[]} stats={{ ...DEFAULT_STATS, avgDurationMs: 3_900_000 }} />,
      );
      expect(lastFrame()).toContain('1h 5m');
    });
  });

  describe('throughput stats', () => {
    it('renders tasks/hr and loops/hr counts', () => {
      const { lastFrame } = render(
        <StatsTile
          costRollup24h={makeUsage()}
          top={[]}
          stats={{ ...DEFAULT_STATS, tasksPerHour: 12, loopsPerHour: 3 }}
        />,
      );
      const frame = lastFrame() ?? '';
      expect(frame).toContain('12');
      expect(frame).toContain('tasks/hr');
      expect(frame).toContain('3');
      expect(frame).toContain('loops/hr');
    });

    it('renders success percentage rounded to integer', () => {
      const { lastFrame } = render(
        <StatsTile costRollup24h={makeUsage()} top={[]} stats={{ ...DEFAULT_STATS, successRate: 0.876 }} />,
      );
      expect(lastFrame()).toContain('88%');
    });

    it('renders 100% when successRate is 1', () => {
      const { lastFrame } = render(
        <StatsTile costRollup24h={makeUsage()} top={[]} stats={{ ...DEFAULT_STATS, successRate: 1 }} />,
      );
      expect(lastFrame()).toContain('100%');
    });
  });

  describe('top entries list', () => {
    it('hides top section when entries array is empty', () => {
      const { lastFrame } = render(<StatsTile costRollup24h={makeUsage()} top={[]} stats={DEFAULT_STATS} />);
      expect(lastFrame()).not.toContain('Top:');
    });

    it('shows top section when one entry is provided', () => {
      const top = [{ orchestrationId: OrchestratorId('orchestrator-abc123'), totalCost: 0.5 }];
      const { lastFrame } = render(<StatsTile costRollup24h={makeUsage()} top={top} stats={DEFAULT_STATS} />);
      const frame = lastFrame() ?? '';
      expect(frame).toContain('Top:');
      expect(frame).toContain('$0.50');
    });

    it('shows all 3 entries when exactly 3 are provided', () => {
      const top = [
        { orchestrationId: OrchestratorId('orchestrator-aaa'), totalCost: 1.0 },
        { orchestrationId: OrchestratorId('orchestrator-bbb'), totalCost: 0.5 },
        { orchestrationId: OrchestratorId('orchestrator-ccc'), totalCost: 0.25 },
      ];
      const { lastFrame } = render(<StatsTile costRollup24h={makeUsage()} top={top} stats={DEFAULT_STATS} />);
      const frame = lastFrame() ?? '';
      expect(frame).toContain('$1.00');
      expect(frame).toContain('$0.50');
      expect(frame).toContain('$0.25');
    });

    it('limits visible top entries to 3 even when more are provided', () => {
      const top = [
        { orchestrationId: OrchestratorId('orchestrator-aaa'), totalCost: 1.0 },
        { orchestrationId: OrchestratorId('orchestrator-bbb'), totalCost: 0.8 },
        { orchestrationId: OrchestratorId('orchestrator-ccc'), totalCost: 0.6 },
        { orchestrationId: OrchestratorId('orchestrator-ddd'), totalCost: 0.4 },
        { orchestrationId: OrchestratorId('orchestrator-eee'), totalCost: 0.2 },
      ];
      const { lastFrame } = render(<StatsTile costRollup24h={makeUsage()} top={top} stats={DEFAULT_STATS} />);
      const frame = lastFrame() ?? '';
      // 4th and 5th entries must not appear
      expect(frame).not.toContain('$0.40');
      expect(frame).not.toContain('$0.20');
      // First 3 are present
      expect(frame).toContain('$1.00');
      expect(frame).toContain('$0.80');
      expect(frame).toContain('$0.60');
    });

    it('renders a short ID for each top entry', () => {
      const top = [{ orchestrationId: OrchestratorId('orchestrator-xyz99999'), totalCost: 0.1 }];
      const { lastFrame } = render(<StatsTile costRollup24h={makeUsage()} top={top} stats={DEFAULT_STATS} />);
      // shortId returns first 12 chars — "orchestrator" is exactly 12
      expect(lastFrame()).toContain('orchestrator');
    });
  });

  describe('resilience', () => {
    it('renders without crashing with all-zero values', () => {
      const { lastFrame } = render(<StatsTile costRollup24h={makeUsage()} top={[]} stats={DEFAULT_STATS} />);
      expect(lastFrame()).toBeTruthy();
    });

    it('renders without crashing with large token and cost values', () => {
      const { lastFrame } = render(
        <StatsTile
          costRollup24h={makeUsage({
            totalCostUsd: 999.99,
            inputTokens: 50_000_000,
            outputTokens: 10_000_000,
          })}
          top={[]}
          stats={DEFAULT_STATS}
        />,
      );
      expect(lastFrame()).toBeTruthy();
    });
  });
});
