# Complexity Review Report

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-28T14:09

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

### MEDIUM

**fetchAllData: 120-line function with 12 sequential unwrap guards** - `src/cli/dashboard/use-dashboard-data.ts:172-291`
**Confidence**: 82%
- Problem: `fetchAllData` is 120 lines long (function length warning threshold: 50). The refactored unwrap block (lines 221-246) replaced a generic `unwrapAll` loop with 12 individual `if (!result.ok) return err(...)` guards followed by 12 `const x = xResult.value` assignments. While the new approach eliminates unsafe positional casts and improves type flow, the mechanical repetition across 24 lines of near-identical code increases visual noise and makes it easy to introduce copy-paste errors (e.g., wrong error label on a result check).
- Fix: Consider extracting the parallel fetch + unwrap into a helper that returns a typed object, or use a small generic unwrapper that preserves the individual Result types. For example, a `unwrapResults` helper that takes a record of Results and returns either a record of values or the first error. This would reduce the repetition while keeping the type safety gained by this refactor. However, note that the current approach is intentional (the removed `unwrapAll` + positional cast was the previous solution to this problem), and the trade-off for stronger typing may be acceptable.

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

**SQLiteChannelRepository: 18 prepared statement fields and 608-line file** - `src/implementations/channel-repository.ts:103-608`
**Confidence**: 80%
- Problem: The class now holds 18 prepared statement fields plus a cache Map, and the file is 608 lines. Adding `findUpdatedSinceStmt` (this PR) brings the total to 18 statements, pushing toward the file length critical threshold (500+). The constructor alone (lines 139-211) is 72 lines of statement preparation. This is a pre-existing growth trajectory rather than something this PR introduced.
- Fix: Not blocking. If the repository continues to grow, consider splitting message-related methods (saveMessage, getMessages, countMessages, pruneMessages) into a separate `ChannelMessageRepository` to keep each class under 400 lines. The 4 message-specific statements and 3 message-specific methods form a natural seam.

## Suggestions (Lower Confidence)

- **cancelEntity switch cyclomatic complexity** - `src/cli/dashboard/keyboard/entity-mutations.ts:35-104` (Confidence: 65%) -- The `cancelEntity` function has 7 switch cases (6 entity kinds + default) with nested conditionals, yielding roughly 12 decision paths. The exhaustiveness guards are good practice but the function is reaching the upper bound of comfortable switch complexity. A table-driven dispatch could reduce this, but the per-entity-kind branching is inherently different (different service calls, different terminal status checks, pipeline has a loop), so this may be as clean as it gets.

- **12 parallel Promise.all slots in fetchMetricsExtras growing** - `src/cli/dashboard/use-dashboard-data.ts:189-218` (Confidence: 62%) -- The main parallel fetch now has 12 slots (6 entity findAll + 6 countByStatus) and `fetchMetricsExtras` has 9 slots. Each new entity type adds 2-3 more slots. The destructured binding at 12 elements is approaching the point where positional errors become likely. The current naming convention (entityResult, entityCountsResult) mitigates this well.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Complexity Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The overall complexity profile of this PR is healthy. The changes actually reduce complexity in several areas:
- Removed `unwrapAll` + unsafe positional cast pattern in favor of direct type-safe unwrapping (eliminates runtime type confusion risk).
- Flattened nested `if (mutations.channelService)` wrapping in `pauseOrResumeEntity` to an early `break` guard.
- Added exhaustiveness guards (`const _exhaustive: never = kind`) to `cancelEntity`, `deleteEntity`, `getPanelItems`, and `panelToEntityKind` -- these are a net positive for maintainability.
- Replaced inline channel filtering (`.filter(c => ...)`) in `fetchMetricsExtras` with proper `findUpdatedSince` repository query, simplifying the data flow.

The one MEDIUM blocking finding (fetchAllData length) is a trade-off accepted by the prior resolution cycle -- the repetitive unwrap block was introduced intentionally to eliminate unsafe casts. The condition is: if more entity types are added, revisit the unwrap pattern to avoid the function growing further.
