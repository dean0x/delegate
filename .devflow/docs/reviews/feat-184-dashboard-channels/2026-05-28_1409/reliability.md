# Reliability Review Report

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-28T14:09

## Issues in Your Changes (BLOCKING)

No blocking reliability issues found.

## Issues in Code You Touched (Should Fix)

No should-fix reliability issues found.

## Pre-existing Issues (Not Blocking)

No pre-existing reliability issues at CRITICAL severity in reviewed files.

## Suggestions (Lower Confidence)

(none -- all findings below 60% confidence or no plausible concerns)

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 0 | 0 |

**Reliability Score**: 9/10
**Recommendation**: APPROVED

## Analysis Notes

### Bounded Iteration

All loops and iterations in the changed code are bounded:

- **Pipeline cancel loop** (`entity-mutations.ts:76-79`): Iterates `pipeline.stepTaskIds` which is a finite array from the database. Bounded by pipeline step count.
- **Message pruning** (`channel-repository.ts:418-426`): Single conditional DELETE within a transaction, guarded by a COUNT check against `MAX_MESSAGES_PER_CHANNEL` (500). No loop involved.
- **Result unwrap sequence** (`use-dashboard-data.ts:221-233`): 12 sequential early-return checks -- linear, bounded, no iteration.
- **Cache eviction** (`channel-repository.ts:527-532`): Single eviction per cache miss, bounded by `DEFAULT_LIMIT` (100) max cache size. Evicts one entry per insertion beyond the limit.

### Assertion Density

The changes show strong defensive patterns:

- **Exhaustive never guards** added to `cancelEntity`, `deleteEntity`, `getPanelItems`, and `panelToEntityKind` switches (`entity-mutations.ts:91-96, 213-219`, `helpers.ts:36-39, 90-93`). These are compile-time exhaustiveness checks that catch missing cases when `EntityKind` or `PanelId` is extended. The comment correctly notes these are inside try/catch so throw would be swallowed -- the assignment alone enforces the invariant at compile time.
- **`resolveMemberIndex` null check** (`helpers.ts:121`): Changed from `!selectedName` (falsy check) to `selectedName === null` (explicit null check). This is a correctness improvement -- the old check would treat empty string as falsy, while the explicit null check preserves the intended domain semantics.
- **`getMessages` limit clamp** (`channel-repository.ts:443-448`): Added `Math.max(1, ...)` lower bound to prevent 0 or negative limits from producing unexpected SQL behavior. Matches defensive clamping principle.

### Resource Bounds

- **`findUpdatedSince`** (`channel-repository.ts:380-388`): Follows the established pattern used by all 5 other entity repositories (task, loop, schedule, orchestration, pipeline). Limit parameter is caller-supplied (hard-coded to 50 in `fetchMetricsExtras`). No unbounded growth risk.
- **`saveMessage` transaction** (`channel-repository.ts:402-431`): Wrapping INSERT + COUNT + conditional DELETE in a single `db.transaction()` prevents double-pruning from concurrent `ChannelMessageSent` events. This is an improvement over the previous non-transactional version. The inner try/catch for prune failure preserves the INSERT even if pruning throws.
- **Statement cache eviction** (`channel-repository.ts:524-532`): Evicts oldest entry when cache exceeds DEFAULT_LIMIT (100). Prevents unbounded memory growth from varied arities.

### Error Handling Consistency

- **`fetchMetricsExtras`** now uses `channelRepository.findUpdatedSince` instead of filtering the full channel list in-memory. The `recentChannelsResult.ok ? ... : []` pattern matches all other entity types in the same function. Consistent best-effort degradation.
- **`fetchAllData` refactor** (`use-dashboard-data.ts:189-246`): Replaced the generic `unwrapAll` helper with individual result checks. This eliminates the positional cast (`unknown[]` to typed tuple) and provides labeled error messages directly from TypeScript's type narrowing. The individual checks are more reliable because the compiler verifies each result type rather than depending on array position alignment.
- **Dashboard mutation error handling**: All three functions (`cancelEntity`, `pauseOrResumeEntity`, `deleteEntity`) consistently swallow errors in catch blocks with clear documentation that the 1Hz poll will refresh state. This prevents unhandled rejections from crashing the TUI.

### Cross-Cycle Awareness

Prior resolutions (cycle 3) fixed: exhaustive never guards, limit clamp, atomic saveMessage, cache eviction guard. All four fixes are confirmed present and correct in the current diff. No regressions detected from prior resolution work.
