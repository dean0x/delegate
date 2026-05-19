# Reliability Review Report

**Branch**: feat/166-167-dashboard-cleanup -> main
**Date**: 2026-05-14

## Issues in Your Changes (BLOCKING)

No blocking reliability issues found.

## Issues in Code You Touched (Should Fix)

No should-fix reliability issues found.

## Pre-existing Issues (Not Blocking)

No critical pre-existing reliability issues found in changed files.

## Suggestions (Lower Confidence)

- **Fire-and-forget async in handlePauseResume without error surface** - `src/cli/dashboard/keyboard/handle-detail-keys.ts:114,119` (Confidence: 65%) -- `pauseOrResumeEntity` is called with `void` (fire-and-forget). The function internally catches all errors and swallows them. While this prevents crashes (good for TUI reliability), the user receives zero feedback when a pause/resume operation fails silently. The same pattern already exists for cancel/delete, so this is consistent -- but if the service layer ever stops logging internally, failures become invisible. Consider surfacing a transient error indicator on the next poll refresh.

- **detailEntityStatus lookup iterates full entity list on every render** - `src/cli/dashboard/app.tsx:148-156` (Confidence: 60%) -- The `useMemo` for `detailEntityStatus` does a linear `.find()` over `data?.schedules` or `data?.loops` on every render where the deps change. With the existing FETCH_LIMIT of 100 entities this is negligible, but if the limit grows the O(n) scan is repeated per-render. A Map lookup would be O(1), though current scale does not justify the change.

- **handlePauseResume returns true (key consumed) even when mutations is undefined** - `src/cli/dashboard/keyboard/handle-detail-keys.ts:109` (Confidence: 70%) -- When `input === 'p'` and `mutations` is undefined (read-only context), the function returns `true`, swallowing the keypress silently. This is consistent with the pattern used by cancel/delete in handle-main-keys (which also returns true when consuming a key even if no action is taken), so it follows existing convention. However, it means `p` is never available as a shortcut for anything else in read-only mode.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Reliability Score**: 9/10
**Recommendation**: APPROVED

## Analysis Details

### Bounded Iteration
All loops and iterations in the changed code are bounded. The `pauseOrResumeEntity` switch statement has a finite set of cases with a `default: break` fallback. No unbounded retry loops, no pagination without limits, no recursive calls. The removed workspace code (handle-workspace-keys.ts, ~273 lines) actually contained unbounded grid page increments (`gridPage: prev.gridPage + 1` without upper bound) -- this deletion improves reliability.

### Assertion Density
The new `pauseOrResumeEntity` function validates entity kind via switch/case and entity status via explicit comparisons against `ScheduleStatus.ACTIVE`, `ScheduleStatus.PAUSED`, `LoopStatus.RUNNING`, `LoopStatus.PAUSED`. Non-matching statuses are no-ops (implicit assertions). The `handlePauseResume` detail handler guards on `view.kind !== 'detail'` and `!mutations` before proceeding.

### Allocation Discipline
No allocations in hot paths. The `useMemo` in `app.tsx` for `detailEntityStatus` correctly memoizes. The `streamTaskIds` array creation (`detailStreamTaskId !== null ? [detailStreamTaskId] : []`) creates a small array per render but is already within the existing pattern and is negligible.

### Error Handling / Resource Safety
The `try/catch` in `pauseOrResumeEntity` (lines 100-126) catches all errors to prevent unhandled rejections from crashing the TUI. This matches the established pattern in `cancelEntity` and `deleteEntity`. Error swallowing is documented in the JSDoc and is appropriate for a best-effort UI operation where the next poll cycle will reconcile state.

### Deletion Analysis (Reliability Impact)
The PR deletes ~2,800 lines including the entire workspace view, grid mode, workspace keyboard handler, workspace types, and associated tests. This is a net reliability improvement:
- Removes `handle-workspace-keys.ts` which had complex focus-area state management (nav/grid cycling)
- Removes `WorkspaceNavState` with its mutable scroll offsets and auto-tail tracking per-task
- Removes grid pagination logic that had no upper bound on `gridPage`
- Simplifies the view state machine from 3 kinds (`main`/`workspace`/`detail`) to 2 (`main`/`detail`)
- Narrows `DetailReturnTarget` from `'main' | 'workspace' | object` to `'main' | object`, eliminating an impossible state

### Test Coverage
New tests cover pause/resume dispatch thoroughly: 9 test cases in `entity-mutations.test.ts` covering active/paused/terminal schedules, running/paused/failed loops, non-pauseable entity kinds (task, orchestration), and service error swallowing. The `hints.test.ts` adds 15 assertions covering all branching conditions. Footer tests verify pause/resume hint visibility for all 5 panel types plus detail-view variants. avoids PF-001 (all issues surfaced, none deferred).
