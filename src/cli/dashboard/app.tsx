/**
 * Dashboard App root component
 * ARCHITECTURE: Shell — composes data hook, keyboard hook, and view components
 * Pattern: State lives here; pure view components receive data as props
 */

import { Box, useApp } from 'ink';
import React, { useCallback, useEffect, useMemo, useReducer } from 'react';
import type { TaskId } from '../../core/domain.js';
import type { OutputRepository, ResourceMonitor } from '../../core/interfaces.js';
import type { Result } from '../../core/result.js';
import type { ReadOnlyContext } from '../read-only-context.js';
import type { DetailOutputConfig } from './components/detail-output-panel.js';
import { Footer } from './components/footer.js';
import { Header } from './components/header.js';
import { resolveSelectedMember } from './keyboard/helpers.js';
import { computeMetricsLayout } from './layout.js';
import { type DashboardState, dashboardReducer } from './nav-reducer.js';
import type { DashboardMutationContext, NavState, ViewState } from './types.js';
import { useChannelPanePreview } from './use-channel-pane-preview.js';
import { useDashboardData } from './use-dashboard-data.js';
import { useKeyboard } from './use-keyboard.js';
import { useResourceMetrics } from './use-resource-metrics.js';
import { useTaskOutputStream } from './use-task-output-stream.js';
import { useTerminalSize } from './use-terminal-size.js';
import { DetailView } from './views/detail-view.js';
import { MetricsView } from './views/metrics-view.js';

interface AppProps {
  readonly ctx: ReadOnlyContext;
  readonly version: string;
  /**
   * Optional mutation context. When provided, 'c', 'd', and 'p' keybindings are
   * enabled for cancel/delete/pause/resume operations. Omitted in read-only contexts.
   */
  readonly mutations?: DashboardMutationContext;
  /**
   * Optional resource monitor for the resources tile.
   * When provided, useResourceMetrics polls it every 2s.
   */
  readonly resourceMonitor?: ResourceMonitor;
  /**
   * Output repository for live streaming in detail views.
   * Threaded from index.tsx alongside other repositories.
   */
  readonly outputRepository?: OutputRepository;
  /**
   * Tmux session liveness check for RUNNING orchestrations.
   * Pass () => false when tmuxSessionManager is unavailable (e.g. test environments).
   */
  readonly isTmuxSessionAlive: (sessionName: string) => boolean;
  /**
   * Optional capture-pane function for channel member live preview.
   * When omitted (e.g. test environments), preview is disabled.
   * Phase 9, epic #184.
   */
  readonly capturePaneContent?: (name: string, lines?: number) => Result<string, Error>;
}

/** Initial navigation state — focus on tasks panel (most common starting point), no selection, no filters */
const INITIAL_NAV: NavState = {
  focusedPanel: 'tasks',
  selectedIndices: { loops: 0, tasks: 0, schedules: 0, orchestrations: 0, pipelines: 0, channels: 0 },
  filters: { loops: null, tasks: null, schedules: null, orchestrations: null, pipelines: null, channels: null },
  scrollOffsets: { loops: 0, tasks: 0, schedules: 0, orchestrations: 0, pipelines: 0, channels: 0 },
  orchestrationChildSelectedTaskId: null,
  orchestrationChildPage: 0,
  detailOutputVisible: true,
  detailOutputAutoTail: true,
  detailOutputScrollOffset: 0,
  loopIterationSelectedNumber: null,
  channelMemberSelectedName: null,
};

const INITIAL_DASHBOARD_STATE: DashboardState = {
  view: { kind: 'main' },
  nav: INITIAL_NAV,
  animFrame: 0,
};

/** Stable empty map used in detail mode to avoid allocating a new Map on every render. */
const EMPTY_STATUS_MAP: ReadonlyMap<TaskId, string> = new Map();

/**
 * Root dashboard component.
 * Renders to stderr via the render() call in index.tsx.
 */
