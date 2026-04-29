/**
 * OrchestrationDetail — full-screen orchestration detail view
 * ARCHITECTURE: Pure view component — all data passed as props
 * Pattern: Functional core, no side effects
 *
 * Phase E additions:
 *  - Children list: paginated tasks attributed to this orchestration
 *  - Cost aggregate: total cost/tokens; hidden when all zero (fresh orch)
 *
 * D3 drill-through (v1.3.0):
 *  - ScrollableList with selection highlighting
 *  - Pagination footer when total > page size
 *  - Enter on selected row → navigate to task detail
 *
 * Phase C additions:
 *  - Progress Indicators: depth/workers/children vs config limits
 *  - Grid mode: folds WorkspaceView into this component via viewMode='grid'
 *
 * DECISION (Phase C): WorkspaceView folded into OrchestrationDetail via viewMode='grid'
 * so the workspace is an enriched orchestration detail, not a separate view.
 * When viewMode='grid', orchestration is determined from orchestrations[committedOrchestratorIndex]
 * and the TaskPanel grid is rendered inline with OrchestratorNav.
 */

import { Box, Text } from 'ink';
import React from 'react';
import type { Orchestration, OrchestratorChild, TaskId, TaskUsage } from '../../../core/domain.js';
import { EmptyWorkspace } from '../components/empty-workspace.js';
import { Field, LongField, StatusField } from '../components/field.js';
import { OrchestratorNav } from '../components/orchestrator-nav.js';
import { ScrollableList } from '../components/scrollable-list.js';
import { StatusBadge } from '../components/status-badge.js';
import { TaskPanel } from '../components/task-panel.js';
import { relativeTime, truncateCell } from '../format.js';
import type { WorkspaceLayout } from '../layout.js';
import type { OutputStreamState } from '../use-task-output-stream.js';
import type { WorkspaceNavState } from '../workspace-types.js';

/** Page size for the children list — matches ORCHESTRATION_CHILDREN_PAGE_SIZE in use-dashboard-data */
export const ORCHESTRATION_CHILDREN_PAGE_SIZE = 15;

interface OrchestrationDetailProps {
  readonly orchestration: Orchestration;
  readonly animFrame?: number;
  /** Children tasks attributed to this orchestration (current page). Default: [] */
  readonly children?: readonly OrchestratorChild[];
  /** Aggregated cost/token usage; undefined or all-zero = hidden */
  readonly costAggregate?: TaskUsage;
  /** TaskId of the currently highlighted child row (null or undefined = highlight first) */
  readonly childSelectedTaskId?: string | null;
  /** 0-based page number for pagination footer */
  readonly currentPage?: number;
  /** Total count of all children (across all pages) for pagination footer */
  readonly childrenTotal?: number;
  /**
   * Grid mode: when 'grid', renders the workspace panel grid instead of the list detail view.
   * Default: 'list' — existing behaviour unchanged.
   * DECISION: Folding workspace into orchestration detail keeps view logic co-located
   * and eliminates the separate WorkspaceView component.
   */
  readonly viewMode?: 'list' | 'grid';
  /** All orchestrations — required for OrchestratorNav in grid mode */
  readonly orchestrations?: readonly Orchestration[];
  /** Workspace nav state — required for grid mode (panel focus, page, scroll offsets) */
  readonly workspaceNav?: WorkspaceNavState;
  /** Live output streams — required for grid mode */
  readonly taskStreams?: ReadonlyMap<TaskId, OutputStreamState>;
  /** Workspace layout — required for grid mode */
  readonly workspaceLayout?: WorkspaceLayout;
}

// ============================================================================
// Grid mode helpers (extracted from WorkspaceView, Phase C fold)
// ============================================================================

function getPanelAutoTail(nav: WorkspaceNavState, taskId: TaskId): boolean {
  return nav.autoTailEnabled[taskId] !== false; // default true
}

function getPanelScrollOffset(nav: WorkspaceNavState, taskId: TaskId): number {
  return nav.panelScrollOffsets[taskId] ?? 0;
}

interface GridModeProps {
  readonly orchestrations: readonly Orchestration[];
  readonly children: readonly OrchestratorChild[];
  readonly layout: WorkspaceLayout;
  readonly nav: WorkspaceNavState;
  readonly streams: ReadonlyMap<TaskId, OutputStreamState>;
}

