# React Review Report

**Branch**: feat/dashboard-visibility-overhaul -> main
**Date**: 2026-04-29

## Issues in Your Changes (BLOCKING)

### HIGH

**Duplicated formatting utilities across StatsTile, CostTile, and ThroughputTile** - `src/cli/dashboard/components/stats-tile.tsx:30-48`
**Confidence**: 90%
- Problem: `StatsTile` re-declares `formatCost()`, `formatTokens()`, and `formatDurationMs()` as private module-level functions. `CostTile` (`cost-tile.tsx:22-30`) already has identical copies of `formatCost` and `formatTokens`. This means three copies of the same formatting logic across the tile components. When formatting rules change (e.g., adding currency symbol or rounding), all copies must be updated in sync.
- Fix: Extract `formatCost`, `formatTokens`, and `formatDurationMs` into `format.ts` (which already hosts `formatElapsed`, `formatActivityTime`, etc.) and import from all tile components.

```ts
// In format.ts — add:
export function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
export function formatDurationMs(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
```

### MEDIUM

**Dead code: CostTile and ThroughputTile are no longer imported by any source file** - `src/cli/dashboard/components/cost-tile.tsx`, `src/cli/dashboard/components/throughput-tile.tsx`
**Confidence**: 92%
- Problem: `MetricsView` was the only source-code consumer of `CostTile` and `ThroughputTile`. It now imports `StatsTile` instead. The old tiles are only referenced by their own test files (`cost-tile.test.tsx`, `throughput-tile.test.tsx`). These components and their tests are dead code that should be removed (similar to how `counts-panel.tsx` and `counts-panel.test.tsx` were correctly deleted in this PR).
- Fix: Delete `cost-tile.tsx`, `throughput-tile.tsx`, `cost-tile.test.tsx`, and `throughput-tile.test.tsx`. Or, if they serve as standalone documentation/reference, add a `@deprecated` JSDoc tag explaining they are superseded by `StatsTile`.

**Dead code: ActivityPanel source file is no longer imported by any source consumer** - `src/cli/dashboard/components/activity-panel.tsx`
**Confidence**: 90%
- Problem: `MetricsView` was the only source consumer of `ActivityPanel` and now uses `ActivityTile`. The `ActivityPanel` component and its test file (`activity-panel.test.tsx`) remain but have no runtime consumers. The PR correctly deleted `CountsPanel` in the same situation but missed these.
- Fix: Delete `activity-panel.tsx` and `activity-panel.test.tsx`, or mark `@deprecated` if retained as a reference for future interactive activity features.

**O(n) .find() calls per row inside EntityRow render path** - `src/cli/dashboard/components/entity-browser-panel.tsx:46-97`
**Confidence**: 82%
- Problem: `getEntityDisplayFields()` is called once per visible `EntityRow` and does a linear `.find()` over the full entity list (`data.tasks.find(...)`, `data.loops.find(...)`, etc.) for each row. With N visible rows and M total entities, this is O(N*M) per render. For typical dashboard sizes (5-50 entities) this is negligible, but the pattern prevents scaling. The React skill guidance [5] recommends `Map`/`Set` via `useMemo` for O(1) lookups.
- Fix: In `EntityBrowserPanel`, build a `Map<string, entity>` via `useMemo` keyed on the active `panelId` and pass it to `EntityRow` instead of the full `data` object. This reduces per-row lookup to O(1).

