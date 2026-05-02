/**
 * Context-sensitive key hint strings for the footer help bar.
 * ARCHITECTURE: Pure functions — no side effects, all inputs explicit
 *
 * Centralises hint text here so the Footer component stays a leaf node and
 * any keyboard refactor only needs to update this one file.
 */

/**
 * Return the footer hint string for the main panel view.
 * Includes panel-jump hint (1-5) and optionally c/d mutation hints.
 */
export function mainHints(hasMutations: boolean): string {
  const base = 'v: workspace · Tab: panel · ↑↓: select · Enter: detail · 1-5: panel · f: filter · r refresh · q quit';
  if (hasMutations) {
    return `${base} · c cancel · d delete (terminal)`;
  }
  return base;
}

/**
 * Return the footer hint string for the workspace view (grid mode in OrchestrationDetail).
 * DECISION (Phase C): Workspace is now orchestration detail in grid mode — hints reflect grid navigation.
 */
export function workspaceHints(): string {
  return 'v metrics · ↑↓ orch · Enter grid · Tab panel · f fullscreen · [/] scroll · G tail · c/d · Esc back';
}

/**
 * Return the footer hint string for the detail view.
 */
export function detailHints(): string {
  return 'Esc back · ↑↓ scroll · r refresh · q quit';
}

/**
 * Return the appropriate hint string for the current view kind.
 */
export function getHints(viewKind: 'main' | 'workspace' | 'detail', hasMutations: boolean): string {
  switch (viewKind) {
    case 'main':
      return mainHints(hasMutations);
    case 'workspace':
      return workspaceHints();
    case 'detail':
      return detailHints();
  }
}
