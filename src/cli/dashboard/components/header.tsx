/**
 * Header component — app title, global health summary, refresh time, quit hint
 * ARCHITECTURE: Pure presentational component, no side effects
 */

import { Box, Text } from 'ink';
import React from 'react';
import type { DashboardData } from '../types.js';

interface HeaderProps {
  readonly version: string;
  readonly data: DashboardData | null;
  readonly refreshedAt: Date | null;
  readonly error: string | null;
  /**
   * Phase E: current view kind — drives the breadcrumb label in the header bar.
   * Optional for backward compatibility with tests that don't pass it.
   */
  readonly viewKind?: 'main' | 'workspace' | 'detail';
}

/**
 * Build a global health summary string from all entity counts.
 * Shows running, queued, and failed totals across all entity types
 * including pipelines (Phase B).
 *
 * Running: tasks, loops, active schedules, orchestrations (running+planning), pipelines
 * Queued:  queued tasks, paused loops, paused schedules, pending pipelines
 * Failed:  failed/cancelled tasks/loops/orchestrations/pipelines, cancelled schedules
 */
function buildHealthSummary(data: DashboardData): string {
  const running =
    (data.taskCounts.byStatus['running'] ?? 0) +
    (data.loopCounts.byStatus['running'] ?? 0) +
    (data.scheduleCounts.byStatus['active'] ?? 0) +
    (data.orchestrationCounts.byStatus['running'] ?? 0) +
    (data.orchestrationCounts.byStatus['planning'] ?? 0) +
    (data.pipelineCounts.byStatus['running'] ?? 0);

  const queued =
    (data.taskCounts.byStatus['queued'] ?? 0) +
    (data.loopCounts.byStatus['paused'] ?? 0) +
    (data.scheduleCounts.byStatus['paused'] ?? 0) +
    (data.pipelineCounts.byStatus['pending'] ?? 0);

  const failed =
    (data.taskCounts.byStatus['failed'] ?? 0) +
    (data.loopCounts.byStatus['failed'] ?? 0) +
    (data.scheduleCounts.byStatus['cancelled'] ?? 0) +
    (data.orchestrationCounts.byStatus['failed'] ?? 0) +
    (data.pipelineCounts.byStatus['failed'] ?? 0) +
    (data.pipelineCounts.byStatus['cancelled'] ?? 0);

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

/**
 * Build breadcrumb text for the current view kind.
 * Returns a short label that fits in the header row.
 */
function buildBreadcrumb(viewKind: 'main' | 'workspace' | 'detail' | undefined): string {
  switch (viewKind) {
    case 'main':
      return '[M] Metrics';
    case 'workspace':
      return '[W] Workspace';
    case 'detail':
      return '[D] Detail';
    default:
      return '';
  }
}

export const Header: React.FC<HeaderProps> = React.memo(({ version, data, refreshedAt, error, viewKind }) => {
  const healthSummary = data !== null ? buildHealthSummary(data) : '—';
  const timestamp = refreshedAt !== null ? formatTime(refreshedAt) : '—';
  const breadcrumb = buildBreadcrumb(viewKind);

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" paddingX={1}>
        <Text color="cyan" bold>
          {'Autobeat v'}
          {version}
        </Text>
        <Box flexDirection="row" gap={2}>
          {breadcrumb !== '' && <Text dimColor>{breadcrumb}</Text>}
          <Text>{healthSummary}</Text>
        </Box>
        <Box flexDirection="row" gap={2}>
          <Text dimColor>{timestamp}</Text>
          <Text dimColor>q=quit</Text>
        </Box>
      </Box>
      {error !== null && (
        <Box paddingX={1}>
          <Text color="yellow" dimColor>
            {'⚠ DB error: '}
            {error.length > 80 ? `${error.slice(0, 77)}...` : error}
            {', showing cached data'}
          </Text>
        </Box>
      )}
    </Box>
  );
});

Header.displayName = 'Header';
