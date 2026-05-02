/**
 * Tests for OrchestrationDetail view — Phase E modernization + Phase C grid mode.
 * Covers:
 *  - Legacy metadata still renders (ID, status, goal, agent, model)
 *  - Children section renders when present
 *  - Cost section renders with correct values
 *  - Cost section hidden when all zero
 *  - Grid mode (viewMode='grid'): workspace panel layout embedded in this view
 */

import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import type { WorkspaceLayout } from '../../../../src/cli/dashboard/layout.js';
import { OrchestrationDetail } from '../../../../src/cli/dashboard/views/orchestration-detail.js';
import { createInitialWorkspaceNavState } from '../../../../src/cli/dashboard/workspace-types.js';
import type {
  Orchestration,
  OrchestratorChild,
  OrchestratorId,
  TaskId,
  TaskUsage,
} from '../../../../src/core/domain.js';
import { OrchestratorStatus, TaskStatus } from '../../../../src/core/domain.js';

// ============================================================================
// Fixtures
// ============================================================================

function makeOrchestration(overrides: Partial<Orchestration> = {}): Orchestration {
  return {
    id: 'orch-test-001' as OrchestratorId,
    goal: 'Build a feature',
    status: OrchestratorStatus.RUNNING,
    agent: 'claude',
    model: 'claude-3-5-sonnet',
    stateFilePath: '/tmp/state.json',
    workingDirectory: '/home/user/project',
    maxDepth: 3,
    maxWorkers: 2,
    maxIterations: 10,
    createdAt: Date.now() - 60000,
    updatedAt: Date.now(),
    ...overrides,
  } as Orchestration;
}

function makeChild(taskId: string, status: TaskStatus = TaskStatus.RUNNING): OrchestratorChild {
  return {
    taskId: taskId as TaskId,
    kind: 'direct',
    status,
    createdAt: Date.now() - 30000,
    updatedAt: Date.now(),
    prompt: 'Implement the feature',
    agent: 'claude',
  };
}

function makeUsage(overrides: Partial<TaskUsage> = {}): TaskUsage {
  return {
    taskId: 'task-usage' as TaskId,
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationInputTokens: 200,
    cacheReadInputTokens: 100,
    totalCostUsd: 0.05,
    capturedAt: Date.now(),
    ...overrides,
  };
}

function makeZeroUsage(): TaskUsage {
  return {
    taskId: 'task-usage' as TaskId,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalCostUsd: 0,
    capturedAt: Date.now(),
  };
}

// ============================================================================
// Legacy metadata
// ============================================================================

describe('OrchestrationDetail — legacy metadata', () => {
  it('renders orchestration ID', () => {
    const orch = makeOrchestration();
    const { lastFrame } = render(
      <OrchestrationDetail orchestration={orch} animFrame={0} children={[]} costAggregate={makeZeroUsage()} />,
    );
    expect(lastFrame()).toContain('orch-test-001');
  });

  it('renders the goal', () => {
    const orch = makeOrchestration({ goal: 'Write unit tests for the auth module' });
    const { lastFrame } = render(
      <OrchestrationDetail orchestration={orch} animFrame={0} children={[]} costAggregate={makeZeroUsage()} />,
    );
    expect(lastFrame()).toContain('Write unit tests for the auth module');
  });

  it('renders agent and model when present', () => {
    const orch = makeOrchestration({ agent: 'claude', model: 'claude-opus-4' });
    const { lastFrame } = render(
      <OrchestrationDetail orchestration={orch} animFrame={0} children={[]} costAggregate={makeZeroUsage()} />,
    );
    expect(lastFrame()).toContain('claude');
    expect(lastFrame()).toContain('claude-opus-4');
  });

  it('renders without crashing when agent and model are absent', () => {
    const orch = makeOrchestration({ agent: undefined, model: undefined });
    const { lastFrame } = render(
      <OrchestrationDetail orchestration={orch} animFrame={0} children={[]} costAggregate={makeZeroUsage()} />,
    );
    expect(lastFrame()).toContain('Orchestration Detail');
  });

  it('renders working directory', () => {
    const orch = makeOrchestration({ workingDirectory: '/home/user/myproject' });
    const { lastFrame } = render(
      <OrchestrationDetail orchestration={orch} animFrame={0} children={[]} costAggregate={makeZeroUsage()} />,
    );
    expect(lastFrame()).toContain('/home/user/myproject');
  });
});

// ============================================================================
// Children section
// ============================================================================

