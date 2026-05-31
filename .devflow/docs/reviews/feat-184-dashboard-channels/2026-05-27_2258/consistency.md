# Consistency Review Report

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-27
**Cycle**: 2 (incremental — Cycle 1 resolved 10/11 issues)

## Issues in Your Changes (BLOCKING)

### HIGH

**Activity feed channel data source inconsistency** - `src/cli/dashboard/use-dashboard-data.ts:368`
**Confidence**: 85%
- Problem: All five other entity kinds in the activity feed use `findUpdatedSince(since1h, 50)` to fetch recently-updated entities for the metrics view. Channels pass the full `channels` array from the main `findAll(FETCH_LIMIT)` batch instead. This means:
  1. Channels show ALL channels (up to FETCH_LIMIT=100) in the activity feed regardless of when they were last updated, while other entities only show those updated in the last hour.
  2. Old, stale channels will appear in the activity feed alongside recent tasks/loops/etc.
  The diff comment at line 330-332 documents this as intentional ("ChannelRepository has no findUpdatedSince"), but the resulting behavioral asymmetry is user-visible: the activity feed for channels is not time-bounded like every other entity.
- Fix: Add `findUpdatedSince(sinceMs: number, limit: number)` to `ChannelRepository` (matching the pattern of all five other repositories in `interfaces.ts` lines 189, 390, 735, 875, 1004) and use it in `fetchMetricsExtras`. The implementation is a single prepared statement: `SELECT * FROM channels WHERE updated_at >= ? ORDER BY updated_at DESC LIMIT ?`.

**`channels` optional in `BuildActivityFeedArgs` but required in `DashboardData`** - `src/cli/dashboard/activity-feed.ts:104`
**Confidence**: 82%
- Problem: `BuildActivityFeedArgs.channels` is typed as `readonly ChannelLike[] | undefined` (optional with `?`), while all other entity arrays (`tasks`, `loops`, `orchestrations`, `schedules`, `pipelines`) are required. In `DashboardData` (types.ts:207), `channels` is non-optional (`readonly Channel[]`). The inconsistency means `buildActivityFeed` must guard with `channels ?? []` (line 171) while no other entity loop needs this guard. Every call site already passes a value.
- Fix: Remove the `?` from `readonly channels?: readonly ChannelLike[]` to match the other five fields:
```typescript
readonly channels: readonly ChannelLike[];
```

### MEDIUM

**`taskAction` and `scheduleAction` helper functions removed** - `src/cli/dashboard/activity-feed.ts:127,157`
**Confidence**: 80%
- Problem: The PR removes the `taskAction()` and `scheduleAction()` helper functions and inlines their return values directly as `task.status` and `sched.status`. This is functionally correct (both functions were identity functions), but breaks the pattern where every entity kind has a dedicated `*Action()` helper. Now the pattern is: tasks/schedules use inline status, loops/orchestrations/pipelines/channels use helper functions. If task or schedule actions gain special verbs in the future (like loops did with "iteration N"), the helper will need to be re-added.
- Fix: Either restore the identity helpers for consistency (preferred — cost is negligible), or add a comment at lines 127 and 157 explaining why these two entities don't use helpers (e.g., `// Identity — status maps directly to action verb`). The comment approach is acceptable since the original code already had those comments.

**Dashboard hint says "cancel" but channels use "destroy"** - `src/cli/dashboard/keyboard/hints.ts:25`
**Confidence**: 80%
- Problem: The main view hint `c cancel` applies to all panels including channels, but `cancelEntity` for the `'channel'` kind calls `mutations.channelService.destroyChannel()` (entity-mutations.ts:87). Other entities (tasks, orchestrations, loops, schedules) have a `cancelX()` method. Channels use `destroyChannel()` because the ChannelStatus enum has DESTROYED, not CANCELLED. The hint text "cancel" is misleading for channel entities — the user is destroying, not cancelling.
- Fix: Update `mainHints` to show a context-aware label for the `c` key when the focused panel is `channels`:
```typescript
const cancelHint = focusedPanel === 'channels' ? 'c destroy' : 'c cancel';
```
Or add a note in the hint: `c cancel/destroy` when channels are focused.

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none — no CRITICAL pre-existing issues found in touched files)

## Suggestions (Lower Confidence)

- **`channelService` optionality guard differs from `pipelineRepo`** - `src/cli/dashboard/keyboard/entity-mutations.ts:86` (Confidence: 70%) — In `cancelEntity`, the channel case guards `mutations.channelService` inside the switch case (line 86: `&& mutations.channelService`), while the pipeline case does NOT guard `mutations.pipelineRepo` before use. However, in `deleteEntity`, both pipeline (line 198: `&& mutations.pipelineRepo`) and channel (line 202: `&& mutations.channelRepo`) guard. The inconsistency in `cancelEntity` is benign (pipelines use `taskManager.cancel` which is required, not `pipelineRepo`), but the guarding pattern is inconsistent.

- **`ChannelMessage.createdAt` uses `event.timestamp` from BaseEvent** - `src/services/handlers/channel-message-persistence-handler.ts:96` (Confidence: 65%) — Other handlers that persist timestamps (e.g., PersistenceHandler, ScheduleHandler) typically use `Date.now()` for `created_at`. This handler uses `event.timestamp` which is set when the event is created. In practice the difference is negligible (milliseconds), but it's a pattern divergence. The event timestamp approach is arguably more correct for message ordering.

- **`channels` guard uses `?? []` in `getPanelItems` but data.channels is non-optional** - `src/cli/dashboard/keyboard/helpers.ts:35` (Confidence: 65%) — `data.channels ?? []` is defensive against a type that is non-optional in `DashboardData`. `data.pipelines ?? []` (line 33) has the same pattern. Both are technically unnecessary but harmless. This is a pre-existing pattern from pipelines that channels correctly copied.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Consistency Score**: 8/10
**Recommendation**: CHANGES_REQUESTED

The channel integration is notably thorough and well-patterned overall. The type cascade (PanelId, ActivityEntry.kind, EntityKind, ViewState) is correctly extended in all locations. Keyboard handling, filter cycles, panel jump keys, terminal statuses, and mutation operations all follow existing entity patterns precisely. The `ChannelMessagePersistenceHandler` correctly mirrors the `UsageCaptureHandler` pattern (factory method, best-effort, warn-not-throw). The `hydrateChannelRows` N+1 optimization is a welcome consistency improvement.

The two HIGH issues are the activity feed data source asymmetry (channels not time-bounded like other entities) and the optional typing inconsistency in BuildActivityFeedArgs. The two MEDIUM issues (removed identity helpers, misleading hint text) are lower-impact pattern deviations.

Decisions/pitfalls applied: The centralized `TERMINAL_STATUSES` for channels (applies ADR-001 — channel name validation aligns with tmux session naming). The 3-layer rollback in `destroyChannel` correctly cleans sessions, DB, and in-memory state (avoids PF-004).
