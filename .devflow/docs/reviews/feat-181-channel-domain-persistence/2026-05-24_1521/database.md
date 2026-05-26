# Database Review Report

**Branch**: feat/181-channel-domain-persistence -> main
**Date**: 2026-05-24
**Diff range**: 676a57af..HEAD (4 commits)

## Issues in Your Changes (BLOCKING)

### HIGH

**N+1 member loading in `findAll` and `findByStatus`** - `src/implementations/channel-repository.ts:188,197`
**Confidence**: 90%
- Problem: Both `findAll` and `findByStatus` call `rowToChannel()` for each channel row, which internally issues a separate `findMembersByChannelIdStmt` query per channel (line 308). With 100 channels (the DEFAULT_LIMIT), this produces 101 queries (1 for channels + 100 for members). The performance test only validates 50 channels and passes, but this is a known N+1 pattern that scales linearly.
- Impact: The PR description and CLAUDE.md both acknowledge this as "N+1 member loading baseline (acceptable for Phase 6)". The test at line 662 confirms it runs under 500ms for 50x3 members, which is reasonable for in-process SQLite. However, the comment labeling this as a baseline should be in the repository code itself, not just in commit messages.
- Fix: Add a code comment at `rowToChannel` documenting the intentional N+1 baseline and the planned optimization path (e.g., batch member fetch with `WHERE channel_id IN (...)`). This makes the design decision discoverable for future maintainers:
  ```typescript
  /**
   * DESIGN DECISION: N+1 member loading — each rowToChannel issues a separate
   * findMembersByChannelIdStmt query. Acceptable for Phase 6 baseline; channels
   * are bounded by DEFAULT_LIMIT=100 and typical usage is single-digit channels.
   * Optimize to batch IN-clause fetch if findAll/findByStatus become hot paths.
   */
  private rowToChannel(row: ChannelRow): Channel {
  ```

### MEDIUM

**No CHECK constraint on `max_rounds` in migration v31** - `src/implementations/database.ts:1237`
**Confidence**: 85%
- Problem: The `max_rounds` column is defined as `INTEGER` with no CHECK constraint, while the domain documents a `1-10000` range (see `ChannelCreateRequest.maxRounds` JSDoc at `src/core/domain.ts:1113-1116`). The `createChannel` factory explicitly defers validation to callers, and `updateRound` has a runtime precondition check, but `max_rounds` itself has no database-level guard against negative values, zero, or values above 10000.
- Impact: If a caller bypasses the service boundary and writes directly to the database (e.g., a migration script, direct SQL), invalid `max_rounds` values can be persisted. The `current_round` column also lacks a CHECK for `>= 0`, though the `updateRound` method validates this at runtime.
- Fix: Add a CHECK constraint to the migration:
  ```sql
  max_rounds INTEGER CHECK(max_rounds IS NULL OR (max_rounds >= 1 AND max_rounds <= 10000)),
  current_round INTEGER NOT NULL DEFAULT 0 CHECK(current_round >= 0),
  ```
  Note: Since this is migration v31 and not yet released (applies PF-002 -- no backward-compat for unreleased features), the migration can be modified directly.

