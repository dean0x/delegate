/**
 * Header component — app title, global health summary, refresh time, quit hint
 * ARCHITECTURE: Pure presentational component, no side effects
 */

import { Box, Text } from 'ink';
import React from 'react';
import type { DashboardData } from '../types.js';

interface HeaderProps {
  readonly data: DashboardData | null;
  readonly refreshedAt: Date | null;
  readonly error: string | null;
}

/**
 * Build a global health summary string from all entity counts.
 * Shows running, queued, and failed totals across all entity types.
 */
function buildHealthSummary(data: DashboardData): string {
  const running =
    (data.taskCounts.byStatus['running'] ?? 0) +
    (data.loopCounts.byStatus['running'] ?? 0) +
    (data.scheduleCounts.byStatus['active'] ?? 0) +
    (data.orchestrationCounts.byStatus['running'] ?? 0) +
    (data.orchestrationCounts.byStatus['planning'] ?? 0);

  const queued =
    (data.taskCounts.byStatus['queued'] ?? 0) +
    (data.loopCounts.byStatus['paused'] ?? 0) +
    (data.scheduleCounts.byStatus['paused'] ?? 0);

  const failed =
    (data.taskCounts.byStatus['failed'] ?? 0) +
    (data.loopCounts.byStatus['failed'] ?? 0) +
    (data.scheduleCounts.byStatus['cancelled'] ?? 0) +
    (data.orchestrationCounts.byStatus['failed'] ?? 0);

  const parts: string[] = [];
  if (running > 0) parts.push(`●${running} run`);
  if (queued > 0) parts.push(`○${queued} queue`);
  if (failed > 0) parts.push(`✗${failed} fail`);

  return parts.length > 0 ? parts.join(' · ') : 'idle';
}

/**
 * Format a Date as HH:MM timestamp.
 */
function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export const Header: React.FC<HeaderProps> = React.memo(({ data, refreshedAt, error }) => {
  const healthSummary = data !== null ? buildHealthSummary(data) : '—';
  const timestamp = refreshedAt !== null ? formatTime(refreshedAt) : '—';

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" paddingX={1}>
        <Text color="cyan" bold>
          Autobeat
        </Text>
        <Text>{healthSummary}</Text>
        <Box flexDirection="row" gap={2}>
          <Text dimColor>{timestamp}</Text>
          <Text dimColor>q=quit</Text>
        </Box>
      </Box>
      {error !== null && (
        <Box paddingX={1}>
          <Text color="yellow" dimColor>
            {'⚠ DB error: '}
            {error}
            {', showing cached data'}
          </Text>
        </Box>
      )}
    </Box>
  );
});

Header.displayName = 'Header';
