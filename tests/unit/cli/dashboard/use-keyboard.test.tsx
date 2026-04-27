/**
 * Tests for useKeyboard hook — core navigation behaviors.
 *
 * Strategy: mount a minimal wrapper component that owns view/nav state,
 * renders nav state as text, and lets us assert on visible output after
 * simulating keypresses via stdin.
 *
 * We test behaviors, not implementation:
 *  - Tab cycles panels forward; Shift+Tab cycles backward
 *  - Arrow keys / j/k move selection; scroll follows
 *  - 1-4 jump directly to panels
 *  - Enter drills into detail view; Escape returns to main
 *  - f cycles filter for the focused panel
 *  - q calls exit; r calls refreshNow
 *
 * NOTE: Ink's useInput dispatches state updates via React's scheduler (microtask
 * queue). After each stdin.write() we must flush pending microtasks so the
 * component re-renders before asserting.
 */

import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import React, { useCallback, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type {
  DashboardData,
  DashboardMutationContext,
  NavState,
  ViewState,
} from '../../../../src/cli/dashboard/types.js';
import { useKeyboard } from '../../../../src/cli/dashboard/use-keyboard.js';
import { createInitialWorkspaceNavState } from '../../../../src/cli/dashboard/workspace-types.js';
import type {
  Loop,
  LoopId,
  Orchestration,
  OrchestratorChild,
  OrchestratorId,
  Schedule,
  ScheduleId,
  Task,
  TaskId,
} from '../../../../src/core/domain.js';
import {
  LoopStatus,
  LoopStrategy,
  OrchestratorStatus,
  ScheduleStatus,
  ScheduleType,
  TaskStatus,
} from '../../../../src/core/domain.js';

// ============================================================================
// Fixtures
// ============================================================================

function makeTask(id: string, status: TaskStatus = TaskStatus.RUNNING): Task {
  return {
    id: id as Task['id'],
    prompt: `Prompt for ${id}`,
    status,
    priority: 'normal' as Task['priority'],
    agent: 'claude',
    createdAt: Date.now(),
  } as Task;
}

function makeSchedule(id: string, status: ScheduleStatus = ScheduleStatus.ACTIVE): Schedule {
  return {
    id: id as Schedule['id'],
    taskTemplate: { prompt: 'Run task', priority: 'normal' as Task['priority'] },
    scheduleType: ScheduleType.CRON,
    cronExpression: '0 9 * * 1-5',
    timezone: 'UTC',
    missedRunPolicy: 'skip' as Schedule['missedRunPolicy'],
    status,
    runCount: 0,
    nextRunAt: Date.now() + 3_600_000,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as Schedule;
}

function makeOrchestratorChild(taskId: string, status: TaskStatus = TaskStatus.RUNNING): OrchestratorChild {
  return {
    taskId: taskId as TaskId,
    kind: 'direct',
    status,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    prompt: `Prompt for ${taskId}`,
    agent: 'claude',
  };
}

function makeOrchestration(id: string, status: OrchestratorStatus = OrchestratorStatus.RUNNING): Orchestration {
  return {
    id: id as Orchestration['id'],
    goal: `Goal for ${id}`,
    status,
    agent: 'claude',
    stateFilePath: '/tmp/state.json',
    workingDirectory: '/tmp',
    maxDepth: 3,
    maxWorkers: 2,
    maxIterations: 10,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as Orchestration;
}

function makeLoop(id: string, status: LoopStatus = LoopStatus.RUNNING): Loop {
  return {
    id: id as Loop['id'],
    strategy: LoopStrategy.RETRY,
    taskTemplate: { prompt: 'Run test', priority: 'normal' as Task['priority'] },
    exitCondition: 'true',
    evalTimeout: 60_000,
    evalMode: 'shell' as Loop['evalMode'],
    workingDirectory: '/tmp',
    maxIterations: 10,
    maxConsecutiveFailures: 3,
    cooldownMs: 0,
    freshContext: false,
    currentIteration: 1,
    consecutiveFailures: 0,
    status,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as Loop;
}

function makeDashboardData(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    tasks: [],
    loops: [],
    schedules: [],
    orchestrations: [],
    pipelines: [],
    taskCounts: { total: 0, byStatus: {} },
    loopCounts: { total: 0, byStatus: {} },
    scheduleCounts: { total: 0, byStatus: {} },
    orchestrationCounts: { total: 0, byStatus: {} },
    pipelineCounts: { total: 0, byStatus: {} },
    ...overrides,
  };
}

const INITIAL_NAV: NavState = {
  focusedPanel: 'loops',
  selectedIndices: { loops: 0, tasks: 0, schedules: 0, orchestrations: 0, pipelines: 0 },
  filters: { loops: null, tasks: null, schedules: null, orchestrations: null, pipelines: null },
  scrollOffsets: { loops: 0, tasks: 0, schedules: 0, orchestrations: 0, pipelines: 0 },
  activityFocused: false,
  activitySelectedIndex: 0,
  orchestrationChildSelectedTaskId: null,
  orchestrationChildPage: 0,
};

// ============================================================================
// Test wrapper component
// ============================================================================

interface WrapperProps {
  readonly initialData?: DashboardData;
  readonly initialNav?: NavState;
  readonly initialView?: ViewState;
  readonly onExit?: () => void;
  readonly onRefresh?: () => void;
  readonly mutations?: DashboardMutationContext;
}

/**
 * Minimal wrapper that owns view/nav state, mounts useKeyboard, and renders
 * enough text for assertions. Only renders state — no visual chrome.
 */
function KeyboardWrapper({
  initialData,
  initialNav = INITIAL_NAV,
  initialView = { kind: 'main' },
  onExit,
  onRefresh,
  mutations,
}: WrapperProps): React.ReactElement {
  const [view, setView] = useState<ViewState>(initialView);
  const [nav, setNav] = useState<NavState>(initialNav);
  const [workspaceNav, setWorkspaceNav] = useState(createInitialWorkspaceNavState());
  const data = initialData ?? makeDashboardData();

  const exit = useCallback(() => onExit?.(), [onExit]);
  const refreshNow = useCallback(() => onRefresh?.(), [onRefresh]);

  useKeyboard({ view, nav, data, setView, setNav, refreshNow, exit, mutations, workspaceNav, setWorkspaceNav });

  return (
    <Box flexDirection="column">
      <Text>view:{view.kind}</Text>
      {view.kind === 'detail' && (
        <Text>
          detail-type:{view.entityType} detail-id:{view.entityId}
        </Text>
      )}
      <Text>panel:{nav.focusedPanel}</Text>
      <Text>activity-focused:{nav.activityFocused ? 'true' : 'false'}</Text>
      <Text>activity-sel:{nav.activitySelectedIndex}</Text>
      <Text>sel-loops:{nav.selectedIndices.loops}</Text>
      <Text>sel-tasks:{nav.selectedIndices.tasks}</Text>
      <Text>filter-loops:{nav.filters.loops ?? 'null'}</Text>
      <Text>filter-tasks:{nav.filters.tasks ?? 'null'}</Text>
      <Text>scroll-loops:{nav.scrollOffsets.loops}</Text>
      <Text>orch-child-sel:{nav.orchestrationChildSelectedTaskId ?? 'null'}</Text>
      <Text>orch-child-page:{nav.orchestrationChildPage}</Text>
    </Box>
  );
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Write a key to stdin and flush React's pending state updates.
 *
 * Ink dispatches state updates from useInput via React's scheduler (microtask
 * queue). We need to flush those updates before asserting on the rendered frame.
 *
 * CI-safe strategy: flush microtasks, then wait for a macrotask, then flush
 * microtasks again. This ensures React's commit phase and ink's effect-based
 * re-registration of useInput both complete before the next press. A 10ms
 * timer is generous enough to cover ink's internal escape-sequence debounce
 * on Linux CI runners while still keeping tests fast.
 */
async function press(stdin: { write: (s: string) => void }, key: string): Promise<void> {
  stdin.write(key);
  // Flush microtasks (React scheduler)
  await Promise.resolve();
  // Macrotask — allows useEffect and ink's internal scheduling to run.
  // 10ms covers ink's escape-sequence debounce on Linux CI runners.
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  // Flush any microtasks queued during the macrotask
  await Promise.resolve();
}

// ============================================================================
// Tab / panel cycling
// ============================================================================

describe('useKeyboard — Tab panel cycling', () => {
  it('Tab moves focus forward from loops → schedules', async () => {
    const { lastFrame, stdin } = render(<KeyboardWrapper />);
    expect(lastFrame()).toContain('panel:loops');
    await press(stdin, '\t');
    expect(lastFrame()).toContain('panel:schedules');
  });

  it('Tab cycles all the way around: loops → schedules → orchestrations → pipelines → activity → tasks → loops', async () => {
    // INITIAL_NAV starts at loops. PANEL_ORDER is tasks/loops/schedules/orchestrations/pipelines.
    // From loops (index 1): Tab → schedules(2) → orchestrations(3) → pipelines(4) → activity → tasks(0) → loops(1)
    const { lastFrame, stdin } = render(<KeyboardWrapper />);
    await press(stdin, '\t'); // → schedules
    await press(stdin, '\t'); // → orchestrations
    await press(stdin, '\t'); // → pipelines
    await press(stdin, '\t'); // → activity (end of list)
    expect(lastFrame()).toContain('activity-focused:true');
    await press(stdin, '\t'); // → tasks (wrap)
    expect(lastFrame()).toContain('panel:tasks');
    expect(lastFrame()).toContain('activity-focused:false');
  });

  it('Shift+Tab cycles backward from loops → tasks', async () => {
    const { lastFrame, stdin } = render(<KeyboardWrapper />);
    expect(lastFrame()).toContain('panel:loops');
    // Shift+Tab is ESC[Z in VT100 — from loops (index 1) → tasks (index 0)
    await press(stdin, '\x1B[Z');
    expect(lastFrame()).toContain('panel:tasks');
  });

  it('Shift+Tab from tasks → activity focus', async () => {
    // tasks is the first panel (index 0) — Shift+Tab wraps to activity
    const { lastFrame, stdin } = render(<KeyboardWrapper initialNav={{ ...INITIAL_NAV, focusedPanel: 'tasks' }} />);
    expect(lastFrame()).toContain('panel:tasks');
    await press(stdin, '\x1B[Z');
    expect(lastFrame()).toContain('activity-focused:true');
  });

  it('Shift+Tab from activity focus → pipelines panel (last panel)', async () => {
    const { lastFrame, stdin } = render(<KeyboardWrapper initialNav={{ ...INITIAL_NAV, activityFocused: true }} />);
    expect(lastFrame()).toContain('activity-focused:true');
    await press(stdin, '\x1B[Z');
    expect(lastFrame()).toContain('panel:pipelines');
    expect(lastFrame()).toContain('activity-focused:false');
  });
});

// ============================================================================
// Panel jump keys 1-4
// ============================================================================

describe('useKeyboard — panel jump keys', () => {
  it('pressing "1" jumps to tasks panel', async () => {
    const { lastFrame, stdin } = render(<KeyboardWrapper />);
    await press(stdin, '1');
    expect(lastFrame()).toContain('panel:tasks');
  });

  it('pressing "2" jumps to loops panel', async () => {
    const { lastFrame, stdin } = render(<KeyboardWrapper />);
    await press(stdin, '2');
    expect(lastFrame()).toContain('panel:loops');
  });

  it('pressing "3" jumps to schedules panel', async () => {
    const { lastFrame, stdin } = render(<KeyboardWrapper />);
    await press(stdin, '3');
    expect(lastFrame()).toContain('panel:schedules');
  });

  it('pressing "4" jumps to orchestrations panel', async () => {
    const { lastFrame, stdin } = render(<KeyboardWrapper />);
    await press(stdin, '4');
    expect(lastFrame()).toContain('panel:orchestrations');
  });

  it('pressing "5" jumps to pipelines panel', async () => {
    const { lastFrame, stdin } = render(<KeyboardWrapper />);
    await press(stdin, '5');
    expect(lastFrame()).toContain('panel:pipelines');
  });
});

// ============================================================================
// Arrow key selection movement
// ============================================================================

describe('useKeyboard — arrow key selection', () => {
  it('down arrow increments selection index', async () => {
    const data = makeDashboardData({
      loops: [makeLoop('loop-1'), makeLoop('loop-2'), makeLoop('loop-3')],
    });
    const { lastFrame, stdin } = render(<KeyboardWrapper initialData={data} />);
    expect(lastFrame()).toContain('sel-loops:0');
    await press(stdin, '\x1B[B'); // down arrow
    expect(lastFrame()).toContain('sel-loops:1');
  });

  it('up arrow decrements selection index', async () => {
    const data = makeDashboardData({
      loops: [makeLoop('loop-1'), makeLoop('loop-2'), makeLoop('loop-3')],
    });
    const { lastFrame, stdin } = render(
      <KeyboardWrapper
        initialData={data}
        initialNav={{ ...INITIAL_NAV, selectedIndices: { ...INITIAL_NAV.selectedIndices, loops: 2 } }}
      />,
    );
    expect(lastFrame()).toContain('sel-loops:2');
    await press(stdin, '\x1B[A'); // up arrow
    expect(lastFrame()).toContain('sel-loops:1');
  });

  it('down arrow does not exceed list length', async () => {
    // Only 1 loop — cannot go below index 0
    const data = makeDashboardData({
      loops: [makeLoop('loop-1')],
    });
    const { lastFrame, stdin } = render(<KeyboardWrapper initialData={data} />);
    await press(stdin, '\x1B[B'); // down — already at max
    expect(lastFrame()).toContain('sel-loops:0');
  });

  it('up arrow does not go below 0', async () => {
    const data = makeDashboardData({
      loops: [makeLoop('loop-1'), makeLoop('loop-2')],
    });
    const { lastFrame, stdin } = render(<KeyboardWrapper initialData={data} />);
    expect(lastFrame()).toContain('sel-loops:0');
    await press(stdin, '\x1B[A'); // up — already at min
    expect(lastFrame()).toContain('sel-loops:0');
  });

  it('"j" acts like down arrow', async () => {
    const data = makeDashboardData({
      loops: [makeLoop('loop-1'), makeLoop('loop-2')],
    });
    const { lastFrame, stdin } = render(<KeyboardWrapper initialData={data} />);
    await press(stdin, 'j');
    expect(lastFrame()).toContain('sel-loops:1');
  });

  it('"k" acts like up arrow', async () => {
    const data = makeDashboardData({
      loops: [makeLoop('loop-1'), makeLoop('loop-2')],
    });
    const { lastFrame, stdin } = render(
      <KeyboardWrapper
        initialData={data}
        initialNav={{ ...INITIAL_NAV, selectedIndices: { ...INITIAL_NAV.selectedIndices, loops: 1 } }}
      />,
    );
    await press(stdin, 'k');
    expect(lastFrame()).toContain('sel-loops:0');
  });

  it('selection is per-panel — moving loops does not affect tasks', async () => {
    const data = makeDashboardData({
      loops: [makeLoop('loop-1'), makeLoop('loop-2'), makeLoop('loop-3')],
      tasks: [makeTask('task-1'), makeTask('task-2')],
    });
    const { lastFrame, stdin } = render(<KeyboardWrapper initialData={data} />);
    await press(stdin, '\x1B[B'); // down on loops
    await press(stdin, '\x1B[B'); // down on loops
    expect(lastFrame()).toContain('sel-loops:2');
    expect(lastFrame()).toContain('sel-tasks:0'); // tasks unchanged
  });
});

// ============================================================================
// Enter — drill into detail view
// ============================================================================

describe('useKeyboard — Enter drill-in', () => {
  it('Enter on a loop item transitions to detail view', async () => {
    const loop = makeLoop('loop-abc');
    const data = makeDashboardData({ loops: [loop] });
    const { lastFrame, stdin } = render(<KeyboardWrapper initialData={data} />);
    expect(lastFrame()).toContain('view:main');
    await press(stdin, '\r'); // Enter
    expect(lastFrame()).toContain('view:detail');
    expect(lastFrame()).toContain('detail-type:loops');
    expect(lastFrame()).toContain('detail-id:loop-abc');
  });

  it('Enter on a task item transitions to detail view', async () => {
    const task = makeTask('task-xyz');
    const data = makeDashboardData({ tasks: [task] });
    const { lastFrame, stdin } = render(
      <KeyboardWrapper initialData={data} initialNav={{ ...INITIAL_NAV, focusedPanel: 'tasks' }} />,
    );
    await press(stdin, '\r');
    expect(lastFrame()).toContain('view:detail');
    expect(lastFrame()).toContain('detail-type:tasks');
    expect(lastFrame()).toContain('detail-id:task-xyz');
  });

  it('Enter does nothing when panel is empty', async () => {
    const { lastFrame, stdin } = render(<KeyboardWrapper />);
    await press(stdin, '\r');
    expect(lastFrame()).toContain('view:main'); // no transition
  });
});

// ============================================================================
// Escape — return to main view
// ============================================================================

describe('useKeyboard — Escape returns to main', () => {
  it('Escape from detail view returns to main', async () => {
    const loop = makeLoop('loop-1');
    const data = makeDashboardData({ loops: [loop] });
    const { lastFrame, stdin } = render(<KeyboardWrapper initialData={data} />);
    await press(stdin, '\r'); // enter detail
    expect(lastFrame()).toContain('view:detail');
    await press(stdin, '\x1B'); // Escape
    expect(lastFrame()).toContain('view:main');
  });
});

// ============================================================================
// f — filter cycling
// ============================================================================

describe('useKeyboard — filter cycling', () => {
  it('"f" advances the filter for the focused panel', async () => {
    const { lastFrame, stdin } = render(<KeyboardWrapper />);
    expect(lastFrame()).toContain('filter-loops:null');
    await press(stdin, 'f');
    // Loops cycle: null → running → paused → completed → failed → cancelled
    expect(lastFrame()).toContain('filter-loops:running');
  });

  it('"f" cycles back to null after going through all filters', async () => {
    const { lastFrame, stdin } = render(<KeyboardWrapper />);
    // Loops cycle has 6 entries (null + 5 statuses) — press 6 times to wrap around
    for (let i = 0; i < 6; i++) {
      await press(stdin, 'f');
    }
    expect(lastFrame()).toContain('filter-loops:null');
  });

  it('filter is per-panel — each panel cycles its own statuses', async () => {
    const { lastFrame, stdin } = render(<KeyboardWrapper />);
    await press(stdin, 'f'); // cycles loops filter → running
    expect(lastFrame()).toContain('filter-loops:running');
    expect(lastFrame()).toContain('filter-tasks:null'); // tasks unchanged
  });
});

// ============================================================================
// Global keys: q and r
// ============================================================================

describe('useKeyboard — global keys', () => {
  it('"q" calls the exit callback', async () => {
    const onExit = vi.fn();
    const { stdin } = render(<KeyboardWrapper onExit={onExit} />);
    await press(stdin, 'q');
    expect(onExit).toHaveBeenCalledOnce();
  });

  it('"r" calls the refreshNow callback', async () => {
    const onRefresh = vi.fn();
    const { stdin } = render(<KeyboardWrapper onRefresh={onRefresh} />);
    await press(stdin, 'r');
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it('"q" works from detail view too', async () => {
    const onExit = vi.fn();
    const loop = makeLoop('loop-1');
    const data = makeDashboardData({ loops: [loop] });
    const { stdin } = render(<KeyboardWrapper initialData={data} onExit={onExit} />);
    await press(stdin, '\r'); // enter detail
    await press(stdin, 'q');
    expect(onExit).toHaveBeenCalledOnce();
  });
});

// ============================================================================
// c/d keybindings — cancel and delete via mutation context
// ============================================================================

/**
 * Build a minimal DashboardMutationContext with vi.fn() stubs.
 * Each service method returns a resolved promise so async handlers complete.
 */
function makeMutations(): {
  mutations: DashboardMutationContext;
  cancelOrchestration: ReturnType<typeof vi.fn>;
  cancelLoop: ReturnType<typeof vi.fn>;
  cancelTask: ReturnType<typeof vi.fn>;
  cancelSchedule: ReturnType<typeof vi.fn>;
  deleteOrchestration: ReturnType<typeof vi.fn>;
  deleteLoop: ReturnType<typeof vi.fn>;
  deleteTask: ReturnType<typeof vi.fn>;
  deleteSchedule: ReturnType<typeof vi.fn>;
} {
  const cancelOrchestration = vi.fn().mockResolvedValue({ ok: true, value: undefined });
  const cancelLoop = vi.fn().mockResolvedValue({ ok: true, value: undefined });
  const cancelTask = vi.fn().mockResolvedValue({ ok: true, value: undefined });
  const cancelSchedule = vi.fn().mockResolvedValue({ ok: true, value: undefined });
  const deleteOrchestration = vi.fn().mockResolvedValue({ ok: true, value: undefined });
  const deleteLoop = vi.fn().mockResolvedValue({ ok: true, value: undefined });
  const deleteTask = vi.fn().mockResolvedValue({ ok: true, value: undefined });
  const deleteSchedule = vi.fn().mockResolvedValue({ ok: true, value: undefined });

  const mutations: DashboardMutationContext = {
    orchestrationService: {
      cancelOrchestration,
    } as unknown as DashboardMutationContext['orchestrationService'],
    loopService: {
      cancelLoop,
    } as unknown as DashboardMutationContext['loopService'],
    scheduleService: {
      cancelSchedule,
    } as unknown as DashboardMutationContext['scheduleService'],
    taskManager: {
      cancel: cancelTask,
    } as unknown as DashboardMutationContext['taskManager'],
    orchestrationRepo: {
      delete: deleteOrchestration,
    } as unknown as DashboardMutationContext['orchestrationRepo'],
    loopRepo: {
      delete: deleteLoop,
    } as unknown as DashboardMutationContext['loopRepo'],
    taskRepo: {
      delete: deleteTask,
    } as unknown as DashboardMutationContext['taskRepo'],
    scheduleRepo: {
      delete: deleteSchedule,
    } as unknown as DashboardMutationContext['scheduleRepo'],
  };

  return {
    mutations,
    cancelOrchestration,
    cancelLoop,
    cancelTask,
    cancelSchedule,
    deleteOrchestration,
    deleteLoop,
    deleteTask,
    deleteSchedule,
  };
}

describe('useKeyboard — c: cancel keybinding', () => {
  it('"c" cancels a running orchestration', async () => {
    const orch = makeOrchestration('orch-1', OrchestratorStatus.RUNNING);
    const data = makeDashboardData({
      orchestrations: [orch],
      orchestrationCounts: { total: 1, byStatus: { running: 1 } },
    });
    const nav: NavState = { ...INITIAL_NAV, focusedPanel: 'orchestrations' };
    const { mutations, cancelOrchestration } = makeMutations();
    const { stdin } = render(<KeyboardWrapper initialData={data} initialNav={nav} mutations={mutations} />);

    await press(stdin, 'c');
    // Allow async handler to complete
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    // Behavioral change (PR #133): main panel cancel now always cascades (cancelAttributedTasks: true)
    // to match activity and workspace views — consistent UX across all dashboard contexts.
    expect(cancelOrchestration).toHaveBeenCalledWith('orch-1', 'User cancelled via dashboard', {
      cancelAttributedTasks: true,
    });
  });

  it('"c" cancels a running loop', async () => {
    const loop = makeLoop('loop-1', LoopStatus.RUNNING);
    const data = makeDashboardData({
      loops: [loop],
      loopCounts: { total: 1, byStatus: { running: 1 } },
    });
    const { mutations, cancelLoop } = makeMutations();
    const { stdin } = render(<KeyboardWrapper initialData={data} mutations={mutations} />);

    await press(stdin, 'c');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(cancelLoop).toHaveBeenCalledWith('loop-1', 'User cancelled via dashboard', true);
  });

  it('"c" cancels a running task', async () => {
    const task = makeTask('task-1', TaskStatus.RUNNING);
    const data = makeDashboardData({
      tasks: [task],
      taskCounts: { total: 1, byStatus: { running: 1 } },
    });
    const nav: NavState = { ...INITIAL_NAV, focusedPanel: 'tasks' };
    const { mutations, cancelTask } = makeMutations();
    const { stdin } = render(<KeyboardWrapper initialData={data} initialNav={nav} mutations={mutations} />);

    await press(stdin, 'c');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(cancelTask).toHaveBeenCalledWith('task-1', 'User cancelled via dashboard');
  });

  it('"c" cancels an active schedule', async () => {
    const schedule = makeSchedule('sched-1', ScheduleStatus.ACTIVE);
    const data = makeDashboardData({
      schedules: [schedule],
      scheduleCounts: { total: 1, byStatus: { active: 1 } },
    });
    const nav: NavState = { ...INITIAL_NAV, focusedPanel: 'schedules' };
    const { mutations, cancelSchedule } = makeMutations();
    const { stdin } = render(<KeyboardWrapper initialData={data} initialNav={nav} mutations={mutations} />);

    await press(stdin, 'c');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(cancelSchedule).toHaveBeenCalledWith('sched-1', 'User cancelled via dashboard');
  });

  it('"c" does NOT cancel a terminal orchestration', async () => {
    const orch = makeOrchestration('orch-2', OrchestratorStatus.COMPLETED);
    const data = makeDashboardData({
      orchestrations: [orch],
      orchestrationCounts: { total: 1, byStatus: { completed: 1 } },
    });
    const nav: NavState = { ...INITIAL_NAV, focusedPanel: 'orchestrations' };
    const { mutations, cancelOrchestration } = makeMutations();
    const { stdin } = render(<KeyboardWrapper initialData={data} initialNav={nav} mutations={mutations} />);

    await press(stdin, 'c');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(cancelOrchestration).not.toHaveBeenCalled();
  });

  it('"c" is a no-op when no mutations context is provided', async () => {
    const orch = makeOrchestration('orch-3', OrchestratorStatus.RUNNING);
    const data = makeDashboardData({ orchestrations: [orch] });
    const nav: NavState = { ...INITIAL_NAV, focusedPanel: 'orchestrations' };
    // No mutations prop — key should be silently ignored
    const { lastFrame, stdin } = render(<KeyboardWrapper initialData={data} initialNav={nav} />);

    await press(stdin, 'c');
    // Still in main view — no crash
    expect(lastFrame()).toContain('view:main');
  });
});

describe('useKeyboard — d: delete terminal entity keybinding', () => {
  it('"d" deletes a completed orchestration', async () => {
    const orch = makeOrchestration('orch-done', OrchestratorStatus.COMPLETED);
    const data = makeDashboardData({
      orchestrations: [orch],
      orchestrationCounts: { total: 1, byStatus: { completed: 1 } },
    });
    const nav: NavState = { ...INITIAL_NAV, focusedPanel: 'orchestrations' };
    const { mutations, deleteOrchestration } = makeMutations();
    const { stdin } = render(<KeyboardWrapper initialData={data} initialNav={nav} mutations={mutations} />);

    await press(stdin, 'd');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(deleteOrchestration).toHaveBeenCalledWith('orch-done');
  });

  it('"d" does NOT delete a running orchestration', async () => {
    const orch = makeOrchestration('orch-live', OrchestratorStatus.RUNNING);
    const data = makeDashboardData({
      orchestrations: [orch],
      orchestrationCounts: { total: 1, byStatus: { running: 1 } },
    });
    const nav: NavState = { ...INITIAL_NAV, focusedPanel: 'orchestrations' };
    const { mutations, deleteOrchestration } = makeMutations();
    const { stdin } = render(<KeyboardWrapper initialData={data} initialNav={nav} mutations={mutations} />);

    await press(stdin, 'd');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(deleteOrchestration).not.toHaveBeenCalled();
  });

  it('"d" deletes a terminal loop row', async () => {
    const loop = makeLoop('loop-done', LoopStatus.COMPLETED);
    const data = makeDashboardData({
      loops: [loop],
      loopCounts: { total: 1, byStatus: { completed: 1 } },
    });
    // loops panel is default focused
    const { mutations, deleteLoop } = makeMutations();
    const { stdin } = render(<KeyboardWrapper initialData={data} mutations={mutations} />);

    await press(stdin, 'd');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(deleteLoop).toHaveBeenCalledWith('loop-done');
  });

  it('"d" deletes a terminal task row', async () => {
    const task = makeTask('task-done', TaskStatus.COMPLETED);
    const data = makeDashboardData({
      tasks: [task],
      taskCounts: { total: 1, byStatus: { completed: 1 } },
    });
    const nav: NavState = { ...INITIAL_NAV, focusedPanel: 'tasks' };
    const { mutations, deleteTask } = makeMutations();
    const { stdin } = render(<KeyboardWrapper initialData={data} initialNav={nav} mutations={mutations} />);

    await press(stdin, 'd');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(deleteTask).toHaveBeenCalledWith('task-done');
  });

  it('"d" deletes a terminal schedule row', async () => {
    const schedule = makeSchedule('sched-done', ScheduleStatus.COMPLETED);
    const data = makeDashboardData({
      schedules: [schedule],
      scheduleCounts: { total: 1, byStatus: { completed: 1 } },
    });
    const nav: NavState = { ...INITIAL_NAV, focusedPanel: 'schedules' };
    const { mutations, deleteSchedule } = makeMutations();
    const { stdin } = render(<KeyboardWrapper initialData={data} initialNav={nav} mutations={mutations} />);

    await press(stdin, 'd');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(deleteSchedule).toHaveBeenCalledWith('sched-done');
  });
});

// ============================================================================
// Global v/m/w keys — already covered in workspace-keyboard.test.tsx for workspace
// Spot-check from main view here to confirm no interference with main-view keys
// ============================================================================

describe('useKeyboard — global v/m/w no interference in main', () => {
  it('"v" from main transitions to workspace without crashing', async () => {
    // This just verifies the key is consumed and we don't crash in the main handler
    const { lastFrame, stdin } = render(<KeyboardWrapper initialView={{ kind: 'main' }} />);
    expect(lastFrame()).toContain('view:main');
    await press(stdin, 'v');
    expect(lastFrame()).toContain('view:workspace');
  });

  it('"m" from main stays in main', async () => {
    const { lastFrame, stdin } = render(<KeyboardWrapper initialView={{ kind: 'main' }} />);
    await press(stdin, 'm');
    expect(lastFrame()).toContain('view:main');
  });

  it('"w" from main transitions to workspace', async () => {
    const { lastFrame, stdin } = render(<KeyboardWrapper initialView={{ kind: 'main' }} />);
    await press(stdin, 'w');
    expect(lastFrame()).toContain('view:workspace');
  });
});

// ============================================================================
// Activity focus mode (v1.3.0 Phase F gap fix)
// ============================================================================

describe('useKeyboard — activity focus mode', () => {
  function makeActivityEntry(id: string, kind: 'task' | 'loop' | 'orchestration' | 'schedule') {
    return {
      timestamp: new Date(),
      kind,
      entityId: id,
      status: 'completed',
      action: 'completed',
    };
  }

  it('↓ increments activitySelectedIndex when activity is focused', async () => {
    const feed = [
      makeActivityEntry('e1', 'task'),
      makeActivityEntry('e2', 'loop'),
      makeActivityEntry('e3', 'schedule'),
    ];
    const data = makeDashboardData({ activityFeed: feed });
    const { lastFrame, stdin } = render(
      <KeyboardWrapper initialData={data} initialNav={{ ...INITIAL_NAV, activityFocused: true }} />,
    );
    expect(lastFrame()).toContain('activity-sel:0');
    await press(stdin, '\x1B[B'); // down arrow
    expect(lastFrame()).toContain('activity-sel:1');
  });

  it('↑ decrements activitySelectedIndex but does not go below 0', async () => {
    const feed = [makeActivityEntry('e1', 'task'), makeActivityEntry('e2', 'loop')];
    const data = makeDashboardData({ activityFeed: feed });
    const { lastFrame, stdin } = render(
      <KeyboardWrapper
        initialData={data}
        initialNav={{ ...INITIAL_NAV, activityFocused: true, activitySelectedIndex: 1 }}
      />,
    );
    expect(lastFrame()).toContain('activity-sel:1');
    await press(stdin, '\x1B[A'); // up
    expect(lastFrame()).toContain('activity-sel:0');
    await press(stdin, '\x1B[A'); // up again — stays at 0
    expect(lastFrame()).toContain('activity-sel:0');
  });

  it('↓ does not exceed activity feed length', async () => {
    const feed = [makeActivityEntry('only', 'task')];
    const data = makeDashboardData({ activityFeed: feed });
    const { lastFrame, stdin } = render(
      <KeyboardWrapper initialData={data} initialNav={{ ...INITIAL_NAV, activityFocused: true }} />,
    );
    await press(stdin, '\x1B[B'); // down — already at last item
    expect(lastFrame()).toContain('activity-sel:0');
  });

  it('Enter on task activity row dispatches openDetail with entityType tasks', async () => {
    const feed = [makeActivityEntry('task-abc', 'task')];
    const data = makeDashboardData({ activityFeed: feed });
    const { lastFrame, stdin } = render(
      <KeyboardWrapper initialData={data} initialNav={{ ...INITIAL_NAV, activityFocused: true }} />,
    );
    await press(stdin, '\r'); // Enter
    expect(lastFrame()).toContain('view:detail');
    expect(lastFrame()).toContain('detail-type:tasks');
    expect(lastFrame()).toContain('detail-id:task-abc');
  });

  it('Enter on loop activity row dispatches openDetail with entityType loops', async () => {
    const feed = [makeActivityEntry('loop-xyz', 'loop')];
    const data = makeDashboardData({ activityFeed: feed });
    const { lastFrame, stdin } = render(
      <KeyboardWrapper initialData={data} initialNav={{ ...INITIAL_NAV, activityFocused: true }} />,
    );
    await press(stdin, '\r');
    expect(lastFrame()).toContain('detail-type:loops');
    expect(lastFrame()).toContain('detail-id:loop-xyz');
  });

  it('Enter on orchestration activity row dispatches openDetail with entityType orchestrations', async () => {
    const feed = [makeActivityEntry('orch-qrs', 'orchestration')];
    const data = makeDashboardData({ activityFeed: feed });
    const { lastFrame, stdin } = render(
      <KeyboardWrapper initialData={data} initialNav={{ ...INITIAL_NAV, activityFocused: true }} />,
    );
    await press(stdin, '\r');
    expect(lastFrame()).toContain('detail-type:orchestrations');
    expect(lastFrame()).toContain('detail-id:orch-qrs');
  });

  it('Enter on schedule activity row dispatches openDetail with entityType schedules', async () => {
    const feed = [makeActivityEntry('sched-def', 'schedule')];
    const data = makeDashboardData({ activityFeed: feed });
    const { lastFrame, stdin } = render(
      <KeyboardWrapper initialData={data} initialNav={{ ...INITIAL_NAV, activityFocused: true }} />,
    );
    await press(stdin, '\r');
    expect(lastFrame()).toContain('detail-type:schedules');
    expect(lastFrame()).toContain('detail-id:sched-def');
  });

  it('Esc from activity focus returns to default panel focus (activityFocused:false)', async () => {
    const { lastFrame, stdin } = render(<KeyboardWrapper initialNav={{ ...INITIAL_NAV, activityFocused: true }} />);
    expect(lastFrame()).toContain('activity-focused:true');
    await press(stdin, '\x1B'); // Esc
    expect(lastFrame()).toContain('activity-focused:false');
  });

  it('detail view returnTo is main when opened from activity feed', async () => {
    const feed = [makeActivityEntry('task-ret', 'task')];
    const data = makeDashboardData({ activityFeed: feed });
    const { lastFrame, stdin } = render(
      <KeyboardWrapper initialData={data} initialNav={{ ...INITIAL_NAV, activityFocused: true }} />,
    );
    await press(stdin, '\r');
    // After drill-in, Esc returns to main view (not workspace)
    await press(stdin, '\x1B');
    expect(lastFrame()).toContain('view:main');
  });
});

// ============================================================================
// Detail view scroll
// ============================================================================

describe('useKeyboard — detail view scroll', () => {
  it('down arrow in detail view does not crash', async () => {
    const loop = makeLoop('loop-1');
    const data = makeDashboardData({ loops: [loop] });
    const { lastFrame, stdin } = render(<KeyboardWrapper initialData={data} />);
    await press(stdin, '\r'); // enter detail view
    expect(lastFrame()).toContain('view:detail');
    // Down arrow in detail should not throw and should remain in detail
    await press(stdin, '\x1B[B');
    expect(lastFrame()).toContain('view:detail');
  });

  it('up arrow in detail view at offset 0 stays at 0', async () => {
    const loop = makeLoop('loop-1');
    const data = makeDashboardData({ loops: [loop] });
    const { lastFrame, stdin } = render(<KeyboardWrapper initialData={data} />);
    await press(stdin, '\r'); // enter detail
    await press(stdin, '\x1B[A'); // up — already at 0
    expect(lastFrame()).toContain('view:detail');
    expect(lastFrame()).toContain('scroll-loops:0');
  });
});

// ============================================================================
// D1 — m and w keys work from detail view (plan §2)
// ============================================================================

describe('useKeyboard — m/w global keys from detail view (D1)', () => {
  it('"m" from detail view dispatches setView({ kind: "main" })', async () => {
    const loop = makeLoop('loop-1');
    const data = makeDashboardData({ loops: [loop] });
    const { lastFrame, stdin } = render(<KeyboardWrapper initialData={data} />);
    await press(stdin, '\r'); // enter detail
    expect(lastFrame()).toContain('view:detail');
    await press(stdin, 'm');
    expect(lastFrame()).toContain('view:main');
  });

  it('"w" from detail view dispatches setView({ kind: "workspace" })', async () => {
    const loop = makeLoop('loop-1');
    const data = makeDashboardData({ loops: [loop] });
    const { lastFrame, stdin } = render(<KeyboardWrapper initialData={data} />);
    await press(stdin, '\r'); // enter detail
    expect(lastFrame()).toContain('view:detail');
    await press(stdin, 'w');
    expect(lastFrame()).toContain('view:workspace');
  });

  it('"v" from detail view is still ignored (no state change)', async () => {
    const loop = makeLoop('loop-1');
    const data = makeDashboardData({ loops: [loop] });
    const { lastFrame, stdin } = render(<KeyboardWrapper initialData={data} />);
    await press(stdin, '\r'); // enter detail
    expect(lastFrame()).toContain('view:detail');
    await press(stdin, 'v');
    // Must remain in detail — v is deliberately ignored from detail
    expect(lastFrame()).toContain('view:detail');
  });
});

// ============================================================================
// D2 — Metrics view c/d target the Activity row when activityFocused (plan §9)
// ============================================================================

describe('useKeyboard — activity-row cancel/delete (D2)', () => {
  function makeActivityEntry(id: string, kind: 'task' | 'loop' | 'orchestration' | 'schedule', status = 'running') {
    return {
      timestamp: new Date(),
      kind,
      entityId: id,
      status,
      action: 'running',
    };
  }

  it('"c" on activity-focused task dispatches task cancel', async () => {
    const entry = makeActivityEntry('task-act', 'task');
    const data = makeDashboardData({ activityFeed: [entry] });
    const nav: NavState = { ...INITIAL_NAV, activityFocused: true, activitySelectedIndex: 0 };
    const { mutations, cancelTask } = makeMutations();
    const { stdin } = render(<KeyboardWrapper initialData={data} initialNav={nav} mutations={mutations} />);

    await press(stdin, 'c');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(cancelTask).toHaveBeenCalledWith('task-act', 'User cancelled via dashboard');
  });

  it('"c" on activity-focused loop dispatches loop cancel', async () => {
    const entry = makeActivityEntry('loop-act', 'loop');
    const data = makeDashboardData({ activityFeed: [entry] });
    const nav: NavState = { ...INITIAL_NAV, activityFocused: true, activitySelectedIndex: 0 };
    const { mutations, cancelLoop } = makeMutations();
    const { stdin } = render(<KeyboardWrapper initialData={data} initialNav={nav} mutations={mutations} />);

    await press(stdin, 'c');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(cancelLoop).toHaveBeenCalledWith('loop-act', 'User cancelled via dashboard', true);
  });

  it('"c" on activity-focused orchestration dispatches orchestration cancel WITH cancelAttributedTasks:true', async () => {
    const entry = makeActivityEntry('orch-act', 'orchestration');
    const data = makeDashboardData({ activityFeed: [entry] });
    const nav: NavState = { ...INITIAL_NAV, activityFocused: true, activitySelectedIndex: 0 };
    const { mutations, cancelOrchestration } = makeMutations();
    const { stdin } = render(<KeyboardWrapper initialData={data} initialNav={nav} mutations={mutations} />);

    await press(stdin, 'c');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(cancelOrchestration).toHaveBeenCalledWith('orch-act', 'User cancelled via dashboard', {
      cancelAttributedTasks: true,
    });
  });

  it('"c" on activity-focused schedule dispatches schedule cancel', async () => {
    const entry = makeActivityEntry('sched-act', 'schedule');
    const data = makeDashboardData({ activityFeed: [entry] });
    const nav: NavState = { ...INITIAL_NAV, activityFocused: true, activitySelectedIndex: 0 };
    const { mutations, cancelSchedule } = makeMutations();
    const { stdin } = render(<KeyboardWrapper initialData={data} initialNav={nav} mutations={mutations} />);

    await press(stdin, 'c');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(cancelSchedule).toHaveBeenCalledWith('sched-act', 'User cancelled via dashboard');
  });

  it('"c" when activityFocused is false does NOT dispatch any cancel (no-op)', async () => {
    const entry = makeActivityEntry('task-noop', 'task');
    const data = makeDashboardData({ activityFeed: [entry] });
    // activityFocused: false — default state on metrics view open
    const nav: NavState = { ...INITIAL_NAV, activityFocused: false };
    const { mutations, cancelTask } = makeMutations();
    const { stdin } = render(<KeyboardWrapper initialData={data} initialNav={nav} mutations={mutations} />);

    await press(stdin, 'c');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    // Must NOT dispatch to activity entry — user has not tabbed to activity feed
    expect(cancelTask).not.toHaveBeenCalled();
  });

  it('"d" on activity-focused terminal task dispatches task delete', async () => {
    const entry = makeActivityEntry('task-done', 'task', 'completed');
    const data = makeDashboardData({ activityFeed: [entry] });
    const nav: NavState = { ...INITIAL_NAV, activityFocused: true, activitySelectedIndex: 0 };
    const { mutations, deleteTask } = makeMutations();
    const { stdin } = render(<KeyboardWrapper initialData={data} initialNav={nav} mutations={mutations} />);

    await press(stdin, 'd');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(deleteTask).toHaveBeenCalledWith('task-done');
  });

  it('"d" on activity-focused running task is no-op (cannot delete live entity)', async () => {
    const entry = makeActivityEntry('task-live', 'task', 'running');
    const data = makeDashboardData({ activityFeed: [entry] });
    const nav: NavState = { ...INITIAL_NAV, activityFocused: true, activitySelectedIndex: 0 };
    const { mutations, deleteTask } = makeMutations();
    const { stdin } = render(<KeyboardWrapper initialData={data} initialNav={nav} mutations={mutations} />);

    await press(stdin, 'd');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(deleteTask).not.toHaveBeenCalled();
  });
});

// ============================================================================
// D3 — orchestration detail drill-through keyboard navigation (v1.3.0)
// ============================================================================

describe('useKeyboard — D3 orchestration detail child navigation', () => {
  /** Build a detail view state for an orchestration */
  function orchDetailView(orchId: string, returnTo: 'main' | 'workspace' = 'main') {
    return {
      kind: 'detail' as const,
      entityType: 'orchestrations' as const,
      entityId: orchId as OrchestratorId,
      returnTo,
    };
  }

  it('↓ moves orchestrationChildSelectedTaskId to next child', async () => {
    const children = [
      makeOrchestratorChild('task-child-001'),
      makeOrchestratorChild('task-child-002'),
      makeOrchestratorChild('task-child-003'),
    ];
    const orch = makeOrchestration('orch-abc');
    const data = makeDashboardData({
      orchestrations: [orch],
      orchestrationChildren: children,
    });
    const nav: NavState = {
      ...INITIAL_NAV,
      orchestrationChildSelectedTaskId: 'task-child-001',
    };
    const { lastFrame, stdin } = render(
      <KeyboardWrapper initialData={data} initialNav={nav} initialView={orchDetailView('orch-abc')} />,
    );
    expect(lastFrame()).toContain('orch-child-sel:task-child-001');
    await press(stdin, '\x1B[B'); // down arrow
    expect(lastFrame()).toContain('orch-child-sel:task-child-002');
  });

  it('↑ moves orchestrationChildSelectedTaskId to previous child', async () => {
    const children = [makeOrchestratorChild('task-child-001'), makeOrchestratorChild('task-child-002')];
    const orch = makeOrchestration('orch-abc');
    const data = makeDashboardData({
      orchestrations: [orch],
      orchestrationChildren: children,
    });
    const nav: NavState = {
      ...INITIAL_NAV,
      orchestrationChildSelectedTaskId: 'task-child-002',
    };
    const { lastFrame, stdin } = render(
      <KeyboardWrapper initialData={data} initialNav={nav} initialView={orchDetailView('orch-abc')} />,
    );
    expect(lastFrame()).toContain('orch-child-sel:task-child-002');
    await press(stdin, '\x1B[A'); // up arrow
    expect(lastFrame()).toContain('orch-child-sel:task-child-001');
  });

  it('↓ does not go past last child', async () => {
    const children = [makeOrchestratorChild('task-child-001'), makeOrchestratorChild('task-child-002')];
    const orch = makeOrchestration('orch-abc');
    const data = makeDashboardData({
      orchestrations: [orch],
      orchestrationChildren: children,
    });
    const nav: NavState = {
      ...INITIAL_NAV,
      orchestrationChildSelectedTaskId: 'task-child-002',
    };
    const { lastFrame, stdin } = render(
      <KeyboardWrapper initialData={data} initialNav={nav} initialView={orchDetailView('orch-abc')} />,
    );
    await press(stdin, '\x1B[B'); // down — already at last
    expect(lastFrame()).toContain('orch-child-sel:task-child-002');
  });

  it('↑ does not go above first child', async () => {
    const children = [makeOrchestratorChild('task-child-001'), makeOrchestratorChild('task-child-002')];
    const orch = makeOrchestration('orch-abc');
    const data = makeDashboardData({
      orchestrations: [orch],
      orchestrationChildren: children,
    });
    const nav: NavState = {
      ...INITIAL_NAV,
      orchestrationChildSelectedTaskId: 'task-child-001',
    };
    const { lastFrame, stdin } = render(
      <KeyboardWrapper initialData={data} initialNav={nav} initialView={orchDetailView('orch-abc')} />,
    );
    await press(stdin, '\x1B[A'); // up — already at first
    expect(lastFrame()).toContain('orch-child-sel:task-child-001');
  });

  it('Enter on selected child transitions to task detail with orchestration returnTo', async () => {
    const children = [makeOrchestratorChild('task-child-aaa'), makeOrchestratorChild('task-child-bbb')];
    const orch = makeOrchestration('orch-drill-123');
    const data = makeDashboardData({
      orchestrations: [orch],
      orchestrationChildren: children,
    });
    const nav: NavState = {
      ...INITIAL_NAV,
      orchestrationChildSelectedTaskId: 'task-child-aaa',
    };
    const { lastFrame, stdin } = render(
      <KeyboardWrapper initialData={data} initialNav={nav} initialView={orchDetailView('orch-drill-123')} />,
    );
    await press(stdin, '\r'); // Enter
    expect(lastFrame()).toContain('view:detail');
    expect(lastFrame()).toContain('detail-type:tasks');
    expect(lastFrame()).toContain('detail-id:task-child-aaa');
  });

  it('Esc from drilled task detail returns to parent orchestration detail', async () => {
    const children = [makeOrchestratorChild('task-child-esc')];
    const orch = makeOrchestration('orch-parent');
    const data = makeDashboardData({
      orchestrations: [orch],
      orchestrationChildren: children,
    });
    const nav: NavState = {
      ...INITIAL_NAV,
      orchestrationChildSelectedTaskId: 'task-child-esc',
    };
    const { lastFrame, stdin } = render(
      <KeyboardWrapper initialData={data} initialNav={nav} initialView={orchDetailView('orch-parent')} />,
    );
    // Drill into task detail
    await press(stdin, '\r');
    expect(lastFrame()).toContain('detail-type:tasks');
    // Esc returns to orchestration detail
    await press(stdin, '\x1B');
    expect(lastFrame()).toContain('detail-type:orchestrations');
    expect(lastFrame()).toContain('detail-id:orch-parent');
  });

  it('Esc from orchestration detail (returnTo main) goes to main', async () => {
    const orch = makeOrchestration('orch-xyz');
    const data = makeDashboardData({ orchestrations: [orch] });
    const { lastFrame, stdin } = render(
      <KeyboardWrapper initialData={data} initialView={orchDetailView('orch-xyz', 'main')} />,
    );
    expect(lastFrame()).toContain('view:detail');
    await press(stdin, '\x1B');
    expect(lastFrame()).toContain('view:main');
  });

  it('Esc from orchestration detail (returnTo workspace) goes to workspace', async () => {
    const orch = makeOrchestration('orch-ws');
    const data = makeDashboardData({ orchestrations: [orch] });
    const { lastFrame, stdin } = render(
      <KeyboardWrapper initialData={data} initialView={orchDetailView('orch-ws', 'workspace')} />,
    );
    expect(lastFrame()).toContain('view:detail');
    await press(stdin, '\x1B');
    expect(lastFrame()).toContain('view:workspace');
  });

  it('PgDn advances orchestrationChildPage and resets selection', async () => {
    const children = [makeOrchestratorChild('task-p1-001')];
    const orch = makeOrchestration('orch-page');
    const data = makeDashboardData({
      orchestrations: [orch],
      orchestrationChildren: children,
      orchestrationChildrenTotal: 30, // 2 pages with PAGE_SIZE=15
    });
    const nav: NavState = {
      ...INITIAL_NAV,
      orchestrationChildSelectedTaskId: 'task-p1-001',
      orchestrationChildPage: 0,
    };
    const onRefresh = vi.fn();
    const { lastFrame, stdin } = render(
      <KeyboardWrapper
        initialData={data}
        initialNav={nav}
        initialView={orchDetailView('orch-page')}
        onRefresh={onRefresh}
      />,
    );
    expect(lastFrame()).toContain('orch-child-page:0');
    await press(stdin, '\x1B[6~'); // PgDn
    expect(lastFrame()).toContain('orch-child-page:1');
    expect(lastFrame()).toContain('orch-child-sel:null'); // selection reset
    expect(onRefresh).toHaveBeenCalled();
  });

  it('PgUp decrements orchestrationChildPage and resets selection', async () => {
    const children = [makeOrchestratorChild('task-p2-001')];
    const orch = makeOrchestration('orch-page2');
    const data = makeDashboardData({
      orchestrations: [orch],
      orchestrationChildren: children,
      orchestrationChildrenTotal: 30,
    });
    const nav: NavState = {
      ...INITIAL_NAV,
      orchestrationChildSelectedTaskId: 'task-p2-001',
      orchestrationChildPage: 1,
    };
    const onRefresh = vi.fn();
    const { lastFrame, stdin } = render(
      <KeyboardWrapper
        initialData={data}
        initialNav={nav}
        initialView={orchDetailView('orch-page2')}
        onRefresh={onRefresh}
      />,
    );
    expect(lastFrame()).toContain('orch-child-page:1');
    await press(stdin, '\x1B[5~'); // PgUp
    expect(lastFrame()).toContain('orch-child-page:0');
    expect(lastFrame()).toContain('orch-child-sel:null'); // selection reset
    expect(onRefresh).toHaveBeenCalled();
  });

  it('PgUp at page 0 does not go negative', async () => {
    const children = [makeOrchestratorChild('task-001')];
    const orch = makeOrchestration('orch-nonneg');
    const data = makeDashboardData({
      orchestrations: [orch],
      orchestrationChildren: children,
      orchestrationChildrenTotal: 5,
    });
    const nav: NavState = {
      ...INITIAL_NAV,
      orchestrationChildPage: 0,
    };
    const { lastFrame, stdin } = render(
      <KeyboardWrapper initialData={data} initialNav={nav} initialView={orchDetailView('orch-nonneg')} />,
    );
    await press(stdin, '\x1B[5~'); // PgUp — already at page 0
    expect(lastFrame()).toContain('orch-child-page:0');
  });

  it('j/k act like ↓/↑ in orchestration detail', async () => {
    const children = [makeOrchestratorChild('task-jk-001'), makeOrchestratorChild('task-jk-002')];
    const orch = makeOrchestration('orch-jk');
    const data = makeDashboardData({
      orchestrations: [orch],
      orchestrationChildren: children,
    });
    const nav: NavState = {
      ...INITIAL_NAV,
      orchestrationChildSelectedTaskId: 'task-jk-001',
    };
    const { lastFrame, stdin } = render(
      <KeyboardWrapper initialData={data} initialNav={nav} initialView={orchDetailView('orch-jk')} />,
    );
    await press(stdin, 'j'); // like down
    expect(lastFrame()).toContain('orch-child-sel:task-jk-002');
    await press(stdin, 'k'); // like up
    expect(lastFrame()).toContain('orch-child-sel:task-jk-001');
  });
});
