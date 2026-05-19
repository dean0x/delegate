# Complexity Review Report

**Branch**: feat/166-167-dashboard-cleanup -> main
**Date**: 2026-05-14

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

### MEDIUM

**`getHints` parameter count reaching threshold (5 params)** - `src/cli/dashboard/keyboard/hints.ts:49`
**Confidence**: 82%
- Problem: `getHints(viewKind, hasMutations, entityType, entityStatus, focusedPanel)` has 5 parameters, which is at the warning threshold per complexity metrics. The function is a simple router to `mainHints` and `detailHints`, each of which also accumulates parameters (2-3 each). The parameters are all simple strings/booleans so the cognitive load is manageable, but a 6th parameter would push this into the object-parameter pattern territory.
- Fix: This is borderline. The function is a thin dispatcher and all params are primitives. If a 6th parameter is ever needed, refactor to an options object:
  ```typescript
  interface HintContext {
    viewKind: 'main' | 'detail';
    hasMutations: boolean;
    entityType?: PanelId;
    entityStatus?: string;
    focusedPanel?: PanelId;
  }
  export function getHints(ctx: HintContext): string { ... }
  ```
  For now, the 5-param form is acceptable given the function's simplicity.

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Duplicated pause/resume lookup pattern in `handlePauseResume` and `app.tsx:detailEntityStatus`** - `src/cli/dashboard/keyboard/handle-detail-keys.ts:111-121`, `src/cli/dashboard/app.tsx:148-157` (Confidence: 65%) -- Both locations perform `data?.schedules.find(s => s.id === view.entityId)` and the equivalent for loops. The patterns serve different purposes (one for action dispatch, one for UI hint status), but if the entity-resolution logic grows, a shared `resolveDetailEntity` helper could reduce duplication.

- **Footer prop count approaching threshold** - `src/cli/dashboard/components/footer.tsx:13-23` (Confidence: 62%) -- `FooterProps` has 5 properties (`viewKind`, `hasMutations`, `entityType`, `entityStatus`, `focusedPanel`). All are optional primitives and the component is a leaf node, so this is within acceptable range. Worth monitoring if more hint-driving props are added.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Complexity Score**: 9/10
**Recommendation**: APPROVED

## Analysis Notes

This PR is overwhelmingly a **complexity reduction** effort. The net delta is -2,093 lines (751 added, 2,844 deleted), which is a strong positive signal.

### What was removed (complexity wins)

- **Workspace view** (`workspace-types.ts`, `handle-workspace-keys.ts`, `empty-workspace.tsx`, `orchestrator-nav.tsx`, `task-panel.tsx`, `workspace-view` test suites): Entire view layer (~1,500 lines) eliminated. The workspace view had a 273-line key handler with 3 focus areas (nav/grid/fullscreen), 2 panel modes, pagination, scroll offsets per task, and fullscreen toggle -- this was the most complex keyboard handler in the dashboard.
- **Grid mode in OrchestrationDetail** (`renderGrid`, `GridMode`, grid helpers): ~170 lines of nested grid rendering with row/column layout, fullscreen mode, and empty-state branching removed.
- **WorkspaceNavState**: 8-field state interface with nested records (`panelScrollOffsets`, `autoTailEnabled`) eliminated from the reducer.
- **`fetchWorkspaceExtras`**: 65-line async function with orchestration resolution fallback logic removed from the data pipeline.
- **`computeWorkspaceLayout`**: Entire layout computation function (~75 lines) with responsive breakpoints removed.
- **View state narrowing**: `ViewState` union simplified from 3 kinds (`main | workspace | detail`) to 2 (`main | detail`). `DetailReturnTarget` simplified from `'main' | 'workspace' | {object}` to `'main' | {object}`.
- **Integration test** (`orchestration-workspace.test.ts`): 203 lines of workspace-specific test infrastructure removed.

### What was added (new complexity)

- **`pauseOrResumeEntity`** (35 lines): Simple switch/case dispatcher matching the existing `cancelEntity`/`deleteEntity` pattern. Cyclomatic complexity ~4. Well-structured.
- **`handlePauseResume`** (18 lines): Thin handler following the established handler chain pattern. Low complexity.
- **Hint functions**: `mainHints` and `detailHints` gained optional parameters for conditional pause/resume hints. The branching is shallow (2 levels max).
- **`detailEntityStatus` useMemo** in `app.tsx` (10 lines): Simple derived state lookup. Low complexity.
- **Tests** (252 lines added across 3 new test files): Behavior-focused, each test is 3-5 lines. Good signal-to-noise ratio.

### Cyclomatic complexity assessment

| File | Before (approx.) | After | Direction |
|------|-------------------|-------|-----------|
| `handle-workspace-keys.ts` | ~18 | 0 (deleted) | Eliminated |
| `handle-detail-keys.ts` | ~14 | ~16 | +2 (handlePauseResume) |
| `entity-mutations.ts` | ~8 | ~12 | +4 (pauseOrResumeEntity) |
| `hints.ts` | ~4 | ~8 | +4 (conditional hints) |
| `app.tsx` | ~12 | ~8 | -4 (workspace removal) |
| `use-keyboard.ts` | ~10 | ~5 | -5 (workspace removal) |
| `use-dashboard-data.ts` | ~8 | ~5 | -3 (fetchWorkspaceExtras removal) |
| `nav-reducer.ts` | ~6 | ~4 | -2 (workspace actions removal) |
| `orchestration-detail.tsx` | ~14 | ~6 | -8 (grid mode removal) |

**Net cyclomatic complexity change**: approximately -14 decision points removed across the codebase, demonstrating substantial simplification.

### Pattern consistency

The new `pauseOrResumeEntity` function follows the exact same pattern as the existing `cancelEntity` and `deleteEntity` functions: same signature shape, same try/catch error swallowing, same `refreshNow()` call placement. The handler chain in `handleDetailKeys` follows the established boolean-return short-circuit pattern. No new architectural patterns were introduced.
