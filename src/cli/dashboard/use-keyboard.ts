/**
 * useKeyboard — routes keyboard input to navigation/action handlers
 * ARCHITECTURE: Pure hook — all state changes via setters, no side effects beyond exit()
 * Pattern: Functional core dispatches to immutable state updates
 *
 * This module is intentionally thin. All handler logic lives in keyboard/:
 *  - keyboard/handle-detail-keys.ts    — detail view key routing
 *  - keyboard/handle-main-keys.ts      — main panel key routing
 *  - keyboard/entity-mutations.ts      — unified cancel/delete/pause/resume dispatch
 *  - keyboard/constants.ts             — PANEL_ORDER, FILTER_CYCLES, etc.
 *  - keyboard/helpers.ts               — pure nav helpers
 *  - keyboard/types.ts                 — KeyHandlerParams, UseKeyboardParams
 */

import { useInput } from 'ink';
import { useRef } from 'react';
import { DETAIL_SCROLL_MAX_DEFAULT, ENTITY_BROWSER_VIEWPORT_HEIGHT } from './keyboard/constants.js';
import { handleDetailKeys } from './keyboard/handle-detail-keys.js';
import { handleMainKeys } from './keyboard/handle-main-keys.js';
import type { UseKeyboardParams } from './keyboard/types.js';

export type { UseKeyboardParams } from './keyboard/types.js';

/**
 * Custom hook wrapping Ink's useInput.
 * Routes keys to handlers based on current view (main or detail).
 *
 * Global keys (handled before view dispatch):
 *  - q: quit
 *  - r: refresh
 *  - m: jump to main (works from any view)
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
  entityBrowserViewportHeight,
}: UseKeyboardParams): void {
  // Keep a ref to the latest data so setNav functional updaters always see
  // current data, not stale closure data from the render that registered useInput.
  const dataRef = useRef(data);
  dataRef.current = data;

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

    // m — jump to main from any view (including detail — acts like Esc→m)
    if (input === 'm') {
      setView({ kind: 'main' });
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
      entityBrowserViewportHeight: entityBrowserViewportHeight ?? ENTITY_BROWSER_VIEWPORT_HEIGHT,
    };

    if (view.kind === 'detail') {
      handleDetailKeys(input, key, params);
    } else {
      handleMainKeys(input, key, params);
    }
  });
}
