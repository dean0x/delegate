/**
 * Dashboard navigation state reducer
 * ARCHITECTURE: Centralises all dashboard state transitions as a pure function
 * Pattern: Elm-style reducer — (state, action) => state; never mutates
 * Rationale: Replaces scattered useState calls with a single predictable update path.
 *   All navigation logic is now testable without mounting a React component.
 */

import type { NavState, ViewState } from './types.js';

// ============================================================================
// State
// ============================================================================

export interface DashboardState {
  readonly view: ViewState;
  readonly nav: NavState;
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

    case 'TICK_ANIM':
      return { ...state, animFrame: state.animFrame + 1 };

    default: {
      // Exhaustive check — TypeScript will error if a case is unhandled
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}
