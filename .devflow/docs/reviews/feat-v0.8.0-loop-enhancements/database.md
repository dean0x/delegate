# Database Review Report

**Branch**: feat/v0.8.0-loop-enhancements -> main
**Date**: 2026-03-23

## Issues in Your Changes (BLOCKING)

### CRITICAL

_No critical issues found._

### HIGH

**Migration v11: `INSERT INTO loops_new SELECT *, NULL, NULL, NULL FROM loops` is fragile** - `src/implementations/database.ts:659`
**Confidence**: 85%
- Problem: Using `SELECT *` with appended NULL columns relies on column ordering between the v10 `loops` table and the v11 `loops_new` table being identical for the first 20 columns. If any intermediate migration were ever to alter column order (unlikely but possible in SQLite via table recreation), or if a developer adds a column to v10 without updating v11, the NULLs would be assigned to the wrong columns. The prior migrations (v2, v3) used `SELECT * FROM <table>` into an identically-columned replacement, which is safe. This migration appends 3 NULLs to a `SELECT *`, creating an implicit column-count contract.
- Fix: Use an explicit column list for both source and destination to make the migration self-documenting and resilient:
  ```sql
  INSERT INTO loops_new (
    id, strategy, task_template, pipeline_steps, exit_condition,
    eval_direction, eval_timeout, working_directory, max_iterations,
    max_consecutive_failures, cooldown_ms, fresh_context, status,
    current_iteration, best_score, best_iteration_id, consecutive_failures,
    created_at, updated_at, completed_at,
    git_branch, git_base_branch, schedule_id
  )
  SELECT
    id, strategy, task_template, pipeline_steps, exit_condition,
    eval_direction, eval_timeout, working_directory, max_iterations,
    max_consecutive_failures, cooldown_ms, fresh_context, status,
    current_iteration, best_score, best_iteration_id, consecutive_failures,
    created_at, updated_at, completed_at,
    NULL, NULL, NULL
  FROM loops
  ```

### MEDIUM

**Missing FK constraint on `schedule_executions.loop_id`** - `src/implementations/database.ts:681`
**Confidence**: 82%
- Problem: The new `loop_id` column on `schedule_executions` references a loop but has no `FOREIGN KEY` constraint. By contrast, `schedule_executions.task_id` has `REFERENCES tasks(id) ON DELETE SET NULL`, and `loops.schedule_id` has `REFERENCES schedules(id) ON DELETE SET NULL`. Without an FK, a deleted loop leaves orphaned `loop_id` values that pass Zod validation but reference nonexistent records. The impact is limited since `loop_id` is currently only read back (not queried by), but it breaks referential integrity patterns used elsewhere in the schema.
- Fix: Add the FK constraint when adding the column. Since `ALTER TABLE ADD COLUMN` in SQLite does not support inline FK constraints when foreign keys are already enabled, this requires the table recreation pattern (same as v2/v3/v11-loops). Alternatively, if the table recreation cost is too high for `schedule_executions`, document the missing FK as an accepted trade-off with a comment:
  ```sql
  -- NOTE: No FK on loop_id — ALTER TABLE ADD COLUMN cannot add FK in SQLite.
  -- Referential integrity enforced at application layer via LoopId branded type.
  ALTER TABLE schedule_executions ADD COLUMN loop_id TEXT;
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Update statement overwrites immutable loop configuration fields** - `src/implementations/loop-repository.ts:191-214`
**Confidence**: 80%
- Problem: The `UPDATE loops SET ...` statement updates every column including `strategy`, `task_template`, `exit_condition`, `working_directory`, and `max_iterations` — fields that should be immutable after loop creation. While the domain layer uses `Object.freeze()` and immutable update patterns, the SQL layer permits overwriting foundational configuration. A bug in the handler layer could silently corrupt loop definitions. This is a pre-existing pattern from v0.7.0 that the new columns (`git_branch`, `git_base_branch`, `schedule_id`) extend.
- Fix: Consider splitting the update statement into a targeted status-update statement that only modifies mutable fields:
  ```sql
  UPDATE loops SET
    status = @status,
    current_iteration = @currentIteration,
    best_score = @bestScore,
    best_iteration_id = @bestIterationId,
    consecutive_failures = @consecutiveFailures,
    updated_at = @updatedAt,
    completed_at = @completedAt,
    git_branch = @gitBranch,
    git_base_branch = @gitBaseBranch
  WHERE id = @id
  ```

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`LoopConfigSchema` validation does not enforce numeric constraints** - `src/implementations/schedule-repository.ts:114-129`
**Confidence**: 80%
- Problem: The `LoopConfigSchema` accepts any number for `evalTimeout`, `maxIterations`, `maxConsecutiveFailures`, and `cooldownMs` without range constraints. A stored JSON like `{"maxIterations": -5}` would pass Zod validation but cause undefined behavior in the loop handler. The domain `createLoop()` factory does not validate these ranges either.
- Fix: Add `.min()` / `.max()` constraints:
  ```typescript
  evalTimeout: z.number().min(1000).max(600000).optional(),
  maxIterations: z.number().min(0).max(1000).optional(),
  maxConsecutiveFailures: z.number().min(1).max(100).optional(),
  cooldownMs: z.number().min(0).max(3600000).optional(),
  ```

### LOW

**Cleanup query excludes paused loops but comment only appears in repository** - `src/implementations/loop-repository.ts:280-283`
**Confidence**: 80%
- Problem: The cleanup query `DELETE FROM loops WHERE status IN ('completed', 'failed', 'cancelled') AND completed_at < ?` intentionally excludes `paused` loops, and this is documented with a comment in the repository. However, this business rule is only captured in a code comment, not enforced by a CHECK constraint or documented in the migration. If another cleanup path is added, the paused-exclusion could be missed.
- Fix: Low priority. Consider adding the business rule to the migration comment or the architecture docs.

## Suggestions (Lower Confidence)

- **No index on `schedule_executions.loop_id`** - `src/implementations/database.ts:681` (Confidence: 65%) -- Currently `loop_id` on `schedule_executions` is only written and read back in execution history rows. If a future query needs to find executions by `loop_id`, an index will be required. No action needed now, but worth tracking.

- **`findByScheduleId` query lacks LIMIT** - `src/implementations/loop-repository.ts:276` (Confidence: 70%) -- The `SELECT * FROM loops WHERE schedule_id = ?` query has no pagination limit. For a schedule that triggers loops on a recurring cron, this could return unbounded results over time. Consider adding a default LIMIT.

- **`LoopConfigSchema` uses `z.enum` for strategy/direction instead of importing from domain** - `src/implementations/schedule-repository.ts:116-118` (Confidence: 60%) -- The schema duplicates enum values (`'retry'`, `'optimize'`, `'minimize'`, `'maximize'`) as string literals rather than deriving them from the domain enums. If a new strategy is added to the domain but not the Zod schema, deserialization will silently fail.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 1 |

**Database Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The migration is structurally sound -- the table recreation pattern for adding `paused` to the CHECK constraint follows established project conventions (v2, v3), and the column additions via `ALTER TABLE ADD COLUMN` are safe nullable additions. The main concern is the fragile `SELECT *, NULL, NULL, NULL` pattern in the data copy step, which should use explicit column lists for safety. The missing FK on `schedule_executions.loop_id` is a moderate schema design gap that should either be fixed or explicitly documented as an accepted trade-off.
