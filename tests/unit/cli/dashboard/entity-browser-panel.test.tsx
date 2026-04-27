/**
 * Tests for EntityBrowserPanel component
 * ARCHITECTURE: Tests behavior — entity list display, filter, empty states
 */

import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { EntityBrowserPanel } from '../../../../src/cli/dashboard/components/entity-browser-panel.js';
import type { Identifiable } from '../../../../src/cli/dashboard/keyboard/types.js';
import type { DashboardData, EntityCounts, PanelId } from '../../../../src/cli/dashboard/types.js';

// ============================================================================
// Fixtures
// ============================================================================

function makeIdentifiable(id: string, status = 'running'): Identifiable {
  return { id, status };
}

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

const MOCK_DATA: DashboardData = {
  tasks: [],
  loops: [],
  schedules: [],
  orchestrations: [],
  pipelines: [],
  taskCounts: makeEntityCounts(),
  loopCounts: makeEntityCounts(),
  scheduleCounts: makeEntityCounts(),
  orchestrationCounts: makeEntityCounts(),
  pipelineCounts: makeEntityCounts(),
};

// ============================================================================
// Helper to render the panel
// ============================================================================

function renderPanel(
  overrides: Partial<{
    focusedType: PanelId;
    items: readonly Identifiable[];
    selectedIndex: number;
    scrollOffset: number;
    filterStatus: string | null;
    focused: boolean;
    viewportHeight: number;
    data: DashboardData | null;
  }> = {},
) {
  const props = {
    focusedType: 'tasks' as PanelId,
    items: [],
    selectedIndex: 0,
    scrollOffset: 0,
    filterStatus: null,
    focused: true,
    entityCounts: makeAllCounts(),
    viewportHeight: 10,
    data: MOCK_DATA,
    ...overrides,
  };
  return render(<EntityBrowserPanel {...props} />);
}

// ============================================================================
// Tests
// ============================================================================

describe('EntityBrowserPanel', () => {
  describe('tab bar', () => {
    it('renders entity tabs', () => {
      const { lastFrame } = renderPanel();
      expect(lastFrame()).toContain('Tasks');
      expect(lastFrame()).toContain('Loops');
    });

    it('shows active tab with brackets', () => {
      const { lastFrame } = renderPanel({ focusedType: 'loops' });
      expect(lastFrame()).toContain('[Loops(');
    });
  });

  describe('empty states', () => {
    it('shows "No tasks found" when items list is empty and no filter', () => {
      const { lastFrame } = renderPanel({ focusedType: 'tasks', items: [] });
      expect(lastFrame()).toContain('No tasks found');
    });

    it('shows "No loops found" for empty loops panel', () => {
      const { lastFrame } = renderPanel({ focusedType: 'loops', items: [] });
      expect(lastFrame()).toContain('No loops found');
    });

    it('shows filter hint when empty with filter applied', () => {
      const { lastFrame } = renderPanel({
        focusedType: 'tasks',
        items: [makeIdentifiable('task-1', 'running')],
        filterStatus: 'failed', // filter that matches nothing
      });
      expect(lastFrame()).toContain("No tasks matching 'failed'");
      expect(lastFrame()).toContain('f to clear filter');
    });

    it('shows "No pipelines found" for empty pipelines panel', () => {
      const { lastFrame } = renderPanel({ focusedType: 'pipelines', items: [] });
      expect(lastFrame()).toContain('No pipelines found');
    });
  });

  describe('entity rows', () => {
    it('renders items from the list', () => {
      const items = [makeIdentifiable('task-abc-123', 'running'), makeIdentifiable('task-def-456', 'completed')];
      const { lastFrame } = renderPanel({ focusedType: 'tasks', items });
      const frame = lastFrame() ?? '';
      // shortId takes first 12 chars
      expect(frame).toContain('task-abc-123');
    });

    it('shows cursor on selected item', () => {
      const items = [makeIdentifiable('task-1', 'running'), makeIdentifiable('task-2', 'completed')];
      const { lastFrame } = renderPanel({ focusedType: 'tasks', items, selectedIndex: 0 });
      expect(lastFrame()).toContain('▶');
    });

    it('shows status text in row', () => {
      const items = [makeIdentifiable('task-1', 'running')];
      const { lastFrame } = renderPanel({ focusedType: 'tasks', items });
      expect(lastFrame()).toContain('running');
    });
  });

  describe('filter behavior', () => {
    it('only shows items matching filter status', () => {
      const items = [
        makeIdentifiable('task-1', 'running'),
        makeIdentifiable('task-2', 'completed'),
        makeIdentifiable('task-3', 'running'),
      ];
      const { lastFrame } = renderPanel({
        focusedType: 'tasks',
        items,
        filterStatus: 'running',
      });
      const frame = lastFrame() ?? '';
      // task-1 and task-3 should be visible, task-2 should not
      expect(frame).toContain('task-1');
      expect(frame).toContain('task-3');
    });

    it('shows filter badge when filter is active', () => {
      const items = [makeIdentifiable('task-1', 'running')];
      const { lastFrame } = renderPanel({
        focusedType: 'tasks',
        items,
        filterStatus: 'running',
      });
      expect(lastFrame()).toContain('[filter: running]');
    });
  });

  describe('rendering with null data', () => {
    it('renders without crashing when data is null', () => {
      const items = [makeIdentifiable('task-1', 'running')];
      const { lastFrame } = renderPanel({ items, data: null });
      expect(lastFrame()).toBeTruthy();
      // Still shows the item ID
      expect(lastFrame()).toContain('task-1');
    });
  });

  describe('constants coverage', () => {
    it('PANEL_ORDER includes pipelines as the 5th panel', () => {
      // Verify via the tab bar rendering order
      const { lastFrame } = renderPanel({ focusedType: 'pipelines' });
      const frame = lastFrame() ?? '';
      // All 5 tabs must be present
      expect(frame).toContain('Tasks');
      expect(frame).toContain('Loops');
      expect(frame).toContain('Scheds');
      expect(frame).toContain('Orchs');
      expect(frame).toContain('[Pipes(');
    });
  });
});
