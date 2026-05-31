# Database Review Report

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-27

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

### MEDIUM

**Pruning statement comment says "best-effort" but exception propagates** - `src/implementations/channel-repository.ts:382-384`
**Confidence**: 85%
- Problem: The comment on line 382 says "Best-effort -- pruning failure does not fail the save" but both `saveMessageStmt.run()` and `pruneMessagesStmt.run()` execute inside the same `tryCatchAsync` closure. If the INSERT succeeds but the DELETE (prune) throws, the entire `tryCatchAsync` returns `err()`, causing the persistence handler to log a warning and report the save as failed -- even though the row was committed (better-sqlite3 auto-commits each statement). The message is saved but the caller sees a failure.
- Fix: Wrap the prune call in its own try/catch so a prune failure is logged but does not affect the save result:
```typescript
async saveMessage(msg: ChannelMessage): Promise<Result<void>> {
  return tryCatchAsync(
    async () => {
      this.saveMessageStmt.run({ /* ... */ });
      // Best-effort prune — isolated from the insert result
      try {
        this.pruneMessagesStmt.run(msg.channelId, msg.channelId, SQLiteChannelRepository.MAX_MESSAGES_PER_CHANNEL);
      } catch (pruneError) {
        // Swallow — pruning is best-effort
      }
    },
    operationErrorHandler('save channel message', { messageId: msg.id, channelId: msg.channelId }),
  );
}
```

**No test for pruning behavior (MAX_MESSAGES_PER_CHANNEL = 500)** - `src/implementations/channel-repository.ts:112,384`
**Confidence**: 82%
- Problem: The pruning logic that deletes messages beyond 500 per channel has no test coverage. If the prune SQL is wrong (e.g., it deletes the wrong rows, or doesn't fire at all), no test would catch it. The test suite covers save/get/cascade but not the retention limit.
- Fix: Add a focused test that inserts MAX_MESSAGES_PER_CHANNEL + N messages and asserts that only MAX_MESSAGES_PER_CHANNEL remain, with the oldest pruned. This can use a smaller constant (e.g., test against the actual 500 limit or monkey-patch the private static for test ergonomics).

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Dynamic SQL in findMembersByChannelIds creates a new prepared statement per call** - `src/implementations/channel-repository.ts:463-465` (Confidence: 65%) -- Each invocation of `findMembersByChannelIds` calls `this.db.prepare()` with a dynamically built IN-clause. Unlike the other queries in this repository (which prepare once in the constructor), this creates a new statement object on every `findAll`/`findByStatus` call. For the bounded DEFAULT_LIMIT of 100, the SQLite statement cache likely absorbs this, but it deviates from the repository's own pattern of pre-prepared statements. Consider caching prepared statements by placeholder count if this becomes a hot path.

- **Pruning subquery performance on large channel_messages** - `src/implementations/channel-repository.ts:178-187` (Confidence: 62%) -- The prune query uses `NOT IN (SELECT id ... ORDER BY created_at DESC LIMIT ?)` which on SQLite may not use the covering index `idx_channel_messages_channel_created` for the subquery's ORDER BY + LIMIT since the outer DELETE scans a different rowset. For 500 messages this is negligible, but if MAX_MESSAGES_PER_CHANNEL were ever raised significantly, the prune could benefit from `DELETE WHERE rowid IN (SELECT rowid ... ORDER BY created_at ASC LIMIT (count - max))` to leverage the index more directly. Current bound of 500 makes this a non-issue.

- **`from_member` and `to_member` have no FK to channel_members** - `src/implementations/database.ts:1268-1275` (Confidence: 70%) -- The `channel_messages` table references `channels(id)` via FK but `from_member`/`to_member` are free-text strings with no FK to `channel_members(name)`. This is likely intentional (messages persist after member destruction, and `to_member` can be NULL for broadcasts), but means orphaned member names accumulate without referential integrity. Documenting this as a conscious choice would clarify intent.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Database Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

## Conditions

1. Fix the prune error isolation (MEDIUM) so that the "best-effort" comment matches actual behavior.
2. Add a pruning test for the 500-message retention bound.

## Notes

**Cross-Cycle Awareness**: The N+1 query in `findAll`/`findByStatus` was resolved in Cycle 1 (commit bcd2845) via batch loading with `hydrateChannelRows`. The covering index `idx_channel_messages_channel_created` was also added in Cycle 1. The unbounded `channel_messages` growth was addressed via inline pruning (commit f6cdd94). All three prior resolutions are confirmed present and correctly implemented.

**Decision citations**:
- Migration v32 correctly uses a clean-break approach with no backward-compatibility scaffolding (avoids PF-002) -- channel_messages is a new table with zero existing data.
- The `findMembersByChannelIds` dynamic IN-clause uses parameterized placeholders (`ids.map(() => '?')`) -- no SQL injection risk. Values are bound as parameters, not interpolated.
- Schema design follows established migration patterns (versioned, idempotent via `IF NOT EXISTS`, transactional).
- `ON DELETE CASCADE` on `channel_id` FK ensures no orphan messages when channels are destroyed.
- Zod validation at the boundary (`ChannelMessageRowSchema.parse`) follows parse-don't-validate pattern for data coming out of the database.
