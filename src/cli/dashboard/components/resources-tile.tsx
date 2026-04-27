/**
 * ResourcesTile — displays system resource utilization
 * ARCHITECTURE: Pure component — all state from props
 * Pattern: Bar chart via unicode block characters (█ ░)
 */

import { Box, Text } from 'ink';
import React from 'react';
import type { SystemResources } from '../../../core/domain.js';

interface ResourcesTileProps {
  readonly resources: SystemResources | null;
  readonly error: string | null;
}

const BAR_WIDTH = 10;
const BAR_FILLED = '█';
const BAR_EMPTY = '░';

function renderBar(percent: number): string {
  const filled = Math.round((percent / 100) * BAR_WIDTH);
  return BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(BAR_WIDTH - filled);
}

function barColor(percent: number): string {
  if (percent >= 80) return 'red';
  if (percent >= 50) return 'yellow';
  return 'green';
}

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)}GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)}MB`;
}

export const ResourcesTile: React.FC<ResourcesTileProps> = React.memo(({ resources, error: _error }) => {
  if (resources === null) {
    return (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text bold>Resources</Text>
        <Text>CPU —</Text>
        <Text>Mem —</Text>
        <Text>Workers —</Text>
        <Text>Load —</Text>
      </Box>
    );
  }

  const { cpuUsage, availableMemory, totalMemory, loadAverage, workerCount } = resources;
  const memUsedPercent = totalMemory > 0 ? ((totalMemory - availableMemory) / totalMemory) * 100 : 0;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Resources</Text>
      <Box>
        <Text>CPU </Text>
        <Text color={barColor(cpuUsage)}>{renderBar(cpuUsage)}</Text>
        <Text> {cpuUsage.toFixed(0)}%</Text>
      </Box>
      <Box>
        <Text>Mem </Text>
        <Text color={barColor(memUsedPercent)}>{renderBar(memUsedPercent)}</Text>
        <Text> {formatBytes(availableMemory)} free</Text>
      </Box>
      <Text>Workers {workerCount}</Text>
      <Text>
        Load {loadAverage[0].toFixed(1)} {loadAverage[1].toFixed(1)} {loadAverage[2].toFixed(1)}
      </Text>
    </Box>
  );
});

ResourcesTile.displayName = 'ResourcesTile';
