# Regression Review Report

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-27

## Issues in Your Changes (BLOCKING)

### HIGH

**Activity feed passes unfiltered channels to buildActivityFeed (time-window inconsistency)** - `src/cli/dashboard/use-dashboard-data.ts:368`
**Confidence**: 85%
- Problem: All other entity types (tasks, loops, orchestrations, schedules, pipelines) are fetched via `findUpdatedSince(since1h, 50)` which returns only entities updated in the last hour. Channels, however, are passed as the full `findAll()` result from the main parallel batch. This means the activity feed will contain channel entries regardless of age, while all other entities are filtered to the last hour. For a user with many channels, old channel entries could dominate the activity feed and push out recent task/loop/schedule activity.
- Fix: Either implement `findUpdatedSince` on `ChannelRepository` and use it here, or filter the passed `channels` array in-memory before passing to `buildActivityFeed`:
  ```typescript
  const recentChannels = channels.filter(
    (c) => (c.updatedAt ?? c.createdAt) >= since1h
  );
  // ...
  buildActivityFeed({ ..., channels: recentChannels, limit: 50 });
  ```
  The in-memory filter is preferable since the channel list is already bounded by FETCH_LIMIT (100) and avoids adding a new repository method.

### MEDIUM

**Removed `taskAction` and `scheduleAction` helper functions changes activity feed behavior** - `src/cli/dashboard/activity-feed.ts:127,157`
**Confidence**: 82%
- Problem: The diff removes the `taskAction()` and `scheduleAction()` functions, replacing their calls with direct `task.status` / `sched.status` inlines. While both removed functions were identity functions (`return status`), this is a behavior-preserving refactor only under the assumption that these functions never need to diverge from identity. The `loopAction`, `orchestrationAction`, and `pipelineAction` functions remain because they have non-trivial logic. This is not a bug today, but removing the named functions means there is no obvious hook point if task/schedule action verbs need customization in the future (e.g., mapping "queued" to "waiting"). This is a mild regression in extensibility.
- Fix: This is low-severity and arguably intentional simplification. If the project wants consistent extensibility, restore the named functions as trivial wrappers. Otherwise, accept the inlining as dead-code removal.

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Channel activity feed entries may appear stale in narrow time windows** - `src/cli/dashboard/use-dashboard-data.ts:368` (Confidence: 70%) -- Because channels use the full `findAll()` result rather than `findUpdatedSince`, a channel that was created days ago but never updated will still appear in the activity feed every poll cycle. The other entity types avoid this via their 1-hour time window filter. This could produce confusing "old" entries in the feed.

- **`buildBreadcrumb` function signature widened with optional `data` parameter** - `src/cli/dashboard/components/header.tsx:100-105` (Confidence: 65%) -- The `buildBreadcrumb` function gained a 4th optional parameter (`data?: DashboardData | null`). While the change is backward compatible, it means the function now depends on `data` being threaded through from the caller for channel-specific formatting. If `data` is null/undefined when viewing a channel, the breadcrumb falls back to `shortId(entityId)` which is still functional but inconsistent with the documented AC-11 intent.

- **`ChannelMessageSentEvent.summary` field is optional without Zod validation** - `src/core/events/events.ts:342` (Confidence: 62%) -- The new `summary` field on `ChannelMessageSentEvent` is typed as `summary?: string` but has no schema validation. The handler guards against missing summary with `if (!event.summary)`, which is sufficient, but events with empty strings would pass through and create empty summary rows in the database.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Regression Score**: 8/10
**Recommendation**: CHANGES_REQUESTED

The PR is well-structured with comprehensive test coverage and follows existing patterns (applies ADR-001 for channel name validation, avoids PF-004 by handling rollback correctly in the persistence handler). The type cascade across ~15 dashboard files is mechanically consistent -- every `PanelId` union expansion, `NavState` record expansion, `DashboardData` field addition, `PANEL_ORDER` entry, `FILTER_CYCLES` entry, and switch-case coverage is complete. No exports were removed, no signatures were broken, and existing tests were correctly updated to account for the new 6th panel.

The primary regression concern is the activity feed time-window inconsistency (HIGH): channels pass the full entity list rather than a 1-hour window like all other entities, which will cause stale channel entries to appear in the feed. The `taskAction`/`scheduleAction` removal (MEDIUM) is a minor extensibility regression but not a functional bug.

Prior cycle 1 resolutions (entity mutation tests in d3fd6a1, exhaustive never guard in bcb03e0) were verified as intact -- the new `memberStatusColor` function in `channel-detail.tsx:49-53` includes the same exhaustive `never` pattern, and the entity mutation tests now cover the `channel` kind.
