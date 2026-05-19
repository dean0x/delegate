# React Review Report

**Branch**: feat-dashboard -> main
**Date**: 2026-04-09

## Issues in Your Changes (BLOCKING)

### HIGH

**`useCallback` dependency on object `viewState` causes interval reset every render when in detail view** - `src/cli/dashboard/use-dashboard-data.ts:159`
**Confidence**: 88%
- Problem: `doFetch` depends on `viewState` via `useCallback(..., [ctx, viewState])`. The `ViewState` discriminated union is a new object reference on every render when the parent calls `useState<ViewState>` setter. In the `main` view case this is stable (the `{ kind: 'main' }` literal is created once in `useState`), but when transitioning to detail view the object `{ kind: 'detail', entityType, entityId }` is created fresh by `setView(...)` and then remains stable until the next navigation. However, the real problem is the `useEffect` that depends on `doFetch` (line 176): every time `viewState` changes (main->detail, or detail->main), the effect tears down and re-creates the interval. While functional, the previous fetch may still be in-flight when the new interval starts, causing a brief overlap where two fetches race. The `closing` ref partially mitigates this (it prevents setState after unmount), but between the effect cleanup (`closing.current = true`) and the new effect setup (`closing.current = false`), the in-flight promise from the old effect can still call setState because `closing` was `false` when it started and is set to `true` only in cleanup, but the `await` resumes after `closing` is already reset to `false` by the new effect.
- Fix: Extract the primitive fields from `viewState` for the dependency array, or use a ref for viewState so the interval never tears down:
  ```ts
  const viewStateRef = useRef(viewState);
  viewStateRef.current = viewState;

  const doFetch = useCallback(async (): Promise<void> => {
    const result = await fetchAllData(ctx, viewStateRef.current);
    // ... rest unchanged
  }, [ctx]); // ctx is stable, viewState read from ref
  ```
  This keeps a single stable interval and always reads the latest viewState.

**`ScrollableList` uses array index as React key** - `src/cli/dashboard/components/scrollable-list.tsx:41`
**Confidence**: 85%
- Problem: `<Box key={absoluteIndex}>` uses the positional index as the key. When scroll offset changes, items shift positions and get different keys, causing React to unmount/remount DOM nodes instead of reusing them. This is a documented React anti-pattern for lists that reorder or shift.
- Fix: Use a stable identifier from the item. Since `ScrollableList` is generic, require an `id` field or accept a `keyExtractor` prop:
  ```tsx
  interface ScrollableListProps<T> {
    // ... existing props
    readonly keyExtractor?: (item: T, index: number) => string;
  }
  ```
  Then: `<Box key={keyExtractor ? keyExtractor(item, absoluteIndex) : absoluteIndex}>`. The row renderers (e.g., `renderLoopRow`) already use `loop.id` as key on their inner element, which creates a redundant nested key. Lifting the stable key to the `ScrollableList` wrapper and removing the inner key would be the cleanest fix.

### MEDIUM

**Detail view scroll offset has no upper bound** - `src/cli/dashboard/use-keyboard.ts:97-106`
**Confidence**: 85%
- Problem: In detail view, pressing down arrow increments `scrollOffset` indefinitely with no max clamp. Unlike the main view (which uses `filteredLength` to clamp), the detail view just does `prev + 1` without checking against the content height. Users can scroll well past the end of content into empty space.
- Fix: Pass a content length to the keyboard hook for detail view scrolling, or compute the max based on available data (iterations count, field count, etc.) and clamp:
  ```ts
  // In the downArrow handler for detail view:
  const maxScroll = /* computed from data length */;
  [view.entityType]: Math.min(maxScroll, prev.scrollOffsets[view.entityType] + 1),
  ```

**Redundant `key` prop on inner elements when `ScrollableList` already wraps with `key`** (4 occurrences) - Confidence: 82%
- `src/cli/dashboard/views/main-view.tsx:46` (`<Box key={loop.id}>`)
- `src/cli/dashboard/views/main-view.tsx:74` (`<Box key={task.id}>`)
- `src/cli/dashboard/views/loop-detail.tsx:40` (`<Box key={iter.id}>`)
- `src/cli/dashboard/views/schedule-detail.tsx:39` (`<Box key={exec.id}>`)
- Problem: Each `renderItem` callback returns an element with a `key` prop, but `ScrollableList` already wraps it in `<Box key={absoluteIndex}>`. The inner key is ignored by React since the outer wrapper is what's in the array. This is confusing but not harmful.
- Fix: Remove `key` from the inner elements returned by render callbacks (they are not array elements from React's perspective — the `ScrollableList` wrapper provides the key). Alternatively, if the `ScrollableList` key fix above is adopted, these inner keys become the correct place for stable IDs.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`viewState` object reference in useCallback deps may cause unnecessary interval restarts** - `src/cli/dashboard/use-dashboard-data.ts:159`
**Confidence**: 80%
- Problem: This is a broader variant of the BLOCKING HIGH issue above. Each time the user presses Enter to drill into a detail or Esc to go back, `viewState` gets a new object reference, which rebuilds `doFetch`, which tears down and re-creates the `setInterval`. In a 1-second polling dashboard this means a brief gap where no poll runs (between cleanup and the next interval tick). Not critical for a 1s interval, but architecturally unnecessary.
- Fix: Use the ref pattern described in the blocking issue above.

## Pre-existing Issues (Not Blocking)

No pre-existing React issues found in unchanged code.

## Suggestions (Lower Confidence)

- **Missing error boundary around `App`** - `src/cli/dashboard/index.tsx:90` (Confidence: 70%) -- If any component throws during render, the entire Ink process will crash without a graceful fallback. An error boundary wrapping `<App>` could catch render errors and display a message while preserving terminal state. However, the `uncaughtException` handler in `index.tsx` does handle terminal cleanup, so the risk is partially mitigated.

- **`StatusBadge` animation timer runs independently per badge** - `src/cli/dashboard/components/status-badge.tsx:52` (Confidence: 65%) -- Each `StatusBadge` with a running/active/planning status creates its own 250ms `setInterval`. With many running entities, this means N independent timers. A single shared animation context or parent-level timer would be more efficient, but for a terminal UI with typically <50 items this is unlikely to cause measurable performance issues.

- **`formatRunProgress` treats `max=0` as unlimited** - `src/cli/dashboard/format.ts:128` (Confidence: 72%) -- The `!max` check is falsy for `0`, so `max=0` renders as "N/infinity" rather than "N/0". If `0` is a valid maxRuns (meaning "no more runs allowed"), this would display incorrectly. However, the domain may define 0 as equivalent to unlimited, in which case this is correct.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**React Score**: 7/10
**Recommendation**: CHANGES_REQUESTED
