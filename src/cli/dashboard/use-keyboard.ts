/**
 * useKeyboard — routes keyboard input to navigation/action handlers
 * ARCHITECTURE: Pure hook — all state changes via setters, no side effects beyond exit()
 * Pattern: Functional core dispatches to immutable state updates
 */

import { useInput } from 'ink';
import type React from 'react';
import { useRef } from 'react';
import type { LoopId, OrchestratorId, ScheduleId, TaskId } from '../../core/domain.js';
import { LoopStatus, OrchestratorStatus, ScheduleStatus, TaskStatus } from '../../core/domain.js';
import type { DashboardData, DashboardMutationContext, NavState, PanelId, ViewState } from './types.js';

/**
 * Minimal shape required for navigation — id and status are the only fields
 * the keyboard hook needs to operate on any entity list.
 */
interface Identifiable {
  readonly id: string;
  readonly status: string;
}

/** Ordered panel cycle for Tab navigation */
const PANEL_ORDER: readonly PanelId[] = ['loops', 'tasks', 'schedules', 'orchestrations'];

/** Per-panel filter cycles — each panel only includes its valid statuses */
const FILTER_CYCLES: Record<PanelId, readonly (string | null)[]> = {
  loops: [null, 'running', 'paused', 'completed', 'failed', 'cancelled'],
  tasks: [null, 'queued', 'running', 'completed', 'failed', 'cancelled'],
  schedules: [null, 'active', 'paused', 'completed', 'cancelled', 'expired'],
  orchestrations: [null, 'planning', 'running', 'completed', 'failed', 'cancelled'],
};

/** Map of digit keys 1–4 to their corresponding panel IDs */
const PANEL_JUMP_KEYS: Record<string, PanelId> = {
  '1': 'loops',
  '2': 'tasks',
  '3': 'schedules',
  '4': 'orchestrations',
};

/** Terminal statuses per panel — used by both 'c' (cancel guard) and 'd' (delete gate) handlers */
const TERMINAL_STATUSES: {
  orchestrations: OrchestratorStatus[];
  loops: LoopStatus[];
  tasks: TaskStatus[];
  schedules: ScheduleStatus[];
} = {
  orchestrations: [OrchestratorStatus.COMPLETED, OrchestratorStatus.FAILED, OrchestratorStatus.CANCELLED],
  loops: [LoopStatus.COMPLETED, LoopStatus.FAILED, LoopStatus.CANCELLED],
  tasks: [TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED],
  schedules: [ScheduleStatus.COMPLETED, ScheduleStatus.CANCELLED, ScheduleStatus.EXPIRED],
};

interface UseKeyboardParams {
  readonly view: ViewState;
  readonly nav: NavState;
  readonly data: DashboardData | null;
  readonly setView: (v: ViewState) => void;
  readonly setNav: React.Dispatch<React.SetStateAction<NavState>>;
  readonly refreshNow: () => void;
  readonly exit: () => void;
  /**
   * Maximum number of scrollable rows in the currently rendered detail view.
   * When provided, down-arrow scroll is clamped to prevent scrolling into empty space.
   * Defaults to a conservative upper bound (200) when omitted.
   */
  readonly detailContentLength?: number;
  /**
   * DECISION (2026-04-10): Optional mutation context for c/d keybindings.
   * When provided, 'c' cancels the focused entity and 'd' deletes terminal entities.
   * Unified UX across all four panels (loops, tasks, schedules, orchestrations).
   */
  readonly mutations?: DashboardMutationContext;
}

/** Conservative upper bound for detail scroll when caller does not provide content length */
const DETAIL_SCROLL_MAX_DEFAULT = 200;

/**
 * Bundled dependencies passed to per-view key handler functions.
 * Separating this from UseKeyboardParams keeps handler signatures stable
 * even if the hook gains new options.
 */
interface KeyHandlerParams {
  readonly view: ViewState;
  readonly nav: NavState;
  readonly data: DashboardData | null;
  readonly dataRef: React.MutableRefObject<DashboardData | null>;
  readonly setView: (v: ViewState) => void;
  readonly setNav: React.Dispatch<React.SetStateAction<NavState>>;
  readonly detailContentLength: number;
  readonly mutations?: DashboardMutationContext;
  readonly refreshNow: () => void;
}

