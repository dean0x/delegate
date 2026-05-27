/**
 * Key handler for the detail view.
 *
 * Scope: view.kind === 'detail'. Handles Esc/Backspace to return to the
 * previous view, D3 orchestration drill-through child row navigation
 * (↑/↓/Enter/PgUp/PgDn), loop iteration navigation (↑/↓/Enter),
 * output stream controls (o/[/]/g/G), and scroll for non-orchestration detail content.
 */

import { ORCHESTRATION_CHILDREN_PAGE_SIZE } from '../views/orchestration-detail.js';
import { pauseOrResumeEntity } from './entity-mutations.js';
import { resolveChildIndex, resolveIterationIndex } from './helpers.js';
import type { InkKey, KeyHandlerParams } from './types.js';

// ─── Section handlers ────────────────────────────────────────────────────────

/**
 * 1. Esc/Backspace — return to the view that opened this detail.
 *
 * D3 drill-through Esc: return to the parent orchestration or loop detail.
 * Otherwise: return to main.
 */
function handleEscReturn(key: InkKey, params: KeyHandlerParams): boolean {
  const { view, setView } = params;
  if (view.kind !== 'detail') return false;
  if (!key.escape && !key.backspace) return false;

  const returnTo = view.returnTo ?? 'main';
  if (typeof returnTo === 'object' && returnTo.kind === 'orchestrations') {
    // D3 drill-through Esc: return to the parent orchestration detail
    setView({
      kind: 'detail',
      entityType: 'orchestrations',
      entityId: returnTo.entityId,
      returnTo: returnTo.originalReturnTo,
    });
  } else if (typeof returnTo === 'object' && returnTo.kind === 'loops') {
    // #168: loop drill-through Esc: return to the parent loop detail
    setView({
      kind: 'detail',
      entityType: 'loops',
      entityId: returnTo.entityId,
      returnTo: returnTo.originalReturnTo,
    });
  } else {
    setView({ kind: 'main' });
  }
  return true;
}

/**
 * 2. Output stream controls — guarded to task/orchestration entity types (#165).
 *
 *  - o: toggle output stream panel visibility
 *  - [: scroll output up (enters paused mode)
 *  - ]: scroll output down (enters paused mode)
 *  - g: jump to top of output (paused mode)
 *  - G: jump to tail (re-engages auto-tail)
 *
 * OutputStreamView clamps the visual offset internally; the upper bound is not
 * tracked here because the key handler has no access to the live line count.
 */
function handleOutputControls(input: string, params: KeyHandlerParams): boolean {
  const { view, setNav } = params;
  if (view.kind !== 'detail') return false;
  if (view.entityType !== 'tasks' && view.entityType !== 'orchestrations') return false;

  if (input === 'o') {
    setNav((prev) => ({ ...prev, detailOutputVisible: !prev.detailOutputVisible }));
    return true;
  }
  if (input === '[') {
    setNav((prev) => ({
      ...prev,
      detailOutputScrollOffset: Math.max(0, prev.detailOutputScrollOffset - 1),
      detailOutputAutoTail: false,
    }));
    return true;
  }
  if (input === ']') {
    setNav((prev) => ({
      ...prev,
      detailOutputScrollOffset: prev.detailOutputScrollOffset + 1,
      detailOutputAutoTail: false,
    }));
    return true;
  }
  if (input === 'G') {
    setNav((prev) => ({ ...prev, detailOutputScrollOffset: 0, detailOutputAutoTail: true }));
    return true;
  }
  if (input === 'g') {
    setNav((prev) => ({ ...prev, detailOutputScrollOffset: 0, detailOutputAutoTail: false }));
    return true;
  }

  return false;
}

/**
 * 3. Pause/resume toggle for schedules and loops.
 *
 *  - p: pause (active schedule / running loop) or resume (paused schedule / loop)
 *  - Silently consumed for non-pauseable entity types.
 */
