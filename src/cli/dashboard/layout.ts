/**
 * Dashboard layout computation — pure functions, no React imports
 * ARCHITECTURE: Functional core — deterministic layout math from terminal dimensions
 * Pattern: Pure functions, trivially unit-testable
 */

// ============================================================================
// Types
// ============================================================================

export interface MetricsLayout {
  readonly headerHeight: 2;
  readonly footerHeight: 1;
  readonly availableHeight: number;
  readonly topRowHeight: number;
  readonly bottomRowHeight: number;
  readonly tileCount: 2 | 3 | 4;
  readonly mode: 'full' | 'narrow' | 'too-small';
}

// ============================================================================
// Helpers
// ============================================================================

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// ============================================================================
// computeMetricsLayout
// ============================================================================

/**
 * Compute the metrics view layout from terminal dimensions.
 *
 * Layout structure:
 *   - headerHeight: always 2 rows (app header)
 *   - footerHeight: always 1 row (keyboard help)
 *   - topRowHeight: tile row (Resources/Cost/Throughput tiles)
 *   - bottomRowHeight: panel row (Activity + Counts)
 *
 * Degraded modes:
 *   - 'too-small': rows < 14 — show "resize terminal" message
 *   - 'narrow': columns < 60 — single column stack layout
 *   - 'full': normal layout
 */
export function computeMetricsLayout(args: { columns: number; rows: number }): MetricsLayout {
  const { columns, rows } = args;

  const headerHeight = 2 as const;
  const footerHeight = 1 as const;
  const availableHeight = rows - headerHeight - footerHeight;

  const topRowHeight = clamp(Math.floor(availableHeight * 0.35), 8, 14);
  const bottomRowHeight = availableHeight - topRowHeight;

  const tileCount: 2 | 3 | 4 = columns >= 120 ? 4 : columns >= 90 ? 3 : 2;

  // Mode priority: too-small wins over narrow
  let mode: 'full' | 'narrow' | 'too-small';
  if (rows < 14) {
    mode = 'too-small';
  } else if (columns < 60) {
    mode = 'narrow';
  } else {
    mode = 'full';
  }

  return {
    headerHeight,
    footerHeight,
    availableHeight,
    topRowHeight,
    bottomRowHeight,
    tileCount,
    mode,
  };
}

// ============================================================================
// computeDetailOutputLayout
// ============================================================================

export interface DetailOutputLayout {
  /** Number of terminal rows available for the output viewport */
  readonly outputViewportHeight: number;
  /** True when there is insufficient space to show output meaningfully (< 5 rows) */
  readonly tooSmall: boolean;
}

/**
 * Compute the output viewport height for a task or orchestration detail view.
 *
 * Layout structure (chrome = 4 rows):
 *   - header: 2 rows
 *   - footer: 1 row
 *   - separator between metadata and output: 1 row
 *
 * Available rows = rows - metadataHeight - chrome.
 * When available < 5, the terminal is too small to render the output usefully.
 *
 * DECISION (#165): Pure function so it can be tested without React mounting.
 * The metadataHeight is measured via Ink's measureElement() in the view components.
 */
export function computeDetailOutputLayout(args: { rows: number; metadataHeight: number }): DetailOutputLayout {
  const chrome = 4; // header(2) + footer(1) + separator(1)
  const available = args.rows - args.metadataHeight - chrome;
  if (available < 5) return { outputViewportHeight: 0, tooSmall: true };
  return { outputViewportHeight: available, tooSmall: false };
}
