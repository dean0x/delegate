# Database Review Report

**Branch**: fix/git-integration -> main
**Date**: 2026-03-25

## Issues in Your Changes (BLOCKING)

No blocking issues found.

### Analysis Details

**Migration 12 (`src/implementations/database.ts:699-713`)**

The migration adds 3 nullable TEXT columns via `ALTER TABLE ADD COLUMN`:
- `loops.git_start_commit_sha` -- HEAD SHA at loop creation
- `loop_iterations.git_commit_sha` -- commit SHA after iteration changes
- `loop_iterations.pre_iteration_commit_sha` -- snapshot before iteration

This follows the safe migration pattern correctly:
- All new columns are nullable (instant operation, no table rewrite)
- No data backfill needed (new columns default to NULL for existing rows)
- No table lock risk
- Old columns (`git_base_branch`, `git_branch`) explicitly preserved with rationale comment
- Consistent with prior migrations (v11 used ALTER TABLE ADD COLUMN for `loop_iterations.git_branch`, `git_diff_summary`)

**Repository Layer (`src/implementations/loop-repository.ts`)**

- Zod schemas (`LoopRowSchema`, `LoopIterationRowSchema`) updated with `.nullable()` for all 3 new fields -- correct boundary validation
- TypeScript interfaces (`LoopRow`, `LoopIterationRow`) updated in lockstep with Zod schemas
- `INSERT` prepared statement for `loops`: uses named parameters (`@gitStartCommitSha`), column count matches value count
- `INSERT` prepared statement for `loop_iterations`: uses positional `?` parameters, 14 columns = 14 `?` placeholders = 14 `.run()` arguments -- verified in both `recordIteration()` (async) and `recordIterationSync()` (sync)
- `UPDATE` prepared statements for both tables include the new columns with named parameters
- `loopToRow()` maps domain `gitStartCommitSha` to row param with `?? null` coercion
- `rowToLoop()` maps `git_start_commit_sha` back to domain with `?? undefined` -- consistent with existing `gitBranch`/`gitBaseBranch` pattern
- `rowToIteration()` maps both new iteration columns with same `?? undefined` pattern
- Domain types in `src/core/domain.ts` define all 3 fields as optional (`readonly gitStartCommitSha?: string`, etc.)
- Default factory (`src/core/domain.ts:628`) sets `gitStartCommitSha: undefined`

**Test Coverage (`tests/unit/implementations/loop-repository.test.ts`)**

- 4 new test cases covering both loops and iterations:
  - Save and read `gitStartCommitSha` (round-trip)
  - Default `gitStartCommitSha` to undefined when not set
  - Save and read `gitCommitSha` + `preIterationCommitSha` (round-trip)
  - Default iteration git SHA fields to undefined when not set
- Tests use realistic SHA-length strings
- Tests verify both presence and absence cases

## Issues in Code You Touched (Should Fix)

No should-fix issues found.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**No rollback/down migration defined** - `src/implementations/database.ts:699-713`
**Confidence**: 85%
- Problem: Migration 12 (and all prior migrations) define only `up` without a `down` method. While SQLite `ALTER TABLE ADD COLUMN` is safe and cannot easily be reversed (SQLite lacks `DROP COLUMN` in older versions), the lack of a rollback strategy means reverting requires manual intervention or a full table rebuild.
- Note: This is a pre-existing architectural pattern throughout the migration system, not introduced by this PR. All 12 migrations follow this pattern. Flagging for awareness only.

### LOW

**No index on new SHA columns** - `src/implementations/database.ts:704-708`
**Confidence**: 82%
- Problem: The new `git_start_commit_sha`, `git_commit_sha`, and `pre_iteration_commit_sha` columns have no indexes. If future features require querying loops/iterations by commit SHA (e.g., "find iteration that produced commit X"), full table scans would result.
- Note: Currently no queries filter by these columns, so indexes would be premature. Worth noting for when/if SHA-based lookups are introduced.

## Suggestions (Lower Confidence)

- **SHA format validation at Zod boundary** - `src/implementations/loop-repository.ts:56,73-74` (Confidence: 65%) -- The Zod schemas accept any nullable string for SHA fields. A `z.string().regex(/^[0-9a-f]{40}$/).nullable()` constraint would catch corrupted data at the boundary. However, SHA values may intentionally be abbreviated or prefixed (as seen in test data like `pre_abc...`), so this may be too restrictive.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 1 | 1 |

**Database Score**: 9/10
**Recommendation**: APPROVED

The migration is clean and follows established project patterns. Column additions are nullable (safe for SQLite), the repository layer is updated consistently across all CRUD paths (async and sync), Zod validation is in place at the boundary, and test coverage verifies round-trip persistence for all 3 new fields. No blocking or should-fix issues identified.
