/**
 * Dashboard layout computation — pure functions, no React imports
 * ARCHITECTURE: Functional core — deterministic layout math from terminal dimensions
 * Pattern: Pure functions, trivially unit-testable
 *
 * Two exported functions:
 *  - computeMetricsLayout: tile row + panel row height distribution
 *  - computeWorkspaceLayout: nav/grid/panel dimension allocation
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

export interface WorkspaceLayout {
  readonly mode: 'nav+grid' | 'grid-only' | 'too-small';
  readonly navWidth: number;
  readonly gridCols: 1 | 2 | 3 | 4;
  readonly maxGridRows: 3 | 4;
  readonly visibleSlots: number;
  readonly panelWidth: number;
  readonly panelHeight: number;
  readonly outputViewportHeight: number;
  readonly compactPanel: boolean;
  readonly displayedGridRows: number;
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

// ============================================================================
// computeWorkspaceLayout
// ============================================================================

/**
 * Compute the workspace view layout from terminal dimensions and child count.
 *
 * Layout structure:
 *   - nav+grid: left navigation panel + task grid
 *   - grid-only: task grid only (no nav — used when columns too narrow for nav)
 *   - too-small: fallback message (columns < 50 or rows < 15)
 *
 * The header (2 rows) and footer (1 row) are subtracted from available grid height.
 */
export function computeWorkspaceLayout(args: { columns: number; rows: number; childCount: number }): WorkspaceLayout {
  const { columns, rows, childCount } = args;

  const headerHeight = 2;
  const footerHeight = 1;

  // Degraded modes — return minimal layout
  if (columns < 50 || rows < 15) {
    return {
      mode: 'too-small',
      navWidth: 0,
      gridCols: 1,
      maxGridRows: 3,
      visibleSlots: 3,
      panelWidth: 0,
      panelHeight: 0,
      outputViewportHeight: 0,
      compactPanel: true,
      displayedGridRows: 1,
    };
  }

  const mode: 'nav+grid' | 'grid-only' = columns < 60 ? 'grid-only' : 'nav+grid';

  const navWidth = mode === 'nav+grid' ? clamp(Math.round(columns * 0.2), 20, 32) : 0;
  const gridWidth = columns - navWidth;

  // Grid columns based on grid width
  let gridCols: 1 | 2 | 3 | 4;
  if (gridWidth < 80) {
    gridCols = 1;
  } else if (gridWidth < 120) {
    gridCols = 2;
  } else if (gridWidth < 160) {
    gridCols = 3;
  } else {
    gridCols = 4;
  }

  const maxGridRows: 3 | 4 = rows >= 50 ? 4 : 3;
  const visibleSlots = gridCols * maxGridRows;

  const displayedGridRows = clamp(Math.ceil(Math.max(childCount, 1) / gridCols), 1, maxGridRows);

  // Grid area height = rows minus header/footer
  const gridAreaHeight = rows - headerHeight - footerHeight;

  const panelWidth = Math.floor(gridWidth / gridCols) - 1;
  const panelHeight = Math.floor(gridAreaHeight / displayedGridRows) - 1;
  const outputViewportHeight = panelHeight - 3;
  const compactPanel = panelWidth < 20 || panelHeight < 6;

  return {
    mode,
    navWidth,
    gridCols,
    maxGridRows,
    visibleSlots,
    panelWidth,
    panelHeight,
    outputViewportHeight,
    compactPanel,
    displayedGridRows,
  };
}
