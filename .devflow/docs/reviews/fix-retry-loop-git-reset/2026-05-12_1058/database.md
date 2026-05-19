# Database Review Report

**Branch**: fix-retry-loop-git-reset -> main
**Date**: 2026-05-12

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

### MEDIUM

(none)

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

(none)

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 0 | 0 |

**Database Score**: 9/10
**Recommendation**: APPROVED

## Detailed Analysis

### Migration v26: Adding 'progress' to loop_iterations CHECK constraint

The migration follows the established pattern (used in v2, v3, v11, v22) for SQLite CHECK constraint updates:

1. **Table recreation approach is correct** -- SQLite cannot ALTER CHECK constraints in-place, so the table is recreated with the new constraint and data is copied over. This is the exact pattern used by 4 prior migrations in this codebase.

2. **Column completeness verified** -- The new table definition includes all 14 columns from the current loop_iterations schema (id, loop_id, iteration_number, task_id, pipeline_task_ids, status, score, exit_code, error_message, started_at, completed_at, git_branch, git_diff_summary, git_commit_sha, pre_iteration_commit_sha, eval_feedback, eval_response). The SELECT in the INSERT matches.

3. **Index recreation is complete** -- All 4 indexes from the original table are recreated after the rename: idx_loop_iterations_loop_id, idx_loop_iterations_task_id, idx_loop_iterations_status, idx_loop_iterations_loop_iteration. These match the indexes created in migrations v10 and v11.

4. **FK constraints preserved** -- The new table correctly preserves both foreign key constraints: `loop_id REFERENCES loops(id) ON DELETE CASCADE` and `task_id REFERENCES tasks(id) ON DELETE SET NULL`.

5. **UNIQUE constraint preserved** -- `UNIQUE(loop_id, iteration_number)` is carried forward.

6. **Transaction safety** -- The migration runs inside the standard `this.db.transaction()` wrapper provided by `applyMigrations()`, so the DROP+RENAME+INSERT is atomic.

7. **PF-002 citation** -- The migration comment explicitly cites `PF-002: no backward-compat path` which is correct: the 'progress' status is a new feature with zero existing data in the field. avoids PF-002.

### Zod Schema Update (loop-repository.ts)

The `LoopIterationRowSchema` Zod enum is updated to include `'progress'` in the status field, keeping it in sync with both the domain type and the DB CHECK constraint. This is the boundary validation layer that parses rows read from SQLite.

### Domain Type Update (domain.ts)

The `LoopIteration.status` union type adds `'progress'` as a new variant. This is the source-of-truth type that the Zod schema and migration CHECK constraint both reflect.

### Behavioral Database Impact

The `consecutiveFailures` counter semantics changed for RETRY loops:
- **Before**: Exit-condition-not-met incremented `consecutiveFailures` (treated as a "fail")
- **After**: Exit-condition-not-met resets `consecutiveFailures` to 0 (task succeeded, only crashes count)

This is a pure application-layer semantic change. The DB column (`loops.consecutive_failures INTEGER`) is unchanged. The new `{ consecutiveFailures: 0 }` update is written atomically in the same transaction as the iteration status update, matching the existing pattern.

### Git Reset Target Change

RETRY task failures now reset to `preIterationCommitSha` (the iteration's own start point) instead of `gitStartCommitSha` (the loop's start point). This is application logic only -- no schema change. The `pre_iteration_commit_sha` column already existed since migration v12.

### No Missing Migration Concerns

- No new columns are added to any table
- No existing column types or constraints are changed (other than the CHECK constraint update)
- No data backfill is needed (the 'progress' status only applies to future iterations)
- The migration is idempotent via the version-based migration system (version 26 only runs once)
