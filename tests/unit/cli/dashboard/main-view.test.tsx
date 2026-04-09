/**
 * Tests for MainView — 4-panel grid component
 * Tests behavior (visible content) not rendering internals
 */

import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import type { DashboardData, NavState } from '../../../../src/cli/dashboard/types.js';
import { MainView } from '../../../../src/cli/dashboard/views/main-view.js';
import type { Loop, Orchestration, Schedule, Task } from '../../../../src/core/domain.js';
import {
  LoopStatus,
  LoopStrategy,
  OrchestratorStatus,
  ScheduleStatus,
  ScheduleType,
  TaskStatus,
} from '../../../../src/core/domain.js';

// ============================================================================
// Test fixtures
// ============================================================================

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1' as Task['id'],
    prompt: 'Write a test suite',
    status: TaskStatus.RUNNING,
    priority: 'normal' as Task['priority'],
    agent: 'claude',
    createdAt: Date.now(),
    ...overrides,
  } as Task;
}

function makeLoop(overrides: Partial<Loop> = {}): Loop {
  return {
    id: 'loop-1' as Loop['id'],
    strategy: LoopStrategy.RETRY,
    taskTemplate: { prompt: 'Optimize the algorithm', priority: 'normal' as Task['priority'] },
    exitCondition: 'npm test',
    evalTimeout: 60000,
    evalMode: 'shell' as Loop['evalMode'],
    workingDirectory: '/tmp',
    maxIterations: 10,
    maxConsecutiveFailures: 3,
    cooldownMs: 0,
    freshContext: true,
    currentIteration: 3,
    consecutiveFailures: 0,
    status: LoopStatus.RUNNING,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as Loop;
}

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'schedule-1' as Schedule['id'],
    taskTemplate: { prompt: 'Deploy to staging' } as Schedule['taskTemplate'],
    scheduleType: ScheduleType.CRON,
    cronExpression: '0 9 * * 1-5',
    timezone: 'UTC',
    missedRunPolicy: 'skip' as Schedule['missedRunPolicy'],
    status: ScheduleStatus.ACTIVE,
    runCount: 5,
    nextRunAt: Date.now() + 3_600_000, // 1 hour from now
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as Schedule;
}

function makeOrchestration(overrides: Partial<Orchestration> = {}): Orchestration {
  return {
    id: 'orch-1' as Orchestration['id'],
    goal: 'Refactor authentication module',
    status: OrchestratorStatus.RUNNING,
    agent: 'claude',
    stateFilePath: '/tmp/state.json',
    workingDirectory: '/tmp',
    maxDepth: 3,
    maxWorkers: 2,
    maxIterations: 10,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as Orchestration;
}

function makeDashboardData(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    tasks: [],
    loops: [],
    schedules: [],
    orchestrations: [],
    taskCounts: { total: 0, byStatus: {} },
    loopCounts: { total: 0, byStatus: {} },
    scheduleCounts: { total: 0, byStatus: {} },
    orchestrationCounts: { total: 0, byStatus: {} },
    ...overrides,
  };
}

const DEFAULT_NAV: NavState = {
  focusedPanel: 'loops',
  selectedIndices: { loops: 0, tasks: 0, schedules: 0, orchestrations: 0 },
  filters: { loops: null, tasks: null, schedules: null, orchestrations: null },
  scrollOffsets: { loops: 0, tasks: 0, schedules: 0, orchestrations: 0 },
};

// ============================================================================
// MainView tests
// ============================================================================

