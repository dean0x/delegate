/**
 * Tests for EntityTabs component
 * ARCHITECTURE: Tests behavior — tab rendering with count badges, active/inactive styling
 */

import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { EntityTabs } from '../../../../src/cli/dashboard/components/entity-tabs.js';
import type { EntityCounts, PanelId } from '../../../../src/cli/dashboard/types.js';

// ============================================================================
// Fixtures
// ============================================================================

function makeEntityCounts(overrides: Partial<EntityCounts> = {}): EntityCounts {
  return {
    total: 0,
    byStatus: {},
    ...overrides,
  };
}

function makeAllCounts(overrides: Partial<Record<PanelId, EntityCounts>> = {}): Record<PanelId, EntityCounts> {
  return {
    tasks: makeEntityCounts(),
    loops: makeEntityCounts(),
    schedules: makeEntityCounts(),
    orchestrations: makeEntityCounts(),
    pipelines: makeEntityCounts(),
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('EntityTabs', () => {
  describe('tab labels', () => {
    it('renders all five panel tabs', () => {
      const { lastFrame } = render(<EntityTabs activeTab="tasks" entityCounts={makeAllCounts()} focused={true} />);
      const frame = lastFrame() ?? '';
      expect(frame).toContain('Tasks');
      expect(frame).toContain('Loops');
      expect(frame).toContain('Schedules');
      expect(frame).toContain('Orchestrations');
      expect(frame).toContain('Pipelines');
    });
  });

  describe('active tab', () => {
    it('wraps active tab in brackets', () => {
      const { lastFrame } = render(<EntityTabs activeTab="tasks" entityCounts={makeAllCounts()} focused={true} />);
      expect(lastFrame()).toContain('[Tasks(');
    });

    it('does not wrap inactive tabs in brackets', () => {
      const { lastFrame } = render(<EntityTabs activeTab="tasks" entityCounts={makeAllCounts()} focused={true} />);
      const frame = lastFrame() ?? '';
      expect(frame).not.toContain('[Loops(');
      expect(frame).not.toContain('[Schedules(');
    });

    it('shows correct active tab for loops', () => {
      const { lastFrame } = render(<EntityTabs activeTab="loops" entityCounts={makeAllCounts()} focused={true} />);
      expect(lastFrame()).toContain('[Loops(');
    });

    it('shows correct active tab for pipelines', () => {
      const { lastFrame } = render(<EntityTabs activeTab="pipelines" entityCounts={makeAllCounts()} focused={true} />);
      expect(lastFrame()).toContain('[Pipelines(');
    });
  });

  describe('count badges', () => {
    it('shows running count with bullet icon', () => {
      const counts = makeAllCounts({
        tasks: makeEntityCounts({ total: 3, byStatus: { running: 3 } }),
      });
      const { lastFrame } = render(<EntityTabs activeTab="tasks" entityCounts={counts} focused={true} />);
      expect(lastFrame()).toContain('3●');
    });

    it('shows completed count with check icon', () => {
      const counts = makeAllCounts({
        tasks: makeEntityCounts({ total: 5, byStatus: { completed: 5 } }),
      });
      const { lastFrame } = render(<EntityTabs activeTab="tasks" entityCounts={counts} focused={true} />);
      expect(lastFrame()).toContain('5✓');
    });

    it('shows failed count with cross icon', () => {
      const counts = makeAllCounts({
        loops: makeEntityCounts({ total: 2, byStatus: { failed: 2 } }),
      });
      const { lastFrame } = render(<EntityTabs activeTab="loops" entityCounts={counts} focused={true} />);
      expect(lastFrame()).toContain('2✗');
    });

    it('shows dash when panel has no entities', () => {
      const { lastFrame } = render(<EntityTabs activeTab="tasks" entityCounts={makeAllCounts()} focused={true} />);
      // active tab shows [Tasks(—)]
      expect(lastFrame()).toContain('[Tasks(—)]');
    });

    it('shows pipeline counts correctly', () => {
      const counts = makeAllCounts({
        pipelines: makeEntityCounts({ total: 2, byStatus: { running: 1, completed: 1 } }),
      });
      const { lastFrame } = render(<EntityTabs activeTab="pipelines" entityCounts={counts} focused={true} />);
      expect(lastFrame()).toContain('1●');
      expect(lastFrame()).toContain('1✓');
    });
  });

  describe('zero state', () => {
    it('renders without crashing when all counts are zero', () => {
      const { lastFrame } = render(<EntityTabs activeTab="tasks" entityCounts={makeAllCounts()} focused={false} />);
      expect(lastFrame()).toBeTruthy();
    });
  });
});