function handlePauseResume(input: string, params: KeyHandlerParams): boolean {
  if (input !== 'p') return false;
  const { view, mutations, refreshNow, dataRef } = params;
  if (view.kind !== 'detail' || !mutations) return true;

  if (view.entityType === 'schedules') {
    const schedule = dataRef.current?.schedules.find((s) => s.id === view.entityId);
    if (schedule) {
      void pauseOrResumeEntity('schedule', view.entityId, schedule.status, mutations, refreshNow);
    }
  } else if (view.entityType === 'loops') {
    const loop = dataRef.current?.loops.find((l) => l.id === view.entityId);
    if (loop) {
      void pauseOrResumeEntity('loop', view.entityId, loop.status, mutations, refreshNow);
    }
  }
  return true;
}

/**
 * 4. Loop detail: iteration row navigation (#168).
 *
 *  - ↑/k: move selection up
 *  - ↓/j: move selection down
 *  - Enter: drill into the selected iteration's task detail (returnTo = loop object)
 *  - Any other key: swallowed (no fallthrough)
 */
function handleLoopNavigation(input: string, key: InkKey, params: KeyHandlerParams): boolean {
  const { view, nav, setView, setNav } = params;
  if (view.kind !== 'detail') return false;
  if (view.entityType !== 'loops') return false;

  const iterations = params.dataRef.current?.iterations ?? [];

  if (key.upArrow || input === 'k') {
    if (iterations.length === 0) return true;
    setNav((prev) => {
      const currentIdx = resolveIterationIndex(prev.loopIterationSelectedNumber, iterations);
      const nextIdx = Math.max(0, currentIdx - 1);
      return { ...prev, loopIterationSelectedNumber: iterations[nextIdx]?.iterationNumber ?? null };
    });
    return true;
  }

  if (key.downArrow || input === 'j') {
    if (iterations.length === 0) return true;
    setNav((prev) => {
      const currentIdx = resolveIterationIndex(prev.loopIterationSelectedNumber, iterations);
      const nextIdx = Math.min(iterations.length - 1, currentIdx + 1);
      return { ...prev, loopIterationSelectedNumber: iterations[nextIdx]?.iterationNumber ?? null };
    });
    return true;
  }

  if (key.return) {
    // Enter: drill into the selected iteration's task detail
    if (iterations.length === 0) return true;
    const selectedIdx = resolveIterationIndex(nav.loopIterationSelectedNumber, iterations);
    const iter = iterations[selectedIdx];
    if (!iter || !iter.taskId) return true; // guard: no taskId means nothing to drill into
    setView({
      kind: 'detail',
      entityType: 'tasks',
      entityId: iter.taskId,
      returnTo: {
        kind: 'loops',
        entityId: view.entityId,
        originalReturnTo: 'main',
      },
    });
    return true;
  }

  // Any other key in loop detail is swallowed (no fallthrough to main handler)
  return true;
}

/**
 * 5. D3 orchestration detail: child row navigation + drill-through.
 *
 *  - ↑/k: move child selection up
 *  - ↓/j: move child selection down
 *  - Enter: drill into the selected child task detail (returnTo = orchestration object)
 *  - PgUp/PgDn: navigate pages of children (resets selection to first row on page)
 *  - Any other key: swallowed (no fallthrough)
 */
