/**
 * Pure helper functions for keyboard navigation.
 * All functions are side-effect-free and suitable for use in any handler module.
 */

import type { DashboardData, NavState, PanelId } from '../types.js';
import type { EntityKind } from './entity-mutations.js';
import type { Identifiable } from './types.js';

/**
 * Map a domain entity array to Identifiable items.
 * Explicit mapping avoids type assertions — status enum values are coerced to
 * string via String() so the result is safely assignable to Identifiable[].
 */
export function toIdentifiables(
  items: ReadonlyArray<{ id: string; status: { toString(): string } }>,
): readonly Identifiable[] {
  return items.map((item) => ({ id: item.id, status: item.status.toString() }));
}

/** Return a navigation-friendly item list for the given panel. */
export function getPanelItems(panelId: PanelId, data: DashboardData): readonly Identifiable[] {
  switch (panelId) {
    case 'loops':
      return toIdentifiables(data.loops);
    case 'tasks':
      return toIdentifiables(data.tasks);
    case 'schedules':
      return toIdentifiables(data.schedules);
    case 'orchestrations':
      return toIdentifiables(data.orchestrations);
    case 'pipelines':
      return toIdentifiables(data.pipelines ?? []);
  }
}

/**
 * Get the filtered list length for the currently focused panel.
 * Used to clamp selectedIndex after navigation.
 */
export function filteredLength(panelId: PanelId, data: DashboardData | null, filterStatus: string | null): number {
  if (data === null) return 0;
  const items = getPanelItems(panelId, data);
  return filterStatus !== null ? items.filter((item) => item.status === filterStatus).length : items.length;
}

/**
 * Clamp a number between min and max (inclusive).
 * Returns min if range is empty.
 */
export function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.max(min, Math.min(max, value));
}

/**
 * Resolve the currently selected child index from a taskId.
 * Returns 0 when no taskId is set or the taskId is not found in the list.
 */
export function resolveChildIndex(selectedTaskId: string | null, children: readonly { taskId: string }[]): number {
  if (!selectedTaskId) return 0;
  const idx = children.findIndex((c) => c.taskId === selectedTaskId);
  return idx >= 0 ? idx : 0;
}

/**
 * Map a PanelId to its corresponding EntityKind.
 * Used by cancel/delete handlers to route to the correct service.
 */
export function panelToEntityKind(panelId: PanelId): EntityKind {
  switch (panelId) {
    case 'orchestrations':
      return 'orchestration';
    case 'loops':
      return 'loop';
    case 'tasks':
      return 'task';
    case 'schedules':
      return 'schedule';
    case 'pipelines':
      return 'pipeline';
  }
}

/**
 * Return the currently selected item in the focused panel, or null if data is absent.
 * Applies the active filter before resolving the selection index.
 * Used by the 'c' (cancel) and 'd' (delete) handlers in the main panel.
 */
export function getFocusedPanelItem(nav: NavState, data: DashboardData | null): Identifiable | null {
  if (data === null) return null;
  const panel = nav.focusedPanel;
  const filter = nav.filters[panel];
  const allItems = getPanelItems(panel, data);
  const filteredItems = filter !== null ? allItems.filter((item) => item.status === filter) : allItems;
  return filteredItems[nav.selectedIndices[panel]] ?? null;
}