/**
 * Render the TaskPanel grid (workspace mode).
 * Mirrors the grid rendering logic from the former WorkspaceView component.
 */
function renderGrid({ orchestrations, children, layout, nav, streams }: GridModeProps): React.ReactNode {
  const { gridPage } = nav;
  const { visibleSlots, gridCols } = layout;

  const pageStart = gridPage * visibleSlots;
  const pageEnd = pageStart + visibleSlots;
  const visibleChildren = children.slice(pageStart, pageEnd);
  const totalPages = Math.ceil(children.length / visibleSlots);

  // Build a null-valued cost map (per-child cost not yet available)
  const costsByTask = new Map<TaskId, TaskUsage | null>(children.map((c) => [c.taskId, null] as [TaskId, null]));

  // Determine focused orchestration from nav committed index
  const focusedOrchestration = orchestrations[nav.committedOrchestratorIndex] ?? orchestrations[0];

  // Fullscreen mode: render a single panel
  const fullscreenIdx = nav.fullscreenPanelIndex;
  if (fullscreenIdx !== null) {
    const globalIdx = pageStart + fullscreenIdx;
    const child = children[globalIdx];
    if (child) {
      return (
        <Box flexGrow={1} flexDirection="column">
          <TaskPanel
            child={child}
            stream={streams.get(child.taskId)}
            cost={costsByTask.get(child.taskId) ?? null}
            layout={layout}
            focused={true}
            scrollOffset={getPanelScrollOffset(nav, child.taskId)}
            autoTail={getPanelAutoTail(nav, child.taskId)}
          />
        </Box>
      );
    }
  }

  // Header line: orchestration summary
  const orchGoalShort = focusedOrchestration ? truncateCell(focusedOrchestration.goal, 40) : '';
  const headerText = focusedOrchestration
    ? `${focusedOrchestration.id.slice(-8)} · "${orchGoalShort}" · ${focusedOrchestration.status}`
    : '';

  // No children
  if (children.length === 0) {
    return (
      <Box flexDirection="column" flexGrow={1}>
        {headerText !== '' && (
          <Box>
            <Text dimColor>{headerText}</Text>
          </Box>
        )}
        <EmptyWorkspace kind="no-children" layout={layout} />
      </Box>
    );
  }

  // Normal grid: rows of panels
  const rows: React.ReactNode[] = [];
  for (let row = 0; row < layout.displayedGridRows; row++) {
    const rowCells: React.ReactNode[] = [];
    for (let col = 0; col < gridCols; col++) {
      const slotIdx = row * gridCols + col;
      const child = visibleChildren[slotIdx];
      const globalSlotIdx = pageStart + slotIdx;
      const isFocused = nav.focusArea === 'grid' && globalSlotIdx === pageStart + nav.focusedPanelIndex;

      if (!child) {
        rowCells.push(<Box key={`empty-${col}`} width={layout.panelWidth} height={layout.panelHeight} />);
        continue;
      }

      rowCells.push(
        <TaskPanel
          key={child.taskId}
          child={child}
          stream={streams.get(child.taskId)}
          cost={costsByTask.get(child.taskId) ?? null}
          layout={layout}
          focused={isFocused}
          scrollOffset={getPanelScrollOffset(nav, child.taskId)}
          autoTail={getPanelAutoTail(nav, child.taskId)}
        />,
      );
    }
    rows.push(
      <Box key={`row-${row}`} flexDirection="row">
        {rowCells}
      </Box>,
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box>
        <Text dimColor>{headerText}</Text>
      </Box>
      {rows}
      {totalPages > 1 && (
        <Box>
          <Text dimColor>{`Page ${gridPage + 1}/${totalPages} — PgUp/PgDn to paginate`}</Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * Grid mode root — renders the workspace panel layout with optional nav.
 * Mirrors WorkspaceView layout logic (nav+grid / grid-only / too-small).
 */
function GridMode({ orchestrations, children, layout, nav, streams }: GridModeProps): React.ReactElement {
  if (layout.mode === 'too-small') {
    return (
      <Box flexGrow={1} alignItems="center" justifyContent="center">
        <Text color="yellow">Resize terminal to view workspace (need ≥50 cols × 15 rows)</Text>
      </Box>
    );
  }

  if (orchestrations.length === 0) {
    return <EmptyWorkspace kind="no-orchestrators" layout={layout} />;
  }

  const gridContent = renderGrid({ orchestrations, children, layout, nav, streams });

  if (layout.mode === 'grid-only') {
    return (
      <Box flexDirection="column" flexGrow={1}>
        {gridContent}
      </Box>
    );
  }

  // nav+grid mode: left nav + main grid
  return (
    <Box flexDirection="row" flexGrow={1}>
      <Box width={layout.navWidth} flexDirection="column">
        <OrchestratorNav
          orchestrations={orchestrations}
          focusedIndex={nav.selectedOrchestratorIndex}
          committedIndex={nav.committedOrchestratorIndex}
          width={layout.navWidth}
          height={24}
        />
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {gridContent}
      </Box>
    </Box>
  );
}

// ============================================================================
// List mode helpers
// ============================================================================

/**
 * Render a single child row with optional selection highlight.
 */
function renderChildRow(child: OrchestratorChild, _index: number, isSelected: boolean): React.ReactNode {
  const shortId = child.taskId.slice(0, 12);
  const kind = child.kind === 'direct' ? 'direct' : 'iter  ';
  const status = child.status.toString().slice(0, 10).padEnd(10);
  const agent = (child.agent ?? '—').slice(0, 8).padEnd(8);
  const promptPreview = child.prompt.slice(0, 40).replace(/\n/g, ' ');

  const line = `${shortId}  ${kind}  ${status}  ${agent}  ${promptPreview}`;

  return (
    <Text color={isSelected ? 'blue' : undefined} inverse={isSelected} dimColor={!isSelected}>
      {line}
    </Text>
  );
}

/**
 * Cost section — hidden when totalCostUsd === 0 and inputTokens === 0.
 */
function CostSection({ costAggregate }: { readonly costAggregate: TaskUsage | undefined }): React.ReactElement | null {
  if (!costAggregate) return null;
  if (costAggregate.totalCostUsd === 0 && costAggregate.inputTokens === 0) return null;

  const costStr = `$${costAggregate.totalCostUsd.toFixed(2)}`;
  const cacheTokens = (costAggregate.cacheCreationInputTokens ?? 0) + (costAggregate.cacheReadInputTokens ?? 0);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold dimColor>
        Cost
      </Text>
      <Field label="Total">{costStr}</Field>
      <Field label="Tokens in">{String(costAggregate.inputTokens)}</Field>
      <Field label="Tokens out">{String(costAggregate.outputTokens)}</Field>
      {cacheTokens > 0 && <Field label="Cache">{`${cacheTokens} tokens`}</Field>}
    </Box>
  );
}

/**
 * Progress indicators — shown when orchestration has configuration limits.
 * Depth is approximated from children data (not exact tree traversal).
 * DECISION: Workers = running children count; Children = total vs maxTasks limit.
 */
function ProgressSection({
  orchestration,
  children,
  childrenTotal,
}: {
  readonly orchestration: Orchestration;
  readonly children: readonly OrchestratorChild[];
  readonly childrenTotal: number | undefined;
}): React.ReactElement | null {
  const totalChildren = childrenTotal ?? children.length;
  const hasLimits = orchestration.maxDepth > 0 || orchestration.maxWorkers > 0 || orchestration.maxIterations > 0;
  const hasChildrenData = totalChildren > 0;
  if (!hasLimits && !hasChildrenData) return null;

  // Count running children as active workers
  const runningWorkers = children.filter((c) => c.status === 'running').length;

  const parts: string[] = [];
  if (orchestration.maxWorkers > 0) {
    parts.push(`Workers ${runningWorkers}/${orchestration.maxWorkers}`);
  }
  if (orchestration.maxIterations > 0) {
    parts.push(`Iterations ${orchestration.maxIterations} max`);
  }
  if (totalChildren > 0 || childrenTotal !== undefined) {
    parts.push(`Children ${totalChildren}`);
  }

  if (parts.length === 0) return null;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold dimColor>
        Progress
      </Text>
      <Field label="Status">{parts.join(' · ')}</Field>
    </Box>
  );
}

export const OrchestrationDetail: React.FC<OrchestrationDetailProps> = React.memo(
  ({
    orchestration,
    animFrame = 0,
    children = [],
    costAggregate,
    childSelectedTaskId,
    currentPage = 0,
    childrenTotal,
    viewMode = 'list',
    orchestrations,
    workspaceNav,
    taskStreams,
    workspaceLayout,
  }) => {
    // Grid mode: render workspace panel layout
    if (
      viewMode === 'grid' &&
      orchestrations !== undefined &&
      workspaceNav !== undefined &&
      taskStreams !== undefined &&
      workspaceLayout !== undefined
    ) {
      return (
        <GridMode
          orchestrations={orchestrations}
          children={children}
          layout={workspaceLayout}
          nav={workspaceNav}
          streams={taskStreams}
        />
      );
    }

    // Compute selected index: by taskId for stability across refetches; fallback to 0.
    const selectedIndex = React.useMemo(() => {
      if (!childSelectedTaskId || children.length === 0) return 0;
      const idx = children.findIndex((c) => c.taskId === childSelectedTaskId);
      return idx >= 0 ? idx : 0;
    }, [children, childSelectedTaskId]);

    const showPaginationFooter = childrenTotal !== undefined && childrenTotal > children.length && children.length > 0;
    const totalPages = childrenTotal !== undefined ? Math.ceil(childrenTotal / ORCHESTRATION_CHILDREN_PAGE_SIZE) : 1;

    return (
      <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
        {/* Header */}
        <Box marginBottom={1}>
          <Text bold>Orchestration Detail</Text>
        </Box>

        <Field label="ID">{truncateCell(orchestration.id, 60)}</Field>
        <StatusField>
          <StatusBadge status={orchestration.status} animFrame={animFrame} />
        </StatusField>

        {/* Goal (full, wrapped) */}
        <LongField label="Goal" value={orchestration.goal} />

        {orchestration.agent ? <Field label="Agent">{orchestration.agent}</Field> : null}
        {orchestration.model ? <Field label="Model">{orchestration.model}</Field> : null}
        {orchestration.loopId ? <Field label="Loop ID">{truncateCell(orchestration.loopId, 50)}</Field> : null}
        <Field label="Max Depth">{String(orchestration.maxDepth)}</Field>
        <Field label="Max Workers">{String(orchestration.maxWorkers)}</Field>
        <Field label="Max Iterations">{String(orchestration.maxIterations)}</Field>
        <Field label="Working Directory">{truncateCell(orchestration.workingDirectory, 50)}</Field>
        <Field label="State File">{truncateCell(orchestration.stateFilePath, 50)}</Field>
        <Field label="Created">{relativeTime(orchestration.createdAt)}</Field>
        <Field label="Updated">{relativeTime(orchestration.updatedAt)}</Field>
        {orchestration.completedAt !== undefined ? (
          <Field label="Completed">{relativeTime(orchestration.completedAt)}</Field>
        ) : null}

        {/* Cost aggregate — only shown when there is actual usage data */}
        <CostSection costAggregate={costAggregate} />

        {/* Progress indicators — only shown when the orchestration has configuration limits */}
        <ProgressSection orchestration={orchestration} children={children} childrenTotal={childrenTotal} />

        {/* Children section — only shown when the orchestration has attributed tasks */}
        {children.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold dimColor>
              {`Children (${childrenTotal ?? children.length})`}
            </Text>
            <ScrollableList
              items={children}
              selectedIndex={selectedIndex}
              scrollOffset={0}
              viewportHeight={ORCHESTRATION_CHILDREN_PAGE_SIZE}
              renderItem={renderChildRow}
              keyExtractor={(child) => child.taskId}
            />
            {/* Pagination footer — only shown when multiple pages exist */}
            {showPaginationFooter && (
              <Box marginTop={1}>
                <Text dimColor>
                  {`Page ${currentPage + 1} of ${totalPages} · PgUp/PgDn to navigate · ${childrenTotal} total · Enter to drill in`}
                </Text>
              </Box>
            )}
            {/* Drill hint on single page */}
            {!showPaginationFooter && children.length > 0 && (
              <Box marginTop={1}>
                <Text dimColor>Enter to drill into child task detail</Text>
              </Box>
            )}
          </Box>
        )}
      </Box>
    );
  },
);

OrchestrationDetail.displayName = 'OrchestrationDetail';