function handleOrchestrationNavigation(input: string, key: InkKey, params: KeyHandlerParams): boolean {
  const { view, nav, setView, setNav, refreshNow } = params;
  if (view.kind !== 'detail') return false;
  if (view.entityType !== 'orchestrations') return false;

  const children = params.dataRef.current?.orchestrationChildren ?? [];
  const childrenTotal = params.dataRef.current?.orchestrationChildrenTotal;

  if (key.upArrow || input === 'k') {
    if (children.length === 0) return true;
    setNav((prev) => {
      const nextIdx = Math.max(0, resolveChildIndex(prev.orchestrationChildSelectedTaskId, children) - 1);
      return {
        ...prev,
        orchestrationChildSelectedTaskId: children[nextIdx]?.taskId ?? null,
        detailOutputAutoTail: true,
        detailOutputScrollOffset: 0,
      };
    });
    return true;
  }

  if (key.downArrow || input === 'j') {
    if (children.length === 0) return true;
    setNav((prev) => {
      const nextIdx = Math.min(
        children.length - 1,
        resolveChildIndex(prev.orchestrationChildSelectedTaskId, children) + 1,
      );
      return {
        ...prev,
        orchestrationChildSelectedTaskId: children[nextIdx]?.taskId ?? null,
        detailOutputAutoTail: true,
        detailOutputScrollOffset: 0,
      };
    });
    return true;
  }

  if (key.return) {
    // Enter: drill into the selected child task detail
    if (children.length === 0) return true;
    const child = children[resolveChildIndex(nav.orchestrationChildSelectedTaskId, children)];
    if (!child) return true;
    setView({
      kind: 'detail',
      entityType: 'tasks',
      entityId: child.taskId,
      returnTo: {
        kind: 'orchestrations',
        entityId: view.entityId,
        originalReturnTo: 'main',
      },
    });
    return true;
  }

  if (key.pageUp) {
    setNav((prev) => {
      const newPage = Math.max(0, prev.orchestrationChildPage - 1);
      if (newPage === prev.orchestrationChildPage) return prev;
      return { ...prev, orchestrationChildPage: newPage, orchestrationChildSelectedTaskId: null };
    });
    // The useDashboardData effect auto-refetches when orchestrationChildPage
    // changes; refreshNow() is called as a belt-and-braces signal so any
    // listener (telemetry, manual indicator) also sees the page-change event.
    refreshNow();
    return true;
  }

  if (key.pageDown) {
    const totalPages = childrenTotal !== undefined ? Math.ceil(childrenTotal / ORCHESTRATION_CHILDREN_PAGE_SIZE) : 1;
    setNav((prev) => {
      const newPage = Math.min(totalPages - 1, prev.orchestrationChildPage + 1);
      if (newPage === prev.orchestrationChildPage) return prev;
      return { ...prev, orchestrationChildPage: newPage, orchestrationChildSelectedTaskId: null };
    });
    refreshNow();
    return true;
  }

  // Any other key in orchestration detail is swallowed
  return true;
}

/**
 * 6. Channel detail: member row navigation (Phase 9, epic #184).
 *
 *  - ↑/k: move member selection up (cycles channelMemberSelectedName)
 *  - ↓/j: move member selection down
 *  - Any other key: falls through to generic scroll
 *
 * Member selection mirrors the loop iteration pattern: tracked by name (stable
 * domain key) rather than array index (which can change when members leave).
 */
function handleChannelNavigation(input: string, key: InkKey, params: KeyHandlerParams): boolean {
  const { view, setNav } = params;
  if (view.kind !== 'detail') return false;
  if (view.entityType !== 'channels') return false;

  const channel = params.dataRef.current?.channels.find((c) => c.id === view.entityId);
  const members = channel?.members ?? [];

  if (key.upArrow || input === 'k') {
    if (members.length === 0) return true;
    setNav((prev) => {
      const currentIdx = prev.channelMemberSelectedName
        ? members.findIndex((m) => m.name === prev.channelMemberSelectedName)
        : 0;
      const resolvedIdx = currentIdx >= 0 ? currentIdx : 0;
      const nextIdx = Math.max(0, resolvedIdx - 1);
      return { ...prev, channelMemberSelectedName: members[nextIdx]?.name ?? null };
    });
    return true;
  }

  if (key.downArrow || input === 'j') {
    if (members.length === 0) return true;
    setNav((prev) => {
      const currentIdx = prev.channelMemberSelectedName
        ? members.findIndex((m) => m.name === prev.channelMemberSelectedName)
        : 0;
      const resolvedIdx = currentIdx >= 0 ? currentIdx : 0;
      const nextIdx = Math.min(members.length - 1, resolvedIdx + 1);
      return { ...prev, channelMemberSelectedName: members[nextIdx]?.name ?? null };
    });
    return true;
  }

  // Any other key in channel detail falls through to generic scroll
  return false;
}

