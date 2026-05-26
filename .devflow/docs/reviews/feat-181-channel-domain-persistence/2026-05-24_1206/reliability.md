# Reliability Review Report

**Branch**: feat/181-channel-domain-persistence -> main
**Date**: 2026-05-24

## Issues in Your Changes (BLOCKING)

### HIGH

**No upper-bound assertion on `maxRounds`** - `src/core/domain.ts:1089`
**Confidence**: 85%
- Problem: `ChannelCreateRequest.maxRounds` is an optional `number` with no upper-bound validation in `createChannel()`. A caller could pass `maxRounds: Number.MAX_SAFE_INTEGER` or even `Infinity`. While `maxRounds` is not directly used in a loop inside this PR, it establishes the contract for the round-advancement engine that will consume it in a later phase. Without an assertion now, the future consumer inherits an unbounded iteration ceiling. The DB column has no CHECK constraint either (`max_rounds INTEGER` -- no `CHECK(max_rounds > 0 AND max_rounds <= N)`).
- Fix: Add a precondition assertion in `createChannel` and a corresponding DB CHECK constraint:
```typescript
// In createChannel:
if (request.maxRounds !== undefined) {
  if (request.maxRounds < 1 || request.maxRounds > 10_000) {
    throw new AutobeatError(
      ErrorCode.INVALID_INPUT,
      `maxRounds must be between 1 and 10000, got ${request.maxRounds}`,
    );
  }
}
```
```sql
-- In migration v31:
max_rounds INTEGER CHECK(max_rounds IS NULL OR (max_rounds > 0 AND max_rounds <= 10000)),
```

**No upper-bound assertion on `updateRound` input** - `src/implementations/channel-repository.ts:219`
**Confidence**: 82%
- Problem: `updateRound(id, round)` accepts any `number` for `round` -- negative values, zero, `NaN`, or values exceeding `maxRounds`. The repository blindly writes this to the database. A future round-advancement engine calling `updateRound` with an off-by-one or runaway counter would produce data corruption silently. This is the reliability equivalent of an unbounded loop -- the round counter has no ceiling enforcement.
- Fix: Add a precondition check at the repository boundary or in the future handler that advances rounds. At minimum, the repository should reject non-positive values:
```typescript
async updateRound(id: ChannelId, round: number): Promise<Result<void>> {
  return tryCatchAsync(
    async () => {
      if (!Number.isInteger(round) || round < 0) {
        throw new AutobeatError(ErrorCode.INVALID_INPUT, `round must be a non-negative integer, got ${round}`);
      }
      this.updateRoundStmt.run(round, Date.now(), id);
    },
    operationErrorHandler('update channel round', { channelId: id, round }),
  );
}
```

### MEDIUM

**N+1 member loading in `findAll` and `findByStatus` -- acknowledged but unbounded for large result sets** - `src/implementations/channel-repository.ts:189-208`
**Confidence**: 80%
- Problem: `findAll` and `findByStatus` fetch N channel rows, then for each row call `rowToChannel()` which issues a separate `findMembersByChannelIdStmt` query per channel. With `DEFAULT_LIMIT = 100` channels and (say) 5 members each, that is 101 SQLite queries per call. The commit message acknowledges this as "N+1 member loading baseline (acceptable for Phase 6)" which is fair for an initial phase. However, the `DEFAULT_LIMIT` of 100 means the N+1 cost scales linearly without a tighter cap.
- Fix: This is already flagged as a known baseline. Consider lowering `DEFAULT_LIMIT` to 50 (matching the performance test baseline) or documenting the expected maximum channel count as a design bound. A JOIN-based approach or batch member fetch (`WHERE channel_id IN (...)`) would eliminate the N+1 entirely when scaling becomes necessary.

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Silent success on update of non-existent entity** - `src/implementations/channel-repository.ts:210-226` (Confidence: 65%) -- `updateStatus`, `updateRound`, and `updateMemberStatus` return `ok(undefined)` even when the target row does not exist (SQLite UPDATE with no matching rows returns `changes: 0`). This is consistent with other repositories in the codebase (loop-repository, task-repository) so it follows the established pattern, but it means callers cannot distinguish "updated successfully" from "no such channel."

- **Migration v31 omits `IF NOT EXISTS` on `CREATE TABLE`** - `src/implementations/database.ts:1231` (Confidence: 60%) -- Most migrations creating new tables use `IF NOT EXISTS` for idempotency. Migration v31 uses bare `CREATE TABLE channels`. This is safe because the migration system tracks versions and never re-runs applied migrations, but it differs from the majority pattern (v1, v4, v5, v9, v10, v14, v19, v24 all use `IF NOT EXISTS`).

- **`createChannel` throws instead of returning Result** - `src/core/domain.ts:1093` (Confidence: 62%) -- The global CLAUDE.md principle states "Never throw in business logic" and "Return Result types for all fallible operations." However, every other factory function in domain.ts (`createTask`, `createSchedule`, `createLoop`, `createOrchestration`, `createPipeline`) also throws directly. This is a consistent project-level pattern -- the factories are called at boundaries where callers catch via `tryCatchAsync`. Not a deviation from project conventions, even if it deviates from the stated principle.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Reliability Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The code follows bounded iteration patterns (DEFAULT_LIMIT caps pagination, transactions protect atomicity, Zod validates at boundaries). The main reliability gap is the absence of upper-bound assertions on `maxRounds` and `updateRound`, which establishes an unbounded contract for the round-advancement engine in a future phase. Fixing these preconditions now is significantly cheaper than retrofitting them after consumers exist. The N+1 member loading is acknowledged and acceptable for Phase 6.
