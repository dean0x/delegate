/**
 * useKeyboard — routes keyboard input to navigation/action handlers
 * ARCHITECTURE: Pure hook — all state changes via setters, no side effects beyond exit()
 * Pattern: Functional core dispatches to immutable state updates
 */

import { useInput } from 'ink';
import type React from 'react';
import { useRef } from 'react';
import type { ActivityEntry, LoopId, OrchestratorId, ScheduleId, TaskId } from '../../core/domain.js';
import { LoopStatus, OrchestratorStatus, ScheduleStatus, TaskStatus } from '../../core/domain.js';
import type { DashboardData, DashboardMutationContext, NavState, PanelId, ViewState } from './types.js';
import { ORCHESTRATION_CHILDREN_PAGE_SIZE } from './views/orchestration-detail.js';
import type { WorkspaceNavState } from './workspace-types.js';

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
  /**
   * Phase E: workspace navigation state.
   * When provided, enables handleWorkspaceKeys when view.kind === 'workspace'.
   */
  readonly workspaceNav?: WorkspaceNavState;
  readonly setWorkspaceNav?: React.Dispatch<React.SetStateAction<WorkspaceNavState>>;
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
  readonly workspaceNav?: WorkspaceNavState;
  readonly setWorkspaceNav?: React.Dispatch<React.SetStateAction<WorkspaceNavState>>;
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
 * Resolve the currently selected child index from a taskId.
 * Returns 0 when no taskId is set or the taskId is not found in the list.
 */
function resolveChildIndex(selectedTaskId: string | null, children: readonly { taskId: string }[]): number {
  if (!selectedTaskId) return 0;
  const idx = children.findIndex((c) => c.taskId === selectedTaskId);
  return idx >= 0 ? idx : 0;
}

/**
 * Handle key input while in the detail view.
 * Returns true if the key was consumed.
 *
 * D3 drill-through (v1.3.0):
 *  - Orchestration detail: ↑/↓/j/k move child row selection (by taskId)
 *  - Enter: drill into selected child's task detail (returnTo = orchestration object)
 *  - PgUp/PgDn: navigate pages of children (resets selection to first row on page)
 *  - Esc/Backspace: returns to the view encoded in returnTo (main, workspace, or orchestration)
 *
 * For non-orchestration detail views, ↑/↓ scroll the detail content as before.
 */