/**
 * 7. Generic scroll for non-orchestration/non-loop/non-channel detail views (schedules, pipelines).
 *
 *  - ↑/k: scroll detail content up
 *  - ↓/j: scroll detail content down (clamped to detailContentLength - 1)
 *  - Any other key: swallowed (no fallthrough to main handler)
 */
function handleGenericScroll(input: string, key: InkKey, params: KeyHandlerParams): boolean {
  const { view, setNav, detailContentLength } = params;
  if (view.kind !== 'detail') return false;

  if (key.upArrow || input === 'k') {
    setNav((prev) => ({
      ...prev,
      scrollOffsets: {
        ...prev.scrollOffsets,
        [view.entityType]: Math.max(0, prev.scrollOffsets[view.entityType] - 1),
      },
    }));
    return true;
  }

  if (key.downArrow || input === 'j') {
    // Clamp to detailContentLength - 1 so the user cannot scroll into empty space
    const maxScroll = Math.max(0, detailContentLength - 1);
    setNav((prev) => ({
      ...prev,
      scrollOffsets: {
        ...prev.scrollOffsets,
        [view.entityType]: Math.min(maxScroll, prev.scrollOffsets[view.entityType] + 1),
      },
    }));
    return true;
  }

  // Any other key in detail view is swallowed (no fallthrough to main handler)
  return true;
}

// ─── Main dispatcher ─────────────────────────────────────────────────────────

/**
 * Handle key input while in the detail view.
 * Returns true if the key was consumed.
 *
 * D3 drill-through (v1.3.0):
 *  - Orchestration detail: ↑/↓/j/k move child row selection (by taskId)
 *  - Enter: drill into selected child's task detail (returnTo = orchestration object)
 *  - PgUp/PgDn: navigate pages of children (resets selection to first row on page)
 *  - Esc/Backspace: returns to the view encoded in returnTo (main or orchestration)
 *
 * Loop iteration navigation (#168):
 *  - Loop detail: ↑/↓/j/k move iteration selection (by iterationNumber)
 *  - Enter: drill into selected iteration's task detail (returnTo = loop object)
 *  - Esc: returns to the view encoded in returnTo (main or loop)
 *
 * Channel member navigation (Phase 9, epic #184):
 *  - Channel detail: ↑/↓/j/k cycle channelMemberSelectedName through channel members
 *  - Esc: returns to main
 *
 * Output controls (#165 — task/orchestration only):
 *  - o: toggle output stream panel visibility
 *  - [: scroll output up (enters paused mode)
 *  - ]: scroll output down (enters paused mode)
 *  - g: jump to top of output (paused mode)
 *  - G: jump to tail (re-engages auto-tail)
 *
 * For non-orchestration/non-loop/non-channel detail views, ↑/↓ scroll the detail content.
 *
 * Key handler ordering:
 *  1. Esc/Backspace → return to previous view
 *  2. Output controls (o/[/]/g/G) → guarded to task/orchestration only
 *  3. Pause/resume (p) → schedules and loops only
 *  4. Loop entity type → iteration navigation (↑/↓/Enter)
 *  5. Orchestration entity type → child navigation (existing D3 pattern)
 *  6. Channel entity type → member navigation (↑/↓)
 *  7. Generic scroll (↑/↓) → non-orchestration/non-loop/non-channel detail (schedules, pipelines)
 */
export function handleDetailKeys(input: string, key: InkKey, params: KeyHandlerParams): boolean {
  if (params.view.kind !== 'detail') return false;

  return (
    handleEscReturn(key, params) ||
    handleOutputControls(input, params) ||
    handlePauseResume(input, params) ||
    handleLoopNavigation(input, key, params) ||
    handleOrchestrationNavigation(input, key, params) ||
    handleChannelNavigation(input, key, params) ||
    handleGenericScroll(input, key, params)
  );
}
