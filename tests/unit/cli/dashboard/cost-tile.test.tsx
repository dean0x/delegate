/**
 * Tests for CostTile component
 * ARCHITECTURE: Tests behavior — formatting, zero state, top orchestration ordering
 */

import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { CostTile } from '../../../../src/cli/dashboard/components/cost-tile.js';
import type { TaskUsage } from '../../../../src/core/domain.js';

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

describe('CostTile', () => {
  describe('zero state', () => {
    it('shows $0.00 when costRollup24h totalCostUsd is 0', () => {
      const { lastFrame } = render(<CostTile costRollup24h={makeUsage({ totalCostUsd: 0 })} top={[]} />);
      expect(lastFrame()).toContain('$0.00');
    });

    it('shows no top entry when top is empty', () => {
      const { lastFrame } = render(<CostTile costRollup24h={makeUsage({ totalCostUsd: 0 })} top={[]} />);
      // Should not crash and should render something
      expect(lastFrame()).toBeTruthy();
    });
  });

  describe('cost formatting', () => {
    it('shows formatted cost as $X.XX', () => {
      const { lastFrame } = render(<CostTile costRollup24h={makeUsage({ totalCostUsd: 1.234 })} top={[]} />);
      expect(lastFrame()).toContain('$1.23');
    });

    it('shows cost with two decimal places', () => {
      const { lastFrame } = render(<CostTile costRollup24h={makeUsage({ totalCostUsd: 0.1 })} top={[]} />);
      expect(lastFrame()).toContain('$0.10');
    });
  });

  describe('token display', () => {
    it('shows input token count formatted as K for thousands', () => {
      const { lastFrame } = render(<CostTile costRollup24h={makeUsage({ inputTokens: 2500 })} top={[]} />);
      expect(lastFrame()).toContain('2.5K');
    });

    it('shows input token count as raw number under 1000', () => {
      const { lastFrame } = render(<CostTile costRollup24h={makeUsage({ inputTokens: 500 })} top={[]} />);
      expect(lastFrame()).toContain('500');
    });

    it('shows output token count formatted as K for thousands', () => {
      const { lastFrame } = render(<CostTile costRollup24h={makeUsage({ outputTokens: 1500 })} top={[]} />);
      expect(lastFrame()).toContain('1.5K');
    });

    it('shows output token count as raw number under 1000', () => {
      const { lastFrame } = render(<CostTile costRollup24h={makeUsage({ outputTokens: 750 })} top={[]} />);
      expect(lastFrame()).toContain('750');
    });
  });

  describe('top orchestration', () => {
    it('shows short ID of most expensive orchestration', () => {
      const { lastFrame } = render(
        <CostTile
          costRollup24h={makeUsage()}
          top={[{ orchestrationId: 'orch-abc123def456' as TaskUsage['taskId'], totalCost: 0.05 }]}
        />,
      );
      // Should show truncated/short ID
      expect(lastFrame()).toMatch(/orch-abc1/);
    });

    it('renders multiple top orchestrations without crashing', () => {
      const { lastFrame } = render(
        <CostTile
          costRollup24h={makeUsage()}
          top={[
            { orchestrationId: 'orch-111111111111' as TaskUsage['taskId'], totalCost: 0.1 },
            { orchestrationId: 'orch-222222222222' as TaskUsage['taskId'], totalCost: 0.05 },
          ]}
        />,
      );
      expect(lastFrame()).toBeTruthy();
    });
  });
});
