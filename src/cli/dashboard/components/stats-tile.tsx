/**
 * StatsTile — combined cost + throughput highlight card
 * ARCHITECTURE: Pure component — all state from props
 * Pattern: Functional core — formats numbers, renders compact stats
 */

import { Box, Text } from 'ink';
import React from 'react';
import type { OrchestratorId, TaskUsage } from '../../../core/domain.js';
import { formatCost, formatMs, formatTokens, shortId } from '../format.js';

interface TopEntry {
  readonly orchestrationId: OrchestratorId;
  readonly totalCost: number;
}

interface ThroughputStats {
  readonly tasksPerHour: number;
  readonly loopsPerHour: number;
  readonly successRate: number;
  readonly avgDurationMs: number;
}

interface StatsTileProps {
  readonly costRollup24h: TaskUsage;
  readonly top: readonly TopEntry[];
  readonly stats: ThroughputStats;
}

export const StatsTile: React.FC<StatsTileProps> = React.memo(({ costRollup24h, top, stats }) => {
  const { totalCostUsd, inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens } = costRollup24h;
  const { tasksPerHour, loopsPerHour, successRate, avgDurationMs } = stats;
  const successPercent = Math.round(successRate * 100);

  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor="gray" paddingX={1}>
      <Text bold>Stats</Text>
      <Text>
        <Text bold>{formatCost(totalCostUsd)}</Text> In {formatTokens(inputTokens)} Out {formatTokens(outputTokens)}
      </Text>
      {cacheCreationInputTokens > 0 && <Text dimColor>Cache create {formatTokens(cacheCreationInputTokens)}</Text>}
      {cacheReadInputTokens > 0 && <Text dimColor>Cache read {formatTokens(cacheReadInputTokens)}</Text>}
      <Text>
        {tasksPerHour} tasks/hr {loopsPerHour} loops/hr
      </Text>
      <Text>
        Success {successPercent}% Avg {formatMs(avgDurationMs)}
      </Text>
      {top.length > 0 && (
        <Box flexDirection="column">
          <Text dimColor>Top:</Text>
          {top.slice(0, 3).map((entry) => (
            <Text key={entry.orchestrationId}>
              {' '}
              {shortId(entry.orchestrationId)} {formatCost(entry.totalCost)}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
});

StatsTile.displayName = 'StatsTile';
