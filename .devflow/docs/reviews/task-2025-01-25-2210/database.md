# Database Review Report

**Branch**: task-2025-01-25_2210 -> main
**Date**: 2026-02-17
**Updated**: 2026-02-18 (post-debate)

---

## Issues in Your Changes (BLOCKING)

### HIGH

**1. Read-Modify-Write Race Condition in `update()` (No Transaction)** - `/Users/dean/Sandbox/delegate/src/implementations/schedule-repository.ts:214-237`
**Confidence: HIGH** (corroborated by architecture, performance, and quality reviewers - 4/4 agreement)

- **Problem**: The `update()` method performs a `findById` (read), merges in-memory, then calls `save()` (write) without wrapping the entire sequence in a transaction. The existing codebase uses `DependencyHandler` synchronous transactions for TOCTOU protection (as documented in CLAUDE.md), but the schedule repository has no transaction usage at all. Under concurrent execution (e.g., two scheduler ticks, or concurrent event handlers calling `update()` on the same schedule), one update can silently overwrite the other's changes. For example, if ScheduleHandler's `handleScheduleTriggered` increments `runCount` while `handleScheduleResumed` updates `status` concurrently, one write clobbers the other.
- **Impact**: Lost updates to schedule state. A `runCount` increment could be lost or a status change reverted. This is exacerbated by the schedule-executor processing multiple due schedules in a loop.
- **Fix**: Two valid approaches exist (performance reviewer favors targeted SQL UPDATE, I favor wrapping in a transaction for consistency with existing patterns). Either works:
  - **Option A (transaction)**: Wrap the read-modify-write in a synchronous SQLite transaction, consistent with the existing `DependencyHandler` pattern.
  - **Option B (targeted UPDATE)**: Use a targeted SQL `UPDATE` statement with only the changed columns, eliminating the read step entirely (performance reviewer's suggestion). This also solves the performance concern about double DB round-trips.
  Option B is superior as it solves both the TOCTOU race and the performance concern simultaneously.
- **Category**: Blocking - code you added

---

**2. `findByStatus()` Has No Result Limit** - `/Users/dean/Sandbox/delegate/src/implementations/schedule-repository.ts:136-138`
**Confidence: HIGH** (corroborated by performance reviewer #5 and quality reviewer S1 - 3/3 agreement)

- **Problem**: `findByStatusStmt` has no `LIMIT` clause: `SELECT * FROM schedules WHERE status = ? ORDER BY created_at DESC`. If a user has thousands of active or completed schedules, this fetches all of them into memory at once. Contrast with `findAll()` which correctly paginates with `LIMIT ? OFFSET ?`.
- **Impact**: Unbounded memory consumption for status queries. The MCP adapter's `handleListSchedules` then applies `.slice()` in JavaScript, meaning all rows are fetched, deserialized, Zod-validated, and domain-mapped before most are thrown away.
- **Fix**: Add a limit parameter or use the same pagination pattern as `findAll()`:
  ```sql
  SELECT * FROM schedules WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?
  ```
  And accept `limit`/`offset` parameters defaulting to `DEFAULT_LIMIT` and `0`.
- **Category**: Blocking - code you added

---

### MEDIUM

**3. Schema Missing Numeric Bounds CHECK Constraints** - `/Users/dean/Sandbox/delegate/src/implementations/database.ts:438-456`
**Confidence: HIGH** (narrowed after architecture reviewer challenge on cross-column constraints; numeric bounds portion unchallenged and consistent with migration v2/v3 pattern)

- **Problem**: The `schedules` table has CHECK constraints on all enum columns (schedule_type, missed_run_policy, status) but none on numeric bounds:
  - `run_count` can go negative (no `CHECK (run_count >= 0)`)
  - `max_runs` can be zero or negative (no `CHECK (max_runs > 0)`)

  Unlike cross-column constraints (e.g., `cron_expression NOT NULL when schedule_type = 'cron'`), which are validated at two application layers, there is no explicit application-layer validation preventing `run_count` from going negative. It is only safe because the increment logic always adds 1 to a non-negative value. A future bug introducing `run_count - 1` would silently succeed without the CHECK constraint.
- **Impact**: If any code path bypasses the handler, invalid numeric state can be persisted.
- **Fix**: Add simple numeric bounds (consistent with migration v2/v3 defense-in-depth pattern):
  ```sql
  run_count INTEGER NOT NULL DEFAULT 0 CHECK (run_count >= 0),
  max_runs INTEGER CHECK (max_runs > 0),
  ```
  Note: Cross-column constraints (e.g., `scheduled_at` nullability based on `schedule_type`) are adequately covered by application-layer validation and are not recommended at the schema level.
- **Category**: Blocking - code you added

---

**4. `INSERT OR REPLACE` Silently Overwrites Conflicting Rows** - `/Users/dean/Sandbox/delegate/src/implementations/schedule-repository.ts:116-126`
**Confidence: MEDIUM** (linked to architecture reviewer's dual-write finding; if architecture is fixed to single persistence path, this concern is reduced)

- **Problem**: The `saveStmt` uses `INSERT OR REPLACE`. The `save()` method is documented as "Save a new schedule" but is also reused by `update()` via the read-modify-write pattern. There is no distinction between create and update at the SQL level, meaning a caller that expects `save()` to fail on duplicate IDs gets silent overwrite instead.
- **Impact**: The architecture reviewer's CRITICAL finding (dual-write: MCP adapter saves first, then handler saves again via event) directly relies on this silent-overwrite behavior. If the architecture is fixed to use a single persistence path (adapter emits event, handler saves once), then `INSERT OR REPLACE` becomes less dangerous because `save()` is only called once per schedule creation. However, the dual-purpose `save()` method is still a design smell.
- **Fix**: If the architecture is fixed first (recommended), then separate `save()` into `insert()` (fails on conflict) and `upsert()` (explicit overwrite). If the architecture is not fixed, at minimum document that `save()` is an upsert.
- **Category**: Blocking - code you added

---

**5. `delete()` Does Not Verify Row Existed** - `/Users/dean/Sandbox/delegate/src/implementations/schedule-repository.ts:322-329`
**Confidence: LOW** (successfully challenged by security reviewer - idempotent deletes prevent information disclosure via differential error responses)

- **Problem**: `DELETE FROM schedules WHERE id = ?` always returns `ok(undefined)` even if no row was deleted (schedule not found). The caller cannot distinguish between "successfully deleted" and "nothing to delete".
- **Impact**: Minimal. The security reviewer correctly argued that idempotent deletes are *safer* because they prevent information disclosure -- an attacker cannot enumerate schedule IDs by observing differential error responses for existent vs nonexistent schedules. The MCP adapter's `handleCancelSchedule` already verifies existence before calling delete.
- **Disposition**: Downgraded from MEDIUM blocking to informational. No change required.
- **Category**: Informational - code you added

---

**6. Missing Index for `getExecutionHistory` Query on `(schedule_id, scheduled_for)`** - `/Users/dean/Sandbox/delegate/src/implementations/database.ts:477-483`
**Confidence: HIGH** (unchallenged, clear index coverage gap for a known query pattern)

- **Problem**: The `getExecutionHistoryStmt` queries `WHERE schedule_id = ? ORDER BY scheduled_for DESC LIMIT ?`. The existing index `idx_schedule_executions_schedule` covers `schedule_id` only. The `ORDER BY scheduled_for DESC` requires a filesort after index lookup. As execution history grows per schedule, this will become increasingly costly.
- **Impact**: Suboptimal query performance for execution history lookups. With high-frequency schedules (e.g., every minute), the execution table grows fast.
- **Fix**: Add a composite index:
  ```sql
  CREATE INDEX IF NOT EXISTS idx_schedule_executions_schedule_time
    ON schedule_executions(schedule_id, scheduled_for DESC);
  ```
  This covers both the WHERE and ORDER BY, enabling index-only scanning for the history query.
- **Category**: Blocking - code you added

---

## Issues in Code You Touched (Should Fix)

### MEDIUM

**7. `task_template` Column Has No Size Limit or Structural Validation** - `/Users/dean/Sandbox/delegate/src/implementations/database.ts:440` and `/Users/dean/Sandbox/delegate/src/implementations/schedule-repository.ts:402-405`
**Confidence: HIGH** (reinforced by security reviewer H2 who flagged `JSON.parse as DelegateRequest` as unsafe deserialization)

- **Problem**: `task_template TEXT NOT NULL` stores JSON-serialized `DelegateRequest` objects with no practical size limit. The Zod schema in the repository validates only that it is a non-empty string (`z.string()`), and `JSON.parse()` result is cast with `as DelegateRequest` without structural validation. The security reviewer correctly identifies this as inconsistent with the project's "parse, don't validate" principle.
- **Impact**: Potential for unbounded row sizes. A corrupted or tampered `task_template` could cause tasks to execute with unexpected parameters (security concern) or bloat the database (performance concern).
- **Fix**: Add both a length check and structural validation:
  ```typescript
  task_template: z.string().min(1).max(65536), // 64KB limit in Zod schema
  ```
  And validate the parsed JSON against a DelegateRequest Zod schema (as security reviewer H2 suggests).
- **Category**: Should-fix - same file as your changes

---

**8. `toMissedRunPolicy` and `toScheduleStatus` Silently Default on Unknown Values** - `/Users/dean/Sandbox/delegate/src/implementations/schedule-repository.ts:449-479`
**Confidence: HIGH** (independently identified by security M4, typescript, quality, and database reviewers - 4/4 agreement)

- **Problem**: Both conversion methods have a `default` case that returns `MissedRunPolicy.SKIP` and `ScheduleStatus.ACTIVE` respectively for unknown values. Since the Zod schema already validates the row, reaching the default case indicates a code/schema mismatch. Silently defaulting to ACTIVE is particularly dangerous because it would re-activate a schedule that should be in a different state.
- **Impact**: Data corruption goes unnoticed. A schedule in an unknown state gets treated as ACTIVE, potentially causing unintended executions.
- **Fix**: Throw an error in the default case:
  ```typescript
  default:
    throw new Error(`Unknown schedule status: ${value} - possible data corruption`);
  ```
- **Category**: Should-fix - code you added

---

## Cross-Reviewer Findings (Database-Relevant Issues Found by Others)

These issues were identified by other reviewers but have significant database implications:

**Quality H3: Infinite retrigger on `getNextRunTime` failure** - `/Users/dean/Sandbox/delegate/src/services/handlers/schedule-handler.ts:299-306`
**Confidence: HIGH** (quality reviewer identified, database reviewer confirms DB impact)

- **Database Impact**: When `getNextRunTime` fails, `nextRunAt` is not cleared, so the `findDue` query keeps returning the same schedule every 60-second tick. This creates an ever-growing set of "stuck" schedules that waste DB query time and trigger infinite event loops.

**Architecture CRITICAL: Dual-write on schedule creation** - `/Users/dean/Sandbox/delegate/src/adapters/mcp-adapter.ts:938` and `/Users/dean/Sandbox/delegate/src/services/handlers/schedule-handler.ts:210`
**Confidence: HIGH** (architecture, performance, quality, and database reviewers all identified)

- **Database Impact**: Every schedule creation performs two `INSERT OR REPLACE` operations. The first write (from MCP adapter) persists a schedule without `nextRunAt`. The second write (from handler) overwrites with `nextRunAt` computed. This doubles write I/O and relies on `INSERT OR REPLACE` silent-overwrite behavior.

---

## Pre-existing Issues (Not Blocking)

### MEDIUM

**9. No `down()` Migration Support** - `/Users/dean/Sandbox/delegate/src/implementations/database.ts:254-258`
**Confidence: HIGH** (unchallenged, pre-existing limitation)

- **Problem**: The migration framework only defines `up()` methods with no rollback (`down()`) support. Migration v4 creates two new tables and five indexes. If the migration needs to be reverted (e.g., bad deployment), there is no automated rollback path.
- **Impact**: Manual intervention required to rollback schema changes in production. This is a pre-existing architectural limitation (all four migrations lack `down()`), not introduced by this PR.
- **Fix**: Add `down` methods to the migration interface. For v4:
  ```typescript
  down: (db) => {
    db.exec(`
      DROP INDEX IF EXISTS idx_schedule_executions_status;
      DROP INDEX IF EXISTS idx_schedule_executions_schedule;
      DROP INDEX IF EXISTS idx_schedules_due;
      DROP INDEX IF EXISTS idx_schedules_next_run;
      DROP INDEX IF EXISTS idx_schedules_status;
      DROP TABLE IF EXISTS schedule_executions;
      DROP TABLE IF EXISTS schedules;
    `);
  }
  ```
- **Category**: Pre-existing

---

### LOW

**10. `idx_schedules_status` Index Is Redundant with `idx_schedules_due`** - `/Users/dean/Sandbox/delegate/src/implementations/database.ts:478-480`
**Confidence: HIGH** (unchallenged, straightforward index analysis)

- **Problem**: `idx_schedules_status` indexes `(status)` and `idx_schedules_due` indexes `(status, next_run_at)`. Queries that filter only on `status` (like `findByStatus`) can use the composite `idx_schedules_due` index as a covering prefix. The standalone `idx_schedules_status` is therefore redundant.
- **Impact**: Minor write overhead for maintaining an unnecessary index. Not significant for this workload.
- **Fix**: Remove `idx_schedules_status` since `idx_schedules_due` already covers status-only lookups.
- **Category**: Pre-existing pattern (applies to new code)

---

## Debate Notes

### Findings I Challenged (from other reviewers)

**Performance #3 (SELECT * on hot path) - Downgraded to LOW:**
SQLite is a row-store, not a column-store. `SELECT *` vs specific columns has negligible performance difference because SQLite reads entire pages regardless. The `findDue` query runs every 60 seconds against a typically small number of active schedules. The suggested fix of splitting into two queries (findDue without template, then findById with template) would double DB round-trips, contradicting the performance reviewer's own Finding #1 about reducing round-trips.

**Performance #4 (Zod validation on every row) - Rejected as premature optimization:**
The `findDue` hot path typically processes single-digit schedules. Zod parse overhead on <10 objects every 60 seconds is measured in microseconds. Removing boundary validation contradicts the project's "parse, don't validate" principle. The data integrity benefit far outweighs the negligible CPU cost at this scale.

**Security M2 (in-memory Map not persisted) - Reclassified to LOW design debt:**
The concern about process restart losing running state is valid but is a design gap, not a security vulnerability. The schedule_executions table already records triggered executions, providing a database-native recovery path on startup.

### My Findings That Were Challenged

**Finding #3 (CHECK constraints) - Scope narrowed after architecture reviewer challenge:**
Architecture reviewer argued that cross-column constraints (e.g., `scheduled_at NOT NULL WHEN schedule_type = 'one_time'`) are validated at two application layers and adding them to the schema complicates evolution. I concede on cross-column constraints but stand firm on numeric bounds (`run_count >= 0`, `max_runs > 0`) which have no equivalent application-layer validation.

**Finding #4 (INSERT OR REPLACE) - Confidence reduced to MEDIUM:**
The architecture reviewer's dual-write finding revealed that `INSERT OR REPLACE` is a symptom of the architecture problem, not the root cause. Fixing the architecture to use a single persistence path (recommended) makes this finding less critical. However, the dual-purpose `save()` method remains a design smell worth addressing.

**Finding #5 (silent delete) - Confidence reduced to LOW, downgraded to informational:**
Security reviewer successfully argued that idempotent deletes prevent information disclosure via differential error responses. The MCP adapter already verifies existence before deleting. I concede this point.

---

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 3 | 0 |
| Informational (downgraded) | 0 | 0 | 0 | 1 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 1 | 1 |

**Database Score**: 6/10

The schema design is solid in structure (proper FKs, CHECK constraints on enum columns, WAL mode, appropriate index selection for the primary query patterns). The use of Zod for boundary validation and prepared statements for performance are good practices. However, the absence of transaction protection on the read-modify-write `update()` path is a significant gap given the project's own documented requirement for TOCTOU protection. The unbounded `findByStatus` query, missing numeric CHECK constraints, and the silent enum defaults (cross-validated by 4 reviewers) also need attention.

**Recommendation**: CHANGES_REQUESTED

**Must fix before merge:**
1. Finding #1 (TOCTOU in update) - HIGH confidence, 4-reviewer consensus
2. Finding #2 (unbounded findByStatus) - HIGH confidence, 3-reviewer consensus

**Should fix before merge:**
3. Finding #3 (missing numeric CHECK constraints) - HIGH confidence
4. Finding #6 (missing composite index) - HIGH confidence
5. Finding #8 (silent enum defaults) - HIGH confidence, 4-reviewer consensus
6. Finding #7 (task_template validation) - HIGH confidence, reinforced by security

**Consider fixing:**
7. Finding #4 (INSERT OR REPLACE) - MEDIUM confidence, linked to architecture fix

**No change needed:**
8. Finding #5 (silent delete) - LOW confidence, downgraded after security reviewer challenge
