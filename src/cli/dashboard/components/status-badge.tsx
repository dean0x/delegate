/**
 * StatusBadge component — colored status icon + text
 * ARCHITECTURE: Leaf component with optional running animation
 */

import { Text } from 'ink';
import React, { useEffect, useState } from 'react';
import { statusColor, statusIcon } from '../format.js';

/** Dot cycle frames for running animation */
const RUNNING_FRAMES = ['●', '◉', '○', '◉'] as const;

/** Statuses that animate */
const ANIMATED_STATUSES = new Set(['running', 'active', 'planning']);

/**
 * Reduced-motion preference: set AUTOBEAT_REDUCE_MOTION=1 or NO_MOTION=1
 * to disable cycling animation for motion-sensitive users.
 */
const REDUCE_MOTION =
  process.env['AUTOBEAT_REDUCE_MOTION'] === '1' || process.env['NO_MOTION'] === '1';

interface StatusBadgeProps {
  readonly status: string;
  /**
   * Optional shared animation frame counter from a parent interval.
   * When provided, StatusBadge is a pure component (no internal interval).
   * When omitted, the component manages its own 250ms interval.
   */
  readonly animFrame?: number;
}

export const StatusBadge: React.FC<StatusBadgeProps> = React.memo(({ status, animFrame }) => {
  const isAnimated = ANIMATED_STATUSES.has(status) && !REDUCE_MOTION;
  const [internalFrameIdx, setInternalFrameIdx] = useState(0);

  // Only run internal interval when no external animFrame is provided
  useEffect(() => {
    if (!isAnimated || animFrame !== undefined) {
      return;
    }
    const timer = setInterval(() => {
      setInternalFrameIdx((prev) => (prev + 1) % RUNNING_FRAMES.length);
    }, 250);
    return () => clearInterval(timer);
  }, [isAnimated, animFrame]);

  const frameIdx = animFrame !== undefined ? animFrame % RUNNING_FRAMES.length : internalFrameIdx;
  const icon = isAnimated ? (RUNNING_FRAMES[frameIdx] ?? '●') : statusIcon(status);
  const color = statusColor(status);
  return (
    <Text color={color}>
      {icon} {status}
    </Text>
  );
});

StatusBadge.displayName = 'StatusBadge';
