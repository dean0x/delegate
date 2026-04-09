/**
 * StatusBadge component — colored status icon + text
 * ARCHITECTURE: Leaf component with optional running animation
 */

import { Text } from 'ink';
import React, { useEffect, useState } from 'react';
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

/** Dot cycle frames for running animation */
const RUNNING_FRAMES = ['●', '◉', '○', '◉'] as const;

/** Statuses that animate */
const ANIMATED_STATUSES = new Set(['running', 'active', 'planning']);

interface StatusBadgeProps {
  readonly status: string;
}

export const StatusBadge: React.FC<StatusBadgeProps> = React.memo(({ status }) => {
  const isAnimated = ANIMATED_STATUSES.has(status);
  const [frameIdx, setFrameIdx] = useState(0);

  useEffect(() => {
    if (!isAnimated) {
      return;
    }
    const timer = setInterval(() => {
      setFrameIdx((prev) => (prev + 1) % RUNNING_FRAMES.length);
    }, 250);
    return () => clearInterval(timer);
  }, [isAnimated]);

  const icon = isAnimated ? RUNNING_FRAMES[frameIdx] : statusIcon(status);
  const color = statusColor(status);
  return (
    <Text color={color}>
      {icon} {status}
    </Text>
  );
});

StatusBadge.displayName = 'StatusBadge';
