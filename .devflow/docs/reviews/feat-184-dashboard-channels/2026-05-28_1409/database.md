# Database Review Report

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-28T14:09

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Redundant index idx_channel_messages_channel_id** - `src/implementations/database.ts:1276`
**Confidence**: 85%
- Problem: Migration v32 creates `idx_channel_messages_channel_id ON channel_messages(channel_id)` as a single-column index, but `idx_channel_messages_channel_created ON channel_messages(channel_id, created_at DESC)` (line 1280) and `idx_channel_messages_channel_round ON channel_messages(channel_id, round DESC)` (line 1278) both have `channel_id` as their leading column. Any query filtering only by `channel_id` can use either composite index. The standalone single-column index is redundant and adds write overhead on every INSERT/DELETE.
- Fix: Remove the `idx_channel_messages_channel_id` index from migration v32. The two composite indexes already cover all `channel_id`-only lookups.
- Note: Migration v32 is pre-existing (not modified in this PR). Flagging as Blocking because it was introduced in this feature epic (Phase 9, epic #184) and the table has not shipped to production yet -- cleaning it up now is free. If it had already shipped, this would be informational only.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Test creates unused variable -- does not actually test the stated behavior** - `tests/unit/implementations/channel-repository.test.ts:496`
**Confidence**: 95%
- Problem: The test "returns empty array when no channels match the time window" at line 495-502 creates `const ch = buildChannel({ name: 'old-only' })` but never calls `await repo.save(ch)`. The channel is never persisted to the database, so the test is actually verifying "empty DB returns empty array" rather than "channel exists but falls outside the time window." The test title is misleading and the variable `ch` is dead code.
- Fix: Either save the channel and use a far-future cutoff (as intended), or remove the unused variable and rename the test:
```typescript
it('returns empty array when no channels match the time window', async () => {
  const ch = buildChannel({ name: 'old-only' });
  await repo.save(ch);
  // Use a far-future cutoff so nothing qualifies
  const result = await repo.findUpdatedSince(Date.now() + 100_000, 50);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('unexpected');
  expect(result.value).toHaveLength(0);
});
```

## Pre-existing Issues (Not Blocking)

_No pre-existing database issues found._

## Suggestions (Lower Confidence)

- **findUpdatedSince hydrates all members per poll tick** - `src/implementations/channel-repository.ts:383` (Confidence: 65%) -- `findUpdatedSince` calls `hydrateChannelRows` which batch-loads all members via IN-clause. For the activity feed use case (only needs channel name, status, timestamp), member data is fetched but likely unused. At current scale this is fine, but if channels grow to many members or the poll frequency increases, a lightweight query returning only channel rows (no member hydration) could reduce unnecessary work. All other repos (task, pipeline, etc.) do not have this N+1-avoidance overhead because they lack child entities.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Database Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

Conditions:
1. Fix the unused variable in `findUpdatedSince` test (Should Fix -- misleading test behavior)
2. Consider removing redundant `idx_channel_messages_channel_id` index from migration v32 while still pre-production

Positive observations:
- `findUpdatedSince` follows the established pattern from all other entity repos (task, pipeline, loop, schedule, orchestration) -- consistent query shape, prepared statement caching, and index-backed WHERE + ORDER BY. The `idx_channels_updated_at` index from migration v31 covers this query.
- `saveMessage` atomicity improvement wrapping INSERT + COUNT + conditional DELETE in a single `db.transaction()` is correct and prevents double-pruning race conditions.
- `getMessages` limit clamping fix (`Math.max(1, Math.min(...))`) properly prevents zero/negative/Infinity limits from reaching SQLite.
- Statement cache eviction guard in `findMembersByChannelIds` is well-bounded (applies ADR-001 -- channel names constrained to tmux SESSION_NAME_REGEX, which bounds member count indirectly).
- The dashboard data refactor replacing `unwrapAll` + positional type casts with destructured `Promise.all` results and individual error checks eliminates the unsafe `as` cast chain and provides better error labels.
- Exhaustive `never` guards in `cancelEntity` and `deleteEntity` (avoids PF-004 -- ensures all entity kinds handle rollback/cleanup).
- FK CASCADE on `channel_messages.channel_id` correctly removes orphaned messages when a channel is deleted (tested in T15 cascade test).
- All new queries use parameterized statements (no SQL injection risk).
