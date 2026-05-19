# Architecture Review Report

**Branch**: feat/166-167-dashboard-cleanup -> main
**Date**: 2026-05-14
**Commits**: 31397d5 (#166 workspace removal), 14b939f (#167 pause/resume), 4f9ad13 (#173 orchestrator fixes)

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Entity status lookup in app.tsx violates "tell, don't ask" / Law of Demeter** - `app.tsx:204-212`
**Confidence**: 82%
- Problem: The `App` component performs a linear scan of `data?.schedules` and `data?.loops` arrays using `.find()` inline within the JSX to derive `entityStatus` for the Footer. This pushes data-derivation logic into the shell component, which per the existing architecture comment should only compose hooks and views. The shell is now reaching into dashboard data arrays to extract status for a leaf component -- this is feature envy.
- Fix: Extract a pure helper (e.g., `getDetailEntityStatus(view, data)`) in a shared module, or derive `entityStatus` alongside `detailStreamTaskId` in the existing data-derivation block (lines 106-124) and pass it as a local variable. This keeps the JSX declarative and the shell component thin:
  ```typescript
  // Above renderView(), alongside detailStreamTaskId:
  const detailEntityStatus =
    view.kind === 'detail' && view.entityType === 'schedules'
      ? data?.schedules.find((s) => s.id === view.entityId)?.status
      : view.kind === 'detail' && view.entityType === 'loops'
        ? data?.loops.find((l) => l.id === view.entityId)?.status
        : undefined;
  // ...then in JSX:
  <Footer ... entityStatus={detailEntityStatus} />
  ```

**Footer hint params use loose `string` types instead of domain enums** - `hints.ts:26-37`, `footer.tsx:17-19`
**Confidence**: 80%
- Problem: `detailHints()` accepts `entityType?: string` and `entityStatus?: string`, then compares against string literals (`'active'`, `'running'`, `'paused'`, `'schedules'`, `'loops'`). The existing codebase consistently uses branded types and domain enums (`ScheduleStatus.ACTIVE`, `LoopStatus.RUNNING`, `PanelId`). Using loose strings here bypasses the type system -- a typo in the comparison strings would silently produce incorrect hints with no compile-time error.
- Fix: Use `PanelId` for `entityType` and the domain status enums for comparison:
  ```typescript
  export function detailHints(entityType?: PanelId, entityStatus?: string): string {
    // ...
    if (entityType === 'schedules' || entityType === 'loops') {
      if (entityStatus === ScheduleStatus.ACTIVE || entityStatus === LoopStatus.RUNNING) {
        return `${base} · p pause`;
      }
      if (entityStatus === ScheduleStatus.PAUSED || entityStatus === LoopStatus.PAUSED) {
        return `${base} · p resume`;
      }
    }
  }
  ```
  This eliminates the `.toLowerCase()` call and makes the hint logic provably correct via the type system.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**CLAUDE.md file-locations table references deleted file** - `CLAUDE.md:297`
**Confidence**: 95%
- Problem: The file-locations table in CLAUDE.md still lists `Workspace view | src/cli/dashboard/views/workspace-view.tsx` but this file was deleted as part of commit 31397d5. While CLAUDE.md was not modified in this branch, the PR is specifically about removing workspace infrastructure, so this stale reference should be cleaned up here. *avoids PF-001* (surface pre-existing issues found in review, fix while here).
- Fix: Remove the workspace view row from the table, and optionally add a row for the new `entity-mutations.ts` keyboard module which now contains the `pauseOrResumeEntity` function.

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **`mainHints` shows "p pause/resume" unconditionally** - `hints.ts:16` (Confidence: 65%) -- The main view hint shows `p pause/resume` for all panels even though only schedules and loops support it. Pressing `p` on tasks or orchestrations is silently consumed, which is correct behavior, but the hint text could mislead users into thinking pause/resume applies universally.

- **`pauseOrResumeEntity` uses bare catch block** - `entity-mutations.ts:123` (Confidence: 62%) -- The `catch {}` block swallows all errors. While the JSDoc explains this is intentional (preventing TUI crashes), the existing `cancelEntity` and `deleteEntity` functions use the same pattern. Consistent, but a structured logger.warn would improve observability without changing crash behavior.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Architecture Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Assessment

This PR is an architecturally clean deletion of ~2,800 lines of workspace/grid infrastructure. The removal is thorough and complete:

1. **Separation of concerns** -- The workspace view collapse into main+detail only is a simplification that reduces the view state machine from 3 variants to 2. The discriminated union `ViewState` is now tighter with no dead branches. The `DashboardState`, `DashboardAction`, `DetailReturnTarget`, and `POLL_INTERVAL_BY_VIEW` types all had their workspace variants removed consistently.

2. **No orphaned references** -- Zero remaining `workspace` string references in the dashboard source tree (verified via grep). All imports, types, state slices, reducer actions, keyboard handlers, and hint functions were updated consistently.

3. **Consistent extension pattern** -- The new `pauseOrResumeEntity` function follows the exact same pattern as the existing `cancelEntity` and `deleteEntity`: same parameter shape, same try/catch, same `refreshNow()` call pattern, same location in `entity-mutations.ts`. The keyboard handler integration in both `handle-main-keys.ts` and `handle-detail-keys.ts` follows the existing `c`/`d` binding pattern.

4. **Test coverage** -- 9 unit tests for the new `pauseOrResumeEntity` dispatch + 10 integration tests for the keyboard hook cover all entity kind/status combinations including edge cases (terminal status, non-pauseable kinds, missing mutations context, service errors).

The two MEDIUM blocking items are about type safety and component responsibility boundaries -- both are small fixes that align the new code with the project's existing patterns.
