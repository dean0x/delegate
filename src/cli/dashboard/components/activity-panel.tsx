/**
 * ActivityPanel — time-sorted activity feed across all entity kinds
 * ARCHITECTURE: Pure component — all state from props
 * Pattern: Uses ScrollableList primitive for consistent scroll behavior
 */

import { Box, Text } from 'ink';
import React from 'react';
import type { ActivityEntry } from '../../../core/domain.js';
import { shortId } from '../format.js';
import { ScrollableList } from './scrollable-list.js';

const VIEWPORT_HEIGHT = 10;

interface ActivityPanelProps {
  readonly activityFeed: readonly ActivityEntry[];
  readonly selectedIndex: number;
  readonly scrollOffset: number;
  readonly focused: boolean;
  /** Called when the user presses Enter on a selected entry */
  readonly onSelect: (entry: ActivityEntry) => void;
}

function formatTime(epochMs: number): string {
  const d = new Date(epochMs);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * Fixed column widths for activity feed alignment.
 * All rows use identical padding so columns align perfectly.
 */
const COL_KIND_W = 5; // 'task '|'loop '|'orch '|'sched'
const COL_ID_W = 8; // shortId output (~8 chars)
const COL_STATUS_W = 11; // 'completed  '|'running    '|'failed     '

function kindLabel(kind: ActivityEntry['kind']): string {
  switch (kind) {
    case 'task':
      return 'task'.padEnd(COL_KIND_W);
    case 'loop':
      return 'loop'.padEnd(COL_KIND_W);
    case 'orchestration':
      return 'orch'.padEnd(COL_KIND_W);
    case 'schedule':
      return 'sched'.padEnd(COL_KIND_W);
  }
}

function renderActivityRow(entry: ActivityEntry, _index: number, isSelected: boolean): React.ReactNode {
  const timeStr = formatTime(entry.timestamp);
  const kind = kindLabel(entry.kind);
  const id = shortId(entry.entityId).padEnd(COL_ID_W);
  const status = entry.status.slice(0, COL_STATUS_W).padEnd(COL_STATUS_W);
  const action = entry.action;

  return (
    <Box key={entry.entityId}>
      <Text bold={isSelected} inverse={isSelected}>
        {timeStr} {kind} {id} {status} {action}
      </Text>
    </Box>
  );
}

export const ActivityPanel: React.FC<ActivityPanelProps> = React.memo(
  ({ activityFeed, selectedIndex, scrollOffset, focused, onSelect }) => {
    const borderColor = focused ? 'cyan' : undefined;

    if (activityFeed.length === 0) {
      return (
        <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={borderColor} paddingX={1}>
          <Text bold={focused} color={focused ? 'cyan' : undefined}>
            Activity
          </Text>
          <Text dimColor>No recent activity</Text>
        </Box>
      );
    }

    return (
      <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={borderColor} paddingX={1}>
        <Text bold={focused} color={focused ? 'cyan' : undefined}>
          Activity
        </Text>
        <ScrollableList
          items={activityFeed as ActivityEntry[]}
          selectedIndex={selectedIndex}
          scrollOffset={scrollOffset}
          viewportHeight={VIEWPORT_HEIGHT}
          renderItem={renderActivityRow}
          keyExtractor={(item) => item.entityId}
        />
      </Box>
    );
  },
);

ActivityPanel.displayName = 'ActivityPanel';
