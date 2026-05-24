# Complexity Review Report

**Branch**: feat/181-channel-domain-persistence -> main
**Date**: 2026-05-24T12:06

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Duplicate prepared statement: `saveMemberStmt` and `addMemberStmt` are identical SQL** - `src/implementations/channel-repository.ts:109` and `src/implementations/channel-repository.ts:132`
**Confidence**: 95%
- Problem: Two separate prepared statements (`saveMemberStmt` at line 109-112 and `addMemberStmt` at line 132-135) contain identical SQL: `INSERT INTO channel_members (...) VALUES (...)`. Both are declared as separate `private readonly` fields, initialized separately in the constructor, and one is only used in `save()` (line 158) while the other is used in `addMember()` (line 231). This is unnecessary duplication that inflates the class field count (14 prepared statements instead of 13) and the constructor size.
- Fix: Remove `addMemberStmt` and reuse `saveMemberStmt` in both `save()` and `addMember()`:
  ```typescript
  // Remove line 95: private readonly addMemberStmt: SQLite.Statement;
  // Remove lines 132-135: this.addMemberStmt = this.db.prepare(...)
  // In addMember() at line 231, change:
  //   this.addMemberStmt.run(...)
  // to:
  //   this.saveMemberStmt.run(...)
  ```

**`createChannel` factory throws instead of returning Result -- inconsistent with project pattern** - `src/core/domain.ts:1093`
**Confidence**: 82%
- Problem: The `createChannel` factory function throws `AutobeatError` on invalid names (lines 1095, 1104), while all other factory functions in the same file (`createTask`, `createSchedule`, `createPipeline`, `createOrchestration`, `createLoop`) never throw. The project's CLAUDE.md and engineering principles state "Always use Result types" and "Never throw errors in business logic." This factory is the only one in domain.ts that throws (verified: only 2 throw statements in the entire 1140-line file, both in `createChannel`). This adds a hidden exception path that callers must know about, increasing cognitive complexity.
- Fix: Return `Result<Channel>` instead of throwing. Callers already handle Result types throughout the codebase:
  ```typescript
  export const createChannel = (request: ChannelCreateRequest): Result<Channel> => {
    if (!CHANNEL_NAME_REGEX.test(request.name)) {
      return err(new AutobeatError(
        ErrorCode.INVALID_INPUT,
        `Invalid channel name "${request.name}": must match ${CHANNEL_NAME_REGEX}`,
      ));
    }
    // ... member validation similarly returns err(...)
    return ok(Object.freeze({ ... }));
  };
  ```

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Constructor length (46 lines, 14 prepared statements)** - `src/implementations/channel-repository.ts:101` (Confidence: 65%) -- The constructor at 46 lines is within the warning range (30-50) and has 14 prepared statements as fields. Other repo constructors in the codebase follow the same pattern at similar scale (schedule-repository: 739 lines, loop-repository: 821 lines), so this is consistent. Removing the duplicate `addMemberStmt` would bring it to 13 fields and ~42 lines. Not blocking but worth noting as this pattern does not scale well.

- **N+1 member loading in `rowToChannel`** - `src/implementations/channel-repository.ts:311` (Confidence: 70%) -- Each call to `rowToChannel` issues a separate query for members via `findMembersByChannelIdStmt`. When `findAll` or `findByStatus` returns N channels, this results in N+1 queries. The PR description acknowledges this as "N+1 member loading baseline (acceptable for Phase 6)". The performance test (50 channels x 3 members, <500ms) confirms it is currently acceptable.

- **Test file repetitive `if (!result.ok) throw` boilerplate (18 occurrences)** - `tests/unit/implementations/channel-repository.test.ts` (Confidence: 60%) -- The pattern `expect(result.ok).toBe(true); if (!result.ok) throw new Error('unexpected');` appears 18 times. A test helper like `expectOk(result)` would reduce noise and make tests more readable. However, this pattern is consistent with other test files in the project, so it is a codebase-wide style choice rather than a PR-specific issue.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Complexity Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The new code is well-structured with low cyclomatic complexity across all methods (all functions under 15 lines, nesting depth max 2, no complex boolean expressions). The repository follows existing codebase patterns closely. The two MEDIUM findings are: (1) a trivially removable duplicate prepared statement, and (2) `createChannel` being the sole factory function in domain.ts that throws instead of returning Result, which is inconsistent with the project's error-handling principles. Neither is blocking for merge, but both should be addressed.
