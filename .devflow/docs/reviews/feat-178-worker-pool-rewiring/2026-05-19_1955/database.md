# Database Review Report

**Branch**: feat/178-worker-pool-rewiring -> main
**Date**: 2026-05-19

## Issues in Your Changes (BLOCKING)

No CRITICAL or HIGH issues found.

### MEDIUM

(none)

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Workers table pid=0 has no CHECK constraint** - `src/implementations/database.ts:1196` (Confidence: 65%) -- The workers table allows any integer for `pid`. With the new tmux worker model always writing `pid=0`, a future CHECK constraint like `CHECK(pid >= 0)` could guard against accidental negative PIDs (crash indicator `-1` used elsewhere). Low urgency since the sentinel semantics are handled in application code.

- **updateHeartbeat JSDoc references PID check as authoritative** - `src/implementations/worker-repository.ts:177` (Confidence: 70%) -- The comment says "PID check remains authoritative" but for tmux workers, session liveness is now authoritative. The comment is not wrong (PID check is still authoritative for process-based workers), but it could be misleading given the dual liveness model.

- **No findBySessionName query** - `src/implementations/worker-repository.ts` (Confidence: 60%) -- An index `idx_workers_session_name` was added for session-name lookups, but no prepared statement or repository method exists to query by session name directly. The index is currently exercised only by RecoveryManager's `findAll()` + in-memory filter pattern. If direct session-name queries are anticipated, a dedicated method would leverage the partial index.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Database Score**: 9/10
**Recommendation**: APPROVED

## Analysis Notes

### Migration v29 Assessment

The migration is clean and well-structured (avoids PF-002 -- no backward-compat migration path needed since tmux workers are a new feature with zero existing users):

- **Schema change**: `ALTER TABLE workers ADD COLUMN session_name TEXT` -- nullable column addition is the safest SQLite migration pattern. No data migration needed. Existing rows get NULL.
- **Index**: Partial index `WHERE session_name IS NOT NULL` keeps the index small since most historical rows will have NULL. This is the correct pattern for sparse columns.
- **Idempotency**: Uses `CREATE INDEX IF NOT EXISTS` -- safe for re-execution.
- **Transaction safety**: Migration runs inside the standard `applyMigrations()` transaction wrapper.

### Repository Changes Assessment

- **Zod schema updated**: `session_name: z.string().nullable().optional()` correctly handles NULL from DB and absent field.
- **INSERT statement updated**: Includes `session_name` in the column list with `@sessionName` parameter. Null-coalescing (`registration.sessionName ?? null`) ensures NULL is written for legacy workers.
- **Row-to-domain mapping**: `data.session_name ?? undefined` correctly converts SQL NULL to TypeScript `undefined`, matching the optional field contract on `WorkerRegistration`.
- **SELECT statements use `SELECT *`**: This is consistent with the existing pattern. Adding `session_name` to the table causes `SELECT *` to automatically include it -- no query changes needed.

### Recovery Manager Database Interactions

- **Liveness dispatch**: `isWorkerAlive()` correctly dispatches pid=0 workers to tmux session check and >0 workers to PID check. Workers with pid=0 but no sessionName return false (dead) -- conservative and correct.
- **Dead worker cleanup**: `handleDeadWorker()` properly unregisters from DB and marks task FAILED with appropriate error messages for both tmux and process workers.
- **Orchestration liveness**: `checkOrchestrationLiveness()` correctly returns 'unknown' for tmux workers when `isTmuxSessionAlive` is not provided -- conservative approach prevents false zombie detection.

### Test Coverage

- Three new tests in `worker-repository.test.ts` cover: session_name persistence, undefined for missing session_name, and NULL handling for legacy rows (direct DB insertion). This covers the boundary validation path thoroughly.
- Worker pool tests cover DB registration with `sessionName` field through integration tests.

### Database Pattern Compliance

| Check | Status |
|-------|--------|
| Queries have appropriate indexes | Pass -- partial index on session_name |
| Migration has idempotent operations | Pass -- IF NOT EXISTS |
| Data types are appropriate | Pass -- TEXT for session name |
| Constraints enforce business rules | Pass -- nullable is correct for optional field |
| Foreign keys maintain referential integrity | Pass -- existing FK on task_id unchanged |
| No SQL injection vulnerabilities | Pass -- all queries use parameterized statements |
| Zod validation at boundaries | Pass -- WorkerRowSchema validates DB rows |
