# Performance Review Report

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-27

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Activity feed receives full channel list instead of recent-only subset** - `src/cli/dashboard/use-dashboard-data.ts:368`
**Confidence**: 85%
- Problem: All other entity types in `fetchMetricsExtras` use `findUpdatedSince(since1h, 50)` to fetch only recently-updated entities for the activity feed. Channels pass the full `channels` array (up to DEFAULT_LIMIT=100) from the main `findAll()` fetch. The comment explains this is because `ChannelRepository` has no `findUpdatedSince` method, but the consequence is that the activity feed sort-and-slice processes up to 100 stale channel entries on every 1-second poll tick, whereas other entities are capped at 50 recently-updated items.
- Impact: On a dashboard with many channels, the `buildActivityFeed` sort processes extra entries unnecessarily. With the current limit of 100 channels and the final `slice(0, 50)`, the overhead is a few extra comparisons per tick -- minor but asymmetric with the established pattern and grows linearly with channel count.
- Fix: Either (a) implement `findUpdatedSince` on `ChannelRepository` for symmetry, or (b) filter the channels array inline before passing to `buildActivityFeed`:
  ```typescript
  const recentChannels = channels.filter(c => (c.updatedAt ?? c.createdAt ?? 0) >= since1h);
  ```
  Option (b) is zero-cost and does not require a new query.

**Prune query runs on every `saveMessage` even when no rows need pruning** - `src/implementations/channel-repository.ts:384`
**Confidence**: 82%
- Problem: `saveMessage` unconditionally executes `pruneMessagesStmt` after every INSERT. The prune SQL uses a correlated subquery (`SELECT id FROM channel_messages WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?`) on every call. For channels with fewer than 500 messages (the common case during normal operation), this subquery scans the index, finds all IDs are within the keep-set, and the DELETE deletes zero rows. The `idx_channel_messages_channel_created` covering index makes this fast, but it is still a non-trivial query executed on every single message event.
- Impact: On high-throughput channels (e.g., 3+ members actively exchanging messages), every message triggers an INSERT + a prune SELECT + a DELETE-of-nothing. The covering index mitigates this to microseconds, but the pattern is wasteful. At 500+ messages the prune becomes useful -- but the common path pays the cost every time.
- Fix: Guard with a modular check to skip pruning when unnecessary. For example, prune every Nth message:
  ```typescript
  // Prune only every 50th message to amortize cost
  const count = this.db.prepare(
    `SELECT COUNT(*) as c FROM channel_messages WHERE channel_id = ?`
  ).get(msg.channelId) as { c: number };
  if (count.c > SQLiteChannelRepository.MAX_MESSAGES_PER_CHANNEL) {
    this.pruneMessagesStmt.run(msg.channelId, msg.channelId, SQLiteChannelRepository.MAX_MESSAGES_PER_CHANNEL);
  }
  ```
  Alternatively, since `saveMessage` is best-effort and the 500 cap is generous, prune every 50th insert using a simple counter or modular check on `count.c % 50 === 0`.

### LOW

