# React Review Report

**Branch**: feat/dashboard-visibility-overhaul -> main
**Date**: 2026-04-28

## Issues in Your Changes (BLOCKING)

### HIGH

**Missing `pipeline` case in `handleActivitySelect` switch** - `src/cli/dashboard/app.tsx:167-180`
**Confidence**: 95%
- Problem: The `handleActivitySelect` callback handles `task`, `loop`, `orchestration`, and `schedule` cases but does not handle the newly added `pipeline` kind. The `ActivityEntry.kind` union type in `domain.ts:899` now includes `'pipeline'`, and `buildActivityFeed` in `activity-feed.ts:153` emits pipeline entries. When a user selects a pipeline activity row and presses Enter, nothing happens -- the switch silently falls through.
- Fix: Add the `pipeline` case to the switch:
```tsx
case 'pipeline':
  setView(openDetail('pipelines', entry.entityId as never, 'main'));
  break;
```

**Inline arrow function defeats `ActivityPanel` memoization** - `src/cli/dashboard/views/metrics-view.tsx:136`
**Confidence**: 90%
- Problem: `onSelect={(entry) => onActivitySelect?.(entry)}` creates a new function reference on every render of `MetricsView`. Since `ActivityPanel` is wrapped with `React.memo`, this new reference invalidates the memo on every render cycle, causing unnecessary re-renders of the entire activity panel including its `ScrollableList`.
- Fix: Pass the callback directly or wrap with useCallback. Since `MetricsView` itself is a memo'd component receiving `onActivitySelect` as a prop, the simplest fix is:
```tsx
<ActivityPanel
  activityFeed={activityFeed}
  selectedIndex={nav.activitySelectedIndex}
  scrollOffset={nav.activitySelectedIndex >= 10 ? nav.activitySelectedIndex - 9 : 0}
  focused={nav.activityFocused}
  onSelect={onActivitySelect ?? noop}
/>
```
Where `noop` is a module-level `const noop = () => {};` (stable reference). Alternatively, if `onActivitySelect` can be undefined, make the `onSelect` prop optional in `ActivityPanel` to match.

### MEDIUM

**Sentinel orchestration object created inline on every workspace render** - `src/cli/dashboard/app.tsx:210-225`
**Confidence**: 85%
- Problem: When `committedOrch` is undefined, a new object literal is created on every render and cast as `Orchestration`. This object is passed as a prop to the memoized `OrchestrationDetail`, which means `React.memo`'s shallow comparison always sees a new prop reference, bypassing memo entirely for the workspace view when no orchestration exists.
- Fix: Extract the sentinel to a module-level constant:
```tsx
const SENTINEL_ORCHESTRATION: import('../../core/domain.js').Orchestration = {
  id: '' as never,
  goal: '',
  status: 'planning' as never,
  agent: undefined,
  model: undefined,
  loopId: undefined,
  maxDepth: 0,
  maxWorkers: 0,
  maxIterations: 0,
  workingDirectory: '',
  stateFilePath: '',
  createdAt: 0,
  updatedAt: 0,
  completedAt: undefined,
};
```
Then use `const sentinelOrch = committedOrch ?? SENTINEL_ORCHESTRATION;`.

**Index used as key in ProgressBar step list** - `src/cli/dashboard/components/progress-bar.tsx:69`
**Confidence**: 82%
- Problem: `key={idx}` is used for the steps map. While steps in a progress bar are positional (their identity IS their index), this violates the project's pattern of using stable unique IDs as keys. In this specific case the risk is minimal since step order is stable and steps are never reordered, but it can cause subtle render issues if the steps array is mutated in-place upstream.
- Fix: Since steps are positional and anonymous (no natural ID), this is acceptable in this context. However, for consistency, a composite key could be used: `key={`step-${idx}`}` (still index-based but more descriptive for debugging).

