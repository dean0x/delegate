# Database Review Report

**Branch**: feat/system-prompt-support -> main
**Date**: 2026-04-17T16:41

## Issues in Your Changes (BLOCKING)

### CRITICAL

_No critical issues found._

### HIGH

_No high-severity blocking issues found._

### MEDIUM

_No medium-severity blocking issues found._

## Issues in Code You Touched (Should Fix)

_No should-fix issues found._

## Pre-existing Issues (Not Blocking)

### MEDIUM

**PF-004: findByOrchestratorId status-filter path uses inline db.prepare()** - `src/implementations/task-repository.ts:443`
**Confidence**: 88%
- Problem: The dynamic IN-list branch of `findByOrchestratorId` calls `this.db.prepare(...)` inside the method body on each call instead of using a cached statement. This is a known pitfall (PF-004) carried from v1.3.0. The diff correctly added `system_prompt` to this inline query, but the inline prepare per-call pattern persists.
- Fix: Pre-existing issue documented in PF-004. Address in a separate PR with per-length statement caching or a JSON-each approach.

## Suggestions (Lower Confidence)

_No suggestions._

## Analysis Notes

### Migration v23: Safe and Correct

The migration (`src/implementations/database.ts:940-953`) uses `ALTER TABLE tasks ADD COLUMN system_prompt TEXT` with a nullable TEXT column. This is the standard SQLite pattern for non-breaking schema evolution:

1. **No table rebuild required** -- SQLite `ALTER TABLE ADD COLUMN` with nullable columns is an instant metadata-only operation. No data rewrite.
2. **Existing rows default to NULL** -- All existing tasks will have `system_prompt IS NULL`, which is correct since they had no system prompt.
3. **No data migration needed** -- Explicitly documented in the migration comment.
4. **Consistent with prior migrations** -- Follows the exact same pattern as v6 (`continue_from`), v7 (`agent`), v16 (`model`), and v18 (`orchestrator_id`).

### NULL Handling in rowToTask: Correct

`rowToTask()` at line 422 maps `data.system_prompt ?? undefined`, converting SQL NULL to JS `undefined`. This matches the pattern used for all other optional fields (`orchestrator_id`, `model`, `agent`, etc.) and correctly produces `Task.systemPrompt?: string | undefined` as defined in the domain type.

The Zod schema at line 40 declares `system_prompt: z.string().nullable().optional()`, which accepts:
- `null` (SQL NULL for existing rows)
- `undefined` (if the column is somehow absent)
- A string value (new tasks with system prompts)

This is defense-in-depth: even if SQLite returns NULL for rows created before migration v23, Zod validation passes cleanly.

### Prepared Statements: All 8+ Updated Correctly

Every cached prepared statement in the constructor includes `system_prompt` in its column list:

| Statement | Line | system_prompt Included |
|-----------|------|----------------------|
| `saveStmt` (INSERT) | 95-109 | Yes -- both column list and VALUES |
| `updateStmt` (UPDATE SET) | 114-136 | Yes -- SET clause |
| `findByIdStmt` (SELECT) | 138-144 | Yes |
| `findAllUnboundedStmt` (SELECT) | 146-152 | Yes |
| `findByStatusStmt` (SELECT) | 154-160 | Yes |
| `findAllPaginatedStmt` (SELECT) | 170-176 | Yes |
| `findUpdatedSinceStmt` (SELECT) | 181-190 | Yes |
| `findByOrchestratorIdStmt` (SELECT) | 195-203 | Yes |
| Dynamic status-filter query | 443-451 | Yes |

All 9 query paths include `system_prompt`. No prepared statement is missing the new column.

### toDbFormat Mapping: Correct

`toDbFormat()` at line 264 maps `systemPrompt: task.systemPrompt ?? null`, correctly converting JS `undefined` to SQL NULL. This is the same null-coalescing pattern used for `orchestratorId`, `exitCode`, and other nullable fields.

### Paired-Interface Drift (PF-006): Addressed

The review prompt flagged concern about paired-interface drift between `system_prompt` and `orchestrator_id`. This branch correctly adds `system_prompt` everywhere `orchestrator_id` appears:

| Location | orchestrator_id | system_prompt |
|----------|----------------|---------------|
| Domain type (`Task` interface) | Yes | Yes |
| `TaskRequest` interface | Yes | Yes |
| `createTask()` factory | Yes | Yes |
| `TaskRowSchema` (Zod) | Yes | Yes |
| `TaskRow` interface | Yes | Yes |
| `toDbFormat()` | Yes | Yes |
| `rowToTask()` | Yes | Yes |
| All 9 SQL queries | Yes | Yes |
| `SpawnOptions` (agents.ts) | Yes | Yes |
| Worker pool spawn call | Yes | Yes |
| Retry path (task-manager.ts:291) | Yes | Yes |
| Resume path (task-manager.ts:402) | Yes | Yes |
| Loop taskTemplate Zod schema | Yes | Yes |

No interface drift detected. The field propagates through all required paths.

### Loop Repository: taskTemplate JSON Blob

The `TaskRequestSchema` in `loop-repository.ts:125` includes `systemPrompt: z.string().optional()`, ensuring the system prompt round-trips through the JSON blob stored in the `task_template` column of the `loops` table. This follows the same pattern established by `orchestratorId` (line 116) and `jsonSchema` (line 120). Without this Zod field, `parse()` would strip the property and system prompts would silently break on loop iteration tasks.

### Query Performance Impact: Negligible

Adding a nullable TEXT column to an existing table has no performance impact on queries that do not reference the column in WHERE/ORDER BY/JOIN clauses. `system_prompt` is only selected (no filtering), so:
- No new index is needed (correct -- none was added)
- Existing indexes are unaffected
- Row size increases only for tasks that actually set a system prompt (SQLite stores NULL efficiently)
- The 1Hz dashboard polling queries are not degraded

### Orchestrator Prompt Refactor: Database-Relevant Aspects

`buildOrchestratorPrompt` now returns `{ systemPrompt, userPrompt }` instead of a single string. The `systemPrompt` flows through `orchestration-manager.ts` into the loop's `taskTemplate.systemPrompt`, which is persisted via the `loops.task_template` JSON column. The Zod round-trip (verified above) ensures this survives DB serialization.

The conditional override (`request.systemPrompt ?? orchestratorSystemPrompt`) correctly prioritizes user-provided system prompts over auto-generated ones, and the decision is well-documented with JSDoc.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Database Score**: 9/10
**Recommendation**: APPROVED

The database changes in this PR are well-executed. Migration v23 follows established patterns for safe column additions. All prepared statements, Zod schemas, type interfaces, and mapping functions are updated consistently. NULL handling is correct at every boundary. The paired-interface drift concern (PF-006) has been thoroughly addressed -- `system_prompt` appears in every location where `orchestrator_id` appears. The only noted issue (PF-004, inline prepare) is pre-existing and does not block this PR.
