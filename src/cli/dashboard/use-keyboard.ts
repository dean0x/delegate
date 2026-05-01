/**
 * useKeyboard — routes keyboard input to navigation/action handlers
 * ARCHITECTURE: Pure hook — all state changes via setters, no side effects beyond exit()
 * Pattern: Functional core dispatches to immutable state updates
 *
 * This module is intentionally thin (~50 lines). All handler logic lives in keyboard/:
 *  - keyboard/handle-detail-keys.ts    — detail view key routing
 *  - keyboard/handle-workspace-keys.ts — workspace view key routing
 *  - keyboard/handle-main-keys.ts      — main panel key routing
 *  - keyboard/entity-mutations.ts      — unified cancel/delete dispatch
 *  - keyboard/constants.ts             — PANEL_ORDER, FILTER_CYCLES, etc.
 *  - keyboard/helpers.ts               — pure nav helpers
 *  - keyboard/types.ts                 — KeyHandlerParams, UseKeyboardParams
 */

import { useInput } from 'ink';
import { useRef } from 'react';
import { OrchestratorStatus } from '../../core/domain.js';
import { DETAIL_SCROLL_MAX_DEFAULT, ENTITY_BROWSER_VIEWPORT_HEIGHT } from './keyboard/constants.js';
import { handleDetailKeys } from './keyboard/handle-detail-keys.js';
import { handleMainKeys } from './keyboard/handle-main-keys.js';
import { handleWorkspaceKeys } from './keyboard/handle-workspace-keys.js';
import type { UseKeyboardParams } from './keyboard/types.js';

export type { UseKeyboardParams } from './keyboard/types.js';

/**
 * Custom hook wrapping Ink's useInput.
 * Routes keys to handlers based on current view (main, workspace, or detail).
 *
 * Global keys (handled before view dispatch):
 *  - q: quit
 *  - r: refresh
 *  - v: toggle main/workspace; in orchestration detail, scopes workspace to that orchestration
 *  - m: jump to main (works from any view)
 *  - w: jump to workspace (works from any view)
 */
export function useKeyboard({
  view,
  nav,
  data,
  setView,
  setNav,
  refreshNow,
  exit,
  detailContentLength,
  mutations,
  workspaceNav,
  setWorkspaceNav,
  entityBrowserViewportHeight,
}: UseKeyboardParams): void {
  // Keep a ref to the latest data so setNav functional updaters always see
  // current data, not stale closure data from the render that registered useInput.
  const dataRef = useRef(data);
  dataRef.current = data;

  const navigateToWorkspace = (orchestrationId?: import('../../core/domain.js').OrchestratorId) => {
    if (orchestrationId && setWorkspaceNav && dataRef.current?.orchestrations) {
      const idx = dataRef.current.orchestrations.findIndex((o) => o.id === orchestrationId);
      if (idx >= 0) {
        setWorkspaceNav((prev) => ({
          ...prev,
          committedOrchestratorIndex: idx,
          selectedOrchestratorIndex: idx,
        }));
      }
    }
    setView({ kind: 'workspace', orchestrationId });
  };

  useInput((input, key) => {
    // Global keys — handled before view dispatch
    if (input === 'q') {
      exit();
      return;
    }
    if (input === 'r') {
      refreshNow();
      return;
    }

    // v — toggle between main and workspace.
    // Special case: when in orchestration detail, v toggles to workspace scoped to that
    // orchestration (grid mode). When already in workspace, v returns to main.
    // Ignored in non-orchestration detail views — user must Esc first.
    if (input === 'v') {
      if (view.kind === 'detail' && view.entityType === 'orchestrations') {
        navigateToWorkspace(view.entityId);
        return;
      }
      if (view.kind === 'workspace') {
        setView({ kind: 'main' });
        return;
      }
      if (view.kind === 'main') {
        navigateToWorkspace();
        return;
      }
      // Other detail views: ignore v (user must Esc first)
      return;
    }

    // m — jump to main from any view (including detail — acts like Esc→m)
    if (input === 'm') {
      setView({ kind: 'main' });
      return;
    }

    // w — jump to workspace from any view.
    // DECISION: Navigate to workspace only when orchestrations exist. If a running
    // orchestration exists, scope the workspace to it. If none are running, navigate
    // to the most recently created orchestration's detail view in list mode.
    // If no orchestrations exist at all, w is a no-op.
    if (input === 'w') {
      const orchestrations = dataRef.current?.orchestrations;
      if (!orchestrations || orchestrations.length === 0) {
        return;
      }
      const running = orchestrations.find((o) => o.status === OrchestratorStatus.RUNNING);
      if (running) {
        navigateToWorkspace(running.id);
      } else {
        const mostRecent = orchestrations[0];
        if (mostRecent) {
          navigateToWorkspace(mostRecent.id);
        }
      }
      return;
    }

    const params = {
      view,
      nav,
      data,
      dataRef,
      setView,
      setNav,
      detailContentLength: detailContentLength ?? DETAIL_SCROLL_MAX_DEFAULT,
      mutations,
      refreshNow,
      workspaceNav,
      setWorkspaceNav,
      entityBrowserViewportHeight: entityBrowserViewportHeight ?? ENTITY_BROWSER_VIEWPORT_HEIGHT,
    };

    if (view.kind === 'detail') {
      handleDetailKeys(input, key, params);
    } else if (view.kind === 'workspace') {
      handleWorkspaceKeys(input, key, params);
    } else {
      handleMainKeys(input, key, params);
    }
  });
}
