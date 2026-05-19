# UI Design Review Report

**Branch**: feat/166-167-dashboard-cleanup -> main
**Date**: 2026-05-14

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Footer hint "p pause/resume" always shown in main view regardless of focused panel** - `src/cli/dashboard/keyboard/hints.ts:16`
**Confidence**: 85%
- Problem: The `mainHints()` function unconditionally appends `p pause/resume` when `hasMutations` is true. However, the `p` key only operates on schedules and loops (silently ignored for tasks, orchestrations, pipelines). Showing a hint for a non-functional key misleads the user when they are focused on tasks, orchestrations, or pipeline panels. In the detail view, this is handled correctly -- `detailHints()` conditionally shows "p pause" or "p resume" only for schedule/loop entity types. The main view lacks equivalent contextual awareness.
- Fix: Pass the `focusedPanel` to the footer in main view and only show the `p pause/resume` hint when the panel is `schedules` or `loops`. Alternatively, keep the hint but annotate it: `p pause/resume (schedules/loops)`.

**Deeply nested ternary for entityStatus prop in app.tsx** - `src/cli/dashboard/app.tsx:204-212`
**Confidence**: 82%
- Problem: The `entityStatus` prop computation uses a 4-level nested ternary expression that spans 8 lines. This harms readability and makes the rendering logic harder to maintain. Per the UI design checklist, visual hierarchy and code clarity serve the same purpose -- making intent obvious.
- Fix: Extract the status lookup into a small helper function:
  ```tsx
  function resolveEntityStatus(view: ViewState, data: DashboardData | null): string | undefined {
    if (view.kind !== 'detail') return undefined;
    if (view.entityType === 'schedules') return data?.schedules.find((s) => s.id === view.entityId)?.status;
    if (view.entityType === 'loops') return data?.loops.find((l) => l.id === view.entityId)?.status;
    return undefined;
  }
  ```

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Main view hint string is long and may truncate on narrow terminals** - `src/cli/dashboard/keyboard/hints.ts:14-16` (Confidence: 65%) -- With mutations enabled, the hint string is now 93 characters (`Tab: panel ... p pause/resume`). On terminals narrower than ~100 columns the Ink `<Text>` will wrap or truncate, potentially hiding the rightmost hints. Consider using an abbreviated form for narrow terminals or prioritizing the most important hints.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**UI Design Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The workspace removal (#166) is clean and thorough -- 5 source files, 4 test files, and ~20 modified files all consistently purge the workspace view, grid mode, and supporting infrastructure. The type system (ViewState, DetailReturnTarget) is properly narrowed from the three-variant union (`main | workspace | detail`) to two (`main | detail`), which eliminates dead code paths at compile time.

The pause/resume feature (#167) follows existing patterns (modeled after cancelEntity/deleteEntity), adds contextual footer hints in detail view, and includes comprehensive tests (9 unit + 10 integration). The detail view correctly shows "p pause" vs "p resume" based on entity status.

The two MEDIUM findings are:
1. The main view footer shows "p pause/resume" unconditionally (even when focused on tasks/orchestrations/pipelines where the key is a no-op), while the detail view correctly conditionalizes it. This is a minor UX inconsistency rather than a functional bug -- the key simply does nothing for non-pauseable types.
2. The entityStatus prop in app.tsx uses a deeply nested ternary that would benefit from extraction into a helper for readability.

Neither finding blocks merge -- both are quality-of-life improvements. avoids PF-002 (no migration scaffolding needed for removing the workspace view with zero external users).
