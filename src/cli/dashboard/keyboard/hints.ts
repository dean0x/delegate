/**
 * Context-sensitive key hint strings for the footer help bar.
 * ARCHITECTURE: Pure functions — no side effects, all inputs explicit
 *
 * Centralises hint text here so the Footer component stays a leaf node and
 * any keyboard refactor only needs to update this one file.
 */

import { LoopStatus, ScheduleStatus } from '../../../core/domain.js';
import type { PanelId } from '../types.js';

/**
 * Return the footer hint string for the main panel view.
 * Includes panel-jump hint (1-5) and optionally c/d/p mutation hints.
 * The pause/resume hint is only shown when the focused panel supports it
 * (schedules and loops); p is a no-op for tasks, orchestrations, and pipelines.
 */
export function mainHints(hasMutations: boolean, focusedPanel?: PanelId): string {
  const base = 'Tab: panel · ↑↓: select · Enter: detail · 1-5: panel · f: filter · r refresh · q quit';
  if (hasMutations) {
    const pauseHint = focusedPanel === 'schedules' || focusedPanel === 'loops' ? ' · p pause/resume' : '';
    return `${base} · c cancel · d delete (terminal)${pauseHint}`;
  }
  return base;
}

/**
 * Return the footer hint string for the detail view.
 * Output controls (o/[/]/G) apply to task and orchestration detail only —
 * schedules and loops have no output stream, so those hints are omitted.
 * Pause/resume hint is conditional on entity type and status.
 */
export function detailHints(entityType?: PanelId, entityStatus?: string, hasMutations = true): string {
  const baseWithOutput = 'Esc back · ↑↓ select · Enter detail · o output · [/] scroll · G tail · r refresh · q quit';
  const baseNoOutput = 'Esc back · ↑↓ select · Enter detail · r refresh · q quit';

  if (entityType === 'schedules' || entityType === 'loops') {
    if (hasMutations && (entityStatus === ScheduleStatus.ACTIVE || entityStatus === LoopStatus.RUNNING)) {
      return `${baseNoOutput} · p pause`;
    }
    if (hasMutations && (entityStatus === ScheduleStatus.PAUSED || entityStatus === LoopStatus.PAUSED)) {
      return `${baseNoOutput} · p resume`;
    }
    return baseNoOutput;
  }
  return baseWithOutput;
}

/**
 * Return the appropriate hint string for the current view kind.
 */
export function getHints(
  viewKind: 'main' | 'detail',
  hasMutations: boolean,
  entityType?: PanelId,
  entityStatus?: string,
  focusedPanel?: PanelId,
): string {
  switch (viewKind) {
    case 'main':
      return mainHints(hasMutations, focusedPanel);
    case 'detail':
      return detailHints(entityType, entityStatus, hasMutations);
  }
}
