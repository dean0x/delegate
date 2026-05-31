# Consistency Review Report

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-28

## Issues in Your Changes (BLOCKING)

### HIGH

(none)

### MEDIUM

**Channel `destroyed` status missing from `buildHealthSummary` failed count** - `src/cli/dashboard/components/header.tsx:59-65`
**Confidence**: 82%
- Problem: Every other entity type contributes its terminal-abnormal statuses to the `failed` tally in `buildHealthSummary`. Tasks contribute `failed` + `cancelled`, loops contribute `failed`, orchestrations contribute `failed`, pipelines contribute `failed` + `cancelled`, schedules contribute `cancelled`. Channels have `destroyed` as their terminal-abnormal status (semantically equivalent to `cancelled`), but it is not added to the `failed` count. This means active dashboard users who destroy channels will see no health summary impact, which is inconsistent with how every other entity type surfaces terminal-abnormal states.
- Fix: Add `(data.channelCounts.byStatus['destroyed'] ?? 0)` to the `failed` sum:
```typescript
const failed =
  (data.taskCounts.byStatus['failed'] ?? 0) +
  (data.loopCounts.byStatus['failed'] ?? 0) +
  (data.scheduleCounts.byStatus['cancelled'] ?? 0) +
  (data.orchestrationCounts.byStatus['failed'] ?? 0) +
  (data.pipelineCounts.byStatus['failed'] ?? 0) +
  (data.pipelineCounts.byStatus['cancelled'] ?? 0) +
  (data.channelCounts.byStatus['destroyed'] ?? 0);
```

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Unnecessary `?? []` null coalescing on non-optional `channels` field** - `src/cli/dashboard/keyboard/helpers.ts:35` (Confidence: 65%) -- `data.channels` is typed as `readonly Channel[]` (non-optional) in `DashboardData`, making `?? []` redundant. However, `data.pipelines ?? []` on line 33 has the same pattern, so this is consistent with the existing style and not worth changing alone.

- **`findUpdatedSince` missing from ChannelRepository** - `src/cli/dashboard/use-dashboard-data.ts:362-364` (Confidence: 70%) -- All five other entity repositories implement `findUpdatedSince(since, limit)` for the activity feed time window, but `ChannelRepository` lacks it, requiring an inline filter of the full channel list. The inline filter is documented with a comment explaining the gap. This is a minor API shape inconsistency -- acceptable for Phase 9 baseline, worth adding if channels become a hot entity type.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Consistency Score**: 9/10
**Recommendation**: APPROVED_WITH_CONDITIONS

## Consistency Analysis

This PR demonstrates very strong consistency with the existing codebase patterns. Key observations:

**Patterns followed correctly:**
- ChannelMessagePersistenceHandler exactly mirrors UsageCaptureHandler: factory pattern, private constructor, best-effort error handling, logger child creation, subscribeToEvents structure (applies ADR-001 for session name validation via shared SESSION_NAME_REGEX in capturePaneContent)
- Handler registration in `handler-setup.ts` follows the sequential optional-handler pattern (items 8-12) with non-fatal warning on failure
- Dashboard type extensions (PanelId, NavState, DashboardData, ViewState, DashboardMutationContext) consistently add `channels` in the same position and style as `pipelines`
- Entity mutation functions (cancel, pause/resume, delete) add `channel` case following the exact switch structure of existing entity types
- Keyboard handler ordering is documented and maintained (new step 6 for channels, existing step 6 renumbered to 7)
- Activity feed integration follows the established per-entity loop pattern
- Channel detail view uses identical component patterns: Field, StatusField, StatusBadge, ScrollableList, formatRunProgress, relativeTime, truncateCell
- Zod schema validation at DB boundary (ChannelMessageRowSchema) matches ChannelRowSchema and ChannelMemberRowSchema
- N+1 fix (hydrateChannelRows with IN-clause batch + statement cache) is production-quality
- `capturePaneContent` method follows the existing TmuxSessionManager method structure: validateSessionName, isSessionNotFound graceful handling, consistent error return shape
- Hook pattern (useChannelPanePreview) matches useResourceMetrics: fetching ref + closing ref for overlap/unmount protection, setInterval with explicit cleanup

**One minor gap:** The `buildHealthSummary` failed count omits `destroyed` channels, creating a small inconsistency with how other entity types surface terminal-abnormal states. This is the only blocking consistency finding.

**Decision citations:**
- applies ADR-001: capturePaneContent validates session names via SESSION_NAME_REGEX, maintaining the channel-name-to-tmux-session constraint
- avoids PF-002: No migration path needed for channel_messages table (new table, never shipped)