**`updateRound` precondition throws inside `tryCatchAsync` instead of returning `Result.err`** - `src/implementations/channel-repository.ts:216-218`
**Confidence**: 82%
- Problem: The `updateRound` method throws an `Error` inside the `tryCatchAsync` wrapper for invalid round values. While `tryCatchAsync` catches this and wraps it in a Result error, the thrown error is a plain `Error`, not an `AutobeatError`. The `operationErrorHandler` will wrap it, but the error message and code may not match what callers expect from a domain validation failure. This is inconsistent with the project convention (CLAUDE.md: "Never throw errors in business logic" and "Return Result types for all fallible operations").
- Impact: The error propagation works correctly (tryCatchAsync catches the throw), but the error code will be `OPERATION_FAILED` rather than `INVALID_INPUT`. Callers checking for specific error codes will not identify this as a validation error.
- Fix: Return an explicit Result error before the `tryCatchAsync` block:
  ```typescript
  async updateRound(id: ChannelId, round: number): Promise<Result<void>> {
    if (!Number.isInteger(round) || round < 0) {
      return Result.err(
        new AutobeatError(
          ErrorCode.INVALID_INPUT,
          `updateRound: round must be a non-negative integer, got ${round}`,
        ),
      );
    }
    return tryCatchAsync(
      async () => {
        this.updateRoundStmt.run(round, Date.now(), id);
      },
      operationErrorHandler('update channel round', { channelId: id, round }),
    );
  }
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Zod schema status enum values are duplicated as string literals** - `src/implementations/channel-repository.ts:35,50`
**Confidence**: 82%
- Problem: The `ChannelRowSchema` uses `z.enum(['active', 'paused', 'completed', 'destroyed'])` and `ChannelMemberRowSchema` uses `z.enum(['active', 'idle', 'destroyed'])` as raw string arrays, while the domain now has `ChannelStatus` and `ChannelMemberStatus` enums. If the enum values are updated in the domain, the Zod schemas must be updated separately, creating a drift risk.
- Impact: A new status value added to the enum but not to the Zod schema would cause Zod validation to reject valid database rows. Conversely, a typo in the Zod schema would silently pass until hit at runtime.
- Fix: Derive the Zod enum from the TypeScript enum values:
  ```typescript
  const channelStatusValues = Object.values(ChannelStatus) as [string, ...string[]];
  const channelMemberStatusValues = Object.values(ChannelMemberStatus) as [string, ...string[]];
  
  // In ChannelRowSchema:
  status: z.enum(channelStatusValues),
  
  // In ChannelMemberRowSchema:
  status: z.enum(channelMemberStatusValues),
  ```

**`rowToChannel` casts `validated.status as ChannelStatus` after Zod validation** - `src/implementations/channel-repository.ts:317`
**Confidence**: 80%
- Problem: After Zod validation confirms `status` is one of `['active', 'paused', 'completed', 'destroyed']`, the code casts it with `as ChannelStatus`. Similarly `rowToMember` casts `as ChannelMemberStatus` (line 333) and `as AgentProvider` (line 330). The Zod schema already narrows the type, but the cast bypasses TypeScript's type system rather than letting the inference flow through. If the Zod schema is derived from the enums (as suggested above), the casts become unnecessary.
- Impact: Minor type safety concern. The `as` cast is not dangerous given the Zod validation, but it masks any future drift between the Zod schema and the domain enum.
- Fix: If the Zod schemas derive from the enum values, the `.parse()` return type already matches, and the `as` cast can be removed.

## Pre-existing Issues (Not Blocking)

No critical pre-existing database issues found in the reviewed files.

## Suggestions (Lower Confidence)

- **Missing `updated_at` update in `updateMemberStatus`** - `src/implementations/channel-repository.ts:241` (Confidence: 70%) -- The `updateMemberStatus` method updates the member's status but does not update the parent channel's `updated_at` timestamp. If callers rely on `updated_at` to detect channel-level changes (e.g., for polling or caching), member status changes would be invisible. This may be intentional if member status is considered a separate concern.

- **No `tmux_session` uniqueness constraint across channels** - `src/implementations/database.ts:1244-1253` (Confidence: 65%) -- The `tmux_session` column in `channel_members` is NOT NULL but has no UNIQUE constraint. Two members in different channels could theoretically have the same `tmux_session` value. The derivation formula `beat-channel-{channelName}-{memberName}` combined with the UNIQUE channel name constraint makes this unlikely in practice, but a UNIQUE index on `tmux_session` would provide defense-in-depth. This applies ADR-001 (channel names are tmux-compatible by construction).

- **`addMember` does not verify parent channel exists** - `src/implementations/channel-repository.ts:225-231` (Confidence: 62%) -- The `addMember` method inserts directly into `channel_members` without first checking that the referenced `channelId` exists. The FK constraint will reject orphaned members, but the resulting error message from SQLite will be a generic constraint violation rather than a clear "channel not found" message.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Database Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The schema design is solid: proper FK with ON DELETE CASCADE, appropriate indexes (status, updated_at, channel_id, unique member name per channel), CHECK constraints on status and agent enums, and Zod boundary validation. The transactional save pattern and prepared statements are consistent with existing repository patterns. The main areas for improvement are: (1) documenting the intentional N+1 baseline in code, (2) adding a CHECK constraint on `max_rounds` while the migration is still unreleased (avoids PF-002), and (3) aligning the `updateRound` precondition with the Result pattern convention.
