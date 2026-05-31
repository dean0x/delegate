# Database Review Report

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-27

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

### MEDIUM

**channel_messages table has no FK constraint on from_member to channel_members** - `src/implementations/database.ts:1267-1276`
**Confidence**: 82%
- Problem: The `channel_messages.from_member` column is a free-text string with no foreign key relationship to `channel_members(channel_id, name)`. This means messages can reference members that do not exist (e.g., if the event carries a typo or an external sender name like `"external"`). The `"external"` sender case is intentional (seen in `channel-manager.ts:461` — `from: 'external'`), so a strict FK would break the current design.
- Fix: This is an intentional design trade-off rather than an oversight. The `from_member` field serves as a display label, not a relational key. The `ChannelMessagePersistenceHandler` already validates the event shape via the `ChannelMessageSentEvent` type, and the Zod `ChannelMessageRowSchema` validates `from_member` is a non-empty string on read. No FK is needed given the "external" sender pattern, but document this decision with a migration comment. Consider adding a `-- NOTE: from_member is not FK'd to channel_members because external senders (e.g. 'external') are valid.` comment in the migration SQL.

**N+1 query pattern in rowToChannel applied to channel_messages via getMessages polling** - `src/implementations/channel-repository.ts:426-428`
**Confidence**: 80%
- Problem: The documented N+1 pattern in `rowToChannel` (each channel row triggers a separate member query) is inherited from Phase 6 and is pre-existing. However, this PR adds `channelRepository.findAll(FETCH_LIMIT)` to the dashboard's 1Hz polling loop (`use-dashboard-data.ts:214`). With 100 channels, this means 101 queries per second on the main polling path. The original comment acknowledges this and defers optimization.
- Fix: This is a known, documented trade-off (the `N+1 LOAD` comment on line 420 of channel-repository.ts explicitly calls it out). The dashboard's FETCH_LIMIT bounds the impact. For channels specifically, the typical count is much lower than 100. No immediate action needed, but monitor if channel usage grows. A batch IN-clause fetch for members would collapse to 2 queries.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**channel_messages summary column has no length constraint at the DB level** - `src/implementations/database.ts:1271`
**Confidence**: 83%
- Problem: The `summary` column is `TEXT NOT NULL` without a CHECK constraint on length. The application layer truncates to 200 code points via `codePointSlice(message, 200)` in `channel-manager.ts:107-108`, and the Zod schema validates non-empty on read. However, if a code path bypasses the service layer and inserts directly (e.g., migration backfill, manual SQL), an arbitrarily large summary could be stored. This contrasts with the defense-in-depth CHECK constraints used elsewhere (e.g., status enums in migrations v2, v3, v4, v10, v22).
- Fix: Add a CHECK constraint on the summary column: `summary TEXT NOT NULL CHECK(LENGTH(summary) <= 1000)`. Using 1000 (not 200) provides headroom for the 200-codepoint limit (worst case: 4 bytes per codepoint = 800 bytes, well within 1000 characters measured by SQLite's LENGTH which counts characters). This follows the defense-in-depth pattern used throughout the codebase. However, given that summary writes are exclusively driven by the event handler which always applies `codePointSlice`, this is a moderate-priority improvement.

### LOW

**channel_messages lacks an index on created_at for time-window pruning** - `src/implementations/database.ts:1276-1279`
**Confidence**: 80%
- Problem: The table has `idx_channel_messages_channel_id` and `idx_channel_messages_channel_round` but no standalone `created_at` index. If a future maintenance task needs to prune old messages globally (e.g., `DELETE FROM channel_messages WHERE created_at < ?`), it would require a full table scan. Other entities (task_usage, loops, schedules, orchestrations) have `created_at` or `updated_at` indexes for similar time-window operations (migrations v19, v20).
- Fix: Not blocking — the current access pattern (fetch by channel_id with LIMIT) is well-served by the existing compound index. Add a standalone `created_at` index when a pruning mechanism is implemented.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**channel_members lacks ON DELETE action specification for channel_id FK** - `src/implementations/database.ts:1244`
**Confidence**: 85%
- Problem: In migration v31, `channel_members` has `REFERENCES channels(id) ON DELETE CASCADE` which is correct. However, the `channel_messages` table in migration v32 also has `ON DELETE CASCADE` for the channel_id FK. This is correct and consistent. No issue here upon closer inspection.

**No `findUpdatedSince` method on ChannelRepository for activity feed** - `src/implementations/channel-repository.ts` (pre-existing interface gap)
**Confidence**: 82%
- Problem: All other entity repositories (task, loop, schedule, orchestration, pipeline) have a `findUpdatedSince(sinceMs, limit)` method used by the activity feed to fetch only recently-changed entities. The channel repository does not. The PR works around this by passing the full `channels` array (already fetched from `findAll`) into `fetchMetricsExtras` (`use-dashboard-data.ts:304`). This means the activity feed includes all channels, not just recently updated ones, which could include stale entries that were updated days ago. With 100 channels max, this is unlikely to cause a visible issue, but it is an inconsistency.
- Fix: Add `findUpdatedSince(sinceMs: number, limit: number)` to `ChannelRepository` interface and implementation in a follow-up PR. Use the existing `idx_channels_updated_at` index (created in migration v31) which already supports this query pattern efficiently.

## Suggestions (Lower Confidence)

- **Message ID generation uses `crypto.randomUUID()` with `cm-` prefix** - `src/services/handlers/channel-message-persistence-handler.ts:90` (Confidence: 65%) — The `cm-` prefix is a good practice for distinguishing message IDs from other entity IDs, but the ID format differs from the `ChannelId` branded type pattern used elsewhere. Consider whether a branded `ChannelMessageId` type would be beneficial for type safety.

- **`toMember` domain/DB mapping asymmetry** - `src/services/handlers/channel-message-persistence-handler.ts:93` (Confidence: 70%) — `event.to === 'all'` maps to `null` in the persistence handler, but the domain type `ChannelMessage.toMember` is `string | null`. This is documented in the type definition comment ("null = broadcast") and consistently handled in both the handler and the row converter. The asymmetry between event format (`'all'` string) and domain format (`null`) is a deliberate mapping but could benefit from a named constant.

- **Activity feed passes all channels instead of recently-updated ones** - `src/cli/dashboard/use-dashboard-data.ts:368` (Confidence: 75%) — See pre-existing issue above about missing `findUpdatedSince`. The workaround is functionally correct but semantically different from the other entity types.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | - | - | 1 | 1 |
| Pre-existing | - | - | 1 | - |

**Database Score**: 8/10

The migration v32 is clean, safe, and follows established patterns (CREATE TABLE IF NOT EXISTS, appropriate indexes, FK with ON DELETE CASCADE). The channel repository correctly uses prepared statements, Zod boundary validation, parameterized queries (no SQL injection risk), and transactional saves. The `ChannelMessagePersistenceHandler` follows the best-effort event-driven pattern established by `UsageCaptureHandler`. The N+1 pattern in `rowToChannel` is documented and bounded. The main gaps are cosmetic (missing CHECK on summary length, missing `findUpdatedSince` for activity feed consistency). Applies ADR-001 (channel name validation compatibility is maintained). Avoids PF-004 (the `ChannelCreated` rollback in `channel-manager.ts:263-284` correctly deletes the DB record on emit failure, covering all three layers).

**Recommendation**: APPROVED
