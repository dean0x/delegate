/**
 * Shared keyboard handler types.
 *
 * These types are shared across all handler modules (handleDetailKeys,
 * handleWorkspaceKeys, handleMainKeys) so each handler is independently
 * importable without cross-calling the others. Placing them here avoids
 * circular imports and lets entity-mutations.ts reference DashboardMutationContext
 * without pulling in handler logic.
 */

import { useInput } from 'ink';
import type React from 'react';
import type { DashboardData, DashboardMutationContext, NavState, ViewState } from '../types.js';
import type { WorkspaceNavState } from '../workspace-types.js';

/**
 * Minimal shape required for navigation — id and status are the only fields
 * the keyboard hook needs to operate on any entity list.
 */
export interface Identifiable {
  readonly id: string;
  readonly status: string;
}

/**
 * Parameters accepted by the useKeyboard hook.
 * Kept as a separate interface so app.tsx callers see a stable API even
 * as internal handler signatures evolve.
 */
export interface UseKeyboardParams {
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
  readonly entityBrowserViewportHeight?: number;
}

/**
 * Bundled dependencies passed to per-view key handler functions.
 * Separating this from UseKeyboardParams keeps handler signatures stable
 * even if the hook gains new options.
 */
export interface KeyHandlerParams {
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
  readonly entityBrowserViewportHeight: number;
}

/** Ink key descriptor extracted from the useInput callback signature */
export type InkKey = Parameters<Parameters<typeof useInput>[0]>[1];
