# React Review Report

**Branch**: feat/166-167-dashboard-cleanup -> main
**Date**: 2026-05-14

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Inline `.find()` in JSX props creates unstable references on every render** - `src/cli/dashboard/app.tsx:204-212`
**Confidence**: 82%
- Problem: The `entityStatus` prop passed to `<Footer>` computes `data?.schedules.find(...)?.status` and `data?.loops.find(...)?.status` inline in JSX. This creates a new computation on every render of the `App` component. While `Footer` is wrapped in `React.memo`, the status string itself is a primitive so referential equality is preserved when the value is the same. However, the triple-nested ternary is hard to read and the `.find()` calls execute on every render even when `view.kind !== 'detail'` (the outer ternary short-circuits, but the pattern invites bugs if extended).
- Fix: Extract to a `useMemo` or a local variable above the return statement:
  ```tsx
  const footerEntityStatus = useMemo(() => {
    if (view.kind !== 'detail') return undefined;
    if (view.entityType === 'schedules') {
      return data?.schedules.find((s) => s.id === view.entityId)?.status;
    }
    if (view.entityType === 'loops') {
      return data?.loops.find((l) => l.id === view.entityId)?.status;
    }
    return undefined;
  }, [view, data?.schedules, data?.loops]);
  ```
  This improves readability and makes the computation cacheable.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Stale CLAUDE.md file location entry: Workspace view** - `CLAUDE.md:297`
**Confidence**: 95%
- Problem: The File Locations table in CLAUDE.md still references `src/cli/dashboard/views/workspace-view.tsx` which was deleted in this PR. This will mislead future developers and Claude Code sessions.
- Fix: Remove the row `| Workspace view | src/cli/dashboard/views/workspace-view.tsx |` from the table.

## Pre-existing Issues (Not Blocking)

No pre-existing React issues found at CRITICAL severity.

## Suggestions (Lower Confidence)

- **`handlePauseResume` returns `true` even when `p` is pressed in non-pauseable detail views (tasks, orchestrations, pipelines)** - `src/cli/dashboard/keyboard/handle-detail-keys.ts:109` (Confidence: 65%) -- When `mutations` is present but `entityType` is e.g. `pipelines`, `p` is consumed and returns `true` without doing anything. This is documented as "silently consumed" and is consistent with how the loop/orchestration handlers also swallow unrecognized keys, but it means pressing `p` in a pipeline detail does nothing instead of falling through to genericScroll. Since genericScroll also swallows all keys, this is behaviorally identical -- the concern is purely about semantic clarity.

- **Footer test coverage for new `entityType`/`entityStatus` props** - `tests/unit/cli/dashboard/footer.test.tsx` (Confidence: 70%) -- The existing footer tests do not cover the new `entityType` and `entityStatus` props that drive the conditional "p pause" / "p resume" hints. The `detailHints()` function in `hints.ts` is tested indirectly via the integration tests in `use-keyboard.test.tsx`, but a few direct unit tests for `Footer` rendering with these props would strengthen coverage.

- **`detailHints` compares `.toLowerCase()` against enum values** - `src/cli/dashboard/keyboard/hints.ts:29-34` (Confidence: 62%) -- The `detailHints` function calls `entityStatus?.toLowerCase()` then compares against literal strings `'active'`, `'running'`, `'paused'`. The `ScheduleStatus` and `LoopStatus` enums already define these as lowercase strings, so the `.toLowerCase()` call is redundant but harmless. If enum values ever change casing, this would silently break. Consider comparing against the enum constants directly (`ScheduleStatus.ACTIVE`, `LoopStatus.RUNNING`, etc.) for consistency with how `pauseOrResumeEntity` does it.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**React Score**: 9/10
**Recommendation**: APPROVED_WITH_CONDITIONS

This PR is a clean, well-executed removal of the workspace view and addition of pause/resume keyboard controls. The changes demonstrate strong React patterns:

- **Composition**: The workspace view elimination correctly removes an entire view layer, its state slice (`workspaceNav`), reducer actions, and keyboard handler -- leaving no orphaned code.
- **Hooks at top level**: All hook usage remains at the top level of components. No conditional hooks introduced.
- **Discriminated unions**: The `ViewState` union type was properly narrowed from 3 to 2 variants, with `DetailReturnTarget` simplified accordingly.
- **`React.memo`**: All memoized components (`Footer`, `OrchestrationDetail`, `App`) remain correctly wrapped.
- **Test coverage**: 9 unit tests for `pauseOrResumeEntity` + 10 integration tests for the keyboard hook cover the new pause/resume feature thoroughly.
- **Dead code elimination**: ~2,800 lines removed across 5 source files, 4 test files, and ~20 modified files with no remaining workspace references in source.

The two conditions are minor: (1) extract the inline `.find()` from the Footer JSX props for readability, and (2) remove the stale CLAUDE.md workspace file location entry.
