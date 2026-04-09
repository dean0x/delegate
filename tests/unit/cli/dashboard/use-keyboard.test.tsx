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

import { render } from 'ink-testing-library';
import { Box, Text } from 'ink';
import React, { useCallback, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  LoopStatus,
  LoopStrategy,
  OrchestratorStatus,
  ScheduleStatus,
  ScheduleType,
  TaskStatus,
} from '../../../../src/core/domain.js';
import type { Loop, Orchestration, Schedule, Task } from '../../../../src/core/domain.js';
import { useKeyboard } from '../../../../src/cli/dashboard/use-keyboard.js';
import type { DashboardData, NavState, ViewState } from '../../../../src/cli/dashboard/types.js';

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
    taskCounts: { total: 0, byStatus: {} },
    loopCounts: { total: 0, byStatus: {} },
    scheduleCounts: { total: 0, byStatus: {} },
    orchestrationCounts: { total: 0, byStatus: {} },
    ...overrides,
  };
}

const INITIAL_NAV: NavState = {
  focusedPanel: 'loops',
  selectedIndices: { loops: 0, tasks: 0, schedules: 0, orchestrations: 0 },
  filters: { loops: null, tasks: null, schedules: null, orchestrations: null },
  scrollOffsets: { loops: 0, tasks: 0, schedules: 0, orchestrations: 0 },
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
}: WrapperProps): React.ReactElement {
  const [view, setView] = useState<ViewState>(initialView);
  const [nav, setNav] = useState<NavState>(initialNav);
  const data = initialData ?? makeDashboardData();

  const exit = useCallback(() => onExit?.(), [onExit]);
  const refreshNow = useCallback(() => onRefresh?.(), [onRefresh]);

  useKeyboard({ view, nav, data, setView, setNav, refreshNow, exit });

  return (
    <Box flexDirection="column">
      <Text>view:{view.kind}</Text>
      {view.kind === 'detail' && (
        <Text>detail-type:{view.entityType} detail-id:{view.entityId}</Text>
      )}
      <Text>panel:{nav.focusedPanel}</Text>
      <Text>sel-loops:{nav.selectedIndices.loops}</Text>
      <Text>sel-tasks:{nav.selectedIndices.tasks}</Text>
      <Text>filter-loops:{nav.filters.loops ?? 'null'}</Text>
      <Text>filter-tasks:{nav.filters.tasks ?? 'null'}</Text>
      <Text>scroll-loops:{nav.scrollOffsets.loops}</Text>
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
 */
async function press(stdin: { write: (s: string) => void }, key: string): Promise<void> {
  stdin.write(key);
  // Flush React scheduler's microtask queue, then give the reconciler one more
  // tick to commit the work and trigger onRender.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// ============================================================================
// Tab / panel cycling
// ============================================================================

describe('useKeyboard — Tab panel cycling', () => {
  it('Tab moves focus forward from loops → tasks', async () => {
    const { lastFrame, stdin } = render(<KeyboardWrapper />);
    expect(lastFrame()).toContain('panel:loops');
    await press(stdin, '\t');
    expect(lastFrame()).toContain('panel:tasks');
  });

  it('Tab cycles all the way around: loops → tasks → schedules → orchestrations → loops', async () => {
    const { lastFrame, stdin } = render(<KeyboardWrapper />);
    await press(stdin, '\t'); // → tasks
    await press(stdin, '\t'); // → schedules
    await press(stdin, '\t'); // → orchestrations
    await press(stdin, '\t'); // → loops (wrap)
    expect(lastFrame()).toContain('panel:loops');
  });

  it('Shift+Tab cycles backward from loops → orchestrations', async () => {
    const { lastFrame, stdin } = render(<KeyboardWrapper />);
    expect(lastFrame()).toContain('panel:loops');
    // Shift+Tab is ESC[Z in VT100
    await press(stdin, '\x1B[Z');
    expect(lastFrame()).toContain('panel:orchestrations');
  });
});

// ============================================================================
// Panel jump keys 1-4
// ============================================================================

describe('useKeyboard — panel jump keys', () => {
  it('pressing "2" jumps to tasks panel', async () => {
    const { lastFrame, stdin } = render(<KeyboardWrapper />);
    await press(stdin, '2');
    expect(lastFrame()).toContain('panel:tasks');
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

  it('pressing "1" jumps to loops panel', async () => {
    const { lastFrame, stdin } = render(
      <KeyboardWrapper initialNav={{ ...INITIAL_NAV, focusedPanel: 'tasks' }} />,
    );
    await press(stdin, '1');
    expect(lastFrame()).toContain('panel:loops');
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
      <KeyboardWrapper
        initialData={data}
        initialNav={{ ...INITIAL_NAV, focusedPanel: 'tasks' }}
      />,
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
    // After one press, filter should be 'running' (first non-null in FILTER_CYCLE)
    expect(lastFrame()).toContain('filter-loops:running');
  });

  it('"f" cycles back to null after going through all filters', async () => {
    const { lastFrame, stdin } = render(<KeyboardWrapper />);
    // FILTER_CYCLE has 9 entries (null + 8 statuses) — press 9 times to wrap around
    for (let i = 0; i < 9; i++) {
      await press(stdin, 'f');
    }
    expect(lastFrame()).toContain('filter-loops:null');
  });

  it('filter is per-panel — cycling loops filter does not affect tasks filter', async () => {
    const { lastFrame, stdin } = render(<KeyboardWrapper />);
    await press(stdin, 'f'); // cycles loops filter
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
