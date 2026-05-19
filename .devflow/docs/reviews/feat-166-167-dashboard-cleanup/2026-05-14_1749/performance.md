# Performance Review Report

**Branch**: feat/166-167-dashboard-cleanup -> main
**Date**: 2026-05-14

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Array.find() in render path for Footer entityStatus prop** - `src/cli/dashboard/app.tsx:207-209`
**Confidence**: 82%
- Problem: The `entityStatus` prop passed to `<Footer>` calls `data?.schedules.find(...)` or `data?.loops.find(...)` inline in the JSX on every render cycle. These arrays are fetched with `FETCH_LIMIT` (typically 50). While the `Footer` is wrapped in `React.memo`, the `entityStatus` prop itself is recomputed every render, and since `find()` returns a new primitive (string or undefined) derived from the array scan, it will only cause a re-render when the status actually changes -- so `React.memo` does protect against unnecessary child re-renders. However, the `find()` itself runs on every parent render regardless. With arrays capped at 50 items and `find()` being O(n), the cost per render is negligible at current scale. This is a MEDIUM rather than HIGH because the dataset is bounded by `FETCH_LIMIT`.
- Fix: Extract the status lookup into a `useMemo` or compute it once in the render body before the JSX return:
  ```typescript
  const footerEntityStatus = useMemo(() => {
    if (view.kind !== 'detail') return undefined;
    if (view.entityType === 'schedules') return data?.schedules.find((s) => s.id === view.entityId)?.status;
    if (view.entityType === 'loops') return data?.loops.find((l) => l.id === view.entityId)?.status;
    return undefined;
  }, [view, data?.schedules, data?.loops]);
  ```

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

_No performance issues found in unchanged code that meet the CRITICAL severity threshold._

## Suggestions (Lower Confidence)

- **Repeated Array.find() in handlePauseResume** - `src/cli/dashboard/keyboard/handle-detail-keys.ts:112,117` (Confidence: 65%) -- The `handlePauseResume` function performs `dataRef.current?.schedules.find(...)` / `dataRef.current?.loops.find(...)` on each `p` keypress. This is user-initiated (not per-render), operates on bounded arrays (FETCH_LIMIT), and only runs once per keypress, so it is a non-issue in practice. Mentioning only for completeness.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Performance Score**: 9/10
**Recommendation**: APPROVED

### Rationale

This PR is overwhelmingly a deletion PR (net -2,285 lines). The performance impact is strongly positive:

1. **Eliminated the 750ms workspace poll interval** -- the workspace view had the most aggressive polling cadence in the dashboard. Removing it means the dashboard now only uses 1,000ms (main) and 2,000ms (detail) intervals, reducing DB pressure.

2. **Removed fetchWorkspaceExtras()** -- this function performed 2 additional parallel DB queries (getOrchestratorChildren + sumByOrchestrationId) every 750ms when in workspace view. Those queries are gone entirely.

3. **Removed computeWorkspaceLayout()** -- eliminated a per-render layout computation that involved grid column/row arithmetic, panel sizing, and compact-mode detection.

4. **Removed workspaceNav state** from the reducer -- the DashboardState object is smaller (one fewer top-level key), reducing spread-copy overhead on every reducer dispatch.

5. **Reduced streaming scope** -- output streaming was previously enabled for all workspace child tasks simultaneously (up to 20 concurrent streams). Now streaming is limited to a single task in detail view only, substantially reducing polling and memory overhead.

6. **New code is minimal and efficient** -- the `pauseOrResumeEntity` function is a simple switch/case dispatching to existing service methods, with no loops, no allocations, and no async chains beyond the single service call. The `handlePauseResume` handler is equally lightweight.

The single MEDIUM finding (inline `find()` in JSX) is a minor style concern at current scale, not a functional performance issue. The PR delivers a meaningful performance improvement by removing an entire high-frequency polling pathway and its associated computation.
