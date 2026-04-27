/**
 * EntityBrowserPanel — replaces CountsPanel, shows scrollable entity list with tabs
 * ARCHITECTURE: Pure component — all state from props
 * Pattern: Tab bar (EntityTabs) + scrollable entity list with filter support
 *
 * Columns (fixed-width via Box):
 *   cursor (2) | icon (2) | shortId (13) | status (11) | elapsed (7) | description (flex)
 *
 * Phase B (Dashboard Visibility Overhaul): Provides first-class pipeline visibility
 * alongside the existing four entity panels in a unified browser interface.
 */

import { Box, Text } from 'ink';
import React from 'react';
import type { Loop, Orchestration, Pipeline, Schedule, Task } from '../../../core/domain.js';
import { formatElapsed, shortId, statusColor, statusIcon } from '../format.js';
import type { Identifiable } from '../keyboard/types.js';
import type { DashboardData, EntityCounts, PanelId } from '../types.js';
import { EntityTabs } from './entity-tabs.js';

// ============================================================================
// Column widths — fixed so all rows align perfectly
// ============================================================================

const COL_CURSOR_W = 2;
const COL_ICON_W = 2;
const COL_ID_W = 13;
const COL_STATUS_W = 11;
const COL_ELAPSED_W = 7;

// ============================================================================
// Entity display helpers
// ============================================================================

interface EntityDisplayFields {
  readonly elapsed: string;
  readonly description: string;
}

/**
 * Extract display fields from the underlying entity object.
 * Returns sensible defaults when the entity or fields are missing.
 */
function getEntityDisplayFields(panelId: PanelId, entityId: string, data: DashboardData | null): EntityDisplayFields {
  if (data === null) return { elapsed: '—', description: '' };

  switch (panelId) {
    case 'tasks': {
      const task = data.tasks.find((t: Task) => t.id === entityId);
      if (!task) return { elapsed: '—', description: '' };
      return {
        elapsed: task.startedAt ? formatElapsed(task.startedAt) : '—',
        description: task.prompt?.slice(0, 60) ?? '',
      };
    }
    case 'loops': {
      const loop = data.loops.find((l: Loop) => l.id === entityId);
      if (!loop) return { elapsed: '—', description: '' };
      return {
        elapsed: formatElapsed(loop.createdAt),
        description: loop.taskTemplate.prompt?.slice(0, 60) ?? '',
      };
    }
    case 'schedules': {
      const schedule = data.schedules.find((s: Schedule) => s.id === entityId);
      if (!schedule) return { elapsed: '—', description: '' };
      return {
        elapsed: '—',
        description: schedule.taskTemplate.prompt?.slice(0, 60) ?? '',
      };
    }
    case 'orchestrations': {
      const orch = data.orchestrations.find((o: Orchestration) => o.id === entityId);
      if (!orch) return { elapsed: '—', description: '' };
      return {
        elapsed: formatElapsed(orch.createdAt),
        description: orch.goal?.slice(0, 60) ?? '',
      };
    }
    case 'pipelines': {
      const pipeline = data.pipelines.find((p: Pipeline) => p.id === entityId);
      if (!pipeline) return { elapsed: '—', description: '' };
      const stepCount = pipeline.steps.length;
      const completedSteps = pipeline.stepTaskIds.filter((id) => id !== null).length;
      return {
        elapsed: formatElapsed(pipeline.createdAt),
        description: `${completedSteps}/${stepCount} steps`,
      };
    }
  }
}

// ============================================================================
// Entity row renderer
// ============================================================================

interface EntityRowProps {
  readonly item: Identifiable;
  readonly isSelected: boolean;
  readonly panelId: PanelId;
  readonly data: DashboardData | null;
}