**Index used as key in ScheduleDetail pipeline steps** - `src/cli/dashboard/views/schedule-detail.tsx:101`
**Confidence**: 82%
- Problem: `key={idx}` used for `schedule.pipelineSteps.map()`. Same concern as ProgressBar -- pipeline steps are positional definitions that are never reordered, so the practical risk is low.
- Fix: Same as above -- acceptable for positional data, but `key={`step-${idx}`}` is slightly more descriptive.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`getEntityDisplayFields` performs O(n) `Array.find` per visible row** - `src/cli/dashboard/components/entity-browser-panel.tsx:48-88`
**Confidence**: 85%
- Problem: Each `EntityRow` calls `getEntityDisplayFields()` which does `data.tasks.find()`, `data.loops.find()`, etc. -- a linear scan for each rendered row. With 100+ entities and 10 visible rows, this is 1000 comparisons per render. Since `EntityBrowserPanel` re-renders on the 250ms animation tick (via `animFrame` in the parent), this runs frequently.
- Fix: Build a `Map<string, EntityDisplayFields>` at the `EntityBrowserPanel` level (using `useMemo`) and pass it to rows instead of the full `data` object:
```tsx
const displayFieldsMap = useMemo(() => {
  if (!data) return new Map<string, EntityDisplayFields>();
  const map = new Map<string, EntityDisplayFields>();
  for (const item of items) {
    map.set(item.id, getEntityDisplayFields(focusedType, item.id, data));
  }
  return map;
}, [data, items, focusedType]);
```
Then `EntityRow` receives `displayFields: EntityDisplayFields` directly instead of `data: DashboardData`.

**`costsByTask` Map rebuilt on every render in `renderGrid`** - `src/cli/dashboard/views/orchestration-detail.tsx:106`
**Confidence**: 80%
- Problem: `renderGrid` is a plain function (not memoized) called from `GridMode` (also a plain function component). On every render, `new Map(children.map(...))` allocates a new Map. This map is then passed as individual lookups to each `TaskPanel`. Since `TaskPanel` may be memoized, the `cost` prop reference changes every time even though the value is always `null`, potentially defeating `TaskPanel`'s memo.
- Fix: Extract a module-level constant for the "no cost data" case:
```tsx
const EMPTY_COST_MAP = new Map<TaskId, TaskUsage | null>();
```
Or wrap the grid rendering functions (`GridMode`, `renderGrid`) in `React.memo` / `useMemo` patterns. Since `cost` is always `null` here, passing `null` directly instead of `costsByTask.get(child.taskId) ?? null` is simpler and avoids the Map allocation entirely.

## Pre-existing Issues (Not Blocking)

### LOW

**`renderView()` function defined inside render body** - `src/cli/dashboard/app.tsx:186`
**Confidence**: 80%
- Problem: `renderView()` is a plain function defined inside the component body, creating a new closure on every render. This is a minor concern since it returns JSX (not passed as a prop to a memoized child), so it does not defeat any downstream memoization. However, it does participate in the closure over many variables.
- Note: This pattern is acceptable in Ink/terminal React where render cost is lower than browser React. Not blocking.

**`GridMode` and helper sub-components not wrapped with `React.memo`** - `src/cli/dashboard/views/orchestration-detail.tsx:207, 275, 300`
**Confidence**: 80%
- Problem: `GridMode`, `CostSection`, and `ProgressSection` are plain function components (not wrapped with `React.memo`). They re-render whenever `OrchestrationDetail` re-renders. In the terminal/Ink context this is less impactful than browser React, but it is inconsistent with the project pattern where all exported components use `React.memo`.
- Note: These are internal helpers, not exported. The parent `OrchestrationDetail` IS memo'd. Acceptable as-is.

## Suggestions (Lower Confidence)

- **`EntityBrowserPanel` filtering not memoized** - `src/cli/dashboard/components/entity-browser-panel.tsx:174` (Confidence: 70%) -- The `filteredItems` array is recomputed on every render via `.filter()`. A `useMemo` keyed on `[items, filterStatus]` would avoid allocating a new array when nothing changed, but the list sizes are small enough that this is unlikely to be noticeable.

- **`DetailView` performs `Array.find` lookups inline** - `src/cli/dashboard/views/detail-view.tsx:49,56,61,73,88` (Confidence: 65%) -- Each case in the switch does `data?.tasks.find(...)` etc. Since `DetailView` only runs when navigating to a specific entity (not on every tick), this is acceptable. A Map-based lookup would be more efficient but the benefit is marginal.

- **`NotFound` component lacks `React.memo` and `displayName`** - `src/cli/dashboard/views/detail-view.tsx:30-34` (Confidence: 60%) -- Minor inconsistency with the project pattern. Since it only renders in error states and is a pure leaf, the impact is negligible.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 2 |

**React Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The architecture is solid -- all components follow the `React.memo` + `displayName` pattern, props interfaces are readonly, hooks follow rules-of-hooks (no conditional calls), and the `useReducer` migration is well-structured. The blocking issues are (1) a missing switch case that silently drops pipeline activity selections, and (2) an inline function that defeats memo on a frequently-rendered component. Both are straightforward fixes.