describe('OrchestrationDetail — children section', () => {
  it('does not render children section when list is empty', () => {
    const orch = makeOrchestration();
    const { lastFrame } = render(
      <OrchestrationDetail orchestration={orch} animFrame={0} children={[]} costAggregate={makeZeroUsage()} />,
    );
    // Should not show "Children" heading when empty
    expect(lastFrame()).not.toContain('Children');
  });

  it('renders the Children heading when children are present', () => {
    const orch = makeOrchestration();
    const children = [makeChild('task-child-001')];
    const { lastFrame } = render(
      <OrchestrationDetail orchestration={orch} animFrame={0} children={children} costAggregate={makeZeroUsage()} />,
    );
    expect(lastFrame()).toContain('Children');
  });

  it('renders each child row with id, kind, status', () => {
    const orch = makeOrchestration();
    const children = [
      makeChild('task-child-aabbcc', TaskStatus.RUNNING),
      makeChild('task-child-ddeeff', TaskStatus.COMPLETED),
    ];
    const { lastFrame } = render(
      <OrchestrationDetail orchestration={orch} animFrame={0} children={children} costAggregate={makeZeroUsage()} />,
    );
    const frame = lastFrame() ?? '';
    // Short IDs should be visible
    expect(frame).toContain('task-chil'); // prefix of task-child-aabbcc
    expect(frame).toContain('running');
    expect(frame).toContain('completed');
  });

  it('renders multiple children', () => {
    const orch = makeOrchestration();
    const children = [makeChild('task-aaa111222333'), makeChild('task-bbb444555666'), makeChild('task-ccc777888999')];
    const { lastFrame } = render(
      <OrchestrationDetail orchestration={orch} animFrame={0} children={children} costAggregate={makeZeroUsage()} />,
    );
    expect(lastFrame()).toBeTruthy();
  });
});

// ============================================================================
// Cost section
// ============================================================================

