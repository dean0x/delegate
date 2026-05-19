# Plan-Alignment: Workspace Fold into OrchestrationDetail

**Branch**: feat/dashboard-visibility-overhaul -> main
**Date**: 2026-04-28
**Focus**: Verifying the workspace fold against plan sections 5.5, 13.4, 13.5, 13.8

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

**`v` does NOT toggle between list and grid mode inside OrchestrationDetail** - `use-keyboard.ts:66-74`
**Confidence**: 95%
- Problem: Plan section 5.5 requires "`v` toggles between list mode (current) and grid mode (workspace-style)" within orchestration detail. The current implementation treats `v` as a global toggle between `view.kind === 'main'` and `view.kind === 'workspace'` (line 67-73 of `use-keyboard.ts`). When viewing an orchestration detail (`view.kind === 'detail'`, `entityType === 'orchestrations'`), pressing `v` is ignored entirely due to the guard `view.kind !== 'detail'`. There is no mechanism to switch an orchestration detail view between list mode and grid mode. The `viewMode` prop on `OrchestrationDetail` is only set to `'grid'` when coming from the workspace route (`view.kind === 'workspace'`) in `app.tsx:230`, and to `'list'` (default) when coming from the detail route in `app.tsx:241-252`.
- Fix: When `view.kind === 'detail'` and `entityType === 'orchestrations'`, pressing `v` should toggle the orchestration detail between list and grid view modes. This could be done by: (a) adding a `viewMode` field to the detail ViewState variant for orchestrations, or (b) using a separate state flag in the nav/workspace nav, or (c) routing `v` in the detail-keys handler to toggle the view mode. The plan is clear that `v` should work within orchestration detail to switch between the two presentations.

**`w` shortcut does NOT implement edge cases from plan section 13.5** - `use-keyboard.ts:82-86`
**Confidence**: 92%
- Problem: Plan section 13.5 specifies 5 edge cases for the `w` shortcut:
  1. No orchestrations: noop or "No orchestrations" message
  2. No RUNNING orchs: show most recent in list mode
  3. One RUNNING orch: show in grid mode
  4. Multiple RUNNING: show first in grid mode
  5. Already in orchestration detail: toggle grid/list (same as `v`)
  6. From deep nav stack: push new frame on top

  The current implementation (line 82-86 of `use-keyboard.ts`) unconditionally sets `{ kind: 'workspace' }` regardless of orchestration state. It does not check whether orchestrations exist, does not distinguish between running/non-running, does not navigate to a specific orchestration in list mode vs grid mode, and does not handle "already in orchestration detail" toggling.
- Fix: The `w` handler should read the current orchestrations data, apply the edge case logic (noop when empty, route to first running orch in grid mode, route to most recent in list mode when none running, toggle when already in orch detail), and dispatch the appropriate view state.

**`streamingEnabled` still gated on `view.kind === 'workspace'` -- grid mode in orch detail never streams** - `app.tsx:140`
**Confidence**: 90%
- Problem: Plan section 13.4 calls for "`streamingEnabled = view.kind === 'workspace'` logic updated". The code at `app.tsx:140` still reads `const streamingEnabled = view.kind === 'workspace' && outputRepository !== undefined`. When the user navigates to an orchestration detail in grid mode (via the `v` toggle per the plan), the view kind would be `'detail'`, not `'workspace'`, so streaming would be disabled. Even in the current partial implementation, the streaming only activates for the `workspace` view kind, which means the grid mode inside orchestration detail will never have live output streams when accessed from the detail route.
- Fix: Once `v` toggle is implemented, `streamingEnabled` should also be true when `view.kind === 'detail'` and the orchestration detail is in grid mode. The condition should account for both workspace and grid-mode-detail views.

### MEDIUM

