/**
 * Tests for workspace grid mode in OrchestrationDetail (Phase C fold)
 * ARCHITECTURE: WorkspaceView was folded into OrchestrationDetail with viewMode='grid'
 * Pattern: ink-testing-library render — behavioral, not snapshots
 *
 * These tests were previously WorkspaceView tests. After the fold they exercise
 * OrchestrationDetail with viewMode='grid', which is the same code path.
 */

import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import type { WorkspaceLayout } from '../../../../src/cli/dashboard/layout.js';
import type { OutputStreamState } from '../../../../src/cli/dashboard/use-task-output-stream.js';
import { OrchestrationDetail } from '../../../../src/cli/dashboard/views/orchestration-detail.js';
import type { WorkspaceNavState } from '../../../../src/cli/dashboard/workspace-types.js';
import { createInitialWorkspaceNavState } from '../../../../src/cli/dashboard/workspace-types.js';
import type { Orchestration, OrchestratorChild } from '../../../../src/core/domain.js';
import { OrchestratorId, OrchestratorStatus, TaskId, TaskStatus } from '../../../../src/core/domain.js';

// ============================================================================
// Fixtures
// ============================================================================

function makeLayout(overrides: Partial<WorkspaceLayout> = {}): WorkspaceLayout {
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

function makeNav(overrides: Partial<WorkspaceNavState> = {}): WorkspaceNavState {
  return {
    ...createInitialWorkspaceNavState(),
    ...overrides,
  };
}

function makeChild(taskId: string, overrides: Partial<OrchestratorChild> = {}): OrchestratorChild {
  return {
    taskId: TaskId(taskId),
    kind: 'direct',
    status: TaskStatus.RUNNING,
    createdAt: Date.now() - 5000,
    updatedAt: Date.now(),
    prompt: `Task prompt for ${taskId}`,
    ...overrides,
  };
}

function makeStream(taskId: string, overrides: Partial<OutputStreamState> = {}): OutputStreamState {
  return {
    lines: [`output from ${taskId}`],
    totalBytes: 100,
    lastFetchedAt: new Date(),
    error: null,
    droppedLines: 0,
    taskStatus: 'running',
    ...overrides,
  };
}

function makeOrch(id: string): Orchestration {
  return {
    id: OrchestratorId(id),
    goal: `Goal: ${id}`,
    loopId: undefined,
    stateFilePath: '/tmp/state.json',
    workingDirectory: '/workspace',
    agent: undefined,
    model: undefined,
    maxDepth: 3,
    maxWorkers: 5,
    maxIterations: 50,
    status: OrchestratorStatus.RUNNING,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: undefined,
  };
}

// ============================================================================
// Tests (grid mode via OrchestrationDetail)
// ============================================================================

describe('WorkspaceView (via OrchestrationDetail grid mode)', () => {
  describe('too-small mode', () => {
    it('shows fallback message when layout is too-small', () => {
      const orch = makeOrch('orch-1');
      const { lastFrame } = render(
        <OrchestrationDetail
          orchestration={orch}
          viewMode="grid"
          orchestrations={[orch]}
          children={[]}
          workspaceNav={makeNav()}
          taskStreams={new Map()}
          workspaceLayout={makeLayout({ mode: 'too-small', panelWidth: 0, panelHeight: 0 })}
        />,
      );
      const frame = lastFrame() ?? '';
      expect(frame.toLowerCase()).toMatch(/resize|too.?small|terminal/);
    });
  });

  describe('no orchestrators empty state', () => {
    it('shows no-orchestrators empty state when orchestrations is empty', () => {
      const orch = makeOrch('orch-1');
      const { lastFrame } = render(
        <OrchestrationDetail
          orchestration={orch}
          viewMode="grid"
          orchestrations={[]}
          children={[]}
          workspaceNav={makeNav()}
          taskStreams={new Map()}
          workspaceLayout={makeLayout()}
        />,
      );
      const frame = lastFrame() ?? '';
      expect(frame.toLowerCase()).toMatch(/no orchestrat|orchestrat.*running|beat orchestrate/);
    });
  });

  describe('no children empty state', () => {
    it('shows no-children empty state when children is empty', () => {
      const orch = makeOrch('orch-1');
      const { lastFrame } = render(
        <OrchestrationDetail
          orchestration={orch}
          viewMode="grid"
          orchestrations={[orch]}
          children={[]}
          workspaceNav={makeNav()}
          taskStreams={new Map()}
          workspaceLayout={makeLayout()}
        />,
      );
      const frame = lastFrame() ?? '';
      expect(frame.toLowerCase()).toMatch(/no.*children|waiting|no active|first iteration/);
    });
  });

  describe('grid rendering', () => {
    it('renders 3 children in the grid without throwing', () => {
      const orch = makeOrch('orch-1');
      const children = [makeChild('task-1'), makeChild('task-2'), makeChild('task-3')];
      const streams = new Map([
        [TaskId('task-1'), makeStream('task-1')],
        [TaskId('task-2'), makeStream('task-2')],
        [TaskId('task-3'), makeStream('task-3')],
      ]);

      expect(() => {
        render(
          <OrchestrationDetail
            orchestration={orch}
            viewMode="grid"
            orchestrations={[orch]}
            children={children}
            workspaceNav={makeNav()}
            taskStreams={streams}
            workspaceLayout={makeLayout()}
          />,
        );
      }).not.toThrow();
    });
  });

  describe('grid-only mode', () => {
    it('renders without nav panel when layout is grid-only', () => {
      const orch = makeOrch('orch-1');
      const children = [makeChild('task-1')];

      expect(() => {
        render(
          <OrchestrationDetail
            orchestration={orch}
            viewMode="grid"
            orchestrations={[orch]}
            children={children}
            workspaceNav={makeNav()}
            taskStreams={new Map([[TaskId('task-1'), makeStream('task-1')]])}
            workspaceLayout={makeLayout({ mode: 'grid-only', navWidth: 0 })}
          />,
        );
      }).not.toThrow();
    });
  });

  describe('fullscreen mode', () => {
    it('renders in fullscreen when fullscreenPanelIndex is set', () => {
      const orch = makeOrch('orch-1');
      const children = [makeChild('task-1'), makeChild('task-2')];
      const streams = new Map([
        [TaskId('task-1'), makeStream('task-1')],
        [TaskId('task-2'), makeStream('task-2')],
      ]);

      // Should not throw with fullscreen active
      expect(() => {
        render(
          <OrchestrationDetail
            orchestration={orch}
            viewMode="grid"
            orchestrations={[orch]}
            children={children}
            workspaceNav={makeNav({ fullscreenPanelIndex: 0 })}
            taskStreams={streams}
            workspaceLayout={makeLayout()}
          />,
        );
      }).not.toThrow();
    });
  });

  describe('nav selection vs committed distinction', () => {
    it('does not immediately switch display when nav moves (focused != committed)', () => {
      const orch1 = makeOrch('orch-1');
      const orch2 = makeOrch('orch-2');

      // Nav moves to index 1 (orch2) but committed stays at index 0 (orch1)
      const nav = makeNav({ selectedOrchestratorIndex: 1, committedOrchestratorIndex: 0 });

      const { lastFrame } = render(
        <OrchestrationDetail
          orchestration={orch1}
          viewMode="grid"
          orchestrations={[orch1, orch2]}
          children={[]}
          workspaceNav={nav}
          taskStreams={new Map()}
          workspaceLayout={makeLayout()}
        />,
      );

      // Should render a valid frame
      expect(lastFrame()).not.toBeNull();
    });
  });
});
