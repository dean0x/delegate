# React Review Report

**Branch**: feat-165-168-dashboard-detail-views -> main
**Date**: 2026-05-13T23:19

## Issues in Your Changes (BLOCKING)

### HIGH

**useEffect without dependency array runs on every render (2 occurrences)** -- Confidence: 90%
- `src/cli/dashboard/views/task-detail.tsx:78-85`, `src/cli/dashboard/views/orchestration-detail.tsx:404-411`
- Problem: Both `TaskDetail` and `OrchestrationDetail` use `useEffect(() => { ... })` with no dependency array to measure metadata height via `measureElement()`. This runs after every render. While the `if (height !== metadataHeight)` guard prevents infinite setState loops, it still runs the effect body (including `measureElement()`) on every single render even when nothing has changed. In Ink's terminal rendering model, this means a DOM measurement call on every tick of the animation frame (which fires every 500ms per the dashboard interval).
- Fix: Add a dependency array that captures the values that could change the measured height. Since Ink's `measureElement` reflects the rendered DOM and the content is driven by props, the relevant dependencies are the data props that affect the metadata section's height:
  ```tsx
  // task-detail.tsx
  useEffect(() => {
    if (metadataRef.current) {
      const { height } = measureElement(metadataRef.current);
      if (height !== metadataHeight) {
        setMetadataHeight(height);
      }
    }
  }); // Keep as-is — Ink does not support useLayoutEffect and measureElement
      // needs post-render measurement. The guard prevents re-render loops.
  ```
  On reflection, Ink's `measureElement` requires post-commit DOM measurement and there is no `useLayoutEffect` equivalent in Ink's renderer. The guard `if (height !== metadataHeight)` prevents cascading re-renders. This is an intentional pattern for Ink-based layout measurement. **Downgrading to MEDIUM** -- the cost per render is a single DOM measurement call which is negligible in a terminal UI that refreshes at 2 Hz.

**Revised severity: MEDIUM** -- Confidence: 85%

**New Map() allocated on every render in app.tsx** -- Confidence: 82%
- `src/cli/dashboard/app.tsx:165`
- Problem: `const streamTaskStatuses: ReadonlyMap<TaskId, string> = view.kind === 'workspace' ? childTaskStatuses : new Map();` creates a new `Map` instance on every render when in detail mode. This causes `useTaskOutputStream` to receive a new reference each time, potentially triggering unnecessary effect re-runs inside that hook if it uses the map in a dependency array.
- Fix: Hoist an empty map constant outside the component:
  ```tsx
  const EMPTY_MAP: ReadonlyMap<TaskId, string> = new Map();
  // then in render:
  const streamTaskStatuses = view.kind === 'workspace' ? childTaskStatuses : EMPTY_MAP;
  ```

### MEDIUM

**scoredIterations and convergenceLine computed on every render without memoization** -- Confidence: 80%
- `src/cli/dashboard/views/loop-detail.tsx:276-279`
- Problem: `scoredIterations` filters the full iterations array and `renderConvergenceLine` reverses, filters, and maps over 20 items on every render. While the parent `LoopDetail` is wrapped in `React.memo`, the computation still runs when any prop changes (e.g., `animFrame` ticks every 500ms). The `renderIterationRow` and `selectedIndex` are correctly memoized with `useMemo`, but these derived values are not.
- Fix: Wrap in `useMemo`:
  ```tsx
  const { showTrend, convergenceLine } = React.useMemo(() => {
    const scored = iterations?.filter((i) => i.score !== undefined && i.status !== 'progress') ?? [];
    const show = loop.strategy === 'optimize' && scored.length >= 2;
    const line = show && iterations !== undefined
      ? renderConvergenceLine(iterations, loop.evalDirection)
      : '';
    return { showTrend: show, convergenceLine: line };
  }, [iterations, loop.strategy, loop.evalDirection]);
  ```

**resolveDetailStreamTaskId defined as inner function on every render** -- Confidence: 80%
- `src/cli/dashboard/app.tsx:140-147`
- Problem: `resolveDetailStreamTaskId` is defined as a closure inside the component body and immediately invoked. While this is functionally correct, it recreates the function on every render. Since it is called inline and its result is used in the same render, the function itself is not passed as a prop or dependency. This is a minor clarity issue rather than a performance issue.
- Fix: Inline the logic directly as a ternary expression (no function wrapper needed), which is the existing pattern used for `streamTaskIds` on line 163-164:
  ```tsx
  const detailStreamTaskId: TaskId | null =
    view.kind !== 'detail' || !outputRepository
      ? null
      : view.entityType === 'tasks'
        ? (view.entityId as TaskId)
        : view.entityType === 'orchestrations' && nav.orchestrationChildSelectedTaskId
          ? (nav.orchestrationChildSelectedTaskId as TaskId)
          : null;
  ```

## Issues in Code You Touched (Should Fix)

No issues found.

## Pre-existing Issues (Not Blocking)

No critical pre-existing issues found.

## Suggestions (Lower Confidence)

- **LoopDetail component receives animFrame but does not use it for animation** - `src/cli/dashboard/views/loop-detail.tsx:255` (Confidence: 65%) -- `animFrame` is passed through to `StatusBadge` for spinner animation, but it also causes `React.memo` to re-render the entire `LoopDetail` on every animation tick (every 500ms). Since the `scoredIterations`/`convergenceLine` computation is not memoized (see MEDIUM finding above), this compounds the issue. Consider splitting the status badge into a separate component that receives `animFrame` independently, so the iteration table and convergence trend are not re-rendered on animation ticks.

- **DetailView prop count is growing** - `src/cli/dashboard/views/detail-view.tsx:49-73` (Confidence: 62%) -- `DetailViewProps` now has 12 props, approaching the threshold where composition or context would reduce coupling. The output-related props (`taskStreams`, `detailOutputVisible`, `detailOutputAutoTail`, `detailOutputScrollOffset`, `terminalRows`) could be grouped into a single `outputConfig` object prop. This is a design consideration for future refactors, not blocking.

- **First convergence arrow is always same-direction arrow** - `src/cli/dashboard/views/loop-detail.tsx:140-163` (Confidence: 70%) -- The first scored iteration always gets a `->` arrow because `runningBest` is initialized to `scored[0].score` and the first comparison is `iter.score === runningBest`. This is technically correct but visually slightly misleading -- the first data point has no prior reference. Consider omitting the arrow for the first point or using a different symbol.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**React Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

Conditions:
1. Fix the `new Map()` allocation on every render in `app.tsx:165` (HIGH) -- referential instability for hook dependencies.
2. Consider memoizing the convergence computation in `loop-detail.tsx` (MEDIUM) -- runs on every animation tick.
3. Consider inlining `resolveDetailStreamTaskId` (MEDIUM) -- minor clarity improvement.

Overall the React patterns are solid: hooks are at top level, `React.memo` is used correctly on all view components, `useMemo` is applied to the expensive computations (renderIterationRow, selectedIndex), and the composition pattern is clean. The `useEffect` without deps for measurement is an acceptable Ink-specific pattern. The main actionable item is the `new Map()` referential instability.
