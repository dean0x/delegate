# Performance Review Report

**Branch**: feat-184-dashboard-channels -> main
**Date**: 2026-05-27T17:36
**PR**: #196

## Issues in Your Changes (BLOCKING)

### HIGH

**N+1 query pattern in channel `findAll` executes on every dashboard poll cycle** - `src/implementations/channel-repository.ts:426-429`
**Confidence**: 90%
- Problem: `rowToChannel()` issues a separate `findMembersByChannelIdStmt` query per channel row. `findAll(50)` = 51 queries. This is called every 1 second on the main dashboard view via `fetchAllData()` in `use-dashboard-data.ts:214`. The code's own JSDoc acknowledges this ("N+1 LOAD: findAll(100) = 101 queries total. Acceptable for Phase 6 baseline"). However, Phase 6 was the domain persistence layer -- now that this is wired into the 1-second dashboard poll loop, the N+1 is no longer just a baseline but a per-second hot path. With 50 channels, that is 51 SQLite queries every second just for channel data, on top of the existing 10+ queries per poll cycle for the other 5 entity types.
- Impact: Linear query growth per channel on a 1-second polling interval. At 20+ channels the cumulative SQLite pressure (51+ channel queries + ~20 existing queries per tick) may cause poll overlap, triggering the `fetching.current` guard and producing stale dashboard data.
- Fix: Batch-load members with a single `WHERE channel_id IN (...)` query after fetching all channel rows, then join in-memory:
```typescript
// In findAll, after fetching channel rows:
const channelIds = rows.map(r => r.id);
if (channelIds.length === 0) return [];
const placeholders = channelIds.map(() => '?').join(',');
const allMembers = this.db.prepare(
  `SELECT * FROM channel_members WHERE channel_id IN (${placeholders}) ORDER BY joined_at ASC`
).all(...channelIds) as ChannelMemberRow[];
const membersByChannel = new Map<string, ChannelMemberRow[]>();
for (const mr of allMembers) {
  const list = membersByChannel.get(mr.channel_id) ?? [];
  list.push(mr);
  membersByChannel.set(mr.channel_id, list);
}
return rows.map(row => this.rowToChannelWithMembers(row, membersByChannel.get(row.id) ?? []));
```

### MEDIUM

**Missing covering index for `getMessages` ORDER BY clause** - `src/implementations/database.ts:1276-1279`, `src/implementations/channel-repository.ts:170-172`
**Confidence**: 85%
- Problem: `getMessages` uses `WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?` but the only single-column index is `idx_channel_messages_channel_id` on `(channel_id)`. The composite index `idx_channel_messages_channel_round` covers `(channel_id, round DESC)`, not `(channel_id, created_at DESC)`. SQLite must fetch all matching rows for a channel, then filesort by `created_at DESC` before applying the LIMIT. This runs on the 2-second detail-view poll interval.
- Impact: For channels with many messages (hundreds+), this forces a full scan-and-sort of all messages for that channel on every poll. With 50 rows returned and potentially thousands stored, this is unnecessary work.
- Fix: Replace or add a composite index that matches the query:
```sql
CREATE INDEX IF NOT EXISTS idx_channel_messages_channel_created
  ON channel_messages(channel_id, created_at DESC);
```
This allows SQLite to serve the query via index scan + early termination at LIMIT.

