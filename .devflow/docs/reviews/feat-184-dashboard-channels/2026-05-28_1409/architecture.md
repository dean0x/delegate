# Architecture Review Report

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-28T14:09
**Diff**: `git diff 37efbc094027922e9cc86f6c6cec0a16e6e0da36...HEAD`
**Prior Resolutions**: Cycle 3 — 13 fixed, 4 false positive. Findings below avoid re-raising resolved items.

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

### MEDIUM

(none)

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Optional `channelService` / `channelRepo` on DashboardMutationContext creates asymmetric DIP** - `src/cli/dashboard/types.ts:60-62`
**Confidence**: 82%
- Problem: `channelService` and `channelRepo` are the only optional (`?`) fields on `DashboardMutationContext`. All other entity repos/services (orchestration, loop, task, schedule) are required, while pipeline repo is also optional. This forces runtime null-checks (`mutations.channelService`, `mutations.channelRepo`) at every call site in `cancelEntity`, `pauseOrResumeEntity`, and `deleteEntity`. The pattern diverges from the other 4 core entities where null-checks are unnecessary.
- Fix: Once the channel feature is fully stabilized, promote `channelService` and `channelRepo` to required fields (matching orchestrationService, loopService, etc.) and update the DashboardMutationContext constructor to always provide them. This eliminates defensive branching in all 3 mutation functions and makes the interface consistent. The same applies to `pipelineRepo` which shares this pattern.

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **`fetchMetricsExtras` channels result is best-effort but `fetchAllData` channels result is blocking** - `src/cli/dashboard/use-dashboard-data.ts:226,333` (Confidence: 70%) -- In `fetchAllData`, `channelRepository.findAll` failure is a hard error that stops the entire dashboard (line 226), while `channelRepository.findUpdatedSince` failure in `fetchMetricsExtras` degrades gracefully to an empty array (line 333). This is consistent with how other entities behave (findAll = hard, findUpdatedSince = soft), so it follows existing convention -- but worth noting that a transient channel DB error kills the whole dashboard even though channels are the newest, least critical entity.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | - |
| Should Fix | - | 0 | 1 | - |
| Pre-existing | - | - | 0 | 0 |

**Architecture Score**: 8/10
**Recommendation**: APPROVED

## Architectural Strengths

The changes in this PR demonstrate strong architectural discipline:

1. **Tuple-to-destructured refactor (fetchAllData)**: Eliminating the `unwrapAll` helper and positional tuple casts in favor of individual destructured results with inline narrowing is a meaningful improvement. The old pattern required `as [TaskList, LoopList, ...]` casts that were fragile -- adding/removing a Promise.all entry could silently misalign positions. The new per-result unwrapping is type-safe without casts and makes error messages self-documenting. This is a good application of "explicit over implicit."

2. **Repository interface consistency (findUpdatedSince)**: Adding `findUpdatedSince` to `ChannelRepository` completes the activity-feed query pattern across all 6 entity repositories (Task, Loop, Schedule, Orchestration, Pipeline, Channel). The signature `(sinceMs: number, limit: number) => Promise<Result<readonly Channel[]>>` matches the other 5 exactly. The previous workaround (filtering the full channel list in-memory with a timestamp predicate) was an architectural deviation that leaked the limitation into the caller; now the caller treats channels identically to every other entity. This applies ADR-003 reasoning -- the workaround was tracked and now properly resolved.

3. **Exhaustive switch guards**: Adding `never`-typed default cases in `cancelEntity`, `deleteEntity`, `getPanelItems`, and `panelToEntityKind` is excellent defensive architecture. The compile-time exhaustiveness guard ensures future `EntityKind` or `PanelId` additions trigger a build error, preventing silent fallthrough. The comment noting that the assignment alone enforces the invariant (since it lives inside a try/catch that would swallow a thrown error) shows awareness of the execution context.

4. **Atomic saveMessage transaction**: Wrapping INSERT + COUNT + conditional DELETE in `this.db.transaction()` prevents concurrent `ChannelMessageSent` events from double-pruning. This correctly addresses the race condition where two messages could each trigger a prune of the same old rows. The best-effort semantics are preserved (prune failure inside the transaction is caught, so the INSERT still commits). This avoids PF-004 reasoning about multi-step cleanup completeness.

5. **Limit clamping in getMessages**: The `Math.max(1, Math.min(...))` clamp ensures the LIMIT clause never receives 0 or negative values (which would cause SQLite to return no rows or behave unexpectedly). This defensive boundary validation follows the "validate at boundaries" principle.

6. **Consistent hint strings (channel detail)**: Using a dedicated `baseChannel` hint string that omits "Enter detail" correctly reflects that channels have no further drill-through -- avoiding misleading keyboard hints for TUI users.
