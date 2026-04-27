/**
 * ThroughputTile — displays task/loop throughput statistics
 * ARCHITECTURE: Pure component — all state from props
 * Pattern: Functional core — formats numbers, renders stats rows
 */

import { Box, Text } from 'ink';
import React from 'react';

interface ThroughputStats {
  readonly tasksPerHour: number;
  readonly loopsPerHour: number;
  readonly successRate: number;
  readonly avgDurationMs: number;
}

interface ThroughputTileProps {
  readonly stats: ThroughputStats;
}

/**
 * Format milliseconds as "Xm Ys" or "Ys" for sub-minute durations.
 * @param ms - Duration in milliseconds
 */
function formatDurationMs(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

export const ThroughputTile: React.FC<ThroughputTileProps> = React.memo(({ stats }) => {
  const { tasksPerHour, loopsPerHour, successRate, avgDurationMs } = stats;
  const successPercent = Math.round(successRate * 100);

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Throughput</Text>
      <Text>Tasks/hr {tasksPerHour}</Text>
      <Text>Loops/hr {loopsPerHour}</Text>
      <Text>Success {successPercent}%</Text>
      <Text>Avg dur {formatDurationMs(avgDurationMs)}</Text>
    </Box>
  );
});

ThroughputTile.displayName = 'ThroughputTile';
