/**
 * Dashboard navigation state reducer
 * ARCHITECTURE: Centralises all dashboard state transitions as a pure function
 * Pattern: Elm-style reducer — (state, action) => state; never mutates
 * Rationale: Replaces scattered useState calls with a single predictable update path.
 *   All navigation logic is now testable without mounting a React component.
 *
 * DECISION: DashboardState owns view + nav + workspaceNav so a single dispatch()
 * replaces the setView/setNav/setWorkspaceNav triple. Keyboard handlers keep the
 * same setView / setNav adapter signatures — adapters are created in app.tsx from
 * dispatch so no handler rewrite is required.
 */

import type { NavState, ViewState } from './types.js';
import type { WorkspaceNavState } from './workspace-types.js';

// ============================================================================
// State
// ============================================================================

export interface DashboardState {
  readonly view: ViewState;
  readonly nav: NavState;
  readonly workspaceNav: WorkspaceNavState;
  /** Monotonic counter incremented every 250ms to drive status-badge animations */
  readonly animFrame: number;
}

// ============================================================================
// Actions
// ============================================================================

export type DashboardAction =
  | { readonly type: 'SET_VIEW'; readonly view: ViewState }
  | { readonly type: 'SET_NAV'; readonly nav: NavState }
  | { readonly type: 'UPDATE_NAV'; readonly updater: (prev: NavState) => NavState }
  | { readonly type: 'SET_WORKSPACE_NAV'; readonly workspaceNav: WorkspaceNavState }
  | { readonly type: 'UPDATE_WORKSPACE_NAV'; readonly updater: (prev: WorkspaceNavState) => WorkspaceNavState }
  | { readonly type: 'TICK_ANIM' };

// ============================================================================
// Reducer
// ============================================================================

/**
 * Pure dashboard state reducer.
 * Each action returns a new state object; the input state is never mutated.
 */
export function dashboardReducer(state: DashboardState, action: DashboardAction): DashboardState {
  switch (action.type) {
    case 'SET_VIEW':
      return { ...state, view: action.view };

    case 'SET_NAV':
      return { ...state, nav: action.nav };

    case 'UPDATE_NAV':
      return { ...state, nav: action.updater(state.nav) };

    case 'SET_WORKSPACE_NAV':
      return { ...state, workspaceNav: action.workspaceNav };

    case 'UPDATE_WORKSPACE_NAV':
      return { ...state, workspaceNav: action.updater(state.workspaceNav) };

    case 'TICK_ANIM':
      return { ...state, animFrame: state.animFrame + 1 };

    default: {
      // Exhaustive check — TypeScript will error if a case is unhandled
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}
