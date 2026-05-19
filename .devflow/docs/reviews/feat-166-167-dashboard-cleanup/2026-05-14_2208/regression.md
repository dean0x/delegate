# Regression Review Report

**Branch**: feat/166-167-dashboard-cleanup -> main
**Date**: 2026-05-14

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Stale JSDoc reference to deleted WorkspaceView** - `src/cli/dashboard/use-task-output-stream.ts:7`
**Confidence**: 90%
- Problem: Line 7 reads `useTaskOutputStream: React hook (used by App/WorkspaceView)` but `WorkspaceView` was deleted in this PR. This is documentation drift in a file you modified (the comment on line 398 was correctly updated in this same file).
- Fix: Update JSDoc to reflect current consumers:
  ```typescript
  *  - useTaskOutputStream: React hook (used by App)
  ```

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

### LOW

**Stale workspace references in docs/FEATURES.md and docs/releases/RELEASE_NOTES_v1.3.0.md**
**Confidence**: 85%
- Problem: `docs/FEATURES.md:336` references "metrics and workspace views" and `docs/releases/RELEASE_NOTES_v1.3.0.md` references workspace throughout (lines 64, 192, 340-341). These are in files NOT modified by this PR, so they are informational only. Release notes are historical artifacts and should not be modified.
- Fix: `docs/FEATURES.md` could be updated in a follow-up commit to remove the workspace reference. Release notes should remain as-is (they document what was true at the time of release).

## Suggestions (Lower Confidence)

(none -- all findings are at or above 80% confidence)

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 1 |

**Regression Score**: 9/10
**Recommendation**: APPROVED_WITH_CONDITIONS

## Detailed Regression Analysis

### Lost Functionality Assessment

This PR intentionally removes the workspace view (#166) -- a deliberate feature deletion, not accidental loss. The removal is clean and thorough:

- **Deleted files** (9 total): 5 source files (`empty-workspace.tsx`, `orchestrator-nav.tsx`, `task-panel.tsx`, `handle-workspace-keys.ts`, `workspace-types.ts`) and 4 test files (`workspace-view.test.tsx`, `workspace-keyboard.test.tsx`, `orchestrator-nav.test.tsx`, `orchestration-workspace.test.ts`).
- **No dangling imports**: Grepped for all deleted module names and exported symbols (`TaskPanel`, `EmptyWorkspace`, `OrchestratorNav`, `handleWorkspaceKeys`, `computeWorkspaceLayout`, `WorkspaceLayout`, `WorkspaceNavState`, `createInitialWorkspaceNavState`) -- zero remaining import references in source.
- **No dangling string literals**: Zero `'workspace'` string literal references remain in `src/cli/dashboard/`.
- **Type narrowing complete**: `ViewState`, `DetailReturnTarget`, `POLL_INTERVAL_BY_VIEW`, `getHints`, `Footer`, `Header` all narrowed from `'main' | 'workspace' | 'detail'` to `'main' | 'detail'`. TypeScript compilation passes cleanly.
- **Reducer actions cleaned**: `SET_WORKSPACE_NAV` and `UPDATE_WORKSPACE_NAV` actions removed from `DashboardAction` union; exhaustive switch compiles.
- **Keyboard handlers**: `v` and `w` key handlers removed from `use-keyboard.ts`. `navigateToWorkspace()` helper removed.
- **Data fetching**: `fetchWorkspaceExtras()` and workspace poll interval (750ms) removed from `use-dashboard-data.ts`. `workspaceData` removed from `DashboardData`.

### New Functionality Assessment (#167 -- p key pause/resume)

The new pause/resume feature is well-scoped and regression-safe:

- **New export**: `pauseOrResumeEntity()` in `entity-mutations.ts` -- additive, no existing APIs changed.
- **Key handler integration**: `p` key added to both `handleMainKeys()` and `handleDetailKeys()` chains. Correctly returns `true` (consumed) even for non-pauseable entities, preventing key leakage.
- **Footer hints**: Contextually conditional -- shows "p pause/resume" only when focused on schedules/loops panels or viewing schedule/loop detail. Status-aware: shows "p pause" for active/running, "p resume" for paused.
- **Error handling**: `pauseOrResumeEntity` catches and swallows service errors to prevent TUI crashes -- consistent with `cancelEntity` pattern.
- **Test coverage**: 9 unit tests for `pauseOrResumeEntity` + 20 hints tests + 10+ footer render tests + keyboard hook integration tests.

### Incomplete Migration Check

No incomplete migration detected. All consumers of workspace-related types and functions have been updated or removed.

### Intent vs Reality Match

- Commit `31397d5` says "remove workspace view and grid mode" -- verified: all workspace and grid mode code is fully removed.
- Commit `14b939f` says "add p key for pause/resume" -- verified: the feature works for both main and detail views, with proper guards for non-pauseable entities.
- Commit `064723a` says "remove stale workspace references" -- verified: CLAUDE.md workspace-view.tsx row removed, domain.ts JSDoc updated.
- Commit `b9a9714` says "convert resolveDetailStreamTaskId to useMemo" -- verified: function converted from inline function to `useMemo` with correct dependency array.

### Regression Checklist

- [x] No exports removed without deprecation (all removed exports were internal dashboard components with no external consumers; avoids PF-002 -- these features had zero external users, clean break is correct)
- [x] Return types backward compatible (no public API changes)
- [x] Default values unchanged (or documented)
- [x] Side effects preserved (events, logging)
- [x] All consumers of changed code updated
- [x] Migration complete across codebase (1 minor JSDoc miss noted above)
- [x] CLI options preserved or deprecated (no CLI changes)
- [x] API endpoints preserved or versioned (no API changes)
- [x] Commit messages match implementation
- [x] Breaking changes documented (workspace removal is internal dashboard UX, not external API)
- [x] All 678 dashboard tests pass
- [x] TypeScript compilation clean
