/**
 * ActivityTile — compact non-interactive activity feed tile for the top row
 * ARCHITECTURE: Pure component — all state from props
 * Pattern: Functional core — formats timestamps, renders recent activity rows
 *
 * Mirrors the tile pattern (ResourcesTile/StatsTile): no interactive
 * focus state, no scroll, just a bounded snapshot of recent activity.
 */

import { Box, Text } from 'ink';
import React from 'react';
import type { ActivityEntry } from '../../../core/domain.js';
import { formatActivityTime, truncateCell } from '../format.js';

interface ActivityTileProps {
  readonly activityFeed: readonly ActivityEntry[];
  readonly maxEntries?: number;
}

/**
 * Column widths for compact tile layout.
 * time(6) = 'HH:MM ' | kind(14) = 'orchestration ' | status(flex remainder)
 */
const COL_TIME_W = 6;
const COL_KIND_W = 14;

export const ActivityTile: React.FC<ActivityTileProps> = React.memo(({ activityFeed, maxEntries = 5 }) => {
  const entries = activityFeed.slice(-maxEntries).reverse();

  if (entries.length === 0) {
    return (
      <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor="gray" paddingX={1}>
        <Text bold>Activity</Text>
        <Text dimColor>No recent activity</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor="gray" paddingX={1}>
      <Text bold>Activity</Text>
      {entries.map((entry) => {
        const timeStr = formatActivityTime(entry.timestamp);
        const statusText = truncateCell(entry.status, 12);

        return (
          <Box key={`${entry.entityId}-${entry.timestamp}`} flexDirection="row">
            <Box width={COL_TIME_W}>
              <Text dimColor>{timeStr}</Text>
            </Box>
            <Box width={COL_KIND_W}>
              <Text dimColor>{entry.kind}</Text>
            </Box>
            <Text dimColor>{statusText}</Text>
          </Box>
        );
      })}
    </Box>
  );
});

ActivityTile.displayName = 'ActivityTile';
