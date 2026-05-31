# Regression Review Report

**Branch**: feat-184-dashboard-channels -> main
**Date**: 2026-05-27

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

**Activity feed channels use full findAll list instead of time-windowed recent entries** - `src/cli/dashboard/use-dashboard-data.ts:368`
**Confidence**: 82%
- Problem: All other entity kinds in the activity feed use `findUpdatedSince(since1h, 50)` to fetch only recently-updated entries (last 1 hour). Channels are passed from the main `findAll(FETCH_LIMIT)` result, which includes ALL channels regardless of when they were last updated. This means old/stale channels pollute the activity feed with entries that haven't changed recently, pushing out genuinely recent activity from other entity kinds.
- Impact: The activity feed may show old channel entries (created days ago, never updated) alongside tasks that completed seconds ago. This is a behavioral inconsistency with how the other 5 entity kinds populate the feed. The `buildActivityFeed` function sorts by `updatedAt` and applies a limit, so old channels will appear at the bottom, but they still consume limit slots that could be used by more recent activity.
- Fix: Add a `findUpdatedSince` method to `ChannelRepository` (matching the pattern of TaskRepository, LoopRepository, etc.) and use it in `fetchMetricsExtras`. Until then, filter the passed channels array client-side:
  ```typescript
  // In fetchMetricsExtras, filter channels to recent ones before passing to buildActivityFeed
  const recentChannels = channels.filter(c => (c.updatedAt ?? c.createdAt) >= since1h);
  ```
  The code comment at line 332 acknowledges "ChannelRepository has no findUpdatedSince" but does not address the behavioral inconsistency.

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Channel activity feed entries lack time-window parity with other entities** - `src/cli/dashboard/use-dashboard-data.ts:368` (Confidence: 75%) -- As noted in the HIGH finding above, the workaround of reusing the main fetch is pragmatic but deviates from the established pattern. A `findUpdatedSince` query with an `idx_channels_updated_at` index (which already exists from migration v31) would restore full parity.

- **`fetchMetricsExtras` signature changed to accept channels parameter** - `src/cli/dashboard/use-dashboard-data.ts:335` (Confidence: 65%) -- The function signature expanded from `(ctx: ReadOnlyContext)` to `(ctx: ReadOnlyContext, channels: readonly Channel[])`. This is a private function so no external consumers break, but it establishes an asymmetric pattern: 5 entities are fetched inside the function while 1 is passed in. If more entities need similar treatment in the future, the signature will grow.

- **TERMINAL_STATUSES constant not extended for channels** - `src/cli/dashboard/keyboard/constants.ts:39` (Confidence: 62%) -- The `TERMINAL_STATUSES` object defines terminal statuses for 5 entity types but not channels. Channel cancel/delete handlers use explicit `ChannelStatus.DESTROYED`/`ChannelStatus.COMPLETED` checks (which is correct), but the inconsistency with the established pattern may cause confusion for future maintainers expecting channels to follow the same pattern.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 0 | 0 |

**Regression Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Regression Checklist

- [x] No exports removed without deprecation -- `taskAction` and `scheduleAction` were private functions, inlined at call sites. No external consumers exist (verified via grep).
- [x] Return types backward compatible -- All modified interfaces (`DashboardData`, `NavState`, `DashboardMutationContext`, `BuildActivityFeedArgs`, `ViewState`, `PanelId`, `ActivityEntry.kind`, `EntityKind`) are additive extensions (new union members, new optional fields). No narrowing.
- [x] Default values unchanged -- `INITIAL_NAV` adds `channels: 0`/`null` entries, preserving existing panel defaults. No existing defaults changed.
- [x] Side effects preserved -- Event emissions preserved for all existing entity types. New `ChannelMessageSent` event gains optional `summary` field (backward compatible -- old events without summary are silently skipped by the persistence handler).
- [x] All consumers of changed code updated -- `PanelId` type widened to include `'channels'`; all switch/Record consumers updated (entity-browser-panel, entity-tabs, helpers, hints, constants, handle-main-keys, handle-detail-keys, metrics-view, app, detail-view).
- [x] Migration complete across codebase -- Migration v32 adds `channel_messages` table. No incomplete migration paths.
- [x] CLI options preserved -- No CLI option changes in this PR.
- [x] API endpoints preserved -- No MCP tool changes in this PR.
- [x] Commit message matches implementation -- 12 commits implementing dashboard channel integration. Implementation matches stated intent.
- [x] Breaking changes documented -- PR description states "No breaking changes." Verified: all changes are additive.

### Decisions Applied

- `applies ADR-001` -- Channel name validation remains constrained to tmux SESSION_NAME_REGEX compatibility. The new `capturePaneContent` method validates session names via the same `validateSessionName` helper.
- `applies ADR-003` -- The missing `findUpdatedSince` on ChannelRepository is a known gap addressed with a pragmatic workaround (reusing the main fetch). If this becomes a performance issue, it should be tracked as a separate issue per ADR-003.
- `avoids PF-004` -- The new `ChannelMessagePersistenceHandler` follows best-effort pattern (errors logged, never thrown), avoiding the multi-layer rollback pitfall. The handler is optional and non-fatal.

### Condition for Approval

The HIGH finding (activity feed time-window inconsistency) is a behavioral regression relative to the established pattern for other entities. Recommend adding a client-side filter on the channels array before passing to `buildActivityFeed` to limit to entries updated within the last hour. This is a one-line fix that restores behavioral parity.
