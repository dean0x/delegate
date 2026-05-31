# Performance Review Report

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-28
**Prior Resolutions**: Cycle 2 resolved codePointSlice O(200) rewrite, statement cache by arity, limit clamping.

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Prune query uses correlated NOT IN subquery on every save when count > 500** - `src/implementations/channel-repository.ts:188-197`
**Confidence**: 82%
- Problem: The `pruneMessagesStmt` executes a `DELETE ... WHERE id NOT IN (SELECT id ... ORDER BY created_at DESC LIMIT ?)` pattern. For SQLite, the NOT IN subquery must materialize all 500 retained IDs, then scan all rows to find those not in the set. While the count guard (line 397) prevents this from running until the channel has > 500 messages, when it does fire, the subquery is O(n) where n = total messages for that channel. With the `idx_channel_messages_channel_created` covering index the subquery is index-assisted, so practical impact is low for 500-600 rows, but the pattern degrades if MAX_MESSAGES_PER_CHANNEL is ever raised.
- Fix: Consider a threshold-based prune (e.g., only prune when count exceeds MAX + batch_size, say 550) to amortize the cost, or use a simpler `DELETE WHERE created_at < (SELECT created_at FROM channel_messages WHERE channel_id = ? ORDER BY created_at DESC LIMIT 1 OFFSET ?)` which avoids materializing the full ID set. Current impact is acceptable at 500 rows.

**saveMessage issues COUNT + conditional DELETE on every message persist** - `src/implementations/channel-repository.ts:394-399`
**Confidence**: 80%
- Problem: Every call to `saveMessage` executes a `COUNT(*)` query against `channel_messages` for that channel. In a high-throughput channel (e.g., fast round-robin with many messages/second), this adds a read query per write. The count guard prevents the more expensive prune from running, but the count itself is still executed unconditionally.
- Fix: Track message count in-memory per channel (a simple `Map<ChannelId, number>`) and only issue the COUNT query when the in-memory count crosses the threshold. Reset the in-memory counter on process restart by lazily loading the count on first access. This eliminates the per-message COUNT overhead entirely for channels well below the 500-message limit.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Missing `findUpdatedSince` for channels forces full-list in-memory filter on every metrics poll** - `src/cli/dashboard/use-dashboard-data.ts:362-364`
**Confidence**: 85%
- Problem: All other entity types (tasks, loops, orchestrations, schedules, pipelines) use a `findUpdatedSince(since1h, 50)` query that filters at the database level with an indexed column. Channels instead reuse the already-fetched full list (up to FETCH_LIMIT=50) and filter in-memory. The comment acknowledges this: "ChannelRepository has no findUpdatedSince". While the in-memory filter on 50 items is trivially fast, this is an asymmetry that will become a real issue if FETCH_LIMIT is raised or channels become more numerous.
- Fix: Add `findUpdatedSince(since: number, limit: number)` to `ChannelRepository` using the existing `idx_channel_messages_channel_created` index pattern (or add an `updated_at` index on the channels table — `idx_channels_updated_at` — which would be needed). This aligns channels with all other entity types and removes the in-memory filter. The existing `updated_at` column on channels already exists; only the index and repository method are missing. Low urgency given current 50-item cap.

## Pre-existing Issues (Not Blocking)

### LOW

**Zod `.parse()` on every row in dashboard poll hot path** - `src/implementations/channel-repository.ts:512,544,556`
**Confidence**: 82%
- Problem: `ChannelRowSchema.parse()`, `ChannelMemberRowSchema.parse()`, and `ChannelMessageRowSchema.parse()` run full Zod validation on every row returned from SQLite, on every 1-second dashboard poll tick. For 50 channels with 3 members each, that is 50 + 150 = 200 Zod parse calls per tick. Zod parse is ~10-50us per call depending on schema complexity, so total is ~2-10ms per tick -- within budget but not free. This is a pre-existing pattern (all other repositories do the same) -- not introduced by this PR.
- Impact: Informational only. The "validate at boundaries" principle (CLAUDE.md) justifies this cost. Would only become a concern if poll interval drops below 1s or entity counts grow significantly.

**`SELECT *` used across all channel queries** - `src/implementations/channel-repository.ts:151-200`
**Confidence**: 80%
- Problem: All prepared statements use `SELECT *` rather than explicit column lists. This fetches all columns even when only a subset is needed (e.g., the activity feed only needs id, status, updatedAt, createdAt, currentRound, maxRounds). This is a pre-existing pattern across all repositories.
- Impact: Informational. SQLite row sizes are small and the tables have few columns, so the overhead is negligible. Would matter more with large TEXT columns (e.g., `summary` in `channel_messages` when only metadata is needed).

## Suggestions (Lower Confidence)

- **`data?.channels` array scan in useMemo deps** - `src/cli/dashboard/app.tsx:164,200` (Confidence: 65%) -- The `channelDetailSessionName` and `detailEntityStatus` useMemos list `data?.channels` as a dependency. Since `data` is a new object on every poll tick, these memos recompute every second even when the channel list hasn't changed. The early-return guard (viewKind !== 'detail') makes the recomputation trivial in the common case, so practical impact is negligible.

- **capturePaneContent is synchronous (spawnSync) on 3s interval** - `src/cli/dashboard/use-channel-pane-preview.ts:50` (Confidence: 70%) -- The `capturePaneFn` call is synchronous (wraps `spawnSync` via TmuxSessionManager). At the 3-second polling interval, a single ~5-20ms blocking call is well within budget. However, if multiple channel detail views were ever rendered simultaneously (not currently possible), this would compound. The `fetching` ref guard prevents overlapping calls within a single hook instance.

- **Statement cache for IN-clause grows without bound** - `src/implementations/channel-repository.ts:136` (Confidence: 62%) -- The `membersByChannelIdsStmtCache` Map grows with each unique arity value. In practice, arity is bounded by FETCH_LIMIT (50) so the cache maxes at ~50 entries, each holding a prepared statement. This is negligible memory. Would only be a concern if FETCH_LIMIT or calling patterns changed dramatically.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 2 |

**Performance Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The N+1 query problem in `findAll`/`findByStatus` was correctly resolved in this PR via the batch `hydrateChannelRows()` pattern with an IN-clause cache (applies ADR-003 approach -- pre-existing gaps tracked and fixed proactively). The `capturePaneContent` polling at 3s intervals is appropriately bounded. The pruning strategy with count-guard is sound but could be more efficient. The missing `findUpdatedSince` is a minor asymmetry that should be addressed before channels see production scale.

Conditions for merge:
1. The two MEDIUM blocking issues (prune query efficiency, per-message COUNT) are acceptable to defer if channel message volumes are expected to stay low (< 100 messages/channel typical). If high-throughput channels are anticipated, address before merge.
