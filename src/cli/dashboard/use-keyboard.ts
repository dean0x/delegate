/**
 * useKeyboard — routes keyboard input to navigation/action handlers
 * ARCHITECTURE: Pure hook — all state changes via setters, no side effects beyond exit()
 * Pattern: Functional core dispatches to immutable state updates
 */

import { useInput } from 'ink';
import type React from 'react';
import type { DashboardData, NavState, PanelId, ViewState } from './types.js';

/** Ordered panel cycle for Tab navigation */
const PANEL_ORDER: readonly PanelId[] = ['loops', 'tasks', 'schedules', 'orchestrations'];

/** Cycled filter states */
const FILTER_CYCLE: readonly (string | null)[] = [null, 'running', 'completed', 'failed', 'cancelled'];

interface UseKeyboardParams {
  readonly view: ViewState;
  readonly nav: NavState;
  readonly data: DashboardData | null;
  readonly setView: (v: ViewState) => void;
  readonly setNav: React.Dispatch<React.SetStateAction<NavState>>;
  readonly refreshNow: () => void;
  readonly exit: () => void;
}

/**
 * Get the filtered list length for the currently focused panel.
 * Used to clamp selectedIndex after navigation.
 */
function filteredLength(panelId: PanelId, data: DashboardData | null, filterStatus: string | null): number {
  if (data === null) return 0;

  const items =
    panelId === 'loops'
      ? data.loops
      : panelId === 'tasks'
        ? data.tasks
        : panelId === 'schedules'
          ? data.schedules
          : data.orchestrations;

  if (filterStatus === null) return items.length;
  return items.filter((item) => (item as { status: string }).status === filterStatus).length;
}

/**
 * Clamp a number between min and max (inclusive).
 * Returns min if range is empty.
 */
function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.max(min, Math.min(max, value));
}

/**
 * Custom hook wrapping Ink's useInput.
 * Routes keys to handlers based on current view (main or detail).
 */
export function useKeyboard({ view, nav, data, setView, setNav, refreshNow, exit }: UseKeyboardParams): void {
  useInput((input, key) => {
    // Global keys
    if (input === 'q') {
      exit();
      return;
    }

    if (input === 'r') {
      refreshNow();
      return;
    }

    // -------------------------------------------------------------------------
    // Detail view keys
    // -------------------------------------------------------------------------
    if (view.kind === 'detail') {
      if (key.escape || key.backspace) {
        setView({ kind: 'main' });
        return;
      }

      if (key.upArrow || input === 'k') {
        setNav((prev) => ({
          ...prev,
          scrollOffsets: {
            ...prev.scrollOffsets,
            [view.entityType]: Math.max(0, prev.scrollOffsets[view.entityType] - 1),
          },
        }));
        return;
      }

      if (key.downArrow || input === 'j') {
        setNav((prev) => ({
          ...prev,
          scrollOffsets: {
            ...prev.scrollOffsets,
            [view.entityType]: prev.scrollOffsets[view.entityType] + 1,
          },
        }));
        return;
      }

      return;
    }

    // -------------------------------------------------------------------------
    // Main view keys
    // -------------------------------------------------------------------------

    // Tab — cycle focus forward
    if (key.tab && !key.shift) {
      setNav((prev) => {
        const currentIdx = PANEL_ORDER.indexOf(prev.focusedPanel);
        const nextIdx = (currentIdx + 1) % PANEL_ORDER.length;
        return { ...prev, focusedPanel: PANEL_ORDER[nextIdx] };
      });
      return;
    }

    // Shift+Tab — cycle focus backward
    if (key.tab && key.shift) {
      setNav((prev) => {
        const currentIdx = PANEL_ORDER.indexOf(prev.focusedPanel);
        const prevIdx = (currentIdx - 1 + PANEL_ORDER.length) % PANEL_ORDER.length;
        return { ...prev, focusedPanel: PANEL_ORDER[prevIdx] };
      });
      return;
    }

    // 1-4 — jump to panel
    if (input === '1') {
      setNav((prev) => ({ ...prev, focusedPanel: 'loops' }));
      return;
    }
    if (input === '2') {
      setNav((prev) => ({ ...prev, focusedPanel: 'tasks' }));
      return;
    }
    if (input === '3') {
      setNav((prev) => ({ ...prev, focusedPanel: 'schedules' }));
      return;
    }
    if (input === '4') {
      setNav((prev) => ({ ...prev, focusedPanel: 'orchestrations' }));
      return;
    }

    // Up arrow / k — move selection up
    if (key.upArrow || input === 'k') {
      setNav((prev) => {
        const panel = prev.focusedPanel;
        const current = prev.selectedIndices[panel];
        const next = Math.max(0, current - 1);
        // Scroll up if selection moves above visible area
        const scrollOffset = Math.min(prev.scrollOffsets[panel], next);
        return {
          ...prev,
          selectedIndices: { ...prev.selectedIndices, [panel]: next },
          scrollOffsets: { ...prev.scrollOffsets, [panel]: scrollOffset },
        };
      });
      return;
    }

    // Down arrow / j — move selection down
    if (key.downArrow || input === 'j') {
      setNav((prev) => {
        const panel = prev.focusedPanel;
        const length = filteredLength(panel, data, prev.filters[panel]);
        const maxIndex = Math.max(0, length - 1);
        const current = prev.selectedIndices[panel];
        const next = clamp(current + 1, 0, maxIndex);
        // Scroll down if selection exceeds viewport
        const viewportHeight = 10;
        const scrollOffset =
          next >= prev.scrollOffsets[panel] + viewportHeight ? next - viewportHeight + 1 : prev.scrollOffsets[panel];
        return {
          ...prev,
          selectedIndices: { ...prev.selectedIndices, [panel]: next },
          scrollOffsets: { ...prev.scrollOffsets, [panel]: scrollOffset },
        };
      });
      return;
    }

    // Enter — drill into detail view
    if (key.return) {
      const panel = nav.focusedPanel;
      const filter = nav.filters[panel];
      const length = filteredLength(panel, data, filter);
      if (length === 0) return;

      // Get the item at selectedIndex from filtered list
      if (data === null) return;
      const allItems =
        panel === 'loops'
          ? data.loops
          : panel === 'tasks'
            ? data.tasks
            : panel === 'schedules'
              ? data.schedules
              : data.orchestrations;
      const filteredItems =
        filter !== null ? allItems.filter((item) => (item as { status: string }).status === filter) : allItems;

      const selectedItem = filteredItems[nav.selectedIndices[panel]];
      if (selectedItem === undefined) return;

      const entityId = (selectedItem as { id: string }).id;
      setView({ kind: 'detail', entityType: panel, entityId });
      return;
    }

    // f — cycle filter for focused panel
    if (input === 'f') {
      setNav((prev) => {
        const panel = prev.focusedPanel;
        const currentFilter = prev.filters[panel];
        const currentIdx = FILTER_CYCLE.indexOf(currentFilter);
        const nextIdx = (currentIdx + 1) % FILTER_CYCLE.length;
        const nextFilter = FILTER_CYCLE[nextIdx] ?? null;

        // Clamp selectedIndex to new filtered length
        const newLength = filteredLength(panel, data, nextFilter);
        const clampedIndex = clamp(prev.selectedIndices[panel], 0, Math.max(0, newLength - 1));

        return {
          ...prev,
          filters: { ...prev.filters, [panel]: nextFilter },
          selectedIndices: { ...prev.selectedIndices, [panel]: clampedIndex },
          scrollOffsets: { ...prev.scrollOffsets, [panel]: 0 },
        };
      });
      return;
    }
  });
}
