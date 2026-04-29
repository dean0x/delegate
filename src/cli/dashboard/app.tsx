/**
 * Dashboard App root component
 * ARCHITECTURE: Shell — composes data hook, keyboard hook, and view components
 * Pattern: State lives here; pure view components receive data as props
 *
 * DECISION (Phase A): Replaced triple useState (view + nav + workspaceNav) with
 * useReducer(dashboardReducer) so all state transitions are centralised and testable
 * as a pure function. Keyboard handlers retain setView/setNav setter signatures —
 * thin adapters dispatch SET_VIEW / UPDATE_NAV actions so no handler rewrite needed.
 */

import { Box, useApp } from 'ink';
import React, { useCallback, useEffect, useReducer } from 'react';
import type { OutputRepository, ResourceMonitor } from '../../core/interfaces.js';
import type { ReadOnlyContext } from '../read-only-context.js';
import { Footer } from './components/footer.js';
import { Header } from './components/header.js';
import { computeMetricsLayout, computeWorkspaceLayout } from './layout.js';
import { type DashboardState, dashboardReducer } from './nav-reducer.js';
import type { DashboardMutationContext, NavState, ViewState } from './types.js';
import { useDashboardData } from './use-dashboard-data.js';
import { useKeyboard } from './use-keyboard.js';
import { useResourceMetrics } from './use-resource-metrics.js';
import { useTaskOutputStream } from './use-task-output-stream.js';
import { useTerminalSize } from './use-terminal-size.js';
import { DetailView } from './views/detail-view.js';
import { MetricsView } from './views/metrics-view.js';
import { OrchestrationDetail } from './views/orchestration-detail.js';
import { createInitialWorkspaceNavState } from './workspace-types.js';

interface AppProps {
  readonly ctx: ReadOnlyContext;
  readonly version: string;
  /**
   * Optional mutation context. When provided, 'c' and 'd' keybindings are
   * enabled for cancel/delete operations. Omitted in read-only contexts.
   */
  readonly mutations?: DashboardMutationContext;
  /**
   * Optional resource monitor for the resources tile.
   * When provided, useResourceMetrics polls it every 2s.
   */
  readonly resourceMonitor?: ResourceMonitor;
  /**
   * Output repository for live streaming in workspace view.
   * Threaded from index.tsx alongside other repositories.
   */
  readonly outputRepository?: OutputRepository;
}

/** Initial navigation state — focus on tasks panel (most common starting point), no selection, no filters */
const INITIAL_NAV: NavState = {
  focusedPanel: 'tasks',
  selectedIndices: { loops: 0, tasks: 0, schedules: 0, orchestrations: 0, pipelines: 0 },
  filters: { loops: null, tasks: null, schedules: null, orchestrations: null, pipelines: null },
  scrollOffsets: { loops: 0, tasks: 0, schedules: 0, orchestrations: 0, pipelines: 0 },
  orchestrationChildSelectedTaskId: null,
  orchestrationChildPage: 0,
};

const INITIAL_DASHBOARD_STATE: DashboardState = {
  view: { kind: 'main' },
  nav: INITIAL_NAV,
  workspaceNav: createInitialWorkspaceNavState(),
  animFrame: 0,
};

/**
 * Root dashboard component.
 * Renders to stderr via the render() call in index.tsx.
 */