**`fetchWorkspaceExtras()` NOT moved to orchestration-detail data path** - `use-dashboard-data.ts:269`
**Confidence**: 85%
- Problem: Plan section 13.4 requires "fetchWorkspaceExtras() moved to orchestration-detail data path". The data fetching for workspace extras is still gated on `viewState.kind === 'workspace'` (line 269). When the plan's `v` toggle is implemented and an orchestration detail shows grid mode, the workspace data (children, cost aggregate, child task IDs/statuses) would NOT be fetched because the view state kind would be `'detail'`, not `'workspace'`. This means the grid mode will have no data when accessed from the detail route.
- Fix: The `fetchWorkspaceExtras` call should also fire when `viewState.kind === 'detail'` and `entityType === 'orchestrations'` with grid mode active (or always for orchestration details, since the list mode also shows children).

**`view.kind === 'workspace'` branch still exists in app.tsx routing** - `app.tsx:200-237`
**Confidence**: 82%
- Problem: Plan section 13.4 says "`view.kind === 'workspace'` branches updated to route through OrchestrationDetail". While the workspace view rendering now uses `OrchestrationDetail` with `viewMode='grid'`, the `view.kind === 'workspace'` branch itself still exists as a first-class routing path (app.tsx:200). This is partially aligned -- the rendering goes through OrchestrationDetail, but the workspace as a distinct view kind persists. The plan intent is to fully absorb workspace into the orchestration detail, making `'workspace'` view kind unnecessary (orchestration detail would handle both list and grid via `viewMode`). The sentinel orchestration construction (lines 210-225) with empty-string IDs and `as never` casts is a code smell indicating an incomplete fold.
- Fix: This may be acceptable as a transitional step, but the plan's full intent is for workspace to not be a separate view kind at all. The sentinel orchestration construction should be replaced by having the `GridMode` component handle the no-orchestration case internally (which it already does via `EmptyWorkspace`).

## Issues in Code You Touched (Should Fix)

### HIGH

(none)

### MEDIUM

**Sentinel orchestration uses unsafe `as never` casts** - `app.tsx:211-225`
**Confidence**: 82%
- Problem: When no orchestrations exist and the user enters workspace view, the code constructs a sentinel orchestration with `id: '' as never`, `status: 'planning' as never`, etc. This bypasses the branded type system and could cause runtime surprises if any downstream code performs identity checks on the orchestration ID.
- Fix: Instead of constructing a sentinel, handle the `committedOrch === undefined` case explicitly: pass `orchestrations={[]}` and let `GridMode` handle the empty state (it already does with `EmptyWorkspace kind="no-orchestrators"`). The sentinel is redundant.

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Missing `v` toggle in hints.ts for orchestration detail** - `hints.ts:33-34` (Confidence: 70%) -- The detail hints do not mention `v` for toggling grid/list mode once inside an orchestration detail. This will need updating when the `v` toggle is implemented.

- **Workspace view kind may become dead code** - `types.ts:88` (Confidence: 65%) -- The `{ kind: 'workspace' }` ViewState variant persists. If the plan fully absorbs workspace into orchestration detail, this variant and all branches handling it become dead code. Consider whether this is a transitional state or the final design.

- **Cost data lost in grid mode fold** - `orchestration-detail.tsx:105-106` (Confidence: 65%) -- The original `WorkspaceView` read `costAggregate` from `data.workspaceData?.costAggregate` and included it in the header text (`$${costAggregate.totalCostUsd.toFixed(3)}`). The grid mode in OrchestrationDetail builds a null-valued cost map and does not include cost in the header text (line 134-137). The cost information that was visible in the original workspace header is now missing.

## Plan Alignment Checklist

### Section 5.5: OrchestrationDetail Enhancement (Absorbs Workspace)

| Requirement | Status | Evidence |
|---|---|---|
| `v` toggles between list mode and grid mode | **NOT IMPLEMENTED** | `v` is a global main/workspace toggle; does not work within orch detail |
| Grid mode renders TaskPanel grid with live OutputStreamView per child | **PARTIAL** | Grid renders TaskPanels via `renderGrid()` but streaming only works via `workspace` view kind, not from detail route |
| OrchestratorNav sidebar visible in grid mode (when multiple orchs exist) | **DONE** | `GridMode` renders `OrchestratorNav` when `layout.mode === 'nav+grid'` |
| `f` toggles fullscreen in grid mode; Esc exits fullscreen | **DONE** | `handle-workspace-keys.ts:143-151` and `:52-58` |
| `[/]` scrolls output, `g/G` jumps to top/bottom in grid mode | **DONE** | `handle-workspace-keys.ts:164-224` |
| `w` shortcut from any view navigates to first running orch in grid mode | **NOT IMPLEMENTED** | `w` unconditionally sets `{ kind: 'workspace' }` with no orch-awareness |

