# Consistency Review Report

**Branch**: feat/166-167-dashboard-cleanup -> main
**Date**: 2026-05-14

## Issues in Your Changes (BLOCKING)

### MEDIUM

**JSDoc section numbering inconsistency in handle-detail-keys.ts** - `src/cli/dashboard/keyboard/handle-detail-keys.ts:126,184`
**Confidence**: 92%
- Problem: After inserting `handlePauseResume` as section "3", the subsequent function JSDoc numbers were not updated. Both `handleLoopNavigation` (line 126) and `handleOrchestrationNavigation` (line 184) are labeled as "4". `handleGenericScroll` (line 278) is labeled "5". The correct sequence should be 3 (pause/resume), 4 (loop), 5 (orchestration), 6 (generic scroll).
- Fix: Renumber the JSDoc comments:
  - Line 126: `4. Loop detail:` (already correct)
  - Line 184: Change `4. D3 orchestration detail:` to `5. D3 orchestration detail:`
  - Line 278: Change `5. Generic scroll` to `6. Generic scroll`

**Dispatcher comment omits handlePauseResume from key handler ordering** - `src/cli/dashboard/keyboard/handle-detail-keys.ts:342-347`
**Confidence**: 95%
- Problem: The `handleDetailKeys` dispatcher JSDoc lists 5 key handler ordering steps, but the actual chain has 6 handlers. `handlePauseResume` (pause/resume toggle, positioned between output controls and loop navigation in the chain at line 355) is missing from the numbered list. The code dispatches to it at position 3 in the chain, but the comment jumps from "2. Output controls" to "3. Loop entity type".
- Fix: Update the key handler ordering comment to include pause/resume:
  ```
  * Key handler ordering:
  *  1. Esc/Backspace -> return to previous view
  *  2. Output controls (o/[/]/g/G) -> guarded to task/orchestration only
  *  3. Pause/resume (p) -> schedules and loops only
  *  4. Loop entity type -> iteration navigation
  *  5. Orchestration entity type -> child navigation (existing D3 pattern)
  *  6. Generic scroll -> non-orchestration/non-loop detail (schedules, pipelines)
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**CLAUDE.md file location table references deleted workspace-view.tsx** - `CLAUDE.md:297`
**Confidence**: 100%
- Problem: The "File Locations" table in CLAUDE.md still contains `| Workspace view | src/cli/dashboard/views/workspace-view.tsx |` but this file was deleted in this PR (along with the entire workspace view feature). This creates a stale reference that will confuse anyone consulting the table.
- Fix: Remove line 297 from CLAUDE.md:
  ```diff
  -| Workspace view | `src/cli/dashboard/views/workspace-view.tsx` |
  ```

## Pre-existing Issues (Not Blocking)

No pre-existing consistency issues found in the reviewed files.

## Suggestions (Lower Confidence)

- **detailHints uses raw string comparison instead of enum constants** - `src/cli/dashboard/keyboard/hints.ts:30-33` (Confidence: 65%) -- `detailHints` lowercases the status then compares to string literals ('active', 'running', 'paused'), whereas `pauseOrResumeEntity` in entity-mutations.ts uses the enum constants (`ScheduleStatus.ACTIVE`, `LoopStatus.RUNNING`). The enum values happen to be lowercase strings so both approaches work, but the entity-mutations pattern is more type-safe and would catch enum value changes at compile time.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Consistency Score**: 9/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The workspace view removal (#166) is thorough and clean -- all type unions, reducer actions, keyboard handlers, test files, and view components related to workspace have been consistently purged. The `ViewState`, `DetailReturnTarget`, `DashboardAction`, `POLL_INTERVAL_BY_VIEW`, and `viewKind` union types all correctly narrow from `'main' | 'workspace' | 'detail'` to `'main' | 'detail'`. No stale source-level workspace references remain.

The pause/resume feature (#167) follows the established entity-mutations pattern precisely: `pauseOrResumeEntity` mirrors `cancelEntity`/`deleteEntity` in signature, error handling (try/catch with swallow), and refresh-on-success. The main-view handler follows the same `getFocusedPanelItem` + `panelToEntityKind` + `void dispatch()` pattern as c/d. Detail-view pause/resume correctly uses `dataRef.current` for freshness. Test coverage (9 unit + 10 integration) follows the existing mutation test patterns.

Conditions: fix the JSDoc numbering gap and the stale CLAUDE.md reference (avoids PF-001 -- surface issues now rather than defer to a future PR).
