# Complexity Review Report

**Branch**: feat-184-dashboard-channels -> main
**Date**: 2026-05-27T17:36
**PR**: #196

## Issues in Your Changes (BLOCKING)

### HIGH

**`setupEventHandlers` exceeds 300 lines (336 lines) — growing linearly with each new handler** - `src/services/handler-setup.ts:261-597`
**Confidence**: 85%
- Problem: This function is 336 lines long and follows a repetitive pattern: check optional dependency, call `create()`, handle error, assign result. Each new handler (ChannelHandler at step 12, ChannelMessagePersistenceHandler at step 13) adds another ~20 lines of near-identical boilerplate. The function is now at 13 handlers and growing. At this trajectory, the next 2-3 features push it past 400 lines.
- Impact: The function is straightforward (low cyclomatic complexity per branch) but its sheer length makes it hard to review diffs — a change to handler 3 is 200 lines away from handler 13. The linear growth pattern means every new event handler increases the maintenance burden.
- Fix: Extract the optional-handler creation pattern into a helper that eliminates the repeated if/create/warn/assign blocks. Example:

```typescript
async function createOptionalHandler<T>(
  name: string,
  condition: boolean,
  factory: () => Promise<Result<T, AutobeatError>>,
  logger: Logger,
): Promise<T | undefined> {
  if (!condition) return undefined;
  const result = await factory();
  if (!result.ok) {
    logger.warn(`Failed to create ${name}`, { error: result.error.message });
    return undefined;
  }
  return result.value;
}
```

This would reduce handlers 8-13 from ~120 lines to ~30 lines.

**`extractHandlerDependencies` is 93 lines of repetitive get/check/return** - `src/services/handler-setup.ts:151-244`
**Confidence**: 82%
- Problem: 15 sequential `getDependency` calls with identical error-check boilerplate. Each call is 3 lines (get, check, return). The function has zero branching logic — it is pure extraction with fail-fast. Adding channelRepository was trivial but the function keeps growing.
- Impact: Low cognitive complexity per line but high visual noise. The real concern is maintenance: the function is 93 lines of near-identical code that could be expressed as a data-driven lookup.
- Fix: Use an array-driven extraction pattern:

```typescript
const required = ['config', 'logger', 'eventBus', 'database', ...] as const;
const deps: Record<string, unknown> = {};
for (const key of required) {
  const r = getDependency(container, key);
  if (!r.ok) return r;
  deps[key] = r.value;
}
// Then extract optional deps with getDependency + fallback
```

This would reduce the function to ~30 lines while preserving fail-fast semantics and specific error messages.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`fetchAllData` has grown to 134 lines with 12-way parallel fetch and 12-element tuple cast** - `src/services/handler-setup.ts` pattern echoed in `src/cli/dashboard/use-dashboard-data.ts:190-324`
**Confidence**: 80%
- Problem: The `Promise.all` now fetches 12 results in parallel, unwraps them through a 12-element `unwrapAll`, then destructures into a 12-element typed tuple (lines 253-279). Each new entity type (channels being the 6th) adds 2 more entries to every array. The type annotations (lines 244-251) are 6 conditional type helpers just to safely cast the results.
- Impact: The parallel fetch is efficient and correct, but the 12-element positional tuple is fragile — a reorder or insertion silently misaligns types. The `unwrapAll` labels array must stay in sync with the `Promise.all` order, which is enforced only by convention.
- Fix: Consider a named-result pattern where each fetch is keyed:

```typescript
const fetches = {
  tasks: taskRepository.findAll(FETCH_LIMIT),
  loops: loopRepository.findAll(FETCH_LIMIT),
  // ...
} as const;
const results = await promiseAllNamed(fetches);
```

This makes the positional tuple unnecessary and self-documents the alignment.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`handler-setup.ts` is 597 lines total — approaching the 500-line file warning threshold** - `src/services/handler-setup.ts`
**Confidence**: 85%
- Problem: The file was already at ~570 lines before this PR. Adding ChannelMessagePersistenceHandler pushed it to 597. The file contains one large extraction function and one large setup function, both of which grow linearly with each handler.
- Impact: Pre-existing growth pattern. The file is not structurally complex (low nesting, clear sequential flow) but its size makes navigation tedious. Applies ADR-003 — tracking pre-existing growth, not blocking this PR.

**`use-dashboard-data.ts` is 557 lines with 4 major functions** - `src/cli/dashboard/use-dashboard-data.ts`
**Confidence**: 80%
- Problem: The file contains `fetchAllData` (134 lines), `fetchMetricsExtras` (44 lines), `fetchDetailExtra` (57 lines), and `useDashboardData` (89 lines). The `fetchDetailExtra` function has an if-chain for 6 entity types, each with different fetch logic. Pre-existing pattern that channels extended by 3 lines.
- Impact: Each entity type adds a new branch to `fetchDetailExtra`. The current 6-way if-chain is manageable but approaching the point where a strategy pattern (entity-type to fetch-function map) would be cleaner. Pre-existing — applies ADR-003.

## Suggestions (Lower Confidence)

- **`buildActivityFeed` has 6 near-identical for-loops** - `src/cli/dashboard/activity-feed.ts:120-179` (Confidence: 70%) — Each entity type has its own for-loop that pushes to the same array with the same shape. A generic mapper could reduce this to a single loop over a config array. However, each loop's action mapper is slightly different, so the current approach is explicit and readable.

- **`cancelEntity` switch has 6 branches with similar structure** - `src/cli/dashboard/keyboard/entity-mutations.ts:45-95` (Confidence: 65%) — The switch follows the same pattern for each entity kind: check terminal status, call service method, refresh. The channel branch introduces a slight variation (destroy instead of cancel). The repetition is bounded by entity count and each branch has entity-specific logic, so consolidation may not be worth the abstraction.

- **`handlePauseResume` in handle-detail-keys.ts repeats the find-then-dispatch pattern for 3 entity types** - `src/cli/dashboard/keyboard/handle-detail-keys.ts:106-128` (Confidence: 65%) — Three if/else-if branches that each find an entity in data, then call `pauseOrResumeEntity`. A lookup table mapping entityType to data finder and kind could reduce this, but the function is only 22 lines and clear.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 0 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 2 | 0 |

**Complexity Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The PR introduces channels as the 6th entity type across the dashboard. The new code itself (channel-detail.tsx, use-channel-pane-preview.ts, channel-message-persistence-handler.ts) is well-structured with low complexity — functions are short, single-responsibility, and follow established patterns. The complexity concern is the linear growth pattern in handler-setup.ts where `setupEventHandlers` (336 lines) and `extractHandlerDependencies` (93 lines) grow by ~20 lines per new handler. Extracting the optional-handler creation pattern would cap future growth and make the existing code easier to navigate.

The dashboard keyboard handling is well-decomposed into focused section handlers (`handleChannelNavigation` is 28 lines, `handlePauseResume` is 22 lines for the new channel code), and helper functions like `resolveMemberIndex` follow the existing `resolveChildIndex`/`resolveIterationIndex` pattern exactly. The new `useChannelPanePreview` hook (99 lines) mirrors the existing `useResourceMetrics` pattern cleanly.

No issues with nesting depth, boolean complexity, or magic values in the new code. The two HIGH findings are about the pre-existing growth pattern that this PR extends — they should be addressed before the next entity type is added.
