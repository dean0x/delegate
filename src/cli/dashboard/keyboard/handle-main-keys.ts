/**
 * Key handler for the main panel view.
 *
 * Scope: view.kind === 'main'. Handles panel Tab cycling, ↑/↓ navigation,
 * Enter drill-through to detail, filter cycling (f), digit panel jumps (1-4),
 * activity feed focus (Tab from last panel), and cancel/delete via entity-mutations.
 *
 * Activity focus mode (v1.3.0):
 *  - Tab from last panel (orchestrations) → activity focus
 *  - Shift+Tab from first panel (loops) → activity focus
 *  - Tab / Shift+Tab from activity focus → return to panel grid
 *  - ↑/↓ when activityFocused → move activitySelectedIndex
 *  - Enter when activityFocused → openDetail for the selected entry
 *  - Esc when activityFocused → return to panel focus (loops)
 */

import type { LoopId, OrchestratorId, ScheduleId, TaskId } from '../../../core/domain.js';
import { FILTER_CYCLES, PANEL_JUMP_KEYS, PANEL_ORDER } from './constants.js';
import { cancelEntity, deleteEntity } from './entity-mutations.js';
import {
  activityKindToEntityType,
  clamp,
  filteredLength,
  getFocusedPanelItem,
  getPanelItems,
  panelToEntityKind,
} from './helpers.js';
import type { InkKey, KeyHandlerParams } from './types.js';

/**
 * Handle key input while in the main panel view.
 * Returns true if the key was consumed.
 */
export function handleMainKeys(input: string, key: InkKey, params: KeyHandlerParams): boolean {
  const { nav, dataRef, setView, setNav } = params;

  // Esc from activity focus — return to default panel focus
  if ((key.escape || key.backspace) && nav.activityFocused) {
    setNav((prev) => ({ ...prev, activityFocused: false }));
    return true;
  }

  // Tab — cycle focus forward
  if (key.tab && !key.shift) {
    setNav((prev) => {
      // Activity → first panel in order (wraps around)
      if (prev.activityFocused) {
        return { ...prev, activityFocused: false, focusedPanel: PANEL_ORDER[0] };
      }
      const currentIdx = PANEL_ORDER.indexOf(prev.focusedPanel);
      const nextIdx = currentIdx + 1;
      // Last panel → activity focus
      if (nextIdx >= PANEL_ORDER.length) {
        return { ...prev, activityFocused: true };
      }
      return { ...prev, focusedPanel: PANEL_ORDER[nextIdx] };
    });
    return true;
  }

  // Shift+Tab — cycle focus backward
  if (key.tab && key.shift) {
    setNav((prev) => {
      // Activity → panel (orchestrations, last in list)
      if (prev.activityFocused) {
        return { ...prev, activityFocused: false, focusedPanel: PANEL_ORDER[PANEL_ORDER.length - 1] };
      }
      const currentIdx = PANEL_ORDER.indexOf(prev.focusedPanel);
      const prevIdx = currentIdx - 1;
      // First panel → activity focus
      if (prevIdx < 0) {
        return { ...prev, activityFocused: true };
      }
      return { ...prev, focusedPanel: PANEL_ORDER[prevIdx] };
    });
    return true;
  }

  // 1-4 — jump to panel by number (also exits activity focus)
  if (input in PANEL_JUMP_KEYS) {
    setNav((prev) => ({ ...prev, activityFocused: false, focusedPanel: PANEL_JUMP_KEYS[input] }));
    return true;
  }

  // Activity focus: ↑/↓/Enter are routed to the activity feed, not the panel grid
  if (nav.activityFocused) {
    if (key.upArrow || input === 'k') {
      setNav((prev) => ({
        ...prev,
        activitySelectedIndex: Math.max(0, prev.activitySelectedIndex - 1),
      }));
      return true;
    }
    if (key.downArrow || input === 'j') {
      const feedLength = dataRef.current?.activityFeed?.length ?? 0;
      setNav((prev) => ({
        ...prev,
        activitySelectedIndex: clamp(prev.activitySelectedIndex + 1, 0, Math.max(0, feedLength - 1)),
      }));
      return true;
    }
    if (key.return) {
      const feed = dataRef.current?.activityFeed;
      if (feed && feed.length > 0) {
        const entry = feed[nav.activitySelectedIndex];
        if (entry) {
          const entityType = activityKindToEntityType(entry.kind);
          // Cast is safe: entityId originates from a domain entity of the matching kind
          switch (entityType) {
            case 'tasks':
              setView({ kind: 'detail', entityType: 'tasks', entityId: entry.entityId as TaskId, returnTo: 'main' });
              break;
            case 'loops':
              setView({ kind: 'detail', entityType: 'loops', entityId: entry.entityId as LoopId, returnTo: 'main' });
              break;
            case 'orchestrations':
              setView({
                kind: 'detail',
                entityType: 'orchestrations',
                entityId: entry.entityId as OrchestratorId,
                returnTo: 'main',
              });
              break;
            case 'schedules':
              setView({
                kind: 'detail',
                entityType: 'schedules',
                entityId: entry.entityId as ScheduleId,
                returnTo: 'main',
              });
              break;
          }
        }
      }
      return true;
    }

    // c — cancel the entity on the focused Activity row
    // Dispatches based on entry.kind — same 4-way mapping as workspace cancel.
    // Orchestration cancel cascades (cancelAttributedTasks: true) — see entity-mutations.ts.
    if (input === 'c' && params.mutations) {
      const feed = dataRef.current?.activityFeed;
      if (feed && feed.length > 0) {
        const entry = feed[nav.activitySelectedIndex];
        if (entry) {
          void cancelEntity(entry.kind, entry.entityId, entry.status, params.mutations, params.refreshNow);
        }
      }
      return true;
    }

    // d — delete the entity on the focused Activity row (terminal status only)
    // Non-terminal entities are silently ignored (cannot delete live work).
    if (input === 'd' && params.mutations) {
      const feed = dataRef.current?.activityFeed;
      if (feed && feed.length > 0) {
        const entry = feed[nav.activitySelectedIndex];
        if (entry) {
          void deleteEntity(entry.kind, entry.entityId, entry.status, params.mutations, params.refreshNow);
        }
      }
      return true;
    }

    // Any other key while activity-focused: consume silently (no fallthrough to panel handlers)
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
    }
    return true;
  }

  // c — cancel focused entity (status-dependent, works when not terminal)
  // DECISION (2026-04-10): Manual cancel/delete keybindings on ALL four panels.
  // All orchestration cancels cascade per PR #133 review resolution.
  if (input === 'c' && params.mutations) {
    const item = getFocusedPanelItem(nav, params.dataRef.current);
    if (item) {
      void cancelEntity(panelToEntityKind(nav.focusedPanel), item.id, item.status, params.mutations, params.refreshNow);
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