const EntityRow: React.FC<EntityRowProps> = React.memo(({ item, isSelected, panelId, data }) => {
  const cursor = isSelected ? '▶' : ' ';
  const icon = statusIcon(item.status);
  const id = shortId(item.id);
  const color = statusColor(item.status);
  const statusText = item.status.slice(0, COL_STATUS_W - 1);
  const { elapsed, description } = getEntityDisplayFields(panelId, item.id, data);

  return (
    <Box flexDirection="row">
      <Box width={COL_CURSOR_W}>
        <Text color={isSelected ? 'cyan' : undefined}>{cursor}</Text>
      </Box>
      <Box width={COL_ICON_W}>
        <Text color={color}>{icon}</Text>
      </Box>
      <Box width={COL_ID_W}>
        <Text color={isSelected ? 'cyan' : undefined} bold={isSelected}>
          {id}
        </Text>
      </Box>
      <Box width={COL_STATUS_W}>
        <Text color={color}>{statusText}</Text>
      </Box>
      <Box width={COL_ELAPSED_W}>
        <Text dimColor>{elapsed}</Text>
      </Box>
      <Box flexGrow={1}>
        <Text dimColor wrap="truncate">
          {description}
        </Text>
      </Box>
    </Box>
  );
});

EntityRow.displayName = 'EntityRow';

// ============================================================================
// EntityBrowserPanel
// ============================================================================

interface EntityBrowserPanelProps {
  readonly focusedType: PanelId;
  readonly items: readonly Identifiable[];
  readonly selectedIndex: number;
  readonly scrollOffset: number;
  readonly filterStatus: string | null;
  readonly focused: boolean;
  readonly entityCounts: Record<PanelId, EntityCounts>;
  readonly viewportHeight: number;
  readonly data: DashboardData | null;
}

/**
 * Entity browser panel with tabbed navigation and scrollable list.
 * Shows all entities for the active panel with status-based filtering.
 *
 * Layout:
 *   1. EntityTabs — tab bar at top
 *   2. Scrollable list of entity rows
 *
 * Empty states:
 *   - No entities: "No {type} found" centered, dimColor
 *   - No matching filter: "No {type} matching '{filter}'" with hint
 */
export const EntityBrowserPanel: React.FC<EntityBrowserPanelProps> = React.memo(
  ({ focusedType, items, selectedIndex, scrollOffset, filterStatus, focused, entityCounts, viewportHeight, data }) => {
    const borderColor = focused ? 'cyan' : 'gray';

    // Apply filter
    const filteredItems = filterStatus !== null ? items.filter((item) => item.status === filterStatus) : items;

    // Viewport calculations
    const hasScrollUp = scrollOffset > 0;
    const effectiveHeight = Math.max(1, viewportHeight - 2); // 1 for tabs row, 1 for potential scroll indicator
    const hasScrollDown = scrollOffset + effectiveHeight < filteredItems.length;
    const visibleSlice = filteredItems.slice(scrollOffset, scrollOffset + effectiveHeight);

    const renderBody = () => {
      if (filteredItems.length === 0) {
        if (filterStatus !== null) {
          return (
            <Box flexDirection="column" alignItems="center" flexGrow={1} paddingY={1}>
              <Text dimColor>{`No ${focusedType} matching '${filterStatus}'`}</Text>
              <Text dimColor>{'f to clear filter'}</Text>
            </Box>
          );
        }
        return (
          <Box alignItems="center" justifyContent="center" flexGrow={1}>
            <Text dimColor>{`No ${focusedType} found`}</Text>
          </Box>
        );
      }

      return (
        <Box flexDirection="column" flexGrow={1}>
          {hasScrollUp && <Text dimColor>{' ↑ more'}</Text>}
          {visibleSlice.map((item, idx) => {
            const absoluteIndex = scrollOffset + idx;
            return (
              <EntityRow
                key={item.id}
                item={item}
                isSelected={absoluteIndex === selectedIndex}
                panelId={focusedType}
                data={data}
              />
            );
          })}
          {hasScrollDown && <Text dimColor>{` ↓ ${filteredItems.length - scrollOffset - effectiveHeight} more`}</Text>}
        </Box>
      );
    };

    return (
      <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={borderColor}>
        <EntityTabs activeTab={focusedType} entityCounts={entityCounts} focused={focused} />
        {filterStatus !== null && (
          <Box paddingX={1}>
            <Text color="cyan" dimColor>{`[filter: ${filterStatus}]`}</Text>
          </Box>
        )}
        {renderBody()}
      </Box>
    );
  },
);

EntityBrowserPanel.displayName = 'EntityBrowserPanel';
