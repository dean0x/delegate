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

// ============================================================================
// Fixtures
// ============================================================================

const INITIAL_NAV: NavState = {
  focusedPanel: 'tasks',
  selectedIndices: { loops: 0, tasks: 0, schedules: 0, orchestrations: 0, pipelines: 0 },
  filters: { loops: null, tasks: null, schedules: null, orchestrations: null, pipelines: null },
  scrollOffsets: { loops: 0, tasks: 0, schedules: 0, orchestrations: 0, pipelines: 0 },
  orchestrationChildSelectedTaskId: null,
  orchestrationChildPage: 0,
  detailOutputVisible: true,
  detailOutputAutoTail: true,
  detailOutputScrollOffset: 0,
  loopIterationSelectedNumber: null,
};

function makeState(overrides: Partial<DashboardState> = {}): DashboardState {
  return {
    view: { kind: 'main' },
    nav: INITIAL_NAV,
    animFrame: 0,
    ...overrides,
  };
}

// ============================================================================
// SET_VIEW
// ============================================================================

describe('SET_VIEW', () => {
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
    const next = dashboardReducer(state, {
      type: 'SET_VIEW',
      view: { kind: 'detail', entityType: 'tasks', entityId: 'task-abc' as never, returnTo: 'main' },
    });
    expect(next.nav).toBe(state.nav);
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

  it('does not mutate view', () => {
    const state = makeState();
    const next = dashboardReducer(state, { type: 'SET_NAV', nav: { ...INITIAL_NAV, focusedPanel: 'schedules' } });
    expect(next.view).toBe(state.view);
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
    const state = makeState({ nav: { ...INITIAL_NAV, focusedPanel: 'loops' } });
    const next = dashboardReducer(state, {
      type: 'UPDATE_NAV',
      updater: (prev) => ({ ...prev, focusedPanel: 'tasks' }),
    });
    expect(next.nav.focusedPanel).toBe('tasks');
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
    expect(next.nav).toBe(state.nav);
  });
});

// ============================================================================
// NavState new fields — output state + loop iteration (#165 + #168)
// ============================================================================

describe('NavState — new output + iteration fields', () => {
  it('SET_VIEW to detail does NOT reset detailOutputVisible', () => {
    const state = makeState({
      nav: { ...INITIAL_NAV, detailOutputVisible: false, detailOutputAutoTail: false },
    });
    const next = dashboardReducer(state, {
      type: 'SET_VIEW',
      view: { kind: 'detail', entityType: 'tasks', entityId: 'task-1' as never, returnTo: 'main' },
    });
    expect(next.nav.detailOutputVisible).toBe(false);
    expect(next.nav.detailOutputAutoTail).toBe(false);
  });

  it('SET_VIEW to detail does NOT reset loopIterationSelectedNumber', () => {
    const state = makeState({
      nav: { ...INITIAL_NAV, loopIterationSelectedNumber: 5 },
    });
    const next = dashboardReducer(state, {
      type: 'SET_VIEW',
      view: { kind: 'detail', entityType: 'loops', entityId: 'loop-1' as never, returnTo: 'main' },
    });
    expect(next.nav.loopIterationSelectedNumber).toBe(5);
  });

  it('SET_VIEW preserves all nav state fields', () => {
    const customNav: NavState = {
      ...INITIAL_NAV,
      detailOutputVisible: false,
      detailOutputAutoTail: false,
      detailOutputScrollOffset: 7,
      loopIterationSelectedNumber: 3,
    };
    const state = makeState({ nav: customNav });
    const next = dashboardReducer(state, { type: 'SET_VIEW', view: { kind: 'main' } });
    expect(next.nav).toBe(customNav);
  });

  it('UPDATE_NAV can update detailOutputVisible', () => {
    const state = makeState({ nav: { ...INITIAL_NAV, detailOutputVisible: true } });
    const next = dashboardReducer(state, {
      type: 'UPDATE_NAV',
      updater: (prev) => ({ ...prev, detailOutputVisible: false }),
    });
    expect(next.nav.detailOutputVisible).toBe(false);
  });

  it('UPDATE_NAV can update loopIterationSelectedNumber', () => {
    const state = makeState({ nav: { ...INITIAL_NAV, loopIterationSelectedNumber: null } });
    const next = dashboardReducer(state, {
      type: 'UPDATE_NAV',
      updater: (prev) => ({ ...prev, loopIterationSelectedNumber: 7 }),
    });
    expect(next.nav.loopIterationSelectedNumber).toBe(7);
  });

  it('UPDATE_NAV can update detailOutputScrollOffset', () => {
    const state = makeState({ nav: { ...INITIAL_NAV, detailOutputScrollOffset: 0 } });
    const next = dashboardReducer(state, {
      type: 'UPDATE_NAV',
      updater: (prev) => ({ ...prev, detailOutputScrollOffset: 5 }),
    });
    expect(next.nav.detailOutputScrollOffset).toBe(5);
  });
});
