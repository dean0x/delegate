# Database Review Report

**Branch**: feat/v1.4.0-reliability-eval-redesign -> main
**Date**: 2026-04-14T15:37

## Issues in Your Changes (BLOCKING)

### HIGH

**Missing CHECK constraint on eval_type column** - `src/implementations/database.ts:856`
**Confidence**: 85%
- Problem: Migration v21 adds `eval_type TEXT DEFAULT 'feedforward'` without a CHECK constraint. The existing project convention for enum-like columns is to use CHECK constraints for defense-in-depth (see `status` columns on loops, schedules, tasks, and the `strategy` column, all of which have CHECKs). Without a CHECK, any arbitrary string can be written to `eval_type`, violating the `EvalType` enum contract (`feedforward` | `judge` | `schema`). The Zod schema in `LoopRowSchema` uses `z.string().nullable().optional()` which also does not restrict to valid values.
- Fix: Add a CHECK constraint in the ALTER TABLE statement:
  ```sql
  ALTER TABLE loops ADD COLUMN eval_type TEXT DEFAULT 'feedforward'
    CHECK(eval_type IS NULL OR eval_type IN ('feedforward', 'judge', 'schema'))
  ```
  Note: SQLite supports CHECK on ALTER TABLE ADD COLUMN. Also tighten the Zod schema:
  ```ts
  eval_type: z.enum(['feedforward', 'judge', 'schema']).nullable().optional(),
  ```

**TaskRequestSchema missing jsonSchema field -- loop taskTemplate round-trip silently strips it** - `src/implementations/loop-repository.ts:94-111`
**Confidence**: 88%
- Problem: The `TaskRequest` domain type now includes `jsonSchema?: string` (added in this PR for eval tasks). The `taskTemplate` field on loops is serialized as JSON and deserialized through `TaskRequestSchema.parse()`. However, the `TaskRequestSchema` Zod object in the loop repository (line 94) does not include a `jsonSchema` property. Zod's default behavior strips unknown keys, so when a loop is saved with `taskTemplate.jsonSchema` set and then read back, the `jsonSchema` field is silently dropped. This means judge-mode loops that need `jsonSchema` on iteration tasks will lose it after a process restart (when state is rebuilt from DB).
- Fix: Add `jsonSchema` to the `TaskRequestSchema` in `loop-repository.ts`:
  ```ts
  jsonSchema: z.string().optional(), // v1.4.0: structured output for eval tasks
  ```
  The same field should also be added to the `TaskRequestSchema` in `schedule-repository.ts` for consistency (future-proofing scheduled loops with eval).

### MEDIUM

**LoopRowSchema uses weak typing for eval_type/judge_agent -- `as` casts bypass Zod validation** - `src/implementations/loop-repository.ts:64-66,686-687`
**Confidence**: 82%
- Problem: The new eval redesign fields in `LoopRowSchema` use `z.string().nullable().optional()` for `eval_type` and `judge_agent`. In `rowToLoop()`, these are cast with `as EvalType` and `as Loop['judgeAgent']` respectively. This bypasses Zod's validation purpose -- the project convention (and known pitfall PF-005) requires validating enum values at the boundary rather than using `as` casts. If a corrupted or invalid value exists in the DB, the cast will silently pass an invalid value into the domain type.
- Fix: Use `z.enum()` with the valid values:
  ```ts
  eval_type: z.enum(['feedforward', 'judge', 'schema']).nullable().optional(),
  judge_agent: z.enum(AGENT_PROVIDERS_TUPLE).nullable().optional(),
  ```
  Then in `rowToLoop()`, remove the `as` casts since Zod has already validated the values.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**LoopRow/LoopIterationRow interface fields use `| undefined` for DB columns** - `src/implementations/loop-repository.ts:157-159,180`
**Confidence**: 80%
- Problem: The new fields `eval_type`, `judge_agent`, `judge_prompt`, and `eval_response` in the `LoopRow` and `LoopIterationRow` interfaces are typed as `string | null | undefined`. Database columns are always present in a row (as `null` when not set) -- they are never `undefined`. The `| undefined` is only needed because the Zod schema uses `.optional()`, but the interface should reflect what SQLite actually returns. This creates a subtle type mismatch: the interface says the property might be absent, but the DB always returns it.
- Fix: Remove `| undefined` from the interface types (keep `| null` since that is what SQLite returns for nullable columns). The `.optional()` on the Zod schema can remain for backward compatibility with pre-migration-v21 rows during the migration window.

## Pre-existing Issues (Not Blocking)

No critical pre-existing database issues identified in the reviewed files.

## Suggestions (Lower Confidence)

- **Heartbeat write frequency vs WAL pressure** - `src/implementations/event-driven-worker-pool.ts:353` (Confidence: 65%) -- The 30s heartbeat interval writes to the `workers` table for every active worker. With many workers (e.g., 10+), this adds 20+ writes/min to the WAL. The current design mitigates this with `timer.unref()` and the decision is well-documented. Worth monitoring in production but not a blocking concern.

- **eval_response TEXT column unbounded** - `src/implementations/database.ts:851` (Confidence: 70%) -- The `eval_response` column stores raw agent output as TEXT with no size limit. While `MAX_FEEDBACK_LENGTH` (16KB) is enforced in `JudgeExitConditionEvaluator`, other evaluators writing to `evalResponse` may not have the same cap. Consider adding a consistent truncation at the repository boundary.

- **No index on loops(eval_type) for future queries** - `src/implementations/database.ts:856` (Confidence: 60%) -- No index is added for the `eval_type` column. Currently no query filters by `eval_type`, so this is not needed today. If future dashboard or management features filter loops by eval type, an index will be needed.

## Pitfall Cross-Check

| Pitfall | Relevant? | Status |
|---------|-----------|--------|
| PF-001 (1Hz polling + missing indexes) | No new polling queries added | N/A |
| PF-004 (Prepared statement caching) | `updateHeartbeatStmt` correctly cached in constructor | Resolved |
| PF-005 (Zod on repo reads) | New `eval_type`/`judge_agent` fields use `as` casts instead of Zod enum validation | Flagged above (MEDIUM) |

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Database Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The migration (v21) is well-structured and follows existing patterns (nullable columns, backward-compatible defaults). Prepared statement caching is correctly applied. Heartbeat design is sound with proper `timer.unref()` and cleanup in both `cleanupWorkerState` and `clearTimeoutForWorker`. However, two HIGH issues should be addressed: the missing CHECK constraint on `eval_type` breaks the project's defense-in-depth convention, and the missing `jsonSchema` in `TaskRequestSchema` will silently lose data on round-trip through the loop repository.
