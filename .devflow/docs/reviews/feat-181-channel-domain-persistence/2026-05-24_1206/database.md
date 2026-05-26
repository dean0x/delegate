# Database Review Report

**Branch**: feat/181-channel-domain-persistence -> main
**Date**: 2026-05-24

## Issues in Your Changes (BLOCKING)

### HIGH

**Null-to-undefined mismatch in `communicationMode` conversion** - `src/implementations/channel-repository.ts:318`
**Confidence**: 95%
- Problem: `validated.communication_mode as CommunicationMode | undefined` does not convert `null` to `undefined`. When `communication_mode` is NULL in the database, the Zod schema validates it as `null`, and the `as` cast silently passes `null` through. The domain type `Channel.communicationMode` is `CommunicationMode | undefined` (optional property), not `CommunicationMode | null`. This means downstream code checking `channel.communicationMode === undefined` will get a false negative when the field is actually `null`. Other nullable fields in the same method (`topic`, `maxRounds`, `createdBy`) correctly use `?? undefined`.
- Fix: Apply the same `?? undefined` pattern used for other nullable fields:
```typescript
communicationMode: (validated.communication_mode as CommunicationMode | null) ?? undefined,
```

### MEDIUM

**Duplicate prepared statements: `saveMemberStmt` and `addMemberStmt`** - `src/implementations/channel-repository.ts:109-112,132-135`
**Confidence**: 90%
- Problem: `saveMemberStmt` (line 109) and `addMemberStmt` (line 132) contain identical SQL. This creates two prepared statement handles for the same query, wasting a small amount of memory and creating a maintenance risk where one could be updated without the other.
- Fix: Remove `addMemberStmt` and reuse `saveMemberStmt` in the `addMember` method, or vice versa. If the names serve a documentation purpose, keep one field and alias the reference:
```typescript
// Remove addMemberStmt declaration and initialization entirely
// In addMember method, use saveMemberStmt:
async addMember(channelId: ChannelId, member: ChannelMember): Promise<Result<void>> {
  return tryCatchAsync(
    async () => {
      this.saveMemberStmt.run(this.memberToDbFormat(channelId, member));
    },
    operationErrorHandler('add channel member', { channelId, memberName: member.name }),
  );
}
```

**Silent no-op on update of nonexistent channel/member (3 occurrences)** - `src/implementations/channel-repository.ts:210,219,237`
**Confidence**: 82%
- `updateStatus` (line 213), `updateRound` (line 222), `updateMemberStatus` (line 244)
- Problem: These update methods call `.run()` but do not check `result.changes` to verify a row was actually updated. If called with a nonexistent `ChannelId` or `memberName`, they silently return `ok(undefined)`, hiding the fact that nothing changed. Other repositories in this codebase (e.g., `task-repository.ts:384`, `loop-repository.ts:450`) check `.changes` for similar operations.
- Fix: Check `changes` and return an error when no rows matched:
```typescript
async updateStatus(id: ChannelId, status: ChannelStatus): Promise<Result<void>> {
  return tryCatchAsync(
    async () => {
      const result = this.updateStatusStmt.run(status, Date.now(), id);
      if (result.changes === 0) {
        throw new Error(`Channel not found: ${id}`);
      }
    },
    operationErrorHandler('update channel status', { channelId: id, status }),
  );
}
```
Apply the same pattern to `updateRound` and `updateMemberStatus`.

**`createChannel` factory throws instead of returning Result** - `src/core/domain.ts:1093-1132`
**Confidence**: 80%
- Problem: `createChannel` is the only factory function in `domain.ts` that uses `throw` (lines 1095, 1104). All other factories (`createTask`, `createSchedule`, `createLoop`, `createOrchestration`, `createPipeline`) do not throw. The project's engineering principles require Result types for fallible operations. While this is a domain factory (not a repository method), it introduces an inconsistency that callers must handle with try/catch rather than Result checking.
- Fix: Return `Result<Channel>` instead of throwing, or document this as an intentional precondition assertion (not a business logic failure path). The `CLAUDE.md` engineering principles state "Never throw in business logic" and "Return Result types for all fallible operations."

## Issues in Code You Touched (Should Fix)

### MEDIUM

**N+1 member loading in `findAll` and `findByStatus`** - `src/implementations/channel-repository.ts:192,204`
**Confidence**: 85%
- Problem: `findAll` and `findByStatus` fetch N channel rows, then `rowToChannel` (line 311) issues a separate `findMembersByChannelIdStmt` query for each row. With the DEFAULT_LIMIT of 100 channels, this means 101 queries. The commit message acknowledges this as "N+1 member loading baseline (acceptable for Phase 6)" and the performance test (50 channels, <500ms) passes, but the pattern should be documented with a code comment for future maintainers.
- Fix: Add an inline comment at the `rowToChannel` call site within `findAll`/`findByStatus` noting the acknowledged N+1 and when it should be addressed:
```typescript
// KNOWN: N+1 member loading — acceptable for Phase 6 (see commit 676a57a).
// If channel count grows, batch-load members with a single IN() query.
return rows.map((row) => this.rowToChannel(row));
```

## Pre-existing Issues (Not Blocking)

No pre-existing database issues identified.

## Suggestions (Lower Confidence)

- **Missing UNIQUE constraint on `channel_members.tmux_session`** - `src/implementations/database.ts:1250` (Confidence: 65%) -- Each tmux session name should be globally unique to prevent two members from claiming the same session. The `createChannel` factory derives session names deterministically from channel+member names, but `addMember` accepts arbitrary `tmuxSession` values. A UNIQUE index would enforce this at the database level.

- **Missing index on `channel_members.tmux_session`** - `src/implementations/database.ts:1244-1253` (Confidence: 60%) -- If future queries need to look up a member by tmux session name (e.g., crash recovery mapping a session back to its channel member), this column will require an index. Currently no query uses it, so this is speculative.

- **`channel_members.agent` CHECK constraint hardcodes provider list** - `src/implementations/database.ts:1248` (Confidence: 70%) -- The CHECK constraint `CHECK(agent IN ('claude', 'codex'))` is hardcoded while the Zod schema uses `AGENT_PROVIDERS_TUPLE` dynamically. If a new agent provider is added in the future, the CHECK constraint requires a new migration. This is consistent with migration v28 which already had to update the `loops.judge_agent` CHECK to remove 'gemini'. Not blocking because migrations are the intended mechanism for schema evolution.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 3 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Database Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The schema design is solid: proper FK with CASCADE delete, CHECK constraints, appropriate indexes for status and pagination queries, UNIQUE composite index for member name uniqueness within a channel. The repository follows established project patterns (prepared statements, Zod boundary validation, Result types, transactional save). The main blocking issue is the `null`-vs-`undefined` bug in `communicationMode` conversion which silently violates the domain type contract. The duplicate prepared statement and silent-no-op updates are medium-severity maintenance and correctness concerns that should be addressed while the code is new. The N+1 pattern is acknowledged in the commit message and acceptable for this phase.
