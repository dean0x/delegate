# Performance Review Report

**Branch**: feat-165-168-dashboard-detail-views -> main
**Date**: 2026-05-13

## Issues in Your Changes (BLOCKING)

### HIGH

**useEffect without dependency array causes measureElement() on every render** - `task-detail.tsx:78-85`, `orchestration-detail.tsx:404-411`
**Confidence**: 92%
- Problem: Both `TaskDetail` and `OrchestrationDetail` call `useEffect(() => { ... })` without a dependency array. This means `measureElement()` runs after every render cycle, not just when the metadata content changes. In a dashboard that re-renders on polling intervals (`animFrame` prop increments), this triggers DOM measurement on every frame even when the metadata section has not changed. While `measureElement()` is synchronous and fast in Ink, the pattern is wasteful and violates React best practices -- effects without dependency arrays are reserved for cases that genuinely need to run after every commit.
- Fix: Add a dependency array. Since `metadataRef.current` is a ref and does not trigger re-renders, the effect should depend on the props that actually change the metadata layout. At minimum, this prevents redundant calls when only the output stream or scroll offset changes:

```tsx
// task-detail.tsx
useEffect(() => {
  if (metadataRef.current) {
    const { height } = measureElement(metadataRef.current);
    if (height !== metadataHeight) {
      setMetadataHeight(height);
    }
  }
}); // <-- no deps = runs every render

// Fix: run only when layout-affecting props change
useEffect(() => {
  if (metadataRef.current) {
    const { height } = measureElement(metadataRef.current);
    if (height !== metadataHeight) {
      setMetadataHeight(height);
    }
  }
}, [task, dependencies, dependents, usage, animFrame]);
```

Apply the same pattern in `orchestration-detail.tsx` with the relevant props (`orchestration`, `children`, `costAggregate`, `animFrame`).

**Note**: The `if (height !== metadataHeight)` guard prevents infinite re-render loops, so this is not a correctness bug -- only a performance inefficiency. Severity is HIGH rather than CRITICAL because the guard limits the actual impact.

---

**new Map() allocated on every render in app.tsx** - `app.tsx:165`
**Confidence**: 85%
- Problem: `new Map()` is created inline every render when `view.kind !== 'workspace'`. This produces a new object reference each cycle, which may cause referential inequality downstream in hooks or memoized components that receive `streamTaskStatuses` as a dependency or prop.
- Fix: Hoist an empty Map constant outside the component:

```tsx
// At module level
const EMPTY_STATUS_MAP: ReadonlyMap<TaskId, string> = new Map();

// In component
const streamTaskStatuses: ReadonlyMap<TaskId, string> =
  view.kind === 'workspace' ? childTaskStatuses : EMPTY_STATUS_MAP;
```

Similarly, `[detailStreamTaskId]` on line 164 creates a new single-element array every render. Consider `useMemo`:

```tsx
const streamTaskIds = useMemo(
  () => view.kind === 'workspace' ? childTaskIds : detailStreamTaskId !== null ? [detailStreamTaskId] : [],
  [view.kind, childTaskIds, detailStreamTaskId],
);
```

### MEDIUM

**renderConvergenceLine copies and filters full iterations array without memoization** - `loop-detail.tsx:275-279`
**Confidence**: 80%
- Problem: Inside the `LoopDetail` memoized component, `scoredIterations` (line 276) and `convergenceLine` (line 278-279) are computed on every render without `useMemo`. `renderConvergenceLine` calls `[...iterations].reverse()` (full array copy) followed by `.filter()` and `.slice()`. With `historyLimit` defaulting to 20, this is not currently expensive, but the computation runs on every render pass (including `animFrame` ticks for the status spinner). The existing `renderIterationRow` and `selectedIndex` correctly use `useMemo` -- this computation should follow the same pattern.
- Fix: Wrap in `useMemo`:

```tsx
const { showTrend, convergenceLine } = React.useMemo(() => {
  const scoredIterations = iterations?.filter(
    (i) => i.score !== undefined && i.status !== 'progress'
  ) ?? [];
  const show = loop.strategy === 'optimize' && scoredIterations.length >= 2;
  const line = show && iterations !== undefined
    ? renderConvergenceLine(iterations, loop.evalDirection)
    : '';
  return { showTrend: show, convergenceLine: line };
}, [iterations, loop.strategy, loop.evalDirection]);
```

## Issues in Code You Touched (Should Fix)

_No issues found in this category._

## Pre-existing Issues (Not Blocking)

_No CRITICAL pre-existing issues found._

## Suggestions (Lower Confidence)

- **resolveDetailStreamTaskId declared as inner function** - `app.tsx:140-147` (Confidence: 65%) -- This function is declared inline and recreated every render. Since it closes over `view`, `outputRepository`, and `nav`, it could be extracted with `useCallback` or inlined as a computed value (no function needed since it is called once immediately). Minor impact since it is cheap, but inconsistent with the rest of the component's memoization discipline.

- **Single-element array allocation on each key press** - `handle-detail-keys.ts:117,127` (Confidence: 60%) -- `iterations[nextIdx]?.iterationNumber ?? null` is fine, but the `setNav` updater creates a new nav object spread on every arrow key press. This is standard React state update behavior and is not a real issue, but worth noting that rapid key repeats (holding arrow key) will queue many state updates. Ink batches these adequately.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Performance Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The two HIGH issues (useEffect without deps causing unnecessary measureElement() calls on every render, and new Map() on every render causing referential instability) are straightforward fixes that prevent wasteful work on each polling-driven re-render. The MEDIUM convergence line computation should be memoized for consistency with the component's existing memoization patterns. None of these are correctness bugs -- the code works correctly -- but they represent avoidable work in a dashboard that re-renders frequently on a timer.
