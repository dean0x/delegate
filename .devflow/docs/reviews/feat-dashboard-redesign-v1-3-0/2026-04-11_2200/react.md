# React Review Report

**Branch**: `feat/dashboard-redesign-v1.3.0` -> `main`
**Date**: 2026-04-11 22:00
**Focus**: React (Ink) — hook correctness, effect lifecycle, memoization, state management
**Files reviewed**: dashboard hooks, components, views (`src/cli/dashboard/**`)

## Iron Law

> Findings restricted to lines added/modified in this PR. All flagged issues are in
> brand-new files (`use-task-output-stream.ts`, `use-dashboard-data.ts`, `app.tsx`,
> components, views) introduced by the v1.3.0 redesign.

---

## Issues in Your Changes (BLOCKING)

### CRITICAL

**UTF-8 byte-slice corrupts multi-byte characters at chunk boundaries** — `src/cli/dashboard/use-task-output-stream.ts:129-134`
**Confidence**: 92%
- Problem: `buildStreamState` slices the stdout buffer at `prev.totalBytes`, which is an arbitrary byte offset from the previous fetch. If a UTF-8 multi-byte sequence (emoji, CJK, accented chars, box-drawing characters in Claude Code's TUI output) straddles that offset, `Buffer.from(fullContent, 'utf-8').slice(prev.totalBytes).toString('utf-8')` produces a U+FFFD replacement character at the start of `newContent`. The corrupted bytes are then ANSI-stripped and pushed into the ring buffer permanently — there's no recovery on the next poll because `prev.totalBytes` advances past them.
- Impact: Garbage characters appear in dashboard output streams whenever a poll boundary lands inside a multi-byte UTF-8 sequence. Real-world frequency depends on output content; for orchestrator logs containing emoji status markers or non-ASCII text it will be visible. Pure helpers are unit-tested but only with ASCII content (`tests/unit/cli/dashboard/use-task-output-stream.test.ts`).
- Fix: Track stream content as a UTF-8 string offset, or buffer trailing partial bytes until the next fetch:
```ts
// Option A: Track char-offset alongside byte-offset
interface OutputStreamState {
  // ...existing fields
  readonly totalBytes: number;
  readonly consumedChars: number; // NEW
}
// Then slice fullContent at consumedChars (string-aware) instead of bytes.

// Option B: Buffer trailing partial bytes between polls
const buf = Buffer.from(fullContent, 'utf-8');
const tail = buf.subarray(prev.totalBytes);
// Walk back to last full UTF-8 codepoint boundary, save remainder for next poll
const safeEnd = findUtf8Boundary(tail); // <-- new util
const newContent = tail.subarray(0, safeEnd).toString('utf-8');
// Persist tail.subarray(safeEnd) in a ref/state for next call
```

**Polling interval is recreated every dashboard refresh due to unstable `taskIds`/`taskStatuses` references** — `src/cli/dashboard/app.tsx:98-108` and `src/cli/dashboard/use-task-output-stream.ts:343,361`
**Confidence**: 95%
- Problem: `app.tsx:98-99` computes `childTaskIds = data?.workspaceData?.childTaskIds ?? []` and `childTaskStatuses = data?.workspaceData?.childTaskStatuses ?? new Map()`. When `data` is null (first 1s after mount, plus when not in workspace view), every render produces a brand new `[]` and `new Map()`. When `data` IS present, `use-dashboard-data.ts:281-284` rebuilds `childTaskIds` and `childTaskStatuses` on every poll → fresh references each second. These references are passed to `useTaskOutputStream`, which lists them in `doPoll`'s `useCallback` deps (`[outputRepo, taskIds, taskStatuses, enabled]`). Each new identity creates a new `doPoll`, which is then a dep of `useEffect(..., [doPoll, enabled])` → cleanup runs, `closingRef.current = true`, `clearInterval`, then a new immediate poll fires and a new interval starts. The intended 1s tick cadence collapses to "poll on every render" (250ms when the animation frame drives a render).
- Impact:
  1. The polling cadence design (1s ticks, slow-poll for non-running tasks) is broken — `tickRef.current` is reset semantics work, but the gating in `shouldPollThisTick` is bypassed because the immediate `void doPoll()` on line 351 fires unconditionally on every render.
  2. Network/repository load increases significantly (every render triggers a fetch).
  3. In-flight fetches are racing against the closing-ref dance: a poll started in one render sees its `closingRef.current` set to `true` by a cleanup that runs before its `await outputRepo.get(taskId)` resolves, then bails. Result: most poll results are discarded.
  4. The `tickRef`-based slow-poll cadence (`pending`/`queued` only every 5 ticks) is effectively "every tick" because each render cycle calls `doPoll` once and `tickRef` increments without throttling.
- Fix: Stabilize the references at the call site OR derive primitives inside the hook:
```tsx
// In app.tsx:
const childTaskIds = useMemo(
  () => data?.workspaceData?.childTaskIds ?? EMPTY_TASK_IDS,
  [data?.workspaceData?.childTaskIds],
);
const childTaskStatuses = useMemo(
  () => data?.workspaceData?.childTaskStatuses ?? EMPTY_STATUS_MAP,
  [data?.workspaceData?.childTaskStatuses],
);
const EMPTY_TASK_IDS: readonly TaskId[] = []; // module-level
const EMPTY_STATUS_MAP = new Map<TaskId, string>(); // module-level
```
Better fix: in `use-task-output-stream.ts`, replace `[outputRepo, taskIds, taskStatuses, enabled]` with a stable string key (e.g., `taskIds.join(',')`) and read `taskIds`/`taskStatuses` via refs inside `doPoll`. This mirrors the `viewStateRef`/`childPageRef` pattern already used in `use-dashboard-data.ts:386-391`. Example:
```ts
const taskIdsRef = useRef(taskIds);
taskIdsRef.current = taskIds;
const taskStatusesRef = useRef(taskStatuses);
taskStatusesRef.current = taskStatuses;

const taskIdsKey = taskIds.join(',');
const doPoll = useCallback(async () => {
  const ids = taskIdsRef.current;
  const statuses = taskStatusesRef.current;
  // ...rest unchanged
}, [outputRepo, enabled, taskIdsKey]); // stable deps
```

### HIGH

**`Date.now()` rounding races inside render** — `src/cli/dashboard/components/task-panel.tsx:40`
**Confidence**: 80%
- Problem: `const elapsedMs = Date.now() - child.createdAt;` is computed inside the render body. Combined with the 250ms animation frame interval, this updates `MetricsBar`'s `elapsedMs` prop on every parent re-render. Functionally correct, but it means `React.memo` on `MetricsBar` (line 45) never short-circuits — the child renders 4×/s for every visible task panel even when the underlying data hasn't moved a meaningful amount.
- Impact: Performance scaling: with N visible panels, this is N memo failures × 4 renders/sec = 4N MetricsBar renders. Combined with the unstable-ref problem above, the dashboard does substantially more work than intended.
- Fix: Either coarsen `elapsedMs` to seconds (so it changes only ~1×/s):
```tsx
const elapsedMs = Math.floor((Date.now() - child.createdAt) / 1000) * 1000;
```
Or — preferred — derive `elapsedMs` from a parent prop that ticks every second instead of every 250ms, so `MetricsBar.memo` actually saves work.

**Sequential N+1 awaits in liveness loop** — `src/cli/dashboard/use-dashboard-data.ts:140-157`
**Confidence**: 85%
- Problem: The `for...of` loop awaits `checkOrchestrationLiveness` once per RUNNING orchestration. With M running orchestrations, this serializes M I/O calls per dashboard poll. Every other expensive fetch in `fetchAllData` uses `Promise.all` (lines 96-115, 204-220, 271-274) — the liveness loop is the only sequential one.
- Impact: Dashboard refresh latency grows linearly with number of running orchestrations. Each `checkOrchestrationLiveness` performs database queries (`loopRepo`, `taskRepo`, `workerRepo`). With 5+ running orchestrations and a slow disk, the 1s polling budget can be exceeded → polls overlap and `fetching.current` skips fall behind → user-visible staleness.
- Fix:
```ts
const livenessEntries = await Promise.all(
  orchestrations.value
    .filter(o => o.status === OrchestratorStatus.RUNNING)
    .map(async (orch): Promise<[string, Liveness]> => {
      try {
        const liveness = await checkOrchestrationLiveness(orch, {
          loopRepo: loopRepository, taskRepo: taskRepository,
          workerRepo: workerRepository, isProcessAlive,
        });
        return [orch.id, liveness];
      } catch {
        return [orch.id, 'unknown' as Liveness];
      }
    }),
);
const orchestrationLiveness: Record<string, Liveness> = Object.fromEntries(livenessEntries);
// Then merge in the PLANNING-without-loopId entries.
```

### MEDIUM

**`React.memo` on view components is mostly defeated by fresh-on-every-poll prop references** — `src/cli/dashboard/views/metrics-view.tsx:77,113-130`, `src/cli/dashboard/views/workspace-view.tsx:143`, `src/cli/dashboard/components/{counts,activity,task,cost,resources,throughput}-*.tsx`
**Confidence**: 82%
- Problem: Every view and major leaf component is wrapped in `React.memo`, but the props they receive are reconstructed on each poll: `data` is a fresh object every 1s; `counts` in `metrics-view.tsx:105-110` is a fresh inline object every render; `extractGroup(data?.orchestrationCounts.byStatus ?? {})` creates a fresh object even when `byStatus` is undefined; `costsByTask` in `workspace-view.tsx:171` is a fresh `Map` every render. None of these memos prevent re-renders.
- Impact: Performance overhead of running shallow-comparison without ever short-circuiting; misleading to readers who assume memoization is providing protection. Combined with the 250ms animation interval, this means the entire view tree re-renders 4×/s.
- Fix: Either remove the `React.memo` wrappers (they're cargo-culted) or stabilize the inputs with `useMemo` at the call sites. For `metrics-view.tsx:105-110`:
```tsx
const counts = useMemo(() => ({
  orchestrations: extractGroup(data?.orchestrationCounts.byStatus ?? EMPTY),
  loops: extractGroup(data?.loopCounts.byStatus ?? EMPTY),
  tasks: extractGroup(data?.taskCounts.byStatus ?? EMPTY),
  schedules: extractGroup(data?.scheduleCounts.byStatus ?? EMPTY),
}), [data?.orchestrationCounts, data?.loopCounts, data?.taskCounts, data?.scheduleCounts]);
```
Note: `EMPTY` is a module-level frozen object so the fallback is stable.

**Inline arrow function defeats `ActivityPanel.memo`** — `src/cli/dashboard/views/metrics-view.tsx:128`
**Confidence**: 85%
- Problem: `<ActivityPanel ... onSelect={(entry) => onActivitySelect?.(entry)} />` creates a new function reference on every render, defeating the `React.memo` on `ActivityPanel`. The lambda is also a passthrough — `onActivitySelect` could be passed directly.
- Note: The `onSelect` prop is currently dead code inside `ActivityPanel` (received but never invoked — selection is driven by `useKeyboard`), so the practical impact today is just adding to the noise. The fix is two-line.
- Fix:
```tsx
<ActivityPanel
  activityFeed={activityFeed}
  selectedIndex={nav.activitySelectedIndex}
  scrollOffset={nav.activitySelectedIndex >= 10 ? nav.activitySelectedIndex - 9 : 0}
  focused={nav.activityFocused}
  onSelect={onActivitySelect ?? noop}  // noop is a module-level constant
/>
```
Even better: drop `onSelect` from `ActivityPanel` entirely until it has a real consumer.

**`useTaskOutputStream` swallows fetch errors during cleanup window** — `src/cli/dashboard/use-task-output-stream.ts:300-307,320-327`
**Confidence**: 80%
- Problem: Every fetch checks `if (closingRef.current) return;` before mutating the streams Map. Combined with the unstable-ref problem above (which sets `closingRef.current = true` on every render's effect cleanup), most poll responses are silently discarded — including error responses. Users won't see fetch errors that happen during the cleanup window because the error state never gets written.
- Impact: Error visibility regression. The OutputStreamView component renders `stream.error` (line 27-33) but it'll often be `null` because the writes were skipped. Users see "no output" instead of a useful error message.
- Fix: This is downstream of the unstable-refs issue above. Once `doPoll` is stable, the closing-ref dance only fires on real unmount, and errors are written normally. No additional change needed beyond fixing the CRITICAL above.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**View switch causes 1s blank state instead of immediate refetch** — `src/cli/dashboard/use-dashboard-data.ts:401,442`
**Confidence**: 82%
- Problem: `viewStateRef.current` is read inside `doFetch`, and the polling effect's deps are `[doFetch, orchestrationChildPage]`. When the user switches view (main → workspace), the new view doesn't trigger an immediate refetch because `doFetch` identity hasn't changed and `viewState` isn't a dep. The user sees a blank workspace (or stale main view metrics) for up to 1s until the next interval tick.
- Impact: UX papercut on every view switch. The intentional design comment (lines 369-372) explains this is to keep the polling interval stable, but the cost is visible.
- Fix: Add a discriminator that triggers re-fetch on view switch without recreating the interval:
```ts
const viewKindKey = viewState.kind; // primitive — stable string
useEffect(() => {
  if (viewKindKey === 'workspace' || viewKindKey === 'main') {
    void doFetch(); // fire-and-forget refresh on view-kind change
  }
}, [viewKindKey, doFetch]);
```
This is additive — the interval effect on line 424 stays as-is.

**Always-on 250ms animation interval re-renders entire app even when nothing animates** — `src/cli/dashboard/app.tsx:73-78`
**Confidence**: 85%
- Problem: The shared animation frame counter increments every 250ms unconditionally, causing the entire `App` tree to re-render 4×/s, even when no orchestration/loop/task is in a `running`/`active`/`planning` state (which are the only states `StatusBadge` animates for, per `status-badge.tsx:14`).
- Impact: Wasted CPU and forced re-renders of memoized leaves (whose memos may or may not actually short-circuit, see MEDIUM above). On a quiet dashboard with idle orchestrations, this is pure overhead.
- Fix: Gate the interval on whether any visible status is animated:
```tsx
const hasAnimatedStatus = useMemo(() => {
  if (!data) return false;
  const animated = (s: string) => s === 'running' || s === 'active' || s === 'planning';
  return data.tasks.some(t => animated(t.status))
    || data.loops.some(l => animated(l.status))
    || data.orchestrations.some(o => animated(o.status));
}, [data]);

useEffect(() => {
  if (!hasAnimatedStatus) return;
  const timer = setInterval(() => setAnimFrame(p => p + 1), 250);
  return () => clearInterval(timer);
}, [hasAnimatedStatus]);
```

### LOW

**Activity feed key collision risk if entityId duplicated across kinds** — `src/cli/dashboard/components/activity-panel.tsx:51,93` and `activity-feed.ts`
**Confidence**: 65%
- Problem: `keyExtractor={(item) => item.entityId}` uses the raw entity ID. Each entity is added once per `buildActivityFeed` call so duplication within a single kind is unlikely, but if a task and an orchestration ever shared a string ID (extremely unlikely with UUIDs but possible if IDs become non-globally-unique in the future), React would warn about duplicate keys.
- Fix:
```tsx
keyExtractor={(item) => `${item.kind}:${item.entityId}`}
```

**`renderNavItem` recreated each render in OrchestratorNav** — `src/cli/dashboard/components/orchestrator-nav.tsx:69`
**Confidence**: 70%
- Problem: `renderItem={(orch, index) => renderNavItem(orch, index, focusedIndex, committedIndex, width)}` creates a new arrow function every render. Since `ScrollableList` is not `React.memo`'d (it's a generic exported as a function-typed value, not a memoed wrapper) this doesn't break memo, but the closure is recreated regardless.
- Note: Without `React.memo` on `ScrollableList`, this is harmless. Flagged only because the pattern is repeated in several components and is worth standardizing.
- Fix: Either accept the pattern as-is or memoize the renderItem closures with `useCallback`.

## Pre-existing Issues (Not Blocking)

None — all dashboard hooks/components reviewed are net-new in this branch (verified via `git diff main...HEAD`).

## Suggestions (Lower Confidence)

- **Consider `useReducer` for `WorkspaceNavState`** — `src/cli/dashboard/use-keyboard.ts:339-590` (Confidence: 72%) — The workspace key handler has ~20 separate `setWorkspaceNav((prev) => ({ ...prev, ... }))` calls. A reducer would consolidate transitions and make the state machine explicit (e.g., a single `'TAB_FORWARD'` action vs. 30 lines of inline branching).
- **Per-entity `c`/`d` handlers are duplicated 3 times** — `src/cli/dashboard/use-keyboard.ts:543-590, 735-808, 897-978` (Confidence: 68%) — The cancel/delete dispatch logic appears in main keys, activity-focus keys, and workspace keys, each with slightly different lookup paths. Extract to a shared helper that takes `(kind, entityId, mutations, refreshNow)` and dispatches.
- **`view`/`nav` captured directly in `useInput` callback risks subtle staleness if Ink's listener semantics change** — `src/cli/dashboard/use-keyboard.ts:1036-1090` (Confidence: 60%) — Today, `useInput` re-registers each render so the closure captures fresh `view`/`nav`. If Ink ever changes to memoize the listener, all captured state would become stale. The `dataRef` pattern is already used for `data`; the same defensive pattern would future-proof `view` and `nav`.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 2 | 2 | 4 | - |
| Should Fix | - | - | 2 | 2 |
| Pre-existing | - | - | - | - |

**React Score**: 6/10
- Hook structure is solid (no rules-of-hooks violations, all effects have cleanup, refs used appropriately for closures and unmount guards)
- Critical correctness issues in the streaming hook (UTF-8 corruption, broken polling cadence) and one HIGH performance bug in the data hook (sequential liveness)
- Pervasive over-application of `React.memo` without stable inputs — code has the appearance of being optimized but isn't
- Test coverage of pure helpers is good; hook lifecycle tests are missing for `use-task-output-stream`

**Recommendation**: **CHANGES_REQUESTED**

The two CRITICAL issues are both data-corrupting / cadence-breaking bugs that affect user-visible behavior in the workspace view. The UTF-8 byte-slice issue is particularly insidious because it surfaces only on certain content patterns and the existing tests (ASCII-only) won't catch it. The unstable-ref issue silently breaks the polling design but works "well enough" in practice that it could ship — but combined with the increased fetch load and the discarded-error problem, it warrants fixing before merge.

The HIGH-severity sequential liveness loop is a straightforward `Promise.all` swap and should ship with the fix.

The MEDIUM memoization issues are not blocking but worth a single follow-up commit to either remove the cargo-culted `React.memo` wrappers or stabilize their inputs — the current state is misleading.
