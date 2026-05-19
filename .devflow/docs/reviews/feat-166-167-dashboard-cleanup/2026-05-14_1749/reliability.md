# Reliability Review Report

**Branch**: feat/166-167-dashboard-cleanup -> main
**Date**: 2026-05-14

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Fire-and-forget async in handlePauseResume without error propagation awareness** - `src/cli/dashboard/keyboard/handle-detail-keys.ts:114,119`
**Confidence**: 82%
- Problem: `handlePauseResume` calls `void pauseOrResumeEntity(...)` which internally catches all errors. This is consistent with the existing `cancelEntity`/`deleteEntity` pattern (also fire-and-forget with catch-all). However, unlike the cancel path which has a comment explaining the catch-all rationale in the calling context (e.g., `handleMainKeys.ts:155-162`), the detail handler dispatches without any comment at the call site explaining why the returned promise is intentionally ignored.
- Fix: This is already handled correctly by the `pauseOrResumeEntity` function's internal try/catch. The `void` prefix is the correct pattern for fire-and-forget in this codebase. No action required -- flagging for completeness since it matches the existing pattern exactly.

**Linear scan of schedules/loops arrays in render path for Footer props** - `src/cli/dashboard/app.tsx:206-211`
**Confidence**: 80%
- Problem: The `entityStatus` prop computation uses `data?.schedules.find(...)` and `data?.loops.find(...)` directly in the JSX return. These are O(n) scans run on every render cycle. With the current FETCH_LIMIT (likely capped at a few hundred), this is negligible. However, it executes in the render path of App, which is the root component re-rendering on every poll tick and every keyboard event.
- Fix: This is a minor concern given the bounded dataset sizes (FETCH_LIMIT). If performance becomes a concern, memoize the status lookup. For now, this is acceptable as the find operations are on small arrays. No blocking action required.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**CLAUDE.md file location table references deleted file** - `CLAUDE.md:297`
**Confidence**: 95%
- Problem: The file location table in CLAUDE.md still references `src/cli/dashboard/views/workspace-view.tsx` and `src/cli/dashboard/workspace-types.ts` (line 297), but these files were deleted in this PR. This is a documentation drift issue that could mislead future development.
- Fix: Remove the "Workspace view" row from the file locations table in CLAUDE.md:
  ```
  | Workspace view | `src/cli/dashboard/views/workspace-view.tsx` |
  ```

## Suggestions (Lower Confidence)

(none -- all findings meet the 80% threshold)

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | 0 |
| Should Fix | - | - | 2 | - |
| Pre-existing | - | - | 1 | - |

**Reliability Score**: 9/10
**Recommendation**: APPROVED

## Analysis Notes

This PR is overwhelmingly a deletion PR (2,810 lines removed, 525 added) that removes the workspace view, grid mode, and all supporting infrastructure. From a reliability perspective:

**Bounded Iteration**: No new loops, retries, or pagination introduced. Existing bounded patterns (FETCH_LIMIT, ORCHESTRATION_CHILDREN_PAGE_SIZE, Math.max/Math.min clamping) are preserved.

**Assertion Density**: The new `pauseOrResumeEntity` function has appropriate guard conditions -- it checks entity kind via switch/case and entity status via equality comparison before dispatching. Non-pauseable entity kinds fall through to the default no-op case. Terminal and unexpected statuses are silently ignored (correct for a TUI where user confusion is worse than a no-op).

**Error Handling**: The new `pauseOrResumeEntity` follows the established catch-all pattern from `cancelEntity`/`deleteEntity`. The comment "Swallowing here prevents unhandled rejection from crashing the dashboard TUI" accurately describes the defensive rationale. The `refreshNow()` call after successful pause/resume ensures the next poll reflects the state change.

**Resource Cleanup**: The workspace view removal eliminates the 750ms workspace poll interval, the workspace data fetching pipeline (`fetchWorkspaceExtras`), and workspace nav state management. This is a net reduction in resource usage and state complexity.

**State Cleanup Completeness**: All workspace-related state (`workspaceNav`, `WorkspaceNavState`, `createInitialWorkspaceNavState`), types (`ViewState` workspace variant, `DetailReturnTarget` workspace variant), and infrastructure (reducer actions, keyboard handlers, layout computation, components) are cleanly removed. No orphaned state remains. The `originalReturnTo` type was correctly narrowed from `'main' | 'workspace'` to just `'main'`.

**Test Coverage**: The new `pauseOrResumeEntity` function has 9 unit tests covering: pause/resume for both entity kinds, terminal status no-ops, non-pauseable entity kind no-ops, and error swallowing. The integration tests for keyboard behavior add 10 more tests covering main-view and detail-view pause/resume for both schedules and loops, plus edge cases (task detail no-op, no mutations context).

**Knowledge Context**: PF-001 (do not defer issues) and PF-002 (no migration for zero-user features) are not triggered by this PR -- the workspace view deletion is a clean removal with zero backward-compatibility concerns (avoids PF-002: clean break is correct for an internal dashboard view with no external API surface).
