# Complexity Review Report

**Branch**: feat/166-167-dashboard-cleanup -> main
**Date**: 2026-05-14

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Nested ternary for entityStatus in app.tsx** - `src/cli/dashboard/app.tsx:204-212`
**Confidence**: 85%
- Problem: The `entityStatus` prop passed to `<Footer>` uses a triple-nested ternary (3 levels deep) to resolve the entity status from data. This is at the boundary of the readability threshold -- the expression nests `view.kind === 'detail'` -> `view.entityType === 'schedules'` -> `view.entityType === 'loops'` with a `data?.find()` call embedded at each leaf. While each branch is individually simple, the nesting forces the reader to track multiple conditions simultaneously.
- Fix: Extract to a named helper function at the top of the component body, making intent explicit:
```typescript
function resolveDetailEntityStatus(
  view: ViewState,
  data: DashboardData | null,
): string | undefined {
  if (view.kind !== 'detail') return undefined;
  if (view.entityType === 'schedules') {
    return data?.schedules.find((s) => s.id === view.entityId)?.status;
  }
  if (view.entityType === 'loops') {
    return data?.loops.find((l) => l.id === view.entityId)?.status;
  }
  return undefined;
}
```

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

_No issues found._

## Suggestions (Lower Confidence)

- **handleDetailKeys dispatcher chain length** - `src/cli/dashboard/keyboard/handle-detail-keys.ts:349-360` (Confidence: 65%) -- The or-chain now has 6 handlers. Not a problem today, but if another handler is added, consider refactoring to a handler array pattern to keep the dispatcher flat. The current chain is still readable and well-documented.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Complexity Score**: 9/10
**Recommendation**: APPROVED_WITH_CONDITIONS

This PR is a net-positive for complexity. It removes approximately 2,800 lines (workspace view, grid mode, workspace-types, workspace keyboard handler, orchestrator-nav, task-panel, empty-workspace, and all associated tests). The resulting codebase has a simpler view state machine (main | detail instead of main | workspace | detail), a reduced type surface (`ViewState`, `DetailReturnTarget`, `DashboardAction` all shrink), and fewer keyboard handler modules.

The new `pauseOrResumeEntity` function follows the exact same pattern as the existing `cancelEntity` and `deleteEntity` -- switch on entity kind, guard on status, dispatch to service, refresh. Cyclomatic complexity is low (~4 per function). The new `handlePauseResume` in detail keys and the `p` handler in main keys are both concise (under 20 lines each) and well-tested (9 unit tests + 10 integration tests).

The single blocking condition is the nested ternary in `app.tsx:204-212`, which can be trivially extracted to a named helper. avoids PF-001 -- all findings are surfaced directly rather than deferred.
