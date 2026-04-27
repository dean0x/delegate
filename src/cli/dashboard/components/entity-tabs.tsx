/**
 * EntityTabs — horizontal tab bar for the entity browser panel
 * ARCHITECTURE: Pure presentational component, no side effects
 * Pattern: Functional core — renders tab bar with count badges
 *
 * Active tab: bold cyan with brackets and running/completed counts.
 * Inactive tabs: dimColor with running count only.
 */

import { Box, Text } from 'ink';
import React from 'react';
import type { EntityCounts, PanelId } from '../types.js';

interface EntityTabsProps {
  readonly activeTab: PanelId;
  readonly entityCounts: Record<PanelId, EntityCounts>;
  readonly focused: boolean;
}

/** Labels for each panel tab — singular, capitalized */
const TAB_LABELS: Record<PanelId, string> = {
  tasks: 'Tasks',
  loops: 'Loops',
  schedules: 'Scheds',
  orchestrations: 'Orchs',
  pipelines: 'Pipes',
};

/**
 * Build a compact count badge string for a panel.
 * Shows running (●) and completed (✓) counts inline.
 * Zero counts are omitted for compactness.
 */
function buildCountBadge(counts: EntityCounts): string {
  const running = counts.byStatus['running'] ?? counts.byStatus['active'] ?? counts.byStatus['planning'] ?? 0;
  const pending = counts.byStatus['pending'] ?? counts.byStatus['queued'] ?? 0;
  const completed = counts.byStatus['completed'] ?? 0;
  const failed = counts.byStatus['failed'] ?? 0;

  const parts: string[] = [];
  if (running > 0) parts.push(`${running}●`);
  if (pending > 0) parts.push(`${pending}○`);
  if (completed > 0) parts.push(`${completed}✓`);
  if (failed > 0) parts.push(`${failed}✗`);

  return parts.length > 0 ? parts.join(' ') : '—';
}

/**
 * Horizontal tab bar showing all entity panels with their count badges.
 * The active tab is highlighted with cyan bold text and brackets.
 * Inactive tabs are dim for visual hierarchy.
 */
export const EntityTabs: React.FC<EntityTabsProps> = React.memo(({ activeTab, entityCounts, focused }) => {
  const panels: readonly PanelId[] = ['tasks', 'loops', 'schedules', 'orchestrations', 'pipelines'];

  return (
    <Box flexDirection="row" gap={1} paddingX={1}>
      {panels.map((panelId) => {
        const isActive = panelId === activeTab;
        const label = TAB_LABELS[panelId];
        const counts = entityCounts[panelId];
        const badge = buildCountBadge(counts);

        if (isActive) {
          return (
            <Text key={panelId} color={focused ? 'cyan' : 'white'} bold>
              {`[${label}(${badge})]`}
            </Text>
          );
        }

        return (
          <Text key={panelId} dimColor>
            {`${label}(${badge})`}
          </Text>
        );
      })}
    </Box>
  );
});

EntityTabs.displayName = 'EntityTabs';
