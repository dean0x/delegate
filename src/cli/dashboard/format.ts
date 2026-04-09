/**
 * Dashboard format utilities
 * ARCHITECTURE: Pure functions — no side effects, fully testable
 * Pattern: Functional core for all display formatting
 */

import stringWidth from 'string-width';

// ============================================================================
// Time formatting
// ============================================================================

/**
 * Format an epoch ms timestamp as a human-readable relative time string.
 * Handles both past ("2m ago") and future ("in 2m") dates.
 */
export function relativeTime(epochMs: number): string {
  const diffMs = epochMs - Date.now();
  const absDiffMs = Math.abs(diffMs);
  const isFuture = diffMs > 0;

  const seconds = Math.floor(absDiffMs / 1_000);
  const minutes = Math.floor(absDiffMs / 60_000);
  const hours = Math.floor(absDiffMs / 3_600_000);
  const days = Math.floor(absDiffMs / 86_400_000);

  if (seconds < 60) {
    return 'just now';
  }

  if (minutes < 60) {
    return isFuture ? `in ${minutes}m` : `${minutes}m ago`;
  }

  if (hours < 24) {
    return isFuture ? `in ${hours}h` : `${hours}h ago`;
  }

  return isFuture ? `in ${days}d` : `${days}d ago`;
}

// ============================================================================
// Status icons
// ============================================================================

const STATUS_ICONS: Record<string, string> = {
  running: '●',
  active: '●',
  planning: '○',
  queued: '○',
  completed: '✓',
  failed: '✗',
  cancelled: '✗',
  paused: '⏸',
};

/**
 * Map a status string to a Unicode symbol.
 * Returns ○ for unknown statuses.
 */
export function statusIcon(status: string): string {
  return STATUS_ICONS[status] ?? '○';
}

// ============================================================================
// Score trend
// ============================================================================

/**
 * Compute trend arrow for a score comparison.
 * "↑" means improvement (higher for maximize, lower for minimize).
 * "↓" means decline.
 * "→" means stable or no prior score.
 */
export function scoreTrend(current: number, previous: number | undefined, direction: 'minimize' | 'maximize'): string {
  if (previous === undefined) {
    return '→';
  }

  if (current === previous) {
    return '→';
  }

  const improved = direction === 'maximize' ? current > previous : current < previous;

  return improved ? '↑' : '↓';
}

// ============================================================================
// Text truncation
// ============================================================================

/**
 * Truncate a string to maxWidth columns (Unicode-aware via string-width).
 * Appends "…" (single ellipsis char, 1 column) if truncation occurs.
 */
export function truncateCell(text: string, maxWidth: number): string {
  if (stringWidth(text) <= maxWidth) {
    return text;
  }

  // Reserve 1 column for the ellipsis character
  const targetWidth = maxWidth - 1;
  let result = '';
  let currentWidth = 0;

  for (const char of text) {
    const charWidth = stringWidth(char);
    if (currentWidth + charWidth > targetWidth) {
      break;
    }
    result += char;
    currentWidth += charWidth;
  }

  return `${result}…`;
}

// ============================================================================
// Progress formatting
// ============================================================================

/**
 * Format a run progress counter as "current/max" or "current/∞".
 * max of null, undefined, or 0 means unlimited.
 */
export function formatRunProgress(current: number, max: number | null | undefined): string {
  if (!max) {
    return `${current}/∞`;
  }
  return `${current}/${max}`;
}

// ============================================================================
// Panel status summary
// ============================================================================

/**
 * Build a compact status summary string from a status-count map.
 * Zero-count statuses are omitted.
 * Example: "2 running, 1 paused"
 */
export function panelStatusSummary(counts: Record<string, number>): string {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${count} ${status}`)
    .join(', ');
}
