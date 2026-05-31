# Performance Review Report

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-28

## Issues in Your Changes (BLOCKING)

### CRITICAL
(none)

### HIGH
(none)

### MEDIUM

**findUpdatedSince hydrates members unnecessarily for activity feed** - `src/implementations/channel-repository.ts:380-388`
**Confidence**: 82%
- Problem: The new `findUpdatedSince` method calls `hydrateChannelRows()`, which fires a second IN-clause query to fetch all `channel_members` rows for the returned channels. However, the sole consumer of this method is `fetchMetricsExtras` in `use-dashboard-data.ts:324`, which passes channels to `buildActivityFeed()`. The activity feed only reads top-level fields (`id`, `status`, `updatedAt`, `currentRound`, `maxRounds`) and never accesses `members`. This means every 1-second main-view poll executes an extra member-hydration query whose results are immediately discarded.
- Impact: At 50 channels with 3 members each, this is an unnecessary ~150-row fetch plus Zod parsing and Object.freeze per row, repeated every second. With the current dashboard poll cadence (1Hz on main view), this adds up to meaningful overhead under sustained use.
- Fix: Add a lightweight `findUpdatedSinceShallow` (or a `hydrate: boolean` parameter) that skips member loading. The method would return channels with an empty `members: []` array, which is sufficient for the activity feed. Alternatively, the `hydrateChannelRows` call can be made conditional:
  ```typescript
  async findUpdatedSince(sinceMs: number, limit: number): Promise<Result<readonly Channel[]>> {
    return tryCatchAsync(
      async () => {
        const rows = this.findUpdatedSinceStmt.all(sinceMs, limit) as ChannelRow[];
        // Activity feed only needs top-level fields; skip member hydration.
        return rows.map((row) => this.rowToChannelWithMembers(row, []));
      },
      operationErrorHandler('find channels updated since', { sinceMs }),
    );
  }
  ```
  Note: this would require the interface to document that `findUpdatedSince` returns shallow Channel objects (members always `[]`). The same trade-off exists for other entity repositories (`findUpdatedSince` for tasks/loops/etc.), but those entities do not have sub-collections to hydrate.

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Additional DB round-trip vs. in-memory filter for channel activity** - `src/cli/dashboard/use-dashboard-data.ts:324` (Confidence: 68%) -- The prior implementation filtered the already-fetched `channels` list in memory (`channels.filter(c => ... >= since1h)`). The new implementation issues a separate `findUpdatedSince` DB query. For a bounded dataset (max 100 channels from `findAll`), the in-memory filter was O(n) with no I/O. The new indexed query is consistent with other entity types but adds one more DB call per poll tick. Net effect is minimal given SQLite in-process locality.

- **Zod validation on every row conversion during 1Hz polling** - `src/implementations/channel-repository.ts:553` (Confidence: 62%) -- `rowToChannelWithMembers` calls `ChannelRowSchema.parse(row)` for every channel row on every poll tick. Zod parsing is not free. For the dashboard's hot path (1-second polling), this could be optimized with `.safeParse` only in debug mode or by using direct field mapping for trusted internal data. This is pre-existing and applies to all entity repositories, not specific to this PR.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Performance Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The performance profile of this PR is solid overall. Key improvements include:
- Replacing the generic `unwrapAll` + positional cast pattern with direct destructuring (zero runtime change, better type flow)
- Replacing in-memory channel filtering with a proper indexed query (`idx_channels_updated_at`) for consistency with other entities
- Wrapping `saveMessage` INSERT + prune in a single transaction (prevents double-pruning race)
- Prepared statement caching with bounded eviction in `findMembersByChannelIds`

The one MEDIUM finding (unnecessary member hydration in `findUpdatedSince`) is real but bounded: at most 50 channels x 3 members = ~150 extra rows per second. It should be addressed before the channel count grows, but does not block merge.

Cross-cycle note: "COUNT per save (intentional)" and "batch pruning (intentional)" from cycle 3 are acknowledged as intentional design choices and not re-raised here.
