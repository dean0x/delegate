/**
 * CostTile — displays 24h cost rollup and top orchestrations by cost
 * ARCHITECTURE: Pure component — all state from props
 * Pattern: Functional core — formats numbers, renders text
 */

import { Box, Text } from 'ink';
import React from 'react';
import type { OrchestratorId, TaskUsage } from '../../../core/domain.js';
import { shortId } from '../format.js';

interface TopEntry {
  readonly orchestrationId: OrchestratorId;
  readonly totalCost: number;
}

interface CostTileProps {
  readonly costRollup24h: TaskUsage;
  readonly top: readonly TopEntry[];
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** Format token counts as compact K/M suffixes */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export const CostTile: React.FC<CostTileProps> = React.memo(({ costRollup24h, top }) => {
  const { totalCostUsd, inputTokens, outputTokens, cacheReadInputTokens } = costRollup24h;
  const cacheSavings = cacheReadInputTokens;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Cost (24h)</Text>
      <Text>
        <Text bold>{formatCost(totalCostUsd)}</Text>
      </Text>
      <Text>In {formatTokens(inputTokens)} tok</Text>
      <Text>Out {formatTokens(outputTokens)} tok</Text>
      {cacheSavings > 0 && <Text>Cache {formatTokens(cacheSavings)} saved</Text>}
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

CostTile.displayName = 'CostTile';
