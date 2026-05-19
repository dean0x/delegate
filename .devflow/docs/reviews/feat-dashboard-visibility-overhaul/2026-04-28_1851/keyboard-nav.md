# Keyboard Navigation & Plan Alignment Review Report

**Branch**: feat/dashboard-visibility-overhaul -> main
**Date**: 2026-04-28
**Focus**: Plan alignment — keyboard interactions and navigation

## Issues in Your Changes (BLOCKING)

### HIGH

**Activity feed Enter/click does not navigate to pipeline detail** - `src/cli/dashboard/keyboard/handle-main-keys.ts:109-131`, `src/cli/dashboard/app.tsx:167-180`
**Confidence**: 95%
- Problem: The `ActivityEntry.kind` type includes `'pipeline'` (domain.ts:899), and the activity feed correctly generates pipeline entries (activity-feed.ts). However, two independent code paths that dispatch detail navigation from activity entries are both missing the `'pipeline'` / `'pipelines'` case:
  1. **handle-main-keys.ts:109-131** -- the keyboard Enter handler in the activity-focused branch has a switch on `entityType` covering `tasks`, `loops`, `orchestrations`, `schedules` but not `pipelines`. When a user highlights a pipeline activity entry and presses Enter, no navigation occurs (silent no-op).
  2. **app.tsx:167-180** -- the `handleActivitySelect` callback has a switch on `entry.kind` covering `task`, `loop`, `orchestration`, `schedule` but not `pipeline`. Same silent no-op for click-based selection.
