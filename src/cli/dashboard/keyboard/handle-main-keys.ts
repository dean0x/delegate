/**
 * Key handler for the main panel view.
 *
 * Scope: view.kind === 'main'. Handles panel Tab cycling, ↑/↓ navigation,
 * Enter drill-through to detail, filter cycling (f), digit panel jumps (1-5),
 * and cancel/delete via entity-mutations.
 *
 * DECISION (Dashboard Layout Overhaul): Activity is now a non-interactive tile.
 * Tab cycles directly among entity browser panels (wraps around).
 */

import type { LoopId, OrchestratorId, PipelineId, ScheduleId, TaskId } from '../../../core/domain.js';
import { FILTER_CYCLES, PANEL_JUMP_KEYS, PANEL_ORDER } from './constants.js';
import { cancelEntity, deleteEntity } from './entity-mutations.js';
import { clamp, filteredLength, getFocusedPanelItem, getPanelItems, panelToEntityKind } from './helpers.js';
import type { InkKey, KeyHandlerParams } from './types.js';

/**
 * Handle key input while in the main panel view.
 * Returns true if the key was consumed.
 */
export function handleMainKeys(input: string, key: InkKey, params: KeyHandlerParams): boolean {
  const { nav, dataRef, setView, setNav } = params;

  // Tab — cycle focus forward through panels (wraps from last to first)
  if (key.tab && !key.shift) {
    setNav((prev) => {
      const currentIdx = PANEL_ORDER.indexOf(prev.focusedPanel);
      const nextIdx = (currentIdx + 1) % PANEL_ORDER.length;
      return { ...prev, focusedPanel: PANEL_ORDER[nextIdx] };
    });
    return true;
  }

  // Shift+Tab — cycle focus backward through panels (wraps from first to last)
  if (key.tab && key.shift) {
    setNav((prev) => {
      const currentIdx = PANEL_ORDER.indexOf(prev.focusedPanel);
      const prevIdx = (currentIdx - 1 + PANEL_ORDER.length) % PANEL_ORDER.length;
      return { ...prev, focusedPanel: PANEL_ORDER[prevIdx] };
    });
    return true;
  }

  // 1-5 — jump to panel by number
  if (input in PANEL_JUMP_KEYS) {
    setNav((prev) => ({ ...prev, focusedPanel: PANEL_JUMP_KEYS[input] }));
    return true;
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
    return true;
  }

  // Down arrow / j — move selection down
  if (key.downArrow || input === 'j') {
    setNav((prev) => {
      const panel = prev.focusedPanel;
      const length = filteredLength(panel, dataRef.current, prev.filters[panel]);
      const maxIndex = Math.max(0, length - 1);
      const current = prev.selectedIndices[panel];
      const next = clamp(current + 1, 0, maxIndex);
      // Effective viewport must match EntityBrowserPanel's effectiveHeight:
      // viewportHeight - 2 (tab bar + scroll indicator) - filterRowHeight
      const filterActive = prev.filters[panel] !== null;
      const effectiveViewport = Math.max(1, params.entityBrowserViewportHeight - 2 - (filterActive ? 1 : 0));
      const scrollOffset =
        next >= prev.scrollOffsets[panel] + effectiveViewport
          ? next - effectiveViewport + 1
          : prev.scrollOffsets[panel];
      return {
        ...prev,
        selectedIndices: { ...prev.selectedIndices, [panel]: next },
        scrollOffsets: { ...prev.scrollOffsets, [panel]: scrollOffset },
      };
    });
    return true;
  }

  // Enter — drill into detail view
  if (key.return) {
    const data = dataRef.current;
    if (data === null) return true;
    const panel = nav.focusedPanel;
    const filter = nav.filters[panel];
    const allItems = getPanelItems(panel, data);
    const filteredItems = filter !== null ? allItems.filter((item) => item.status === filter) : allItems;
    const selectedItem = filteredItems[nav.selectedIndices[panel]];
    if (selectedItem === undefined) return true;
    // Reset scroll offset for detail view so it starts at top, not at the main-list position
    setNav((prev) => ({
      ...prev,
      scrollOffsets: { ...prev.scrollOffsets, [panel]: 0 },
    }));
    // Cast id back to the branded type for the discriminated ViewState union.
    // The id originates from the domain entity — the cast is safe at this boundary.
    switch (panel) {
      case 'loops':
        setView({ kind: 'detail', entityType: 'loops', entityId: selectedItem.id as LoopId, returnTo: 'main' });
        break;
      case 'tasks':
        setView({ kind: 'detail', entityType: 'tasks', entityId: selectedItem.id as TaskId, returnTo: 'main' });
        break;
      case 'schedules':
        setView({ kind: 'detail', entityType: 'schedules', entityId: selectedItem.id as ScheduleId, returnTo: 'main' });
        break;
      case 'orchestrations':
        setView({
          kind: 'detail',
          entityType: 'orchestrations',
          entityId: selectedItem.id as OrchestratorId,
          returnTo: 'main',
        });
        break;
      case 'pipelines':
        setView({
          kind: 'detail',
          entityType: 'pipelines',
          entityId: selectedItem.id as PipelineId,
          returnTo: 'main',
        });
        break;
    }
    return true;
  }

  // c — cancel focused entity (status-dependent, works when not terminal)
  // DECISION (2026-04-10): Manual cancel/delete keybindings on ALL four panels.
  // All orchestration cancels cascade per PR #133 review resolution.
  if (input === 'c' && params.mutations) {
    const item = getFocusedPanelItem(nav, params.dataRef.current);
    if (item) {
      void cancelEntity(
        panelToEntityKind(nav.focusedPanel),
        item.id,
        item.status,
        params.mutations,
        params.refreshNow,
        params.dataRef.current,
      );
    }
    return true;
  }

  // d — delete focused terminal entity row
  if (input === 'd' && params.mutations) {
    const item = getFocusedPanelItem(nav, params.dataRef.current);
    if (item) {
      void deleteEntity(panelToEntityKind(nav.focusedPanel), item.id, item.status, params.mutations, params.refreshNow);
    }
    return true;
  }

  // f — cycle filter for focused panel
  if (input === 'f') {
    setNav((prev) => {
      const panel = prev.focusedPanel;
      const currentFilter = prev.filters[panel];
      const cycle = FILTER_CYCLES[panel];
      const currentIdx = cycle.indexOf(currentFilter);
      const nextIdx = (currentIdx + 1) % cycle.length;
      const nextFilter = cycle[nextIdx] ?? null;

      // Clamp selectedIndex to new filtered length (use ref for freshness)
      const newLength = filteredLength(panel, dataRef.current, nextFilter);
      const clampedIndex = clamp(prev.selectedIndices[panel], 0, Math.max(0, newLength - 1));

      return {
        ...prev,
        filters: { ...prev.filters, [panel]: nextFilter },
        selectedIndices: { ...prev.selectedIndices, [panel]: clampedIndex },
        scrollOffsets: { ...prev.scrollOffsets, [panel]: 0 },
      };
    });
    return true;
  }

  return false;
}
