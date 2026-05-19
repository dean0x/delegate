# Database Review Report

**Branch**: feat/177-agent-adapter-migration -> main
**Date**: 2026-05-19

## Issues in Your Changes (BLOCKING)

### HIGH

**Migration v28 does not clean `agent='gemini'` from `orchestrations`, `pipelines`, or serialized JSON columns** - `src/implementations/database.ts:1073-1077`
**Confidence**: 85%

- Problem: Migration v28 maps `tasks.agent='gemini'` to NULL and handles `loops.judge_agent='gemini'` via CASE WHEN, but does not touch three other surfaces where `agent='gemini'` may exist:
  1. **`pipelines.agent`** -- validated by `z.enum(AGENT_PROVIDERS_TUPLE).nullable()` in `pipeline-repository.ts:44`. Any pipeline row with `agent='gemini'` will throw a ZodError on read.
  2. **`orchestrations.agent`** -- validated by `toAgentProvider()` in `orchestration-repository.ts:490-494`, which calls `isAgentProvider()` and throws `"Unknown agent provider: gemini - possible data corruption"`.
  3. **JSON blobs** in `schedules.task_template`, `schedules.pipeline_steps`, `schedules.loop_config`, and `loops.task_template` -- all deserialized through Zod schemas using `z.enum(AGENT_PROVIDERS_TUPLE)` (e.g., `schedule-repository.ts:89`, `loop-repository.ts:113`). Gemini values in these JSON blobs will fail Zod validation.
- Impact: Any user who previously created pipelines, orchestrations, or schedules with `agent='gemini'` will get runtime errors when those rows are read after upgrading. The application becomes unable to list or query those entities.
- Fix: Extend migration v28 to also update these tables. For direct columns, simple UPDATEs suffice (avoids PF-002 -- these rows represent real data from the published v0.5.0+ gemini adapter, not an unpublished feature):
  ```typescript
  // Direct columns — same pattern as the tasks UPDATE
  db.exec(`UPDATE orchestrations SET agent = NULL WHERE agent = 'gemini'`);
  db.exec(`UPDATE pipelines SET agent = NULL WHERE agent = 'gemini'`);
  db.exec(`UPDATE workers SET agent = 'claude' WHERE agent = 'gemini'`);

  // JSON blobs — update task_template in schedules and loops
  // (only rows containing '"agent":"gemini"' need patching)
  db.exec(`
    UPDATE schedules SET task_template = REPLACE(task_template, '"agent":"gemini"', '"agent":null')
    WHERE task_template LIKE '%"agent":"gemini"%'
  `);
  db.exec(`
    UPDATE loops SET task_template = REPLACE(task_template, '"agent":"gemini"', '"agent":null')
    WHERE task_template LIKE '%"agent":"gemini"%'
  `);
  // Similarly for pipeline_steps and loop_config JSON columns if they can contain agent
  db.exec(`
    UPDATE schedules SET pipeline_steps = REPLACE(pipeline_steps, '"agent":"gemini"', '"agent":"claude"')
    WHERE pipeline_steps LIKE '%"agent":"gemini"%'
  `);
  db.exec(`
    UPDATE schedules SET loop_config = REPLACE(loop_config, '"agent":"gemini"', '"agent":null')
    WHERE loop_config LIKE '%"agent":"gemini"%'
  `);
  ```
  Note: The JSON REPLACE approach is fragile for edge cases (whitespace variations in JSON). An alternative is to read-modify-write in TypeScript within the migration, but SQLite string replacement works for machine-serialized JSON with no whitespace variation. `JSON.stringify` output is deterministic, so `REPLACE` is safe here.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Test simulates migration UPDATE in isolation rather than exercising the actual migration path** - `tests/unit/implementations/database.test.ts:449-471`
**Confidence**: 82%

- Problem: The new test at line 449 creates a fresh `Database(':memory:')` (which runs ALL migrations including v28), then manually seeds a `tasks` row with `agent='gemini'`, and manually runs the UPDATE. But the actual migration v28 already ran during construction, so this test is not validating that the migration works -- it is re-running the UPDATE statement on data that was inserted AFTER all migrations completed. This means the test passes even if the UPDATE statement were removed from migration v28, because it runs its own copy.
- Impact: The test gives false confidence. If someone accidentally removed the UPDATE from migration v28, this test would still pass.
- Fix: The test should either:
  (a) Verify the migration outcome by constructing a Database at migration v27 state, inserting gemini data, then applying migration v28 -- which is complex with the current single-constructor design, or
  (b) At minimum, assert the migration v28 description mentions tasks.agent (already done), and verify that a freshly-constructed DB rejects `agent='gemini'` at the Zod level (which tests the end-to-end invariant that matters):
  ```typescript
  it('tasks.agent=gemini fails Zod validation after migration', () => {
    const freshDb = new Database(':memory:');
    const freshSqlite = freshDb.getDatabase();
    const now = Date.now();
    // Insert with agent='gemini' at DB level (no CHECK constraint on tasks.agent)
    freshSqlite
      .prepare(`INSERT INTO tasks (id, prompt, status, priority, created_at, agent) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('zod-test', 'prompt', 'queued', 'P1', now, 'gemini');
    // Verify the Zod schema in task-repository would reject this row
    // (this validates the end-to-end invariant)
    expect(() => TaskRowSchema.parse({ /* row data with agent: 'gemini' */ })).toThrow();
    freshDb.close();
  });
  ```

## Pre-existing Issues (Not Blocking)

No pre-existing database issues identified in the reviewed files.

## Suggestions (Lower Confidence)

- **Consider adding a CHECK constraint on `tasks.agent`** - `src/implementations/database.ts` (Confidence: 65%) -- The `tasks` table has no DB-level CHECK on the `agent` column, relying solely on Zod validation in the repository layer. Other tables with agent-like columns (`loops.judge_agent`, `loops.status`) have CHECK constraints as defense-in-depth. Adding one to `tasks.agent` would catch invalid values at the DB layer.

- **`workers.agent` uses `z.string()` instead of `z.enum(AGENT_PROVIDERS_TUPLE)`** - `src/implementations/worker-repository.ts:27` (Confidence: 62%) -- The workers table agent column is validated as a bare string, not against the agent provider enum. While workers are transient and cleaned up on completion, this is inconsistent with the stricter validation used elsewhere.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | - |
| Should Fix | - | 0 | 1 | - |
| Pre-existing | - | - | 0 | 0 |

**Database Score**: 6/10
**Recommendation**: CHANGES_REQUESTED

The migration correctly handles `tasks.agent` and `loops.judge_agent` cleanup, but misses several other tables and JSON columns that also contain gemini agent references and are validated against the narrowed `AGENT_PROVIDERS_TUPLE`. The blocking HIGH issue must be addressed to prevent runtime failures for users who previously used the Gemini adapter (shipped in v0.5.0+).