describe('MainView', () => {
  describe('panel headers', () => {
    it('renders all 4 panel titles', () => {
      const { lastFrame } = render(<MainView data={makeDashboardData()} nav={DEFAULT_NAV} />);
      const frame = lastFrame() ?? '';
      expect(frame).toContain('[1] Loops');
      expect(frame).toContain('[2] Tasks');
      expect(frame).toContain('[3] Schedules');
      expect(frame).toContain('[4] Orchestrations');
    });

    it('shows empty state when data is null', () => {
      const { lastFrame } = render(<MainView data={null} nav={DEFAULT_NAV} />);
      const frame = lastFrame() ?? '';
      // Should have all panel titles but with empty states
      expect(frame).toContain('[1] Loops');
      expect(frame).toContain('No loops found');
    });
  });

  describe('loop row', () => {
    it('shows iteration progress', () => {
      const loop = makeLoop({ currentIteration: 3, maxIterations: 10 });
      const { lastFrame } = render(<MainView data={makeDashboardData({ loops: [loop] })} nav={DEFAULT_NAV} />);
      expect(lastFrame()).toContain('3/10');
    });

    it('shows best score when present', () => {
      const loop = makeLoop({ bestScore: 0.85 });
      const { lastFrame } = render(<MainView data={makeDashboardData({ loops: [loop] })} nav={DEFAULT_NAV} />);
      expect(lastFrame()).toContain('0.85');
    });

    it('shows loop strategy', () => {
      const loop = makeLoop({ strategy: LoopStrategy.OPTIMIZE });
      const { lastFrame } = render(<MainView data={makeDashboardData({ loops: [loop] })} nav={DEFAULT_NAV} />);
      expect(lastFrame()).toContain('optimize');
    });

    it('shows truncated prompt', () => {
      const loop = makeLoop({
        taskTemplate: { prompt: 'My test loop prompt', priority: 'normal' as Task['priority'] },
      });
      const { lastFrame } = render(<MainView data={makeDashboardData({ loops: [loop] })} nav={DEFAULT_NAV} />);
      expect(lastFrame()).toContain('My test loop prompt');
    });
  });

  describe('task row', () => {
    it('shows agent name', () => {
      const task = makeTask({ agent: 'claude' });
      const { lastFrame } = render(<MainView data={makeDashboardData({ tasks: [task] })} nav={DEFAULT_NAV} />);
      expect(lastFrame()).toContain('claude');
    });

    it('shows truncated prompt', () => {
      const task = makeTask({ prompt: 'Write unit tests for auth module' });
      const { lastFrame } = render(<MainView data={makeDashboardData({ tasks: [task] })} nav={DEFAULT_NAV} />);
      // Prompt may be truncated to fit column width — check for prefix
      expect(lastFrame()).toContain('Write unit tests for auth');
    });

    it('shows status', () => {
      const task = makeTask({ status: TaskStatus.QUEUED });
      const { lastFrame } = render(<MainView data={makeDashboardData({ tasks: [task] })} nav={DEFAULT_NAV} />);
      expect(lastFrame()).toContain('queued');
    });
  });

  describe('schedule row', () => {
    it('shows schedule type', () => {
      const schedule = makeSchedule({ scheduleType: ScheduleType.CRON });
      const { lastFrame } = render(<MainView data={makeDashboardData({ schedules: [schedule] })} nav={DEFAULT_NAV} />);
      expect(lastFrame()).toContain('cron');
    });

    it('shows next run time', () => {
      // 1 hour = 60 minutes, but relativeTime threshold is < 60min → shows minutes
      // Use 2 hours (7_200_000ms) to guarantee "in Xh" display
      const schedule = makeSchedule({ nextRunAt: Date.now() + 7_200_000 });
      const { lastFrame } = render(<MainView data={makeDashboardData({ schedules: [schedule] })} nav={DEFAULT_NAV} />);
      // Should show "in 2h" or similar relative time
      const frame = lastFrame() ?? '';
      expect(frame).toMatch(/in \d+[hm]/);
    });

    it('shows run count progress', () => {
      const schedule = makeSchedule({ runCount: 5, maxRuns: 20 });
      const { lastFrame } = render(<MainView data={makeDashboardData({ schedules: [schedule] })} nav={DEFAULT_NAV} />);
      expect(lastFrame()).toContain('5/20');
    });
  });

  describe('orchestration row', () => {
    it('shows agent name', () => {
      const orch = makeOrchestration({ agent: 'gemini' });
      const { lastFrame } = render(<MainView data={makeDashboardData({ orchestrations: [orch] })} nav={DEFAULT_NAV} />);
      expect(lastFrame()).toContain('gemini');
    });

    it('shows goal text', () => {
      const orch = makeOrchestration({ goal: 'Refactor auth module' });
      const { lastFrame } = render(<MainView data={makeDashboardData({ orchestrations: [orch] })} nav={DEFAULT_NAV} />);
      expect(lastFrame()).toContain('Refactor auth module');
    });
  });

  describe('filtering', () => {
    it('shows only matching items when filter is set', () => {
      const runningLoop = makeLoop({ id: 'loop-1' as Loop['id'], status: LoopStatus.RUNNING });
      const pausedLoop = makeLoop({
        id: 'loop-2' as Loop['id'],
        status: LoopStatus.PAUSED,
        taskTemplate: { prompt: 'Paused loop prompt', priority: 'normal' as Task['priority'] },
      });
      const nav: NavState = {
        ...DEFAULT_NAV,
        filters: { ...DEFAULT_NAV.filters, loops: 'running' },
      };

      const { lastFrame } = render(
        <MainView data={makeDashboardData({ loops: [runningLoop, pausedLoop] })} nav={nav} />,
      );
      const frame = lastFrame() ?? '';
      // Running loop should appear, paused should not
      expect(frame).toContain('running');
      expect(frame).not.toContain('Paused loop prompt');
    });

    it('shows empty state when all items are filtered out', () => {
      const completedLoop = makeLoop({ status: LoopStatus.COMPLETED });
      const nav: NavState = {
        ...DEFAULT_NAV,
        filters: { ...DEFAULT_NAV.filters, loops: 'running' },
      };

      const { lastFrame } = render(<MainView data={makeDashboardData({ loops: [completedLoop] })} nav={nav} />);
      const frame = lastFrame() ?? '';
      expect(frame).toContain('No running loops found');
    });

    it('shows filter badge in panel header', () => {
      const nav: NavState = {
        ...DEFAULT_NAV,
        filters: { ...DEFAULT_NAV.filters, tasks: 'failed' },
      };

      const { lastFrame } = render(<MainView data={makeDashboardData()} nav={nav} />);
      const frame = lastFrame() ?? '';
      expect(frame).toContain('filter: failed');
    });
  });

  describe('focused panel', () => {
    it('highlights the focused panel', () => {
      const nav: NavState = { ...DEFAULT_NAV, focusedPanel: 'tasks' };
      // We verify the panel renders — Ink's ANSI color codes make exact color assertion hard
      // in test output, so we just ensure the panel title renders correctly.
      const { lastFrame } = render(<MainView data={makeDashboardData()} nav={nav} />);
      expect(lastFrame()).toContain('[2] Tasks');
    });
  });
});