### Section 13.4: Workspace Deletion Checklist

| Requirement | Status | Evidence |
|---|---|---|
| workspace-view.tsx deleted (or empty) | **DONE** | File deleted in diff |
| `import { WorkspaceView }` removed from app.tsx | **DONE** | Replaced with `OrchestrationDetail` import |
| `view.kind === 'workspace'` branches updated to route through OrchestrationDetail | **PARTIAL** | Branch exists but renders `OrchestrationDetail` with `viewMode='grid'` |
| `streamingEnabled = view.kind === 'workspace'` logic updated | **NOT DONE** | Still gated on `view.kind === 'workspace'` only |
| `fetchWorkspaceExtras()` moved to orchestration-detail data path | **NOT DONE** | Still gated on `viewState.kind === 'workspace'` |
| `handleWorkspaceKeys` still functional for grid mode | **DONE** | Handler unchanged, dispatches when `view.kind === 'workspace'` |
| `workspace-types.ts` still exists (needed for WorkspaceNavState) | **DONE** | File exists |
| Workspace components reused: task-panel.tsx, orchestrator-nav.tsx, empty-workspace.tsx | **DONE** | All imported and used by `orchestration-detail.tsx` |
| `computeWorkspaceLayout()` function preserved | **DONE** | Called in `app.tsx:127-131` |

### Section 13.5: `w` Shortcut Edge Cases

| Requirement | Status | Evidence |
|---|---|---|
| No orchestrations: noop or message | **NOT IMPLEMENTED** | `w` always sets `{ kind: 'workspace' }` |
| No RUNNING orchs: show most recent in list mode | **NOT IMPLEMENTED** | No data check |
| One RUNNING orch: show in grid mode | **NOT IMPLEMENTED** | No data check |
| Multiple RUNNING: show first in grid mode | **NOT IMPLEMENTED** | No data check |
| Already in orchestration detail: toggle grid/list (same as v) | **NOT IMPLEMENTED** | `w` forces workspace view kind |
| From deep nav stack: push new frame on top | **NOT IMPLEMENTED** | `w` replaces view state |

### Section 13.8: Empty States for Workspace/Grid

| Requirement | Status | Evidence |
|---|---|---|
| Grid (zero children): "No tasks to display" with hint | **DONE** | `EmptyWorkspace kind="no-children"` rendered at line 148 |
| List (zero children): "Orchestration is planning..." or similar | **PARTIAL** | The list mode shows "No tasks to display" via the children section guard, but does not show the "planning" hint for fresh orchestrations |

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 3 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Plan Alignment Score**: 4/10
**Recommendation**: CHANGES_REQUESTED

### Assessment

The workspace fold is structurally sound: `workspace-view.tsx` is deleted, its rendering logic is faithfully reproduced inside `OrchestrationDetail` via the `viewMode='grid'` prop, all shared components (TaskPanel, OrchestratorNav, EmptyWorkspace) are reused, and existing tests are migrated. The `nav-reducer.ts` centralisation is clean.

However, the fold is **incomplete against the plan**. The three HIGH blocking issues represent core plan requirements that are not yet implemented:

1. **`v` toggle** between list/grid within orchestration detail does not exist -- `v` only toggles between the main and workspace view kinds.
2. **`w` shortcut** has none of the 6 edge cases from plan section 13.5. It unconditionally navigates to the workspace view.
3. **Streaming** is still gated on `view.kind === 'workspace'`, so grid mode reached via any future orch-detail route would lack live output.

The `fetchWorkspaceExtras` data path and `streamingEnabled` logic both need to be updated to support grid mode within the detail view. Until these changes land, the fold is a rendering-layer refactor but not a behavioral fold as the plan specifies.
