# Database Review Report

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-28

## Issues in Your Changes (BLOCKING)

### MEDIUM

**getMessages limit accepts negative and NaN values** - `src/implementations/channel-repository.ts:414`
**Confidence**: 85%
- Problem: `Math.min(limit ?? 50, 500)` does not guard against negative or `NaN` limit values. `Math.min(-1, 500)` returns `-1`, which SQLite interprets as "return all rows" (depending on driver behavior). `Math.min(NaN, 500)` returns `NaN`, which will cause a SQLite bind error or undefined behavior.
- Fix: Clamp the effective limit to at least 0 (or 1) before passing to the prepared statement:
```typescript
const effectiveLimit = Math.max(
  1,
  Math.min(
    limit ?? SQLiteChannelRepository.DEFAULT_MESSAGE_LIMIT,
    SQLiteChannelRepository.MAX_MESSAGES_PER_CHANNEL,
  ),
);
```

**Prune statement: save + count + prune are not wrapped in a transaction** - `src/implementations/channel-repository.ts:383-402`
**Confidence**: 80%
- Problem: `saveMessage` performs three synchronous SQLite operations (INSERT, SELECT COUNT, DELETE) outside a transaction. If two concurrent `ChannelMessageSent` events fire for the same channel, both could read a count of 501, both execute the prune DELETE, and a double-prune could remove more messages than intended. In practice, the event handler is best-effort and channels are unlikely to hit exactly 500 concurrently, but for correctness the three operations should be atomic.
- Fix: Wrap in a `this.db.transaction()`:
```typescript
const saveAndPrune = this.db.transaction(() => {
  this.saveMessageStmt.run({ ... });
  const countRow = this.countMessagesStmt.get(msg.channelId) as { count: number };
  if (countRow.count > SQLiteChannelRepository.MAX_MESSAGES_PER_CHANNEL) {
    this.pruneMessagesStmt.run(msg.channelId, msg.channelId, SQLiteChannelRepository.MAX_MESSAGES_PER_CHANNEL);
  }
});
saveAndPrune();
```
This keeps the save + prune atomic and still allows the outer `tryCatchAsync` to handle errors. The best-effort try/catch around prune alone would no longer be needed since a transaction failure rolls back everything including the save.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Statement cache grows unbounded for arbitrary arity values** - `src/implementations/channel-repository.ts:484-491`
**Confidence**: 82%
- Problem: `membersByChannelIdsStmtCache` is a `Map<number, SQLite.Statement>` that caches a prepared statement per distinct arity (number of channel IDs). Although the comment correctly notes arity is bounded by DEFAULT_LIMIT (100), the cache itself has no upper bound. If the application somehow calls `findMembersByChannelIds` with varying arities (1, 2, 3, ..., 100), it will hold 100 prepared statements. This is benign in practice since dashboard polling uses a stable arity, but violates the reliability principle of explicit bounds. applies ADR-003 -- flagging as informational rather than blocking given the practical bound.
- Fix: Either add a size guard (`if (this.membersByChannelIdsStmtCache.size > 100) this.membersByChannelIdsStmtCache.clear()`) or document the implicit bound more explicitly. Low risk given DEFAULT_LIMIT constraint.

## Pre-existing Issues (Not Blocking)

_No critical pre-existing database issues found in the reviewed files._

## Suggestions (Lower Confidence)

- **Prune DELETE uses correlated subquery** - `src/implementations/channel-repository.ts:188-196` (Confidence: 65%) -- The prune statement uses `DELETE ... WHERE id NOT IN (SELECT id ... ORDER BY created_at DESC LIMIT ?)` which requires a correlated subquery scan. For large message counts this could be slow. An alternative would be `DELETE WHERE rowid < (SELECT rowid FROM channel_messages WHERE channel_id = ? ORDER BY created_at DESC LIMIT 1 OFFSET ?)`. However, with MAX=500 and pruning only beyond 500, this is unlikely to be a practical performance concern.

- **Migration v32 lacks CHECK constraint on `round`** - `src/implementations/database.ts:1267-1275` (Confidence: 62%) -- Other tables in the codebase (loops, loop_iterations) have CHECK constraints on numeric fields. The `channel_messages.round` column has no CHECK constraint to enforce `round >= 0`. The Zod schema (`z.number().int().nonnegative()`) catches this at the application layer, and adding a DB-level CHECK would be defense-in-depth consistent with the established pattern. Low impact since the Zod boundary validation already covers this.

- **No `updated_at` index on `channel_messages`** - `src/implementations/database.ts:1276-1281` (Confidence: 60%) -- The migration creates `idx_channel_messages_channel_created` covering `(channel_id, created_at DESC)` which is the right covering index for the `getMessages` query. However, the activity feed pattern used by other entities uses `updated_at` for time-window polling. Since `channel_messages` is append-only (no updates), `created_at` is correct and `updated_at` is not needed. No action required.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Database Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The migration v32 schema is well-designed: proper FK with ON DELETE CASCADE, appropriate indexes for the query patterns (channel_id, channel_id+round DESC, channel_id+created_at DESC), and consistent naming with the existing schema. The batch member loading optimization (replacing N+1 with a single IN-clause query) is a significant improvement, correctly implemented with statement caching by arity. The prune-with-count-guard pattern is sound. The Zod boundary validation on `ChannelMessageRowSchema` follows the established validate-at-boundary pattern.

Conditions for approval:
1. Fix the `getMessages` limit to guard against negative/NaN values (MEDIUM blocking)
2. Wrap save+count+prune in a transaction for atomicity (MEDIUM blocking)