function handleDetailKeys(
  input: string,
  key: Parameters<Parameters<typeof useInput>[0]>[1],
  params: KeyHandlerParams,
): boolean {
  const { view, nav, setView, setNav, detailContentLength, refreshNow } = params;
  if (view.kind !== 'detail') return false;

  if (key.escape || key.backspace) {
    // Return to the view that opened this detail (returnTo defaults to 'main')
    const returnTo = view.returnTo ?? 'main';
    if (typeof returnTo === 'object' && returnTo.kind === 'orchestrations') {
      // D3 drill-through Esc: return to the parent orchestration detail
      setView({
        kind: 'detail',
        entityType: 'orchestrations',
        entityId: returnTo.entityId,
        returnTo: returnTo.originalReturnTo,
      });
    } else if (returnTo === 'workspace') {
      setView({ kind: 'workspace' });
    } else {
      setView({ kind: 'main' });
    }
    return true;
  }

  // D3 orchestration detail: child row navigation + drill-through
  if (view.entityType === 'orchestrations') {
    const children = params.dataRef.current?.orchestrationChildren ?? [];
    const childrenTotal = params.dataRef.current?.orchestrationChildrenTotal;

    if (key.upArrow || input === 'k') {
      if (children.length === 0) return true;
      setNav((prev) => {
        const nextIdx = Math.max(0, resolveChildIndex(prev.orchestrationChildSelectedTaskId, children) - 1);
        return { ...prev, orchestrationChildSelectedTaskId: children[nextIdx]?.taskId ?? null };
      });
      return true;
    }

    if (key.downArrow || input === 'j') {
      if (children.length === 0) return true;
      setNav((prev) => {
        const nextIdx = Math.min(
          children.length - 1,
          resolveChildIndex(prev.orchestrationChildSelectedTaskId, children) + 1,
        );
        return { ...prev, orchestrationChildSelectedTaskId: children[nextIdx]?.taskId ?? null };
      });
      return true;
    }

    if (key.return) {
      // Enter: drill into the selected child task detail
      if (children.length === 0) return true;
      const child = children[resolveChildIndex(nav.orchestrationChildSelectedTaskId, children)];
      if (!child) return true;
      const originalReturnTo: 'main' | 'workspace' = view.returnTo === 'workspace' ? 'workspace' : 'main';
      setView({
        kind: 'detail',
        entityType: 'tasks',
        entityId: child.taskId as import('../../core/domain.js').TaskId,
        returnTo: {
          kind: 'orchestrations',
          entityId: view.entityId,
          originalReturnTo,
        },
      });
      return true;
    }

    if (key.pageUp) {
      setNav((prev) => {
        const newPage = Math.max(0, prev.orchestrationChildPage - 1);
        if (newPage === prev.orchestrationChildPage) return prev;
        return { ...prev, orchestrationChildPage: newPage, orchestrationChildSelectedTaskId: null };
      });
      // The useDashboardData effect auto-refetches when orchestrationChildPage
      // changes; refreshNow() is called as a belt-and-braces signal so any
      // listener (telemetry, manual indicator) also sees the page-change event.
      refreshNow();
      return true;
    }

    if (key.pageDown) {
      const totalPages = childrenTotal !== undefined ? Math.ceil(childrenTotal / ORCHESTRATION_CHILDREN_PAGE_SIZE) : 1;
      setNav((prev) => {
        const newPage = Math.min(totalPages - 1, prev.orchestrationChildPage + 1);
        if (newPage === prev.orchestrationChildPage) return prev;
        return { ...prev, orchestrationChildPage: newPage, orchestrationChildSelectedTaskId: null };
      });
      refreshNow();
      return true;
    }

    // Any other key in orchestration detail is swallowed
    return true;
  }

  // Non-orchestration detail: ↑/↓ scroll the content
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
 * Handle key input while in the workspace view.
 * Returns true if the key was consumed.
 *
 * Key routing:
 *  - ↑/k / ↓/j   : move nav cursor (nav focus only)
 *  - Enter        : commit nav selection → grid focus; grid focus → drill into child detail
 *  - Tab          : cycle focusArea nav → grid → nav
 *  - Shift+Tab    : reverse cycle
 *  - 1-9          : jump to panel index (grid focus)
 *  - f            : toggle fullscreen for focused panel
 *  - [/]          : scroll focused panel up/down with auto-tail toggle
 *  - g/G          : jump to top / bottom of focused panel
 *  - PgUp/PgDn    : page grid
 *  - Esc/Backspace: exit fullscreen → return to main
 *  - c/d          : cancel/delete (nav: committed orch; grid: focused child task)
 */
function handleWorkspaceKeys(
  input: string,
  key: Parameters<Parameters<typeof useInput>[0]>[1],
  params: KeyHandlerParams,
): boolean {
  const { view, setView, dataRef, mutations, refreshNow } = params;
  if (view.kind !== 'workspace') return false;
  const { workspaceNav, setWorkspaceNav } = params;
  if (!workspaceNav || !setWorkspaceNav) return false;

  // Esc / Backspace — exit fullscreen if active; otherwise return to main
  if (key.escape || key.backspace) {
    if (workspaceNav.fullscreenPanelIndex !== null) {
      setWorkspaceNav((prev) => ({ ...prev, fullscreenPanelIndex: null }));
    } else {
      setView({ kind: 'main' });
    }
    return true;
  }

  // Tab — cycle focusArea: nav → grid → nav; also cycle focusedPanelIndex within grid
  if (key.tab && !key.shift) {
    setWorkspaceNav((prev) => {
      if (prev.focusArea === 'nav') {
        return { ...prev, focusArea: 'grid' };
      }
      // grid → advance panel or wrap back to nav
      const data = dataRef.current;
      const childCount = data?.workspaceData?.children.length ?? 0;
      if (childCount === 0) {
        // No panels — just toggle back to nav
        return { ...prev, focusArea: 'nav' };
      }
      const nextPanel = (prev.focusedPanelIndex + 1) % childCount;
      if (nextPanel === 0) {
        // Wrapped around — go back to nav
        return { ...prev, focusArea: 'nav', focusedPanelIndex: 0 };
      }
      return { ...prev, focusArea: 'grid', focusedPanelIndex: nextPanel };
    });
    return true;
  }

  // Shift+Tab — reverse cycle
  if (key.tab && key.shift) {
    setWorkspaceNav((prev) => {
      if (prev.focusArea === 'grid') {
        return { ...prev, focusArea: 'nav' };
      }
      return { ...prev, focusArea: 'grid' };
    });
    return true;
  }

  // ↑ / k — move nav cursor up (nav focus only)
  if (key.upArrow || input === 'k') {
    if (workspaceNav.focusArea === 'nav') {
      setWorkspaceNav((prev) => ({
        ...prev,
        selectedOrchestratorIndex: Math.max(0, prev.selectedOrchestratorIndex - 1),
      }));
      return true;
    }
    return true; // consume in grid too (no-op for now)
  }

  // ↓ / j — move nav cursor down (nav focus only)
  // Upper clamp: if orchestration list is available, clamp to list length - 1.
  // When list is empty (e.g. during test with no data), allow cursor to move freely.
  if (key.downArrow || input === 'j') {
    if (workspaceNav.focusArea === 'nav') {
      const orchList = dataRef.current?.orchestrations;
      const maxIdx = orchList && orchList.length > 0 ? orchList.length - 1 : Number.MAX_SAFE_INTEGER;
      setWorkspaceNav((prev) => ({
        ...prev,
        selectedOrchestratorIndex: Math.min(maxIdx, prev.selectedOrchestratorIndex + 1),
      }));
      return true;
    }
    return true; // consume in grid too
  }

  // Enter — commit (nav focus) or drill into child detail (grid focus)
  if (key.return) {
    if (workspaceNav.focusArea === 'nav') {
      setWorkspaceNav((prev) => ({
        ...prev,
        committedOrchestratorIndex: prev.selectedOrchestratorIndex,
        fullscreenPanelIndex: null,
        focusArea: 'grid',
      }));
      return true;
    }
    // grid focus — drill into child task detail
    const data = dataRef.current;
    const children = data?.workspaceData?.children;
    if (children && children.length > 0) {
      const child = children[workspaceNav.focusedPanelIndex];
      if (child) {
        setView({ kind: 'detail', entityType: 'tasks', entityId: child.taskId as TaskId, returnTo: 'workspace' });
      }
    }
    return true;
  }

  // f — toggle fullscreen for focused panel (grid focus)
  if (input === 'f') {
    if (workspaceNav.focusArea === 'grid') {
      setWorkspaceNav((prev) => ({
        ...prev,
        fullscreenPanelIndex: prev.fullscreenPanelIndex === prev.focusedPanelIndex ? null : prev.focusedPanelIndex,
      }));
    }
    return true;
  }

  // 1–9 — jump to panel by number (grid focus)
  if (input >= '1' && input <= '9' && workspaceNav.focusArea === 'grid') {
    const panelIdx = parseInt(input, 10) - 1;
    const data = dataRef.current;
    const childCount = data?.workspaceData?.children.length ?? 0;
    if (panelIdx < childCount) {
      setWorkspaceNav((prev) => ({ ...prev, focusedPanelIndex: panelIdx }));
    }
    return true;
  }

  // [ — scroll focused panel up
  if (input === '[') {
    const data = dataRef.current;
    const children = data?.workspaceData?.children;
    if (children && children.length > 0) {
      const child = children[workspaceNav.focusedPanelIndex];
      if (child) {
        const taskId = child.taskId;
        setWorkspaceNav((prev) => ({
          ...prev,
          panelScrollOffsets: {
            ...prev.panelScrollOffsets,
            [taskId]: Math.max(0, (prev.panelScrollOffsets[taskId] ?? 0) - 1),
          },
          autoTailEnabled: { ...prev.autoTailEnabled, [taskId]: false },
        }));
      }
    }
    return true;
  }

  // ] — scroll focused panel down
  if (input === ']') {
    const data = dataRef.current;
    const children = data?.workspaceData?.children;
    if (children && children.length > 0) {
      const child = children[workspaceNav.focusedPanelIndex];
      if (child) {
        const taskId = child.taskId;
        setWorkspaceNav((prev) => ({
          ...prev,
          panelScrollOffsets: {
            ...prev.panelScrollOffsets,
            [taskId]: (prev.panelScrollOffsets[taskId] ?? 0) + 1,
          },
          // auto-tail stays as-is — caller re-enables when reaching bottom
        }));
      }
    }
    return true;
  }

  // g — jump to top of focused panel
  if (input === 'g') {
    const data = dataRef.current;
    const children = data?.workspaceData?.children;
    if (children && children.length > 0) {
      const child = children[workspaceNav.focusedPanelIndex];
      if (child) {
        const taskId = child.taskId;
        setWorkspaceNav((prev) => ({
          ...prev,
          panelScrollOffsets: { ...prev.panelScrollOffsets, [taskId]: 0 },
          autoTailEnabled: { ...prev.autoTailEnabled, [taskId]: false },
        }));
      }
    }
    return true;
  }

  // G — jump to bottom and re-engage auto-tail
  if (input === 'G') {
    const data = dataRef.current;
    const children = data?.workspaceData?.children;
    if (children && children.length > 0) {
      const child = children[workspaceNav.focusedPanelIndex];
      if (child) {
        const taskId = child.taskId;
        setWorkspaceNav((prev) => ({
          ...prev,
          panelScrollOffsets: { ...prev.panelScrollOffsets, [taskId]: 0 },
          autoTailEnabled: { ...prev.autoTailEnabled, [taskId]: true },
        }));
      }
    }
    return true;
  }

  // PgUp — previous grid page
  if (key.pageUp) {
    setWorkspaceNav((prev) => ({
      ...prev,
      gridPage: Math.max(0, prev.gridPage - 1),
    }));
    return true;
  }

  // PgDn — next grid page
  if (key.pageDown) {
    setWorkspaceNav((prev) => ({
      ...prev,
      gridPage: prev.gridPage + 1,
    }));
    return true;
  }

  // c — cancel (nav: committed orch with cascade; grid: focused child task)
  if (input === 'c' && mutations) {
    const data = dataRef.current;
    if (workspaceNav.focusArea === 'nav') {
      const orchs = data?.orchestrations ?? [];
      const orch = orchs[workspaceNav.committedOrchestratorIndex];
      if (orch && !TERMINAL_STATUSES.orchestrations.includes(orch.status as OrchestratorStatus)) {
        void (async () => {
          await mutations.orchestrationService.cancelOrchestration(
            orch.id as OrchestratorId,
            'User cancelled via dashboard',
            { cancelAttributedTasks: true },
          );
          refreshNow();
        })();
      }
    } else {
      // grid focus — cancel focused child task
      const children = data?.workspaceData?.children;
      if (children && children.length > 0) {
        const child = children[workspaceNav.focusedPanelIndex];
        if (child && !TERMINAL_STATUSES.tasks.includes(child.status as TaskStatus)) {
          void (async () => {
            await mutations.taskManager.cancel(child.taskId as TaskId, 'User cancelled via dashboard');
            refreshNow();
          })();
        }
      }
    }
    return true;
  }

  // d — delete terminal entity (grid focus only; nav focus is ignored)
  if (input === 'd' && mutations) {
    if (workspaceNav.focusArea === 'grid') {
      const data = dataRef.current;
      const children = data?.workspaceData?.children;
      if (children && children.length > 0) {
        const child = children[workspaceNav.focusedPanelIndex];
        if (child && TERMINAL_STATUSES.tasks.includes(child.status as TaskStatus)) {
          void (async () => {
            await mutations.taskRepo.delete(child.taskId as TaskId);
            refreshNow();
          })();
        }
      }
    }
    return true;
  }

  return false;
}

/**
 * Map an ActivityEntry kind to the detail entityType used by openDetail.
 * Kept as a pure function so tests can assert on dispatched entityType.
 */
function activityKindToEntityType(kind: ActivityEntry['kind']): 'tasks' | 'loops' | 'orchestrations' | 'schedules' {
  switch (kind) {
    case 'task':
      return 'tasks';
    case 'loop':
      return 'loops';
    case 'orchestration':
      return 'orchestrations';
    case 'schedule':
      return 'schedules';
  }
}

/**
 * Handle key input while in the main panel view.
 * Returns true if the key was consumed.
 *
 * Activity focus mode (v1.3.0):
 *  - Tab from last panel (orchestrations) → activity focus
 *  - Shift+Tab from first panel (loops) → activity focus
 *  - Tab / Shift+Tab from activity focus → return to panel grid
 *  - ↑/↓ when activityFocused → move activitySelectedIndex
 *  - Enter when activityFocused → openDetail for the selected entry
 *  - Esc when activityFocused → return to panel focus (loops)
 */
function handleMainKeys(
  input: string,
  key: Parameters<Parameters<typeof useInput>[0]>[1],
  params: KeyHandlerParams,
): boolean {
  const { nav, dataRef, setView, setNav } = params;

  // Esc from activity focus — return to default panel focus
  if ((key.escape || key.backspace) && nav.activityFocused) {
    setNav((prev) => ({ ...prev, activityFocused: false }));
    return true;
  }

  // Tab — cycle focus forward
  if (key.tab && !key.shift) {
    setNav((prev) => {
      // Activity → panel (loops)
      if (prev.activityFocused) {
        return { ...prev, activityFocused: false, focusedPanel: 'loops' };
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

    // c — cancel the entity on the focused Activity row (plan §9)
    // Dispatches based on entry.kind — same 4-way mapping as workspace cancel.
    // Orchestration cancel passes cancelAttributedTasks: true to trigger cascade.
    if (input === 'c' && params.mutations) {
      const feed = dataRef.current?.activityFeed;
      if (feed && feed.length > 0) {
        const entry = feed[nav.activitySelectedIndex];
        if (entry) {
          const { orchestrationService, loopService, taskManager, scheduleService } = params.mutations;
          const reason = 'User cancelled via dashboard';
          void (async () => {
            switch (entry.kind) {
              case 'orchestration':
                await orchestrationService.cancelOrchestration(entry.entityId as OrchestratorId, reason, {
                  cancelAttributedTasks: true,
                });
                params.refreshNow();
                break;
              case 'loop':
                await loopService.cancelLoop(entry.entityId as LoopId, reason, true);
                params.refreshNow();
                break;
              case 'task':
                await taskManager.cancel(entry.entityId as TaskId, reason);
                params.refreshNow();
                break;
              case 'schedule':
                await scheduleService.cancelSchedule(entry.entityId as ScheduleId, reason);
                params.refreshNow();
                break;
            }
          })();
        }
      }
      return true;
    }

    // d — delete the entity on the focused Activity row (terminal status only, plan §9)
    // Non-terminal entities are silently ignored (cannot delete live work).
    if (input === 'd' && params.mutations) {
      const feed = dataRef.current?.activityFeed;
      if (feed && feed.length > 0) {
        const entry = feed[nav.activitySelectedIndex];
        if (entry) {
          const { orchestrationRepo, loopRepo, taskRepo, scheduleRepo } = params.mutations;
          void (async () => {
            switch (entry.kind) {
              case 'orchestration':
                if (TERMINAL_STATUSES.orchestrations.includes(entry.status as OrchestratorStatus)) {
                  await orchestrationRepo.delete(entry.entityId as OrchestratorId);
                  params.refreshNow();
                }
                break;
              case 'loop':
                if (TERMINAL_STATUSES.loops.includes(entry.status as LoopStatus)) {
                  await loopRepo.delete(entry.entityId as LoopId);
                  params.refreshNow();
                }
                break;
              case 'task':
                if (TERMINAL_STATUSES.tasks.includes(entry.status as TaskStatus)) {
                  await taskRepo.delete(entry.entityId as TaskId);
                  params.refreshNow();
                }
                break;
              case 'schedule':
                if (TERMINAL_STATUSES.schedules.includes(entry.status as ScheduleStatus)) {
                  await scheduleRepo.delete(entry.entityId as ScheduleId);
                  params.refreshNow();
                }
                break;
            }
          })();
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
        const { orchestrationRepo, loopRepo, taskRepo, scheduleRepo } = params.mutations;

        void (async () => {
          switch (panel) {
            case 'orchestrations':
              if (TERMINAL_STATUSES.orchestrations.includes(selectedItem.status as OrchestratorStatus)) {
                await orchestrationRepo.delete(selectedItem.id as OrchestratorId);
                params.refreshNow();
              }
              break;
            case 'loops':
              if (TERMINAL_STATUSES.loops.includes(selectedItem.status as LoopStatus)) {
                await loopRepo.delete(selectedItem.id as LoopId);
                params.refreshNow();
              }
              break;
            case 'tasks':
              if (TERMINAL_STATUSES.tasks.includes(selectedItem.status as TaskStatus)) {
                await taskRepo.delete(selectedItem.id as TaskId);
                params.refreshNow();
              }
              break;
            case 'schedules':
              if (TERMINAL_STATUSES.schedules.includes(selectedItem.status as ScheduleStatus)) {
                await scheduleRepo.delete(selectedItem.id as ScheduleId);
                params.refreshNow();
              }
              break;
          }
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
 * Routes keys to handlers based on current view (main, workspace, or detail).
 *
 * Global keys (handled before view dispatch):
 *  - q: quit
 *  - r: refresh
 *  - v: toggle between main/workspace (ignored when in detail — user must Esc first)
 *  - m: jump to main (works from any view)
 *  - w: jump to workspace (works from any view)
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
  workspaceNav,
  setWorkspaceNav,
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

    // v — toggle between main and workspace (ignored in detail view)
    if (input === 'v' && view.kind !== 'detail') {
      if (view.kind === 'workspace') {
        setView({ kind: 'main' });
      } else {
        setView({ kind: 'workspace' });
      }
      return;
    }

    // m — jump to main from any view (including detail — acts like Esc→m)
    if (input === 'm') {
      setView({ kind: 'main' });
      return;
    }

    // w — jump to workspace from any view (including detail — acts like Esc→w)
    if (input === 'w') {
      setView({ kind: 'workspace' });
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
      workspaceNav,
      setWorkspaceNav,
    };

    if (view.kind === 'detail') {
      handleDetailKeys(input, key, params);
    } else if (view.kind === 'workspace') {
      handleWorkspaceKeys(input, key, params);
    } else {
      handleMainKeys(input, key, params);
    }
  });
}
