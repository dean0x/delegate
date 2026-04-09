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
// Status colors and icons
// ============================================================================

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
    case 'triggered':
      return 'green';
    case 'failed':
    case 'cancelled':
    case 'missed':
      return 'red';
    case 'paused':
      return 'yellow';
    case 'queued':
    case 'expired':
    default:
      return 'gray';
  }
}

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
  // ASCII fast-path: avoid stringWidth per-char overhead for common case
  if (/^[\x20-\x7E]*$/.test(text)) {
    if (text.length <= maxWidth) return text;
    return `${text.slice(0, maxWidth - 1)}…`;
  }

  if (stringWidth(text) <= maxWidth) {
    return text;
  }

  // Unicode path: accumulate display width character-by-character (single pass)
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
// Elapsed time and duration formatting
// ============================================================================

/**
 * Format a non-negative millisecond count as a human-readable duration string.
 * Examples: "45s", "2m 30s", "1h 5m"
 */
function formatMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1_000);
  const totalMinutes = Math.floor(totalSeconds / 60);
  const totalHours = Math.floor(totalMinutes / 60);

  if (totalHours > 0) {
    const remainingMinutes = totalMinutes % 60;
    return remainingMinutes > 0 ? `${totalHours}h ${remainingMinutes}m` : `${totalHours}h`;
  }

  if (totalMinutes > 0) {
    const remainingSeconds = totalSeconds % 60;
    return remainingSeconds > 0 ? `${totalMinutes}m ${remainingSeconds}s` : `${totalMinutes}m`;
  }

  return `${totalSeconds}s`;
}

/**
 * Format elapsed time from a start timestamp (epoch ms) to now.
 * Returns human-readable string like "45s", "2m 30s", "1h 5m".
 */
export function formatElapsed(startedAt: number): string {
  const elapsedMs = Date.now() - startedAt;
  return elapsedMs < 0 ? '0s' : formatMs(elapsedMs);
}

/**
 * Format the duration between two epoch ms timestamps (start → end).
 * Returns "—" if either timestamp is undefined.
 * Examples: "45s", "2m 30s", "1h 5m"
 */
export function formatDuration(startedAt: number | undefined, completedAt: number | undefined): string {
  if (startedAt === undefined || completedAt === undefined) {
    return '—';
  }
  return formatMs(completedAt - startedAt);
}

// ============================================================================
// Truncation notice
// ============================================================================

/**
 * Build a truncation notice string when a fetch limit hides items from the user.
 * Returns null when all items are visible (no truncation).
 *
 * Examples:
 *   truncationNotice(50, 247, null)       → "showing 50 of 247"
 *   truncationNotice(5, 15, 'running')    → "showing 5 of 15 running"
 *   truncationNotice(50, 50, null)        → null
 */
export function truncationNotice(
  displayedCount: number,
  totalCount: number,
  filterStatus: string | null,
): string | null {
  if (displayedCount >= totalCount) return null;
  return filterStatus !== null
    ? `showing ${displayedCount} of ${totalCount} ${filterStatus}`
    : `showing ${displayedCount} of ${totalCount}`;
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
