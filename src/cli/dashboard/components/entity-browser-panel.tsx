/**
 * EntityBrowserPanel — replaces CountsPanel, shows scrollable entity list with tabs
 * ARCHITECTURE: Pure component — all state from props
 * Pattern: Tab bar (EntityTabs) + scrollable entity list with filter support
 *
 * Columns (fixed-width via Box):
 *   cursor (2) | icon (2) | shortId (13) | status (11) | elapsed (9) | agent (8) | description (flex)
 *
 * Phase B (Dashboard Visibility Overhaul): Provides first-class pipeline visibility
 * alongside the existing four entity panels in a unified browser interface.
 */

import { Box, Text } from 'ink';
import React from 'react';
import { formatElapsed, shortId, statusColor, statusIcon, truncateCell } from '../format.js';
import type { Identifiable } from '../keyboard/types.js';
import type { DashboardData, EntityCounts, PanelId } from '../types.js';
import { FETCH_LIMIT } from '../use-dashboard-data.js';
import { EntityTabs } from './entity-tabs.js';

// ============================================================================
// Column widths — fixed so all rows align perfectly
// ============================================================================

const COL_CURSOR_W = 2;
const COL_ICON_W = 2;
const COL_ID_W = 13;
const COL_STATUS_W = 11;
const COL_ELAPSED_W = 9;
const COL_AGENT_W = 8;

// ============================================================================
// Entity display helpers
// ============================================================================

interface EntityDisplayFields {
  readonly elapsed: string;
  readonly agent: string;
  readonly description: string;
}

const EMPTY_FIELDS: EntityDisplayFields = { elapsed: '—', agent: '—', description: '' };

/**
 * Find an item by id and map it to display fields, returning EMPTY_FIELDS when
 * the item is absent. Eliminates the repeated find-guard-return pattern across
 * every switch arm in getEntityDisplayFields.
 */
function findAndMap<T>(
  items: readonly T[],
  predicate: (item: T) => boolean,
  mapper: (item: T) => EntityDisplayFields,
): EntityDisplayFields {
  const item = items.find(predicate);
  return item !== undefined ? mapper(item) : EMPTY_FIELDS;
}

/**
 * Extract display fields from the underlying entity object.
 * Returns sensible defaults when the entity or fields are missing.
 */
function getEntityDisplayFields(panelId: PanelId, entityId: string, data: DashboardData | null): EntityDisplayFields {
  if (data === null) return EMPTY_FIELDS;

  switch (panelId) {
    case 'tasks':
      return findAndMap(
        data.tasks,
        (t) => t.id === entityId,
        (task) => ({
          elapsed: task.startedAt ? formatElapsed(task.startedAt) : '—',
          agent: task.agent ?? '—',
          description: truncateCell(task.prompt ?? '', 60),
        }),
      );
    case 'loops':
      return findAndMap(
        data.loops,
        (l) => l.id === entityId,
        (loop) => ({
          elapsed: formatElapsed(loop.createdAt),
          agent: loop.taskTemplate.agent ?? '—',
          description: truncateCell(loop.taskTemplate.prompt ?? '', 60),
        }),
      );
    case 'schedules':
      return findAndMap(
        data.schedules,
        (s) => s.id === entityId,
        (schedule) => ({
          elapsed: '—',
          agent: schedule.taskTemplate.agent ?? '—',
          description: truncateCell(schedule.taskTemplate.prompt ?? '', 60),
        }),
      );
    case 'orchestrations':
      return findAndMap(
        data.orchestrations,
        (o) => o.id === entityId,
        (orch) => ({
          elapsed: formatElapsed(orch.createdAt),
          agent: orch.agent ?? '—',
          description: truncateCell(orch.goal ?? '', 60),
        }),
      );
    case 'pipelines':
      return findAndMap(
        data.pipelines,
        (p) => p.id === entityId,
        (pipeline) => {
          const stepCount = pipeline.steps.length;
          const assignedSteps = pipeline.stepTaskIds.filter((id) => id !== null).length;
          return {
            elapsed: formatElapsed(pipeline.createdAt),
            agent: pipeline.agent ?? '—',
            description: `${assignedSteps}/${stepCount} assigned`,
          };
        },
      );
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
  const statusText = truncateCell(item.status, COL_STATUS_W - 1);
  const { elapsed, agent, description } = getEntityDisplayFields(panelId, item.id, data);
  const elapsedText = truncateCell(elapsed, COL_ELAPSED_W - 1);
  const agentText = truncateCell(agent, COL_AGENT_W - 1);

  return (
    <Box flexDirection="row" overflow="hidden">
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
        <Text dimColor>{elapsedText}</Text>
      </Box>
      <Box width={COL_AGENT_W}>
        <Text dimColor>{agentText}</Text>
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

    const body =
      filteredItems.length === 0 ? (
        filterStatus !== null ? (
          <Box flexDirection="column" alignItems="center" flexGrow={1} paddingY={1}>
            <Text dimColor>{`No ${focusedType} matching '${filterStatus}'`}</Text>
            <Text dimColor>{'f to clear filter'}</Text>
          </Box>
        ) : (
          <Box alignItems="center" justifyContent="center" flexGrow={1}>
            <Text dimColor>{`No ${focusedType} found`}</Text>
          </Box>
        )
      ) : (
        <Box flexDirection="column" flexGrow={1}>
          {hasScrollUp && <Text dimColor>{' ↑ more'}</Text>}
          {visibleSlice.map((item, idx) => (
            <EntityRow
              key={item.id}
              item={item}
              isSelected={scrollOffset + idx === selectedIndex}
              panelId={focusedType}
              data={data}
            />
          ))}
          {hasScrollDown && <Text dimColor>{` ↓ ${filteredItems.length - scrollOffset - effectiveHeight} more`}</Text>}
        </Box>
      );

    return (
      <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={borderColor}>
        <EntityTabs activeTab={focusedType} entityCounts={entityCounts} focused={focused} />
        {filterStatus !== null && (
          <Box paddingX={1}>
            <Text color="cyan" dimColor>{`[filter: ${filterStatus}]`}</Text>
          </Box>
        )}
        {body}
        {items.length >= FETCH_LIMIT && (
          <Box paddingX={1}>
            <Text dimColor>{`Showing first ${FETCH_LIMIT} — more items exist`}</Text>
          </Box>
        )}
      </Box>
    );
  },
);

EntityBrowserPanel.displayName = 'EntityBrowserPanel';
