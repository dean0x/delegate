# Architecture Review Report

**Branch**: feat/181-channel-domain-persistence -> main
**Date**: 2026-05-24

## Issues in Your Changes (BLOCKING)

### HIGH

**Duplicate prepared statement: saveMemberStmt and addMemberStmt are identical** - `src/implementations/channel-repository.ts:109,132`
**Confidence**: 95%
- Problem: `saveMemberStmt` (line 109) and `addMemberStmt` (line 132) contain identical SQL. Two prepared statements occupy memory and add maintenance surface for the same operation. This violates SRP at the statement level -- one reason to change (the INSERT SQL) is duplicated across two fields.
- Fix: Remove `addMemberStmt` and reuse `saveMemberStmt` in `addMember()`. Rename to `insertMemberStmt` for clarity.
```typescript
// Remove addMemberStmt field declaration and initialization entirely.
// In addMember(), use the existing saveMemberStmt:
async addMember(channelId: ChannelId, member: ChannelMember): Promise<Result<void>> {
  return tryCatchAsync(
    async () => {
      this.saveMemberStmt.run(this.memberToDbFormat(channelId, member));
    },
    operationErrorHandler('add channel member', { channelId, memberName: member.name }),
  );
}
```

**Missing exclude for channel-repository.test.ts in test:implementations script** - `package.json:31`
**Confidence**: 95%
- Problem: `test:repositories` explicitly lists `channel-repository.test.ts`, but `test:implementations` does not exclude it. Every other repository test file listed in `test:repositories` is excluded from `test:implementations` to prevent double-running. This test will run in both groups, wasting CI time and creating confusing double-failure scenarios.
- Fix: Add `--exclude='**/channel-repository.test.ts'` to the `test:implementations` script, matching the pattern of all other repository test exclusions.
```json
"test:implementations": "NODE_OPTIONS='--max-old-space-size=2048' vitest run tests/unit/implementations --exclude='**/dependency-repository.test.ts' --exclude='**/task-repository.test.ts' --exclude='**/database.test.ts' --exclude='**/checkpoint-repository.test.ts' --exclude='**/output-repository.test.ts' --exclude='**/worker-repository.test.ts' --exclude='**/loop-repository.test.ts' --exclude='**/channel-repository.test.ts' --exclude='**/tmux/**' --no-file-parallelism",
```

### MEDIUM

**N+1 member loading in rowToChannel acknowledged but undocumented in code** - `src/implementations/channel-repository.ts:309-312`
**Confidence**: 82%
- Problem: `rowToChannel` executes a separate `findMembersByChannelIdStmt` query per channel row. In `findAll` and `findByStatus`, this creates N+1 queries (1 for channels + N for members). The commit message acknowledges this as "acceptable for Phase 6" but there is no code-level `@design` or `ARCHITECTURE:` comment documenting this known trade-off and the conditions under which it should be revisited. Future maintainers may not read commit messages.
- Fix: Add an architecture comment on the method:
```typescript
/**
 * Convert database row to Channel domain object with eager member loading.
 * ARCHITECTURE: N+1 pattern — each channel triggers a separate member query.
 * Acceptable for Phase 6 where channel counts are low. Revisit with JOIN-based
 * loading if findAll/findByStatus performance degrades at scale.
 */
private rowToChannel(row: ChannelRow): Channel {
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**createChannel factory throws instead of returning Result** - `src/core/domain.ts:1093-1132`
**Confidence**: 80%
- Problem: `createChannel` throws `AutobeatError` on invalid input (lines 1095, 1104). The project's CLAUDE.md engineering principles state "Always use Result types - Never throw errors in business logic." However, this follows the established pattern of ALL other domain factory functions (`createTask`, `createSchedule`, `createLoop`, `createOrchestration`, `createPipeline`) which also throw. This is a pre-existing architectural choice, not a deviation introduced by this PR. Flagging as should-fix because the channel factories are new code being added to a pattern that conflicts with stated principles.
- Fix: No action required for this PR -- the factory-throws pattern is established and consistent. If the project decides to migrate factories to Result types, all factories should be migrated together. (avoids PF-001 -- surfacing rather than deferring)

## Pre-existing Issues (Not Blocking)

No pre-existing architectural issues identified in the reviewed files.

## Suggestions (Lower Confidence)

- **updateChannel does not re-freeze members array** - `src/core/domain.ts:1134-1140` (Confidence: 65%) -- If `updates` includes a `members` array, the spread produces a top-level frozen object but the members array itself is not re-frozen. TypeScript's `readonly` provides compile-time safety, and `Object.freeze` in `createChannel` is defense-in-depth, but `updateChannel` does not maintain this invariant.

- **ChannelRepository lacks a general update(channel) method** - `src/core/interfaces.ts:1017-1030` (Confidence: 62%) -- The interface has granular update methods (`updateStatus`, `updateRound`, `updateMemberStatus`) but no `update(channel: Channel)` for multi-field atomic updates (e.g., changing name + topic + communicationMode together). This may need addition when channel management features are built in later phases.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Architecture Score**: 8/10
**Recommendation**: CHANGES_REQUESTED

The architecture follows established patterns well -- branded types, repository pattern with DI, Zod boundary validation, immutable domain objects, event-driven lifecycle, and transactional saves. The two HIGH issues (duplicate prepared statement and missing test exclusion) are straightforward fixes. The overall design is clean, consistent with the existing codebase, and appropriate for a Phase 6 primitives PR.
