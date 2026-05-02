/**
 * MetricsView — redesigned main view for view.kind === 'main'
 * ARCHITECTURE: Stateless view component — all data from props
 * Pattern: Functional core — composes tiles (top row) + entity browser + activity
 *
 * Layout is driven by MetricsLayout from computeMetricsLayout().
 * Degraded modes:
 *   - 'too-small': show resize message
 *   - 'narrow': single-column stack
 *   - 'full': normal tile + browser + activity layout
 */

import { Box, Text } from 'ink';
import React from 'react';
import type { SystemResources } from '../../../core/domain.js';
import { ActivityTile } from '../components/activity-tile.js';
import { EntityBrowserPanel } from '../components/entity-browser-panel.js';
import { ResourcesTile } from '../components/resources-tile.js';
import { StatsTile } from '../components/stats-tile.js';
import { getPanelItems } from '../keyboard/helpers.js';
import type { MetricsLayout } from '../layout.js';
import type { DashboardData, EntityCounts, NavState, PanelId } from '../types.js';

// Zero-value placeholders for when data is not yet available
const ZERO_USAGE = {
  taskId: '' as never,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  totalCostUsd: 0,
  capturedAt: 0,
};

const ZERO_THROUGHPUT = {
  tasksPerHour: 0,
  loopsPerHour: 0,
  successRate: 0,
  avgDurationMs: 0,
};

const ZERO_ENTITY_COUNTS: EntityCounts = { total: 0, byStatus: {} };

interface MetricsViewProps {
  readonly layout: MetricsLayout;
  readonly data: DashboardData | null;
  readonly nav: NavState;
  readonly resourceMetrics: SystemResources | null;
  readonly resourceError: string | null;
}

// ============================================================================
// MetricsView
// ============================================================================

export const MetricsView: React.FC<MetricsViewProps> = React.memo(
  ({ layout, data, nav, resourceMetrics, resourceError }) => {
    // Degraded mode: terminal too small
    if (layout.mode === 'too-small') {
      return (
        <Box flexGrow={1} alignItems="center" justifyContent="center">
          <Text color="yellow">Resize terminal to view metrics (need ≥60 cols × 14 rows)</Text>
        </Box>
      );
    }

    // Degraded mode: narrow terminal — single column stack
    if (layout.mode === 'narrow') {
      return (
        <Box flexDirection="column" flexGrow={1} paddingX={1}>
          <Text dimColor>Narrow terminal — expand to see full dashboard</Text>
          <ResourcesTile resources={resourceMetrics} error={resourceError} />
          <StatsTile
            costRollup24h={data?.costRollup24h ?? ZERO_USAGE}
            top={data?.topOrchestrationsByCost ?? []}
            stats={data?.throughputStats ?? ZERO_THROUGHPUT}
          />
          <ActivityTile activityFeed={data?.activityFeed ?? []} maxEntries={3} />
        </Box>
      );
    }

    // Full metrics layout
    const activityFeed = data?.activityFeed ?? [];
    const topOrchestrationsByCost = data?.topOrchestrationsByCost ?? [];
    const costRollup24h = data?.costRollup24h ?? ZERO_USAGE;
    const throughputStats = data?.throughputStats ?? ZERO_THROUGHPUT;

    // Build entity counts record for EntityBrowserPanel tabs
    const entityCounts: Record<PanelId, EntityCounts> = {
      tasks: data?.taskCounts ?? ZERO_ENTITY_COUNTS,
      loops: data?.loopCounts ?? ZERO_ENTITY_COUNTS,
      schedules: data?.scheduleCounts ?? ZERO_ENTITY_COUNTS,
      orchestrations: data?.orchestrationCounts ?? ZERO_ENTITY_COUNTS,
      pipelines: data?.pipelineCounts ?? ZERO_ENTITY_COUNTS,
    };

    // Get items for the focused panel (applying the current filter for count display)
    const focusedPanel = nav.focusedPanel;
    const panelFilter = nav.filters[focusedPanel];
    const panelItems = data !== null ? getPanelItems(focusedPanel, data) : [];
    const panelSelectedIndex = nav.selectedIndices[focusedPanel];
    const panelScrollOffset = nav.scrollOffsets[focusedPanel];

    // Compute entity browser viewport height from layout
    const browserViewportHeight = Math.max(4, layout.bottomRowHeight - 4);

    return (
      <Box flexDirection="column" flexGrow={1}>
        {/* Top row: 3 equal-width tiles */}
        <Box flexDirection="row" height={layout.topRowHeight}>
          <Box flexGrow={1} flexBasis={0}>
            <ResourcesTile resources={resourceMetrics} error={resourceError} />
          </Box>
          <Box flexGrow={1} flexBasis={0}>
            <StatsTile costRollup24h={costRollup24h} top={topOrchestrationsByCost} stats={throughputStats} />
          </Box>
          <Box flexGrow={1} flexBasis={0}>
            <ActivityTile activityFeed={activityFeed} maxEntries={layout.topRowHeight - 3} />
          </Box>
        </Box>

        {/* Bottom row: entity browser — full width, always focused */}
        <EntityBrowserPanel
          focusedType={focusedPanel}
          items={panelItems}
          selectedIndex={panelSelectedIndex}
          scrollOffset={panelScrollOffset}
          filterStatus={panelFilter}
          focused={true}
          entityCounts={entityCounts}
          viewportHeight={browserViewportHeight}
          data={data}
        />
      </Box>
    );
  },
);

MetricsView.displayName = 'MetricsView';
