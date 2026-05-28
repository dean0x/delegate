/**
 * Unit tests for keyboard/helpers.ts pure functions.
 * ARCHITECTURE: Pure functions — no I/O, no side effects, no mocks needed.
 * Tests cover all 6 panel types for getPanelItems and panelToEntityKind,
 * and all edge cases (null, not found, found) for resolveMemberIndex.
 */

import { describe, expect, it } from 'vitest';
import {
  getPanelItems,
  panelToEntityKind,
  resolveMemberIndex,
} from '../../../../src/cli/dashboard/keyboard/helpers.js';
import type { DashboardData } from '../../../../src/cli/dashboard/types.js';

// ============================================================================
// Test helpers
// ============================================================================

const EMPTY_COUNTS = { total: 0, byStatus: {} };

function makeData(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    tasks: [],
    loops: [],
    schedules: [],
    orchestrations: [],
    pipelines: [],
    channels: [],
    taskCounts: EMPTY_COUNTS,
    loopCounts: EMPTY_COUNTS,
    scheduleCounts: EMPTY_COUNTS,
    orchestrationCounts: EMPTY_COUNTS,
    pipelineCounts: EMPTY_COUNTS,
    channelCounts: EMPTY_COUNTS,
    ...overrides,
  };
}

// ============================================================================
// getPanelItems
// ============================================================================

describe('getPanelItems()', () => {
  const item = (id: string, status: string) => ({ id, status: { toString: () => status } as never });

  it('returns tasks for tasks panel', () => {
    const data = makeData({ tasks: [item('t1', 'running')] as never });
    const result = getPanelItems('tasks', data);
    expect(result).toEqual([{ id: 't1', status: 'running' }]);
  });

  it('returns loops for loops panel', () => {
    const data = makeData({ loops: [item('l1', 'paused')] as never });
    const result = getPanelItems('loops', data);
    expect(result).toEqual([{ id: 'l1', status: 'paused' }]);
  });

  it('returns schedules for schedules panel', () => {
    const data = makeData({ schedules: [item('s1', 'active')] as never });
    const result = getPanelItems('schedules', data);
    expect(result).toEqual([{ id: 's1', status: 'active' }]);
  });

  it('returns orchestrations for orchestrations panel', () => {
    const data = makeData({ orchestrations: [item('o1', 'running')] as never });
    const result = getPanelItems('orchestrations', data);
    expect(result).toEqual([{ id: 'o1', status: 'running' }]);
  });

  it('returns pipelines for pipelines panel', () => {
    const data = makeData({ pipelines: [item('p1', 'completed')] as never });
    const result = getPanelItems('pipelines', data);
    expect(result).toEqual([{ id: 'p1', status: 'completed' }]);
  });

  it('returns channels for channels panel', () => {
    const data = makeData({ channels: [item('c1', 'active')] as never });
    const result = getPanelItems('channels', data);
    expect(result).toEqual([{ id: 'c1', status: 'active' }]);
  });

  it('returns empty array when panel has no items', () => {
    const data = makeData();
    expect(getPanelItems('tasks', data)).toEqual([]);
    expect(getPanelItems('channels', data)).toEqual([]);
  });
});

// ============================================================================
// panelToEntityKind
// ============================================================================

describe('panelToEntityKind()', () => {
  it('maps tasks -> task', () => {
    expect(panelToEntityKind('tasks')).toBe('task');
  });

  it('maps loops -> loop', () => {
    expect(panelToEntityKind('loops')).toBe('loop');
  });

  it('maps schedules -> schedule', () => {
    expect(panelToEntityKind('schedules')).toBe('schedule');
  });

  it('maps orchestrations -> orchestration', () => {
    expect(panelToEntityKind('orchestrations')).toBe('orchestration');
  });

  it('maps pipelines -> pipeline', () => {
    expect(panelToEntityKind('pipelines')).toBe('pipeline');
  });

  it('maps channels -> channel', () => {
    expect(panelToEntityKind('channels')).toBe('channel');
  });
});

// ============================================================================
// resolveMemberIndex
// ============================================================================

describe('resolveMemberIndex()', () => {
  const members = [{ name: 'alice' }, { name: 'bob' }, { name: 'carol' }];

  it('returns 0 when selectedName is null', () => {
    expect(resolveMemberIndex(null, members)).toBe(0);
  });

  it('returns 0 when selectedName is null and members array is empty', () => {
    expect(resolveMemberIndex(null, [])).toBe(0);
  });

  it('returns correct index when name is found', () => {
    expect(resolveMemberIndex('alice', members)).toBe(0);
    expect(resolveMemberIndex('bob', members)).toBe(1);
    expect(resolveMemberIndex('carol', members)).toBe(2);
  });

  it('returns 0 when selectedName is not found in members', () => {
    expect(resolveMemberIndex('unknown', members)).toBe(0);
  });

  it('returns 0 when selectedName is not found and members array is empty', () => {
    expect(resolveMemberIndex('alice', [])).toBe(0);
  });

  it('does not match empty string to null — returns 0 for not-found empty string', () => {
    // resolveMemberIndex uses === null check (not !selectedName), so empty string is treated
    // as a valid search key that simply will not match any member name.
    expect(resolveMemberIndex('', members)).toBe(0);
  });
});
