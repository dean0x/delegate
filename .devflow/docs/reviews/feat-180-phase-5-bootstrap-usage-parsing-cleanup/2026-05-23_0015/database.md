# Database Review Report

**Branch**: feat/180-phase-5-bootstrap-usage-parsing-cleanup -> main
**Date**: 2026-05-23

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

## Analysis Notes

### Migration v30 (session_name on orchestrations)

The new migration at `src/implementations/database.ts:1211-1225` follows the established pattern exactly:

1. **Nullable column via ALTER TABLE** -- `session_name TEXT` is nullable, so existing rows get NULL automatically. No data migration or backfill is needed. This matches the pattern used in migration v29 (session_name on workers), v25 (mode/pid on orchestrations), v23 (system_prompt on tasks), and many others.

2. **Partial index** -- `idx_orchestrations_session_name ON orchestrations(session_name) WHERE session_name IS NOT NULL` keeps the index small since most orchestrations (standard mode) will never have a session name. This matches the pattern from migration v29 (`idx_workers_session_name`), v18 (`idx_tasks_orchestrator_id`), and v20 (`idx_tasks_retry_of`).

3. **Monotonically incrementing version** -- Version 30 correctly follows version 29. Description includes context (Phase 5).

4. **Idempotency** -- Uses `IF NOT EXISTS` on the index. ALTER TABLE ADD COLUMN is inherently non-repeatable in SQLite, but the version-based migration framework prevents double-application.

5. **No table recreation needed** -- Since there are no CHECK constraints to add, a simple ALTER TABLE suffices. No risk of data loss from table recreation.

### Repository Changes (orchestration-repository.ts)

1. **Zod schema updated** -- `OrchestrationRowSchema` correctly adds `session_name: z.string().nullable().optional()`. The `.optional()` is intentional for forward/backward compat (pre-v30 databases won't have this column in SELECT * results).

2. **Row interface updated** -- `OrchestrationRow.session_name: string | null` matches the schema.

3. **Prepared statements updated** -- `saveStmt`, `updateStmt`, and `updateIfStatusStmt` all include `session_name` / `@sessionName` in the column and parameter lists. The ordering is consistent across all three statements.

4. **toRow() mapping** -- Correctly maps `orchestration.sessionName ?? null` (domain optional -> DB null).

5. **rowToOrchestration() mapping** -- Correctly maps `data.session_name ?? undefined` (DB null -> domain optional).

6. **All queries use parameterized statements** -- No SQL injection risk. The `@sessionName` named parameter is bound through better-sqlite3's prepared statement API.

### Service Layer (orchestration-manager.ts)

1. **updateInteractiveOrchestrationSessionName()** -- Validates non-empty input, uses `updateIfStatus(RUNNING)` for atomic check-and-set (same pattern as `updateInteractiveOrchestrationPid`). Sets `pid: 0` sentinel consistent with the tmux worker convention from migration v29.

2. **cancelOrchestration()** -- The cancel path correctly implements a fallback chain: `sessionName + tmuxSessionManager` (Phase 5 tmux destroy) -> `pid > 0` (pre-Phase 5 SIGTERM) -> loop cancel (standard mode). The backward compatibility is well-structured and the guard conditions (`orchestration.pid > 0 && Number.isInteger(orchestration.pid)`) prevent sending SIGTERM to the pid=0 sentinel.

3. **Race condition handling** -- The `updateIfStatus(RUNNING)` pattern prevents the cancel path from clobbering a concurrent finalize, and vice versa. This is the same proven pattern used since v1.3.0.

### Domain Model (domain.ts)

1. **Task.persistentSessionKey** -- Correctly marked as in-memory only (not persisted to DB). The comment is clear. This field has no database impact.

2. **Orchestration.sessionName** -- Optional string, properly documented with JSDoc explaining the nullable semantics and the cancel path behavior.

### Decision Context

- **PF-001** (Do not defer review issues): Not applicable -- no issues found to defer.
- **PF-002** (No migration paths for features with zero users): The migration is additive (nullable column + index) with no backward-compatibility scaffolding. The cancel path does include backward compat for pre-Phase 5 orchestrations, but this is correct because those orchestrations may be in-flight during the upgrade window -- they are existing published functionality with real users, not an unpublished feature. This correctly avoids PF-002.
