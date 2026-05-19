# Regression Review Report

**Branch**: feat/166-167-dashboard-cleanup -> main
**Date**: 2026-05-14

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

### MEDIUM

**Stale CLAUDE.md file reference for deleted workspace-view.tsx** - `CLAUDE.md:297`
**Confidence**: 95%
- Problem: The File Locations table in CLAUDE.md still references `src/cli/dashboard/views/workspace-view.tsx` under "Workspace view", but this file was deleted in #166. Developers or agents consulting CLAUDE.md for navigation will find a dead reference.
- Fix: Remove the `| Workspace view | src/cli/dashboard/views/workspace-view.tsx |` row from the File Locations table in CLAUDE.md.

**Stale JSDoc comment in domain.ts referencing "workspace view"** - `src/core/domain.ts:885`
**Confidence**: 85%
- Problem: The `OrchestratorChild` interface JSDoc says "ARCHITECTURE: Read-only projection used by workspace view." The workspace view no longer exists; this interface is now used by the orchestration detail children list. The comment creates confusion about what consumes this type.
- Fix: Update the comment to: `ARCHITECTURE: Read-only projection used by orchestration detail view.`

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

(none -- all findings met the 80% threshold)

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Regression Score**: 9/10
**Recommendation**: APPROVED_WITH_CONDITIONS

## Detailed Analysis

### Workspace Removal (#166) -- Regression Checklist

**Removed exports**: All removed exports (`computeWorkspaceLayout`, `WorkspaceLayout`, `WorkspaceNavState`, `createInitialWorkspaceNavState`, `handleWorkspaceKeys`, `workspaceHints`, `EmptyWorkspace`, `OrchestratorNav`, `TaskPanel`) were internal dashboard-only types/components. No external consumers exist. Zero remaining import references found in source files. **No regression.**

**Removed keyboard shortcuts**: The `v` (toggle main/workspace), `w` (jump to workspace), `f` (fullscreen panel in grid), and all workspace-specific keys (`1-9` panel jump, `[/]/g/G` panel scroll, `PgUp/PgDn` grid pagination) are removed. These only functioned in the now-deleted workspace view. No workspace view means no regression from removing its keybindings. The `m` key (jump to main) is preserved. **No regression.**

**Removed view state variant**: `{ kind: 'workspace' }` removed from `ViewState` union type. The `'workspace'` literal removed from `DetailReturnTarget` and `originalReturnTo`. All `returnTo` fields now only accept `'main'` (plus object variants for drill-through). TypeScript exhaustive checks via `never` in the reducer ensure no unhandled cases. **No regression.**

**Removed data pipeline**: `fetchWorkspaceExtras()` deleted from `use-dashboard-data.ts`, along with the `workspaceData` field from `DashboardData`. The 750ms workspace poll interval removed from `POLL_INTERVAL_BY_VIEW`. The orchestration detail view continues to fetch children and cost aggregates via `fetchDetailExtra()`. **No regression.**

**Type narrowing**: `originalReturnTo` narrowed from `'main' | 'workspace'` to just `'main'`. All drill-through paths (`handleLoopNavigation`, `handleOrchestrationNavigation`) updated to hardcode `'main'`. The `handleEscReturn` function no longer checks for `returnTo === 'workspace'`. **No regression.**

**State management**: `workspaceNav` field removed from `DashboardState`. `SET_WORKSPACE_NAV` and `UPDATE_WORKSPACE_NAV` actions removed from `DashboardAction` and `dashboardReducer`. Exhaustive switch (`never` default) ensures no dead code paths. **No regression.**

### Pause/Resume Addition (#167) -- Regression Checklist

**New functionality**: `pauseOrResumeEntity()` added to `entity-mutations.ts`. New `p` key handler added in both `handleMainKeys` and `handleDetailKeys`. Footer hints updated to show contextual `p pause` / `p resume` based on entity type and status. **No regression risk -- purely additive.**

**Existing key handlers preserved**: All existing key handlers (`c` cancel, `d` delete, `f` filter, `Tab`/`Shift+Tab`, arrow keys, `Enter`, `Esc`, `r` refresh, `q` quit, `m` jump-to-main) remain unchanged. The `p` key is inserted in the handler chain after `c` and before `d` in main view, and after output controls in detail view. **No regression.**

**Error handling**: `pauseOrResumeEntity()` wraps all service calls in try/catch to prevent unhandled rejections from crashing the TUI. Non-pauseable entity kinds (tasks, orchestrations, pipelines) fall through to the `default` case (no-op). Terminal statuses are silently skipped. **No regression.**

**Test coverage**: 9 unit tests for `pauseOrResumeEntity` + 10 integration tests for the keyboard hook covering main view and detail view scenarios for schedules and loops, including no-op on non-pauseable types and no-mutations context. All 651 dashboard tests pass. **No regression.**

### Migration Completeness

- Source files: 0 remaining references to `workspace` in `src/cli/dashboard/` (verified via grep)
- Source files: 0 remaining references to `'v'` or `'w'` keybindings in `src/cli/dashboard/` (verified via grep)
- Domain layer: 1 stale JSDoc comment in `src/core/domain.ts:885` (flagged above as MEDIUM)
- Documentation: 1 stale file reference in `CLAUDE.md:297` (flagged above as MEDIUM)
- Tests: All workspace-specific test files deleted; all remaining 651 tests pass
- Integration: All 91 integration tests pass (workspace integration test correctly removed)

### Pitfall Assessment (avoids PF-002)

The workspace view and grid mode removal is a clean break with zero users. This feature was internal dashboard UI only -- not an external API, CLI flag, or config option consumed by downstream users. No migration or backward-compatibility path is needed. This correctly follows PF-002: do not add migration paths for features with zero users.