**Zod schema validation on every row in the 1-second polling hot path** - `src/implementations/channel-repository.ts:427,447`
**Confidence**: 82%
- Problem: `rowToChannel()` calls `ChannelRowSchema.parse(row)` and `ChannelMemberRowSchema.parse(row)` for every row returned from SQLite. These Zod parse calls run on every poll tick (1s main, 2s detail). Other repositories in this codebase (task-repository, loop-repository) do NOT use Zod validation on read paths -- they validate at write boundaries only. This is inconsistent and adds overhead proportional to result-set size on every poll.
- Impact: Zod `parse()` involves schema construction, type coercion, and error formatting overhead. For 50 channels with 3 members each = 200 Zod parse calls per second. While each call is fast (~50-100us), the aggregate adds ~10-20ms of CPU per tick, which is non-trivial in a 1-second budget that also includes 50+ SQLite queries.
- Fix: Follow the existing repository pattern: validate at write boundaries (in `save()`, `addMember()`), trust data from SQLite on read paths. Replace `ChannelRowSchema.parse(row)` with direct field access using the `ChannelRow` TypeScript interface (already defined), and similarly for members and messages.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`SELECT *` in all channel repository prepared statements** - `src/implementations/channel-repository.ts:137-171`
**Confidence**: 80%
- Problem: All 7 SELECT queries use `SELECT *` instead of explicit column lists. While other repositories in this codebase follow the same pattern (pre-existing), this PR introduces 7 new `SELECT *` statements. When `channel_messages` or `channels` tables gain columns in future migrations, these queries will fetch unnecessary data, increasing memory allocation and deserialization cost on the hot polling path.
- Impact: Low immediate impact, but grows with schema evolution. Each extra column adds deserialization overhead multiplied by rows x polls/second.
- Fix: Use explicit column lists in the prepared statements. At minimum, the `getMessagesStmt` (detail poll path) and `findAllStmt` (main poll path) should enumerate columns.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Dashboard poll cycle now issues 12+ parallel queries per tick (6 entities x 2 queries each)** - `src/cli/dashboard/use-dashboard-data.ts:208-221`
**Confidence**: 80%
- Problem: Adding channels as the 6th entity increased the parallel query batch from 10 to 12 queries (findAll + countByStatus per entity). Combined with the channel N+1 pattern, the main view issues ~63 queries per second (12 base + 51 N+1 for channels). This is a pre-existing architectural pattern but the PR pushes the cumulative load higher.
- Impact: SQLite WAL mode handles concurrent reads well, but all 12+ Promise.all queries serialize on the single SQLite connection in better-sqlite3 (which uses synchronous calls wrapped in async). The effective query budget per tick is the sequential sum of all query times.
- Note: The existing fetching-guard and stale-on-error patterns prevent cascading failures, so this degrades gracefully. Informational -- the N+1 fix in Blocking reduces this from ~63 to ~13 queries per tick.

## Suggestions (Lower Confidence)

- **Activity feed reuses full channel list instead of `findUpdatedSince`** - `src/cli/dashboard/use-dashboard-data.ts:368` (Confidence: 70%) -- Other entities use `findUpdatedSince(since1h, 50)` for the activity feed, but channels pass the full `findAll` result. This means all channels (up to 50) are included in the activity feed sort regardless of recency. Not a performance concern at current scale but inconsistent with the targeted-query pattern used for other entities.

- **capturePaneContent spawns a tmux process every 3 seconds per channel detail view** - `src/cli/dashboard/use-channel-pane-preview.ts:15,53` (Confidence: 65%) -- The `POLL_INTERVAL_MS = 3000` interval spawns `tmux capture-pane` via `spawnSync` every 3 seconds. This is a synchronous child process spawn that blocks the Node.js event loop briefly. Acceptable for a single session, but if the pattern were extended to multiple simultaneous previews it would become blocking.

- **`crypto.randomUUID()` in message persistence handler** - `src/services/handlers/channel-message-persistence-handler.ts:90` (Confidence: 62%) -- `crypto.randomUUID()` is called for every message event. While fast (~1-2us), if message volume is high (many rounds x many members), a pre-allocated ID or event-carried ID would avoid the entropy pool access.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Performance Score**: 6/10
**Recommendation**: CHANGES_REQUESTED

The primary concern is the N+1 query pattern in `findAll` being wired into the 1-second dashboard poll loop. The code itself documents this as a known baseline limitation, but integrating it into the hot poll path elevates its severity. The missing covering index on `channel_messages` and unnecessary Zod validation on read paths compound the per-tick overhead. Fixing the N+1 alone reduces per-tick query count from ~63 to ~13, which is the highest-impact single fix.