```tsx
// In EntityBrowserPanel render:
const entityMap = useMemo(() => {
  if (!data) return new Map();
  const list = getPanelItems(focusedType, data); // or the appropriate list
  return new Map(list.map(item => [item.id, item]));
}, [data, focusedType]);
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**O(n) .find() calls in detail-view.tsx dependency resolution** - `src/cli/dashboard/views/detail-view.tsx:59-70`
**Confidence**: 80%
- Problem: The new dependency resolution code does `data?.tasks.find((t) => t.id === depId)` for each dependency ID, then `data?.tasks.filter((t) => t.dependsOn?.includes(...))` for dependents. For a task with K dependencies and a task list of length M, this is O(K*M + M*K). The `.includes()` on the `dependsOn` array adds another O(D) factor per task.
- Fix: Build lookup maps once at the top of the `tasks` case. This is especially valuable because `detail-view.tsx` re-renders on every poll cycle.

```tsx
case 'tasks': {
  const task = data?.tasks.find((t) => t.id === entityId);
  if (task === undefined) return <NotFound ... />;
  const taskById = new Map(data?.tasks.map(t => [t.id, t]) ?? []);
  const dependencies = task.dependsOn?.length
    ? task.dependsOn.map(depId => ({
        taskId: depId,
        status: taskById.get(depId)?.status ?? 'unknown',
      }))
    : undefined;
  const dependents = data?.tasks
    .filter(t => t.dependsOn?.includes(entityId as TaskId))
    .map(t => ({ taskId: t.id, status: t.status }));
  // ...
}
```

### MEDIUM

**Inconsistent `v` key behavior: main->workspace has no orchestrationId, but `w` always provides one** - `src/cli/dashboard/use-keyboard.ts:71-86`
**Confidence**: 80%
- Problem: The `v` key from main view navigates to `{ kind: 'workspace' }` without an `orchestrationId`, while the `w` key always resolves a specific `orchestrationId`. The ViewState type allows `orchestrationId` to be optional, so this is not a type error. However, the behavioral inconsistency means users get a different workspace experience depending on whether they press `v` or `w` from the same main view. The `w` key smartly picks a running orchestration; `v` does not.
- Fix: Apply the same orchestration resolution logic from the `w` handler to the `v` handler's `kind === 'main'` branch, or document this as intentional (v = unscoped workspace, w = orchestration-scoped workspace).

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Duplicated `TopEntry` and `ThroughputStats` interfaces across tile components** - `src/cli/dashboard/components/stats-tile.tsx:12-22`, `src/cli/dashboard/components/cost-tile.tsx:12-15`, `src/cli/dashboard/components/throughput-tile.tsx:17-22`
**Confidence**: 85%
- Problem: `TopEntry` is defined identically in both `cost-tile.tsx` and `stats-tile.tsx`. `ThroughputStats` is defined identically in both `throughput-tile.tsx` and `stats-tile.tsx`. These should be shared types in `types.ts`.
- Fix: Move both interfaces to `types.ts` and import them.

## Suggestions (Lower Confidence)

- **`openDetail` function in `types.ts` may now be dead code** - `src/cli/dashboard/types.ts:124-143` (Confidence: 70%) -- No imports of `openDetail` were found in any source file. The `handleMainKeys` and `handleDetailKeys` handlers construct `ViewState` objects directly instead of using `openDetail`. Verify whether it is used by downstream consumers not checked, or remove.

- **Activity feed list keying could collide on rapid updates** - `src/cli/dashboard/components/activity-tile.tsx:47` (Confidence: 65%) -- The key is `${entry.entityId}-${entry.timestamp}`. If the same entity produces two activity entries at the same millisecond timestamp (e.g., rapid status transitions), the keys would collide. Consider appending the entry index or action string to the key.

- **`filteredLength` is no longer imported in metrics-view.tsx** - `src/cli/dashboard/keyboard/helpers.ts` (Confidence: 72%) -- The diff removes the `filteredLength` import from `metrics-view.tsx`, but `filteredLength` is still exported from `helpers.ts` and used in `handle-main-keys.ts`. Not a bug, just an unused import that was correctly removed.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**React Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The PR shows strong React patterns overall: proper `React.memo` on all new components, `displayName` set, `readonly` props, clean composition in the top-row tile layout, and good use of `useRef` for stale closure prevention. The main concerns are (1) duplicated formatting utilities across three tile components that should be extracted to the shared `format.ts` module, (2) three dead component files left behind after the refactor (CostTile, ThroughputTile, ActivityPanel were replaced but not deleted), and (3) O(n) find patterns in the render path that, while acceptable today, prevent scaling. None of these are critical blockers, but the duplication and dead code should be addressed before merge.