- Fix: Add the missing cases to both locations:

  In `handle-main-keys.ts` after the `'schedules'` case (around line 131):
  ```typescript
  case 'pipelines':
    setView({
      kind: 'detail',
      entityType: 'pipelines',
      entityId: entry.entityId as PipelineId,
      returnTo: 'main',
    });
    break;
  ```

  In `app.tsx` `handleActivitySelect` after the `'schedule'` case (around line 179):
  ```typescript
  case 'pipeline':
    setView(openDetail('pipelines', entry.entityId as never, 'main'));
    break;
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Footer hint text uses plain `dimColor` for all keys and descriptions -- no visual distinction between keys and descriptions** - `src/cli/dashboard/components/footer.tsx:23`, `src/cli/dashboard/keyboard/hints.ts`
**Confidence**: 82%
- Problem: The plan (section 6.2) specifies keys in `magentaBright` and descriptions in `dimColor` (or similar visual distinction). The current implementation renders the entire hint string as a single `<Text dimColor>` element, making key bindings hard to spot quickly in the footer bar. This is a usability gap versus the plan specification.
- Fix: Either parse the hint strings to apply differential coloring, or refactor `hints.ts` to return structured data (key-description pairs) that Footer can render with distinct styles. Given the current architecture where hints are plain strings, the simplest approach is to accept the current single-color rendering and document this as a descoped cosmetic item. If visual distinction is desired, hints.ts would need to return `{ key: string; desc: string }[]` and Footer would map them to `<Text color="magentaBright">{key}</Text><Text dimColor> {desc}</Text>`.

### MEDIUM

**`w` shortcut has no edge case handling for empty/missing orchestrations** - `src/cli/dashboard/use-keyboard.ts:83-85`
**Confidence**: 85%
- Problem: The plan (section 13.5) specifies four edge cases for the `w` shortcut:
  1. No orchestrations: noop or message
  2. No running orchestrations: show most recent in list mode
  3. One running: show in grid mode
  4. Multiple running: show first in grid mode

  The current implementation is a simple unconditional `setView({ kind: 'workspace' })` on line 84. It always navigates to the workspace view regardless of orchestration state. When no orchestrations exist, the workspace view renders a sentinel orchestration object (app.tsx:210-225) and relies on OrchestrationDetail's `EmptyWorkspace` component. While this provides a non-crashing experience, it does not match the plan's specification for intelligent mode selection (list vs grid) based on running orchestration count.
- Fix: This is likely an intentional descope for the initial implementation. If the plan's edge cases are desired, add logic in `use-keyboard.ts` before the `setView` call:
  ```typescript
  if (input === 'w') {
    const orchestrations = data?.orchestrations ?? [];
    if (orchestrations.length === 0) return; // noop per plan
    // Additional logic: check running count, set list/grid mode
    setView({ kind: 'workspace' });
    return;
  }
  ```

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Detail view `r` key triggers global refresh but does not appear in detail hint text** - `src/cli/dashboard/use-keyboard.ts:61-63`, `src/cli/dashboard/keyboard/hints.ts:33-35`
**Confidence**: 80%
- Problem: The plan (section 6.1) lists `r (refresh)` as a detail view key binding. The global `r` handler at use-keyboard.ts:61-63 does work in all views including detail (it fires before view-specific dispatch). The detail hint string at hints.ts:34 correctly includes `r refresh`. This is actually working correctly -- no issue here.
- Note: This was initially flagged as potentially missing but confirmed working upon deeper analysis. The `r` key is a global handler that fires before the view-specific `handleDetailKeys` dispatch. Included here for audit completeness.

## Suggestions (Lower Confidence)

- **Nav stack overflow guard not implemented** - (Confidence: 70%) -- The plan (section 13.6) specifies a max depth of 20 for the navigation stack. The implementation uses a flat `ViewState` with `returnTo` field instead of a stack data structure. There is no explicit depth limit. In practice, the deepest drill-through is 2 levels (main -> orchestration detail -> child task detail), so overflow is unlikely. However, if future features add deeper navigation, the lack of a guard could become an issue. Consider adding a depth counter or stack structure in a later phase.

- **`v` key blocked in detail view may confuse users** - `src/cli/dashboard/use-keyboard.ts:67` (Confidence: 65%) -- The `v` key is explicitly gated with `view.kind !== 'detail'`, meaning pressing `v` in a detail view is silently ignored. The plan (section 6.1) lists `v/w (workspace)` under main view keys only, so this is plan-compliant. However, since `m` and `w` both work from detail view (lines 77-85), the asymmetry with `v` could be surprising. Users must press Esc first then `v`, or use `w` directly.

- **`handleActivitySelect` only called for mouse/programmatic selection, not keyboard** - `src/cli/dashboard/app.tsx:165` (Confidence: 65%) -- The `handleActivitySelect` callback passed to MetricsView is only used when the activity panel supports mouse click selection. The keyboard Enter handler in handle-main-keys.ts has its own independent switch statement. This duplication means both paths must be updated when new entity types are added (as seen with the pipeline gap). Consider refactoring to share a single dispatch function.

## Plan Alignment Summary

### Section 1.1 Navigation Stack
- **State centralized**: YES -- `useReducer(dashboardReducer)` replaces 3 separate `useState` calls (app.tsx:79). Single `DashboardState` holds `view`, `nav`, `workspaceNav`, `animFrame`.
- **Navigation from main -> detail -> back**: YES -- Enter drills into detail (handle-main-keys.ts:208), Esc returns via `returnTo` (handle-detail-keys.ts:30-46).
- **Deep navigation (orch detail -> child task -> back)**: YES -- D3 drill-through implemented (handle-detail-keys.ts:75-91) with `returnTo: { kind: 'orchestrations', entityId, originalReturnTo }`.
- **Breadcrumb reflects navigation state**: YES -- entity-specific breadcrumbs via `buildBreadcrumb(viewKind, entityType, entityId)` (header.tsx:98-118).
- **NOTE**: The implementation uses a flat `ViewState` with `returnTo` instead of a true NavStack with typed NavFrame per view kind. This achieves the same behavior for the current 2-level depth but differs architecturally from the plan.

### Section 1.2 State Reducer
- **useReducer replacing useState**: YES -- (app.tsx:79, nav-reducer.ts).
- **Pure reducer function**: YES -- `dashboardReducer` is a pure function (nav-reducer.ts:49-74).
- **Actions typed via union**: YES -- `DashboardAction` is a discriminated union of 6 action types (nav-reducer.ts:33-39).

### Section 1.4 Keyboard Handlers
- **Pipeline panel has Enter -> drill to detail**: YES -- (handle-main-keys.ts:242-249).
- **Pipeline tab accessible via digit key (5)**: YES -- (constants.ts:26 `'5': 'pipelines'`).
- **Tab cycles through all 5 panels**: YES -- `PANEL_ORDER` has 5 entries (constants.ts:9).
- **Filter (f) works on pipeline panel**: YES -- `FILTER_CYCLES` includes `pipelines` (constants.ts:17).
- **Cancel (c) works on pipelines**: PARTIAL -- Pipeline cancel is a no-op by design (entity-mutations.ts:66-69, comment: "cascade via tasks").
- **Delete (d) works on pipelines**: YES -- (entity-mutations.ts:117-122, checks `pipelineRepo`).

### Section 6.1 Key Binding Matrix
| Key | Main | Detail | Workspace | Status |
|-----|------|--------|-----------|--------|
| q (quit) | Global | Global | Global | PASS |
| r (refresh) | Global | Global | Global | PASS |
| m (jump to main) | Global | Global | Global | PASS |
| Enter (drill) | YES | YES (orch children) | YES | PASS |
| f (filter/fullscreen) | YES (filter) | N/A | YES (fullscreen) | PASS |
| Tab (panel cycle) | YES (5 panels + activity) | N/A | YES (nav/grid) | PASS |
| 1-5 (panel jump) | YES | N/A | 1-9 (grid panels) | PASS |
| c (cancel) | YES | N/A | YES | PASS |
| d (delete) | YES | N/A | YES (grid only) | PASS |
| Up/Down (select/scroll) | YES | YES | YES | PASS |
| v/w (workspace) | v: toggle, w: jump | v: blocked, w: jump | v: to main, w: N/A | PASS |
| Esc (back) | Esc from activity | Return to prev | Exit fullscreen/return | PASS |
| [/] (scroll output) | N/A | N/A | YES | PASS |
| g/G (top/tail) | N/A | N/A | YES | PASS |

### Section 6.2 Context-Sensitive Footer
- **Different hints per view**: YES -- `getHints()` returns view-specific strings (hints.ts:40-48).
- **Visual distinction for keys vs descriptions**: NO -- All text is `dimColor`. Plan called for keys in `magentaBright`. See Should-Fix issue above.

### Section 6.3 Header Breadcrumb
- **Entity-specific breadcrumbs**: YES -- `ENTITY_LABEL` map with Task/Loop/Schedule/Orch/Pipeline (header.tsx:84-90).
- **Format "Metrics . Entity shortId"**: YES -- `buildBreadcrumb` produces `[D] Metrics . {Label} {shortId}` (header.tsx:111).

### Section 13.5 `w` Shortcut Edge Cases
- **Implemented**: NO -- Simple unconditional `setView({ kind: 'workspace' })`. No orchestration-count-aware logic. See Should-Fix issue above.

### Section 13.6 Nav Stack Overflow
- **Implemented**: NO -- No depth limit. Flat `returnTo` approach instead of stack. Max practical depth is 2. See Suggestions above.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Keyboard Navigation Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The keyboard navigation is well-structured with a clean reducer pattern, correct 5-panel Tab cycling, proper pipeline Enter/filter/delete support in the entity browser panels, and functional D3 drill-through navigation. The one blocking issue is the missing pipeline case in activity feed navigation (both keyboard Enter and `handleActivitySelect`), which means pipeline activity entries cannot be drilled into. Two should-fix items are the missing footer key color styling and the `w` shortcut edge case handling specified in the plan.