**`codePointSlice` uses `Array.from()` which allocates a full array of code points** - `src/services/channel-manager.ts:108`
**Confidence**: 80%
- Problem: `Array.from(str).slice(0, maxCodePoints).join('')` creates a temporary array of all code points in `str` to extract the first 200. For large agent outputs (which can be 10KB+), this allocates a large array only to discard most of it.
- Impact: This runs once per routed message, not in a tight loop. With a 200-codepoint cap, even large strings produce small output. The allocation cost is bounded by the input size, which is capped by tmux buffer sizes. In practice, this is a micro-optimization -- LOW severity.
- Fix: Use an iterator-based approach that stops after `maxCodePoints`:
  ```typescript
  function codePointSlice(str: string, maxCodePoints: number): string {
    let result = '';
    let count = 0;
    for (const cp of str) {
      if (count >= maxCodePoints) break;
      result += cp;
      count++;
    }
    return result;
  }
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Dynamic SQL in `findMembersByChannelIds` creates a new prepared statement on every call** - `src/implementations/channel-repository.ts:463-464`
**Confidence**: 85%
- Problem: `this.db.prepare(...)` is called inside `findMembersByChannelIds` on every invocation of `findAll()` or `findByStatus()`. Unlike all other queries in this repository (which are prepared once in the constructor and reused), this builds a new SQL string and compiles a new statement on every dashboard poll tick. better-sqlite3's `prepare()` compiles the SQL, which is measurably more expensive than executing a pre-compiled statement.
- Impact: The dashboard polls every 1 second. Each poll that fetches channels calls `prepare()` with a dynamically-sized IN clause. SQLite must parse and compile the statement each time. With 10-50 channels, this adds measurable overhead compared to a cached statement approach.
- Fix: Cache prepared statements by arity (the number of placeholders). Since the ID list is bounded by DEFAULT_LIMIT (100), there are at most 100 unique statement shapes:
  ```typescript
  private readonly membersByIdsStmtCache = new Map<number, SQLite.Statement>();

  private findMembersByChannelIds(ids: readonly string[]): Map<string, ChannelMemberRow[]> {
    const arity = ids.length;
    let stmt = this.membersByIdsStmtCache.get(arity);
    if (!stmt) {
      const placeholders = ids.map(() => '?').join(', ');
      stmt = this.db.prepare(
        `SELECT * FROM channel_members WHERE channel_id IN (${placeholders}) ORDER BY joined_at ASC`
      );
      this.membersByIdsStmtCache.set(arity, stmt);
    }
    const memberRows = stmt.all(...ids) as ChannelMemberRow[];
    // ... rest unchanged
  }
  ```

**Multiple `data?.channels.find()` linear scans in the render path** - `src/cli/dashboard/app.tsx:159,195` and `src/cli/dashboard/views/detail-view.tsx:172` and `src/cli/dashboard/components/header.tsx:114`
**Confidence**: 80%
- Problem: When viewing a channel detail, `data.channels.find((c) => c.id === view.entityId)` is called independently in (1) `channelDetailSessionName` useMemo, (2) `detailEntityStatus` useMemo, (3) `buildBreadcrumb`, and (4) the `DetailView` render switch. Each is a separate O(n) scan over the channels array. This matches the existing pattern for other entity types (schedules/loops use the same pattern), but channels add a new entity type that compounds the issue.
- Impact: With the dashboard polling at 1Hz and channel lists bounded to 100 items, the absolute cost is small. However, the cumulative effect of 4 linear scans per render tick is asymptotically worse than a Map lookup. This mirrors a pre-existing pattern in the codebase (schedules and loops do the same), so it is a "Should Fix" rather than blocking.
- Fix: Consider building a `channelsById` Map in a single useMemo at the top of the component, then using O(1) lookups everywhere. This would benefit all entity types, not just channels.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**No `findUpdatedSince` on `ChannelRepository` — activity feed cannot filter recent channels efficiently** - `src/core/interfaces.ts:1019-1055`
**Confidence**: 85%
- Problem: All other entity repositories (tasks, loops, schedules, orchestrations, pipelines) expose a `findUpdatedSince(sinceMs, limit)` method used by the activity feed to fetch only recently-changed entities. ChannelRepository does not have this method, forcing the dashboard to pass the full channel list to `buildActivityFeed`. This is a pre-existing API gap from the Phase 7 channel implementation.
- Impact: Forces the workaround in `fetchMetricsExtras` (passing full list vs. recent-only). As channel volume grows, the activity feed sort processes more entries than necessary.

## Suggestions (Lower Confidence)

- **Capture-pane poll interval may be too aggressive at 3000ms for inactive sessions** - `src/cli/dashboard/use-channel-pane-preview.ts:15` (Confidence: 65%) -- The 3-second poll spawns a `tmux capture-pane` subprocess every 3 seconds per selected member. For idle sessions producing no output, this is wasted work. Consider increasing to 5-10 seconds or implementing a smarts-based backoff when content has not changed between polls.

- **Prune query passes `channel_id` twice as separate bind parameters** - `src/implementations/channel-repository.ts:384` (Confidence: 70%) -- The prune SQL `WHERE channel_id = ? AND id NOT IN (SELECT id FROM channel_messages WHERE channel_id = ? ...)` binds `msg.channelId` twice. SQLite's query planner handles this fine, but a CTE or single-bind approach would be cleaner: `DELETE FROM channel_messages WHERE channel_id = ? AND created_at < (SELECT created_at FROM channel_messages WHERE channel_id = ? ORDER BY created_at DESC LIMIT 1 OFFSET ?)`.

- **`idx_channel_messages_channel_id` index is redundant given `idx_channel_messages_channel_created`** - `src/implementations/database.ts:1276-1281` (Confidence: 72%) -- The composite index `(channel_id, created_at DESC)` can serve all queries that the single-column `(channel_id)` index serves, since channel_id is the leftmost column. The standalone index adds write overhead on every INSERT without providing unique query plan benefits.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 1 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Performance Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The branch handles the major performance concern well -- the N+1 query in `findAll`/`findByStatus` was resolved in cycle 1 (commit bcd2845) with batch member loading and a covering index for `getMessages`. The pruning mechanism prevents unbounded `channel_messages` growth (commit f6cdd94). The remaining issues are moderate: the dynamic `prepare()` on every poll tick, the full-channel-list pass to the activity feed (easily fixed with an inline filter), and the per-message prune overhead. None are blocking, but the dynamic `prepare()` and the activity feed filter should be addressed before this branch sees heavy channel usage.
