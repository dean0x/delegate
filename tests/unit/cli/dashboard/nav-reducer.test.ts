/**
 * Unit tests for dashboardReducer
 * ARCHITECTURE: Pure function tests — no React mounting, no Ink dependency
 * Pattern: Each test verifies a single action type produces correct state
 */

import { describe, expect, it } from 'vitest';
import {
  type DashboardAction,
  type DashboardState,
  dashboardReducer,
} from '../../../../src/cli/dashboard/nav-reducer.js';
import type { NavState, ViewState } from '../../../../src/cli/dashboard/types.js';
import { createInitialWorkspaceNavState } from '../../../../src/cli/dashboard/workspace-types.js';

// ============================================================================
// Fixtures
// ============================================================================

const INITIAL_NAV: NavState = {
  focusedPanel: 'tasks',
  selectedIndices: { loops: 0, tasks: 0, schedules: 0, orchestrations: 0, pipelines: 0 },
  filters: { loops: null, tasks: null, schedules: null, orchestrations: null, pipelines: null },
  scrollOffsets: { loops: 0, tasks: 0, schedules: 0, orchestrations: 0, pipelines: 0 },
  activityFocused: false,
  activitySelectedIndex: 0,
  orchestrationChildSelectedTaskId: null,
  orchestrationChildPage: 0,
};

function makeState(overrides: Partial<DashboardState> = {}): DashboardState {
  return {
    view: { kind: 'main' },
    nav: INITIAL_NAV,
    workspaceNav: createInitialWorkspaceNavState(),
    animFrame: 0,
    ...overrides,
  };
}

// ============================================================================
// SET_VIEW
// ============================================================================

describe('SET_VIEW', () => {
  it('transitions view to workspace', () => {
    const state = makeState();
    const next = dashboardReducer(state, { type: 'SET_VIEW', view: { kind: 'workspace' } });
    expect(next.view).toEqual({ kind: 'workspace' });
  });

  it('transitions view to detail', () => {
    const state = makeState();
    const next = dashboardReducer(state, {
      type: 'SET_VIEW',
      view: { kind: 'detail', entityType: 'tasks', entityId: 'task-abc' as never, returnTo: 'main' },
    });
    expect(next.view.kind).toBe('detail');
  });

  it('does not mutate other state slices', () => {
    const state = makeState();
    const next = dashboardReducer(state, { type: 'SET_VIEW', view: { kind: 'workspace' } });
    expect(next.nav).toBe(state.nav); // referential equality — not re-created
    expect(next.animFrame).toBe(state.animFrame);
  });
});

// ============================================================================
// SET_NAV
// ============================================================================

describe('SET_NAV', () => {
  it('replaces nav state entirely', () => {
    const state = makeState();
    const newNav: NavState = { ...INITIAL_NAV, focusedPanel: 'tasks' };
    const next = dashboardReducer(state, { type: 'SET_NAV', nav: newNav });
    expect(next.nav.focusedPanel).toBe('tasks');
  });

  it('does not mutate view or workspaceNav', () => {
    const state = makeState({ view: { kind: 'workspace' } });
    const next = dashboardReducer(state, { type: 'SET_NAV', nav: { ...INITIAL_NAV, focusedPanel: 'schedules' } });
    expect(next.view).toBe(state.view);
    expect(next.workspaceNav).toBe(state.workspaceNav);
  });
});

// ============================================================================
// UPDATE_NAV
// ============================================================================

describe('UPDATE_NAV', () => {
  it('applies updater function to current nav', () => {
    const state = makeState();
    const next = dashboardReducer(state, {
      type: 'UPDATE_NAV',
      updater: (prev) => ({ ...prev, focusedPanel: 'orchestrations' }),
    });
    expect(next.nav.focusedPanel).toBe('orchestrations');
  });

  it('updater receives current nav state (not stale)', () => {
    const state = makeState({ nav: { ...INITIAL_NAV, activityFocused: true } });
    const next = dashboardReducer(state, {
      type: 'UPDATE_NAV',
      updater: (prev) => ({ ...prev, activityFocused: false }),
    });
    expect(next.nav.activityFocused).toBe(false);
  });
});

// ============================================================================
// SET_WORKSPACE_NAV
// ============================================================================

describe('SET_WORKSPACE_NAV', () => {
  it('replaces workspaceNav', () => {
    const state = makeState();
    const newWsNav = { ...createInitialWorkspaceNavState(), focusedPanelIndex: 2 };
    const next = dashboardReducer(state, { type: 'SET_WORKSPACE_NAV', workspaceNav: newWsNav });
    expect(next.workspaceNav.focusedPanelIndex).toBe(2);
  });
});

// ============================================================================
// UPDATE_WORKSPACE_NAV
// ============================================================================

describe('UPDATE_WORKSPACE_NAV', () => {
  it('applies updater function to current workspaceNav', () => {
    const state = makeState();
    const next = dashboardReducer(state, {
      type: 'UPDATE_WORKSPACE_NAV',
      updater: (prev) => ({ ...prev, gridPage: 3 }),
    });
    expect(next.workspaceNav.gridPage).toBe(3);
  });
});

// ============================================================================
// TICK_ANIM
// ============================================================================

describe('TICK_ANIM', () => {
  it('increments animFrame by 1', () => {
    const state = makeState({ animFrame: 5 });
    const next = dashboardReducer(state, { type: 'TICK_ANIM' });
    expect(next.animFrame).toBe(6);
  });

  it('does not affect other state slices', () => {
    const state = makeState({ animFrame: 0 });
    const next = dashboardReducer(state, { type: 'TICK_ANIM' });
    expect(next.view).toBe(state.view);
    expect(next.nav).toBe(state.nav);
    expect(next.workspaceNav).toBe(state.workspaceNav);
  });

  it('accumulates over multiple ticks', () => {
    let state = makeState({ animFrame: 0 });
    for (let i = 0; i < 4; i++) {
      state = dashboardReducer(state, { type: 'TICK_ANIM' });
    }
    expect(state.animFrame).toBe(4);
  });
});

// ============================================================================
// Immutability
// ============================================================================

describe('immutability', () => {
  it('returns a new object reference on every action', () => {
    const state = makeState();
    const next = dashboardReducer(state, { type: 'TICK_ANIM' });
    expect(next).not.toBe(state);
  });

  it('preserves reference for unchanged slices (structural sharing)', () => {
    const state = makeState();
    const next = dashboardReducer(state, { type: 'TICK_ANIM' });
    // Only animFrame changed — nav and workspaceNav should be same reference
    expect(next.nav).toBe(state.nav);
    expect(next.workspaceNav).toBe(state.workspaceNav);
  });
});
