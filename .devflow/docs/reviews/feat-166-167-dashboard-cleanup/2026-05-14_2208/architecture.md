# Architecture Review Report

**Branch**: feat/166-167-dashboard-cleanup -> main
**Date**: 2026-05-14
**PR**: #174

## Issues in Your Changes (BLOCKING)

_No blocking architectural issues found._

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Duplicated entity-status lookup between App and detail key handler** - `app.tsx:148-157`, `handle-detail-keys.ts:111-121`
**Confidence**: 82%
- Problem: The `detailEntityStatus` useMemo in `app.tsx` performs `data?.schedules.find()` / `data?.loops.find()` to resolve the current entity status for the Footer hint. The `handlePauseResume` function in `handle-detail-keys.ts` performs an identical `.find()` lookup via `dataRef.current?.schedules.find()` / `dataRef.current?.loops.find()` to dispatch the actual pause/resume action. This is two independent traversals of the same lists to resolve the same information on every `p` keypress.
- Impact: Minor duplication. Both are O(n) scans of small arrays so there is no performance issue, but the duplicated logic means a future change to entity resolution (e.g., a status-to-entity index) must be applied in two places. Not a SOLID violation per se, but the pattern of "compute status in one place, look it up again in another" is a shallow abstraction smell per Ousterhout (2018).
- Fix: Consider threading `detailEntityStatus` into the key handler params (it is already computed in App) so `handlePauseResume` can skip the redundant `.find()` and directly call `pauseOrResumeEntity` with the status already resolved. This aligns with the existing pattern where `nav` and `view` are threaded through params rather than re-derived.

## Pre-existing Issues (Not Blocking)

_No critical pre-existing architectural issues found in reviewed files._

## Suggestions (Lower Confidence)

- **`detailHints` uses raw string literals for status comparison** - `hints.ts:36-41` (Confidence: 72%) -- The function compares `entityStatus` against raw strings (`'active'`, `'running'`, `'paused'`) rather than importing `ScheduleStatus` / `LoopStatus` constants. The JSDoc comment documents this as intentional ("values are already lowercase"), but it creates a coupling to the string representation that would silently break if the domain enum values changed. The `pauseOrResumeEntity` function in the same PR correctly imports and uses the domain constants.

- **Footer prop surface area growing** - `footer.tsx:13-23` (Confidence: 65%) -- Footer now accepts 5 props (`viewKind`, `hasMutations`, `entityType`, `entityStatus`, `focusedPanel`) with 3 new ones added in this PR. The component is still simple (it delegates to `getHints()`), but if more view-conditional hints are added, consider a single `hintContext` object prop to avoid prop explosion.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Architecture Score**: 9/10
**Recommendation**: APPROVED

## Detailed Analysis

### What this PR does well architecturally

**Clean workspace removal (applies PF-002)**: The removal of the workspace view, grid mode, and all supporting infrastructure (~2,800 lines deleted) is a textbook clean break. The workspace view (`WorkspaceView`, `TaskPanel`, `OrchestratorNav`, `EmptyWorkspace`, `WorkspaceNavState`, `computeWorkspaceLayout`, `handleWorkspaceKeys`, `fetchWorkspaceExtras`) was a parallel view layer that duplicated data flows already available through orchestration detail. Removing it without migration scaffolding is correct per PF-002 -- the feature had zero external users (dashboard-only, not an API surface).

**Type system tightening**: The `ViewState` union narrows from `'main' | 'workspace' | 'detail'` to `'main' | 'detail'`, and `DetailReturnTarget` narrows `originalReturnTo` from `'main' | 'workspace'` to just `'main'`. This makes impossible states unrepresentable at compile time -- a discriminated union improvement that eliminates an entire category of runtime bugs.

**Layering discipline maintained**: The new `pauseOrResumeEntity` function follows the established pattern exactly:
- Same signature shape as `cancelEntity` and `deleteEntity` (entity kind, ID, status, mutations, refreshNow)
- Same try/catch error swallowing pattern for TUI resilience
- Same service-layer delegation (no direct repo writes from the keyboard handler)
- Consistent `refreshNow()` call placement (after successful mutation, inside the status guard)

**Separation of concerns in the pause/resume feature**:
- `entity-mutations.ts` owns the dispatch logic (which service to call based on entity kind + status)
- `handle-main-keys.ts` and `handle-detail-keys.ts` own the view-specific wiring (which entity is focused/selected)
- `hints.ts` owns the display logic (which hint text to show based on context)
- `footer.tsx` is a pure render component that accepts hint context as props
- Each module has one reason to change -- SRP is preserved.

**Reducer simplification**: Removing `workspaceNav` from `DashboardState` and eliminating `SET_WORKSPACE_NAV` / `UPDATE_WORKSPACE_NAV` actions reduces the state surface area. The reducer's exhaustive `never` check in the default case ensures this is compile-time safe.

**Test coverage matches the architecture**: New tests for `pauseOrResumeEntity` (9 cases), `hints.ts` (15 cases), and integration tests in `use-keyboard.test.tsx` (12 new pause/resume cases) cover the new feature at all three levels (dispatch, display, integration). Deleted tests for workspace-related components are appropriate -- they tested code that no longer exists.