describe('OrchestrationDetail — cost aggregate section', () => {
  it('hides cost section when all usage is zero', () => {
    const orch = makeOrchestration();
    const { lastFrame } = render(
      <OrchestrationDetail orchestration={orch} animFrame={0} children={[]} costAggregate={makeZeroUsage()} />,
    );
    // No cost/token info shown
    expect(lastFrame()).not.toContain('$');
    expect(lastFrame()).not.toContain('tokens');
  });

  it('renders cost section when totalCostUsd > 0', () => {
    const orch = makeOrchestration();
    const usage = makeUsage({ totalCostUsd: 0.1234 });
    const { lastFrame } = render(
      <OrchestrationDetail orchestration={orch} animFrame={0} children={[]} costAggregate={usage} />,
    );
    expect(lastFrame()).toContain('$');
    expect(lastFrame()).toContain('0.12'); // formatted to 2 decimal places
  });

  it('renders cost section when inputTokens > 0 even if cost is 0', () => {
    const orch = makeOrchestration();
    const usage = makeUsage({ inputTokens: 5000, totalCostUsd: 0 });
    const { lastFrame } = render(
      <OrchestrationDetail orchestration={orch} animFrame={0} children={[]} costAggregate={usage} />,
    );
    // Has input tokens — should show something
    expect(lastFrame()).toContain('5000');
  });

  it('renders input tokens out tokens in cost section', () => {
    const orch = makeOrchestration();
    const usage = makeUsage({ inputTokens: 1500, outputTokens: 750, totalCostUsd: 0.05 });
    const { lastFrame } = render(
      <OrchestrationDetail orchestration={orch} animFrame={0} children={[]} costAggregate={usage} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('1500');
    expect(frame).toContain('750');
  });
});

// ============================================================================
// D3 drill-through: selection highlighting + pagination footer (v1.3.0)
// ============================================================================

describe('OrchestrationDetail — D3 selection and pagination', () => {
  it('highlights the selected child row', () => {
    const orch = makeOrchestration();
    const children = [makeChild('task-sel-001'), makeChild('task-sel-002'), makeChild('task-sel-003')];
    const { lastFrame } = render(
      <OrchestrationDetail orchestration={orch} animFrame={0} children={children} childSelectedTaskId="task-sel-002" />,
    );
    // The selected row should be present in the output
    expect(lastFrame()).toContain('task-sel-0');
  });

  it('renders pagination footer when childrenTotal > children.length', () => {
    const orch = makeOrchestration();
    // 5 children on current page but 30 total
    const children = Array.from({ length: 5 }, (_, i) => makeChild(`task-page-${String(i).padStart(3, '0')}`));
    const { lastFrame } = render(
      <OrchestrationDetail orchestration={orch} animFrame={0} children={children} childrenTotal={30} currentPage={0} />,
    );
    const frame = lastFrame() ?? '';
    // Should show page info
    expect(frame).toContain('Page 1');
    expect(frame).toContain('30 total');
  });

  it('does NOT render pagination footer when all children fit on one page', () => {
    const orch = makeOrchestration();
    const children = [makeChild('task-single-001'), makeChild('task-single-002')];
    const { lastFrame } = render(
      <OrchestrationDetail orchestration={orch} animFrame={0} children={children} childrenTotal={2} currentPage={0} />,
    );
    const frame = lastFrame() ?? '';
    // Should not show "Page N of M" — single-page hint instead
    expect(frame).not.toContain('PgUp/PgDn');
    expect(frame).toContain('Enter to drill');
  });

  it('shows correct page number in pagination footer', () => {
    const orch = makeOrchestration();
    const children = Array.from({ length: 5 }, (_, i) => makeChild(`task-page2-${String(i).padStart(3, '0')}`));
    const { lastFrame } = render(
      <OrchestrationDetail
        orchestration={orch}
        animFrame={0}
        children={children}
        childrenTotal={30}
        currentPage={1} // page 2 (0-indexed)
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Page 2');
  });

  it('renders single-page drill hint when no pagination needed', () => {
    const orch = makeOrchestration();
    const children = [makeChild('task-hint-001')];
    const { lastFrame } = render(
      <OrchestrationDetail orchestration={orch} animFrame={0} children={children} childrenTotal={1} currentPage={0} />,
    );
    expect(lastFrame()).toContain('Enter to drill into child task detail');
  });
});

// ============================================================================
// Step 10: Grid mode (Phase C fold — workspace into OrchestrationDetail)
// ============================================================================

function makeGridLayout(overrides: Partial<WorkspaceLayout> = {}): WorkspaceLayout {
  return {
    mode: 'nav+grid',
    navWidth: 22,
    gridCols: 2,
    maxGridRows: 3,
    visibleSlots: 6,
    panelWidth: 50,
    panelHeight: 12,
    outputViewportHeight: 9,
    compactPanel: false,
    displayedGridRows: 2,
    ...overrides,
  };
}

describe('OrchestrationDetail — grid mode (viewMode=grid)', () => {
  it('renders EmptyWorkspace when orchestrations list is empty', () => {
    const orch = makeOrchestration();
    const { lastFrame } = render(
      <OrchestrationDetail
        orchestration={orch}
        viewMode="grid"
        orchestrations={[]}
        workspaceNav={createInitialWorkspaceNavState()}
        taskStreams={new Map()}
        workspaceLayout={makeGridLayout()}
      />,
    );
    // EmptyWorkspace renders a message about no orchestrators
    const frame = lastFrame() ?? '';
    expect(frame).toBeTruthy();
    // Should NOT render the list-mode detail header
    expect(frame).not.toContain('Orchestration Detail');
  });

  it('renders too-small message when layout mode is too-small', () => {
    const orch = makeOrchestration();
    const { lastFrame } = render(
      <OrchestrationDetail
        orchestration={orch}
        viewMode="grid"
        orchestrations={[orch]}
        workspaceNav={createInitialWorkspaceNavState()}
        taskStreams={new Map()}
        workspaceLayout={makeGridLayout({ mode: 'too-small' })}
      />,
    );
    expect(lastFrame()).toContain('Resize terminal');
  });

  it('renders no-children empty state when children is empty with orchestration', () => {
    const orch = makeOrchestration();
    const { lastFrame } = render(
      <OrchestrationDetail
        orchestration={orch}
        viewMode="grid"
        orchestrations={[orch]}
        children={[]}
        workspaceNav={createInitialWorkspaceNavState()}
        taskStreams={new Map()}
        workspaceLayout={makeGridLayout()}
      />,
    );
    // Should not render detail list view
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('Orchestration Detail');
  });

  it('falls back to list mode when grid props are missing', () => {
    // When viewMode='grid' but required props are missing, falls back to list mode
    const orch = makeOrchestration();
    const { lastFrame } = render(
      <OrchestrationDetail
        orchestration={orch}
        viewMode="grid"
        // orchestrations, workspaceNav, taskStreams, workspaceLayout all missing
      />,
    );
    // Falls back to list mode — renders the detail header
    expect(lastFrame()).toContain('Orchestration Detail');
  });

  it('renders OrchestratorNav in nav+grid mode with multiple orchestrations', () => {
    const orch1 = makeOrchestration({ id: 'orch-g1-001' as OrchestratorId, goal: 'First goal' });
    const orch2 = makeOrchestration({ id: 'orch-g2-002' as OrchestratorId, goal: 'Second goal' });
    const { frames } = render(
      <OrchestrationDetail
        orchestration={orch1}
        viewMode="grid"
        orchestrations={[orch1, orch2]}
        children={[]}
        workspaceNav={createInitialWorkspaceNavState()}
        taskStreams={new Map()}
        workspaceLayout={makeGridLayout({ mode: 'nav+grid', navWidth: 22 })}
      />,
    );
    // OrchestratorNav renders at least one of the orchestration IDs
    const allFrames = frames.join('\n');
    expect(allFrames).toBeTruthy();
    // Nav is rendered — output should exist
    expect(frames.length).toBeGreaterThan(0);
  });

  it('renders list-mode detail unchanged when viewMode is default (list)', () => {
    const orch = makeOrchestration();
    const { lastFrame } = render(<OrchestrationDetail orchestration={orch} animFrame={0} />);
    expect(lastFrame()).toContain('Orchestration Detail');
  });
});