export const App: React.FC<AppProps> = React.memo(
  ({ ctx, version, mutations, resourceMonitor, outputRepository, isTmuxSessionAlive, capturePaneContent }) => {
    const { exit } = useApp();

    const [state, dispatch] = useReducer(dashboardReducer, INITIAL_DASHBOARD_STATE);
    const { view, nav, animFrame } = state;

    // Adapter setters — keep keyboard handler signatures stable
    const setView = useCallback((v: ViewState) => dispatch({ type: 'SET_VIEW', view: v }), []);
    const setNav = useCallback((updaterOrValue: NavState | ((prev: NavState) => NavState)) => {
      if (typeof updaterOrValue === 'function') {
        dispatch({ type: 'UPDATE_NAV', updater: updaterOrValue });
      } else {
        dispatch({ type: 'SET_NAV', nav: updaterOrValue });
      }
    }, []);

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

    const { data, error, refreshedAt, refreshNow } = useDashboardData(
      ctx,
      view,
      nav.orchestrationChildPage,
      isTmuxSessionAlive,
    );

    // Resolve the task ID(s) to stream in detail mode (#165).
    // Task detail: the task itself. Orchestration detail: the selected child (if any).
    const detailStreamTaskId = useMemo((): TaskId | null => {
      if (view.kind !== 'detail' || !outputRepository) return null;
      if (view.entityType === 'tasks') return view.entityId as TaskId;
      if (view.entityType === 'orchestrations' && nav.orchestrationChildSelectedTaskId) {
        return nav.orchestrationChildSelectedTaskId as TaskId;
      }
      return null;
    }, [view, nav.orchestrationChildSelectedTaskId, outputRepository]);

    // Live output streaming for task/orchestration detail views
    const streamingEnabled =
      outputRepository !== undefined &&
      view.kind === 'detail' &&
      detailStreamTaskId !== null &&
      nav.detailOutputVisible &&
      (view.entityType === 'tasks' || view.entityType === 'orchestrations');

    const streamTaskIds = detailStreamTaskId !== null ? [detailStreamTaskId] : [];

    const { streams } = useTaskOutputStream(
      outputRepository ?? ctx.outputRepository,
      streamTaskIds,
      EMPTY_STATUS_MAP,
      streamingEnabled,
    );

    // Extract view primitives to avoid spurious useMemo recomputations on unrelated view changes.
    const viewKind = view.kind;
    const viewEntityType = view.kind === 'detail' ? view.entityType : undefined;
    const viewEntityId = view.kind === 'detail' ? view.entityId : undefined;

    // Resolve the selected channel member's tmux session name for live preview.
    // Only relevant when viewing a channel detail — other views pass null.
    const channelDetailSessionName = useMemo((): string | null => {
      if (viewKind !== 'detail' || viewEntityType !== 'channels') return null;
      const channel = data?.channels.find((c) => c.id === viewEntityId);
      if (channel === undefined) return null;
      const member = resolveSelectedMember(nav.channelMemberSelectedName, channel.members);
      return member?.tmuxSession ?? null;
    }, [viewKind, viewEntityType, viewEntityId, data?.channels, nav.channelMemberSelectedName]);

    // Live capture-pane preview for channel member sessions (Phase 9, #184)
    const { preview: channelPanePreview, error: channelPanePreviewError } = useChannelPanePreview(
      capturePaneContent,
      channelDetailSessionName,
      viewKind === 'detail' && viewEntityType === 'channels',
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
      entityBrowserViewportHeight: Math.max(4, metricsLayout.bottomRowHeight - 4),
    });

    // Resolve the status of the entity currently shown in detail view.
    // Used by Footer to select the correct pause vs resume hint.
    const detailEntityStatus = useMemo(() => {
      if (viewKind !== 'detail') return undefined;
      if (viewEntityType === 'schedules') {
        return data?.schedules.find((s) => s.id === viewEntityId)?.status;
      }
      if (viewEntityType === 'loops') {
        return data?.loops.find((l) => l.id === viewEntityId)?.status;
      }
      if (viewEntityType === 'channels') {
        return data?.channels.find((c) => c.id === viewEntityId)?.status;
      }
      return undefined;
    }, [viewKind, viewEntityType, viewEntityId, data?.schedules, data?.loops, data?.channels]);

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

      if (view.kind === 'detail') {
        const detailOutputConfig: DetailOutputConfig = {
          visible: nav.detailOutputVisible,
          autoTail: nav.detailOutputAutoTail,
          scrollOffset: nav.detailOutputScrollOffset,
          terminalRows: terminalSize.rows,
        };
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
            loopIterationSelectedNumber={nav.loopIterationSelectedNumber}
            taskStreams={streams}
            detailOutputConfig={detailOutputConfig}
            channelMemberSelectedName={nav.channelMemberSelectedName}
            panePreview={channelPanePreview}
            panePreviewError={channelPanePreviewError}
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
        <Footer
          viewKind={view.kind}
          hasMutations={mutations !== undefined}
          entityType={view.kind === 'detail' ? view.entityType : undefined}
          entityStatus={detailEntityStatus}
          focusedPanel={view.kind === 'main' ? nav.focusedPanel : undefined}
        />
      </Box>
    );
  },
);

App.displayName = 'App';