export const App: React.FC<AppProps> = React.memo(({ ctx, version, mutations, resourceMonitor, outputRepository }) => {
  const { exit } = useApp();

  const [state, dispatch] = useReducer(dashboardReducer, INITIAL_DASHBOARD_STATE);
  const { view, nav, workspaceNav, animFrame } = state;

  // Adapter setters — keep keyboard handler signatures stable
  const setView = useCallback((v: ViewState) => dispatch({ type: 'SET_VIEW', view: v }), []);
  const setNav = useCallback((updaterOrValue: NavState | ((prev: NavState) => NavState)) => {
    if (typeof updaterOrValue === 'function') {
      dispatch({ type: 'UPDATE_NAV', updater: updaterOrValue });
    } else {
      dispatch({ type: 'SET_NAV', nav: updaterOrValue });
    }
  }, []);
  const setWorkspaceNav = useCallback(
    (
      updaterOrValue:
        | import('./workspace-types.js').WorkspaceNavState
        | ((
            prev: import('./workspace-types.js').WorkspaceNavState,
          ) => import('./workspace-types.js').WorkspaceNavState),
    ) => {
      if (typeof updaterOrValue === 'function') {
        dispatch({ type: 'UPDATE_WORKSPACE_NAV', updater: updaterOrValue });
      } else {
        dispatch({ type: 'SET_WORKSPACE_NAV', workspaceNav: updaterOrValue });
      }
    },
    [],
  );

  // Shared animation frame counter — single interval drives all StatusBadge animations
  useEffect(() => {
    const timer = setInterval(() => {
      dispatch({ type: 'TICK_ANIM' });
    }, 250);
    return () => clearInterval(timer);
  }, []);

  // Terminal size + layout for responsive rendering
  const terminalSize = useTerminalSize();
  const metricsLayout = computeMetricsLayout(terminalSize);

  // Resource metrics polling (2s interval)
  const { resources: resourceMetrics, error: resourceError } = useResourceMetrics(resourceMonitor);

  const { data, error, refreshedAt, refreshNow } = useDashboardData(ctx, view, nav.orchestrationChildPage);

  // Workspace layout — computed from children count when in workspace view
  const childCount = data?.workspaceData?.children.length ?? 0;
  const workspaceLayout = computeWorkspaceLayout({
    columns: terminalSize.columns,
    rows: terminalSize.rows,
    childCount,
  });

  // Workspace task IDs and statuses for streaming
  const childTaskIds = data?.workspaceData?.childTaskIds ?? [];
  const childTaskStatuses = data?.workspaceData?.childTaskStatuses ?? new Map();

  // Live output streaming — only enabled when in workspace view and outputRepository is available
  // Phase C prep: a future `o` toggle in task detail would also enable streaming here.
  // That requires keyboard handler changes (handle-detail-keys) deferred to a later phase.
  // TODO: When grid/detail mode is fully wired via the 'v' toggle, also enable streaming
  // for orchestration detail in grid mode (view.kind === 'detail' && view.entityType === 'orchestrations').
  const streamingEnabled = view.kind === 'workspace' && outputRepository !== undefined;
  const { streams } = useTaskOutputStream(
    outputRepository ?? ctx.outputRepository,
    childTaskIds,
    childTaskStatuses,
    streamingEnabled,
  );

  useKeyboard({
    view,
    nav,
    data,
    setView,
    setNav,
    refreshNow,
    exit,
    mutations,
    workspaceNav,
    setWorkspaceNav,
  });

  // View dispatcher
  const renderView = (): React.ReactNode => {
    if (view.kind === 'main') {
      return (
        <MetricsView
          layout={metricsLayout}
          data={data}
          nav={nav}
          resourceMetrics={resourceMetrics}
          resourceError={resourceError}
        />
      );
    }

    if (view.kind === 'workspace') {
      if (!data) {
        return null;
      }
      // Phase C: workspace folded into OrchestrationDetail with viewMode='grid'
      // DECISION: Eliminates WorkspaceView as a separate component — detail shows list, workspace shows grid.
      const orchestrations = data.orchestrations;
      const committedOrch = orchestrations[workspaceNav.committedOrchestratorIndex] ?? orchestrations[0];
      const workspaceChildren = data.workspaceData?.children ?? [];
      // Provide a sentinel orchestration when none exist — GridMode handles the empty state via EmptyWorkspace
      const sentinelOrch = committedOrch ?? {
        id: '' as never,
        goal: '',
        status: 'planning' as never,
        agent: undefined,
        model: undefined,
        loopId: undefined,
        maxDepth: 0,
        maxWorkers: 0,
        maxIterations: 0,
        workingDirectory: '',
        stateFilePath: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        completedAt: undefined,
      };
      return (
        <OrchestrationDetail
          orchestration={sentinelOrch as import('../../core/domain.js').Orchestration}
          children={workspaceChildren}
          viewMode="grid"
          orchestrations={orchestrations}
          workspaceNav={workspaceNav}
          taskStreams={streams}
          workspaceLayout={workspaceLayout}
        />
      );
    }

    if (view.kind === 'detail') {
      return (
        <DetailView
          entityType={view.entityType}
          entityId={view.entityId}
          data={data}
          scrollOffset={nav.scrollOffsets[view.entityType]}
          animFrame={animFrame}
          orchestrationChildSelectedTaskId={nav.orchestrationChildSelectedTaskId}
          orchestrationChildPage={nav.orchestrationChildPage}
          orchestrationChildrenTotal={data?.orchestrationChildrenTotal}
        />
      );
    }

    return null;
  };

  return (
    <Box flexDirection="column" width="100%">
      <Header
        version={version}
        data={data}
        refreshedAt={refreshedAt}
        error={error}
        viewKind={view.kind}
        entityType={view.kind === 'detail' ? view.entityType : undefined}
        entityId={view.kind === 'detail' ? view.entityId : undefined}
      />
      {renderView()}
      <Footer viewKind={view.kind} hasMutations={mutations !== undefined} />
    </Box>
  );
});

App.displayName = 'App';
