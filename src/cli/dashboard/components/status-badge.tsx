/**
 * StatusBadge component — colored status icon + text
 * ARCHITECTURE: Pure leaf component, no side effects
 */

import { Text } from 'ink';
import React from 'react';
import { statusIcon } from '../format.js';

/**
 * Map a status string to an Ink color name.
 * Covers all domain status values across tasks, loops, schedules, and orchestrations.
 */
export function statusColor(status: string): string {
  switch (status) {
    case 'running':
    case 'active':
    case 'planning':
      return 'cyan';
    case 'completed':
      return 'green';
    case 'failed':
    case 'cancelled':
      return 'red';
    case 'paused':
      return 'yellow';
    case 'queued':
    case 'expired':
    default:
      return 'gray';
  }
}

interface StatusBadgeProps {
  readonly status: string;
}

export const StatusBadge: React.FC<StatusBadgeProps> = React.memo(({ status }) => {
  const icon = statusIcon(status);
  const color = statusColor(status);
  return (
    <Text color={color}>
      {icon} {status}
    </Text>
  );
});

StatusBadge.displayName = 'StatusBadge';