/**
 * Map a domain entity array to Identifiable items.
 * Explicit mapping avoids type assertions — status enum values are coerced to
 * string via String() so the result is safely assignable to Identifiable[].
 */
function toIdentifiables(
  items: ReadonlyArray<{ id: string; status: { toString(): string } }>,
): readonly Identifiable[] {
  return items.map((item) => ({ id: item.id, status: item.status.toString() }));
}

/** Return a navigation-friendly item list for the given panel. */
function getPanelItems(panelId: PanelId, data: DashboardData): readonly Identifiable[] {
  switch (panelId) {
    case 'loops':
      return toIdentifiables(data.loops);
    case 'tasks':
      return toIdentifiables(data.tasks);
    case 'schedules':
      return toIdentifiables(data.schedules);
    case 'orchestrations':
      return toIdentifiables(data.orchestrations);
  }
}

/**
 * Get the filtered list length for the currently focused panel.
 * Used to clamp selectedIndex after navigation.
 */
function filteredLength(panelId: PanelId, data: DashboardData | null, filterStatus: string | null): number {
  if (data === null) return 0;
  const items = getPanelItems(panelId, data);
  return filterStatus !== null ? items.filter((item) => item.status === filterStatus).length : items.length;
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
 * Handle key input while in the detail view.
 * Returns true if the key was consumed.
 */
function handleDetailKeys(
  input: string,
  key: Parameters<Parameters<typeof useInput>[0]>[1],
  params: KeyHandlerParams,
): boolean {
  const { view, setView, setNav, detailContentLength } = params;
  if (view.kind !== 'detail') return false;

  if (key.escape || key.backspace) {
    setView({ kind: 'main' });
    return true;
  }

  if (key.upArrow || input === 'k') {
    setNav((prev) => ({
      ...prev,
      scrollOffsets: {
        ...prev.scrollOffsets,
        [view.entityType]: Math.max(0, prev.scrollOffsets[view.entityType] - 1),
      },
    }));
    return true;
  }

  if (key.downArrow || input === 'j') {
    // Clamp to detailContentLength - 1 so the user cannot scroll into empty space
    const maxScroll = Math.max(0, detailContentLength - 1);
    setNav((prev) => ({
      ...prev,
      scrollOffsets: {
        ...prev.scrollOffsets,
        [view.entityType]: Math.min(maxScroll, prev.scrollOffsets[view.entityType] + 1),
      },
    }));
    return true;
  }

  // Any other key in detail view is swallowed (no fallthrough to main handler)
  return true;
}

/**
 * Handle key input while in the main panel view.
 * Returns true if the key was consumed.
 */
function handleMainKeys(
  input: string,
  key: Parameters<Parameters<typeof useInput>[0]>[1],
  params: KeyHandlerParams,
): boolean {
  const { nav, dataRef, setView, setNav } = params;

  // Tab — cycle focus forward
  if (key.tab && !key.shift) {
    setNav((prev) => {
      const currentIdx = PANEL_ORDER.indexOf(prev.focusedPanel);
      const nextIdx = (currentIdx + 1) % PANEL_ORDER.length;
      return { ...prev, focusedPanel: PANEL_ORDER[nextIdx] };
    });
    return true;
  }

  // Shift+Tab — cycle focus backward
  if (key.tab && key.shift) {
    setNav((prev) => {
      const currentIdx = PANEL_ORDER.indexOf(prev.focusedPanel);
      const prevIdx = (currentIdx - 1 + PANEL_ORDER.length) % PANEL_ORDER.length;
      return { ...prev, focusedPanel: PANEL_ORDER[prevIdx] };
    });
    return true;
  }

  // 1-4 — jump to panel by number
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
        setView({ kind: 'detail', entityType: 'loops', entityId: selectedItem.id as LoopId });
        break;
      case 'tasks':
        setView({ kind: 'detail', entityType: 'tasks', entityId: selectedItem.id as TaskId });
        break;
      case 'schedules':
        setView({ kind: 'detail', entityType: 'schedules', entityId: selectedItem.id as ScheduleId });
        break;
      case 'orchestrations':
        setView({ kind: 'detail', entityType: 'orchestrations', entityId: selectedItem.id as OrchestratorId });
        break;
    }
    return true;
  }

  // c — cancel focused entity (status-dependent, works when not terminal)
  // DECISION (2026-04-10): Manual cancel/delete keybindings on ALL four panels
  // (loops/tasks/schedules/orchestrations). 'c' dispatches to the focused entity's
  // existing cancel service method — works whenever the row is not already terminal.
  // 'd' is restricted to terminal statuses to prevent accidental data loss on active work.
  // Unified UX across panels per user preference.
  if (input === 'c' && params.mutations) {
    const data = params.dataRef.current;
    if (data !== null) {
      const panel = nav.focusedPanel;
      const filter = nav.filters[panel];
      const allItems = getPanelItems(panel, data);
      const filteredItems = filter !== null ? allItems.filter((item) => item.status === filter) : allItems;
      const selectedItem = filteredItems[nav.selectedIndices[panel]];
      if (selectedItem) {
        const { orchestrationService, loopService, taskManager, scheduleService } = params.mutations;
        const reason = 'User cancelled via dashboard';

        void (async () => {
          if (
            panel === 'orchestrations' &&
            !TERMINAL_STATUSES.orchestrations.includes(selectedItem.status as OrchestratorStatus)
          ) {
            await orchestrationService.cancelOrchestration(selectedItem.id as OrchestratorId, reason);
            params.refreshNow();
          } else if (panel === 'loops' && !TERMINAL_STATUSES.loops.includes(selectedItem.status as LoopStatus)) {
            await loopService.cancelLoop(selectedItem.id as LoopId, reason, true);
            params.refreshNow();
          } else if (panel === 'tasks' && !TERMINAL_STATUSES.tasks.includes(selectedItem.status as TaskStatus)) {
            await taskManager.cancel(selectedItem.id as TaskId, reason);
            params.refreshNow();
          } else if (
            panel === 'schedules' &&
            !TERMINAL_STATUSES.schedules.includes(selectedItem.status as ScheduleStatus)
          ) {
            await scheduleService.cancelSchedule(selectedItem.id as ScheduleId, reason);
            params.refreshNow();
          }
        })();
      }
    }
    return true;
  }

  // d — delete focused terminal entity row
  if (input === 'd' && params.mutations) {
    const data = params.dataRef.current;
    if (data !== null) {
      const panel = nav.focusedPanel;
      const filter = nav.filters[panel];
      const allItems = getPanelItems(panel, data);
      const filteredItems = filter !== null ? allItems.filter((item) => item.status === filter) : allItems;
      const selectedItem = filteredItems[nav.selectedIndices[panel]];
      if (selectedItem) {
        const { orchestrationRepo } = params.mutations;

        void (async () => {
          if (
            panel === 'orchestrations' &&
            TERMINAL_STATUSES.orchestrations.includes(selectedItem.status as OrchestratorStatus)
          ) {
            await orchestrationRepo.delete(selectedItem.id as OrchestratorId);
            params.refreshNow();
          }
          // NOTE: loop, task, schedule delete would go here when those repos are added to mutations context
        })();
      }
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

/**
 * Custom hook wrapping Ink's useInput.
 * Routes keys to handlers based on current view (main or detail).
 */
export function useKeyboard({
  view,
  nav,
  data,
  setView,
  setNav,
  refreshNow,
  exit,
  detailContentLength,
  mutations,
}: UseKeyboardParams): void {
  // Keep a ref to the latest data so setNav functional updaters always see
  // current data, not stale closure data from the render that registered useInput.
  const dataRef = useRef(data);
  dataRef.current = data;

  useInput((input, key) => {
    // Global keys — handled before view dispatch
    if (input === 'q') {
      exit();
      return;
    }
    if (input === 'r') {
      refreshNow();
      return;
    }

    const params: KeyHandlerParams = {
      view,
      nav,
      data,
      dataRef,
      setView,
      setNav,
      detailContentLength: detailContentLength ?? DETAIL_SCROLL_MAX_DEFAULT,
      mutations,
      refreshNow,
    };

    if (view.kind === 'detail') {
      handleDetailKeys(input, key, params);
    } else {
      handleMainKeys(input, key, params);
    }
  });
}
