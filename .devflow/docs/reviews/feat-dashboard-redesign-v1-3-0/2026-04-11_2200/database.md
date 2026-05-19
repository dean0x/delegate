# Database Review Report

**Branch**: feat/dashboard-redesign-v1.3.0 -> main
**Date**: 2026-04-11 22:00
**PR**: dean0x/autobeat#133 (dashboard redesign v1.3.0)
**Methodology**: devflow:review-methodology + devflow:database

---

## Issues in Your Changes (BLOCKING)

### CRITICAL

_None._

### HIGH

**Missing index on `tasks.retry_of` makes recursive CTE quadratic** — `src/implementations/usage-repository.ts:106-131`
**Confidence**: 92%
- Problem: `sumByOrchestrationId()` runs a `WITH RECURSIVE task_tree` that joins
  `tasks t INNER JOIN task_tree tt ON t.retry_of = tt.task_id` on every recursion
  step. There is **no index on `tasks.retry_of`** anywhere in the migration set
  (grep `idx_tasks_retry_of` returns no matches; the only `tasks` indexes are
  `status`, `priority`, `created_at`, and the new partial `orchestrator_id`).
  Each recursion level therefore scans the entire `tasks` table. The dashboard
  workspace view calls this query every 1s polling tick (`use-dashboard-data.ts:273`,
  `use-dashboard-data.ts:343`), so once `tasks` grows past a few thousand rows
  the workspace view becomes the dominant CPU consumer of the SQLite connection.
- Impact: O(rows * retry_chain_depth) per dashboard tick. At 10k tasks and 1Hz
  polling that is 10k row scans per second purely for cost rollups.
- Fix: Add a non-partial index in a follow-up migration (forward-only):
  ```ts
  // migration v20
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_retry_of ON tasks(retry_of) WHERE retry_of IS NOT NULL`);
  ```
  Use a partial index because the column is NULL for the vast majority of tasks
  (only retried tasks set it). This is the same pattern as the v18 partial index
  on `orchestrator_id`. Verify with `EXPLAIN QUERY PLAN` after the migration.

**Statements re-prepared inside hot-path query methods (1Hz polling)** — multiple files
**Confidence**: 88%
- `src/implementations/usage-repository.ts:106` — `sumByOrchestrationId` calls `this.db.prepare(...)`
- `src/implementations/usage-repository.ts:142` — `sumByLoopId` calls `this.db.prepare(...)`
- `src/implementations/usage-repository.ts:164,174` — `sumGlobal` (both branches) call `this.db.prepare(...)`
- `src/implementations/usage-repository.ts:197` — `topOrchestrationsByCost` calls `this.db.prepare(...)`
- `src/implementations/orchestration-repository.ts:427` — `getOrchestratorChildren` calls `this.db.prepare(...)`
- `src/implementations/orchestration-repository.ts:490` — `countOrchestratorChildren` calls `this.db.prepare(...)`
- `src/implementations/orchestration-repository.ts:514` — `findUpdatedSince` calls `this.db.prepare(...)`
- `src/implementations/loop-repository.ts:751` — `findUpdatedSince` calls `this.db.prepare(...)`
- `src/implementations/schedule-repository.ts:719` — `findUpdatedSince` calls `this.db.prepare(...)`
- `src/implementations/task-repository.ts:430,447` — `getThroughputStats` (2 statements)
- `src/implementations/task-repository.ts:393,406` — `findByOrchestratorId` (both branches)
- Problem: better-sqlite3 has **no internal prepared-statement cache**. Every
  call to `db.prepare()` re-parses, re-binds, and re-compiles the SQL via the
  SQLite VM bytecode generator. The constructor of every other repository in
  this codebase (and the constructors of these same files for save/find/update)
  caches statements as instance fields — that pattern was abandoned for the
  v1.3.0 additions and the throughput stats query.

  When the dashboard is on the metrics view, `fetchMetricsExtras` runs
  (`use-dashboard-data.ts:204`):
  - 1× `usageRepository.sumGlobal` (1 prepare)
  - 1× `usageRepository.topOrchestrationsByCost` (1 prepare)
  - 1× `taskRepository.getThroughputStats` (2 prepares)
  - 1× `loopRepository.findUpdatedSince` (1 prepare)
  - 1× `orchestrationRepository.findUpdatedSince` (1 prepare)
  - 1× `scheduleRepository.findUpdatedSince` (1 prepare)
  → **7 unnecessary prepare() calls per second** while the metrics view is open.

  When the workspace/orchestration-detail view is open, `fetchWorkspaceExtras`
  and `fetchDetailExtra` add another 2-3 prepare() calls per second (children +
  count + cost).
- Impact: Wasted CPU on every dashboard poll. SQLite parser is fast (~tens of
  microseconds), so this is not a P0 outage, but it is a regression from the
  pre-v1.3.0 caching pattern and it does not match the constructor-prepared
  style used by the same files for find/save/update.
- Fix: Cache the new statements as instance fields in the constructor, matching
  the existing pattern. Example for `usage-repository.ts`:
  ```ts
  constructor(database: Database) {
    this.db = database.getDatabase();
    this.saveStmt = this.db.prepare(...);
    this.getStmt = this.db.prepare(...);
    // Add:
    this.sumByOrchIdStmt = this.db.prepare(`WITH RECURSIVE ... `);
    this.sumByLoopIdStmt = this.db.prepare(...);
    this.sumGlobalStmt = this.db.prepare(...);            // no WHERE
    this.sumGlobalSinceStmt = this.db.prepare(...);       // with WHERE captured_at >= ?
    this.topOrchsByCostStmt = this.db.prepare(...);
  }
  ```
  Same change in `orchestration-repository.ts` (`getOrchestratorChildren`,
  `countOrchestratorChildren`, `findUpdatedSince`), `loop-repository.ts`
  (`findUpdatedSince`), `schedule-repository.ts` (`findUpdatedSince`), and
  `task-repository.ts` (`getThroughputStats`'s two statements). For
  `findByOrchestratorId` cache the no-status-filter statement; the
  status-filter branch must remain dynamic because the placeholder count varies.

### MEDIUM

**Missing `updated_at` index on loops/schedules/orchestrations forces full scan + sort every poll** — `src/implementations/database.ts` (no migration), `src/implementations/loop-repository.ts:751`, `schedule-repository.ts:719`, `orchestration-repository.ts:514`
**Confidence**: 85%
- Problem: All three `findUpdatedSince` queries do
  `WHERE updated_at >= ? ORDER BY updated_at DESC LIMIT ?`. There is no index
  on `loops.updated_at`, `schedules.updated_at`, or `orchestrations.updated_at`
  (grep on `idx_.*updated_at` returns zero matches in `database.ts`). Each query
  is a full table scan + in-memory sort on every dashboard tick (1Hz). For the
  metrics view, this happens 3 times per second.
- Impact: Linear in the number of loops/schedules/orchestrations per poll.
  Acceptable today (small N), but the cost grows with usage and the queries
  are explicitly designed for time-window pagination — exactly the kind of
  query that should be index-backed.
- Fix: Add a follow-up migration (forward-only):
  ```ts
  // migration v20
  db.exec(`CREATE INDEX IF NOT EXISTS idx_loops_updated_at ON loops(updated_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_schedules_updated_at ON schedules(updated_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_orchestrations_updated_at ON orchestrations(updated_at)`);
  ```

**`tasks.findUpdatedSince` cannot use any index on its time-window predicate** — `src/implementations/task-repository.ts:170-179`
**Confidence**: 85%
- Problem: The query is
  ```sql
  WHERE COALESCE(completed_at, started_at, created_at) >= ?
  ORDER BY COALESCE(completed_at, started_at, created_at) DESC
  LIMIT ?
  ```
  SQLite cannot use an index for a `COALESCE` expression unless an
  expression-based index covers exactly that expression. None of the existing
  `tasks` indexes (`status`, `priority`, `created_at`, partial
  `orchestrator_id`) help. The query must scan the entire `tasks` table on
  every dashboard tick (1 Hz).
- Impact: Same as above — linear per-poll cost in `tasks` row count. With
  `findAll(50)` already keeping the table hot in cache the absolute cost is
  small, but it scales poorly and the dashboard polls this every second.
- Fix: Either
  1. Add an expression index:
     ```sql
     CREATE INDEX idx_tasks_activity_time
       ON tasks(COALESCE(completed_at, started_at, created_at) DESC);
     ```
     SQLite supports indexes on expressions since 3.9.0; the planner will use
     it as long as the query expression text matches, OR
  2. Add an `updated_at` column to `tasks` (filled by the same handlers that
     write `started_at`/`completed_at`) and index it. Cleaner long-term.
  Option 1 is the smaller change for a v1.3.x patch.

**`countOrchestratorChildren` re-runs the full UNION CTE on every poll for pagination footer** — `src/implementations/orchestration-repository.ts:487-509`
**Confidence**: 82%
- Problem: When the orchestration-detail view is open, `fetchDetailExtra`
  fires `getOrchestratorChildren` AND `countOrchestratorChildren` AND
  `sumByOrchestrationId` in parallel — three independent walks of the same
  UNION (direct + iteration) every 1 second. The count query also does a
  full materialization and `COUNT(DISTINCT task_id)` which is more expensive
  than the children query because it cannot use the LIMIT optimization.
- Impact: For an orchestration with many sub-tasks (the very thing the
  drill-through view exists to show), the dashboard does 3× the necessary
  work per poll. The count rarely changes between polls — caching it in
  React state and only re-fetching on entity-count change would eliminate
  most of the load.
- Fix: One of:
  1. Cache the count in the dashboard hook and only refresh when an
     orchestration child is added/removed (event-driven invalidation), or
  2. Combine count and children into a single CTE that emits one row of
     count plus the page rows (windowed query), or
  3. At minimum, only re-fetch the count when `childPage` changes or every
     N polls (e.g. once per 5 s) instead of every tick.

**`getOrchestratorChildren` ORDER BY uses an unindexable expression** — `src/implementations/orchestration-repository.ts:431,438,452`
**Confidence**: 80%
- Problem: The CTE projects
  `COALESCE(t.completed_at, t.started_at, t.created_at) AS updated_at`
  and the outer query does `ORDER BY updated_at DESC, created_at DESC`.
  Because `updated_at` is a CTE projection over `COALESCE`, SQLite must
  materialize the entire deduped result and sort it in memory before
  applying LIMIT/OFFSET. For an orchestration with thousands of children
  this is a full scan of every attributed row plus an O(n log n) sort,
  per dashboard tick. The pagination semantics are correct, but the
  performance is unbounded by the page size.
- Impact: The drill-through view becomes O(total children) per poll, not
  O(page size). The current scale (rare orchestrations with 100s of children)
  is fine but the asymptote is poor.
- Fix: Two complementary options:
  1. Persist a real `updated_at` column on `tasks` that is set whenever
     `started_at` or `completed_at` is written — then index it and use it
     directly in the ORDER BY, or
  2. Lower the polling frequency for the workspace/detail view (e.g. 2-3 s
     instead of 1 s) since orchestration children change infrequently.
  Option 1 is the structural fix; option 2 is a stop-gap.

### LOW

**`task_usage` lacks a covering index for `(orchestrator_id, captured_at)` join in `topOrchestrationsByCost`** — `src/implementations/usage-repository.ts:197-208`
**Confidence**: 80%
- Problem: The query is
  ```sql
  SELECT t.orchestrator_id, COALESCE(SUM(u.total_cost_usd), 0)
  FROM task_usage u
  JOIN tasks t ON t.id = u.task_id
  WHERE u.captured_at >= ?
    AND t.orchestrator_id IS NOT NULL
  GROUP BY t.orchestrator_id
  ORDER BY total_cost DESC LIMIT ?
  ```
  The `idx_task_usage_captured_at` index handles the time filter, then each
  matching row does a PK lookup on `tasks(id)` (fast), then filters by
  `orchestrator_id IS NOT NULL`. The `idx_tasks_orchestrator_id` partial
  index isn't used here because we're driving from `task_usage`. This is
  acceptable for "top 3 in last 24h" but not for larger windows.
- Impact: Today: minimal. Long-term: degrades as `task_usage` grows.
- Fix: No urgent change required. If this becomes hot, consider denormalizing
  `orchestrator_id` onto `task_usage` so the GROUP BY can run without the join.

---

## Issues in Code You Touched (Should Fix)

_None — issues above are all in newly added/modified code._

---

## Pre-existing Issues (Not Blocking)

**`findAll(LIMIT)` queries on `loops`, `schedules`, `orchestrations` lack a `created_at` index** — `src/implementations/database.ts:614-744`, repos at `loop-repository.ts:247`, `schedule-repository.ts:249`, `orchestration-repository.ts:124`
**Confidence**: 90%
- Problem: All three tables order by `created_at DESC LIMIT ?` without an index
  on `created_at`. The migrations only added `idx_*_status` and a few specific
  indexes (e.g. `idx_loops_schedule_id`, `idx_schedules_next_run`). Only `tasks`
  has `idx_tasks_created_at`.
- Impact: Pre-existing — predates this PR. Each `findAll` poll is a full scan +
  sort. Becomes a problem when the user accumulates many orchestrations/loops.
  This PR adds a 1Hz polling pattern over these three tables, so the impact of
  the missing index is now amplified.
- Fix: In a separate cleanup migration, add `idx_loops_created_at`,
  `idx_schedules_created_at`, `idx_orchestrations_created_at`.

---

## Suggestions (Lower Confidence)

- **`task_usage.task_id` is the PK and has no separate index — joins via `task_id` are fine but writes that update by `(captured_at, model)` would not have an index** — `src/implementations/database.ts:789` (Confidence: 65%) — Currently no such queries exist, but if a future feature adds "show usage for model X", consider an index on `model`.
- **Migration v18's partial index `WHERE orchestrator_id IS NOT NULL` may not be picked by the planner if the query is `WHERE orchestrator_id = ?` and the planner cannot prove `?` is non-NULL** — `src/implementations/database.ts:778` (Confidence: 70%) — In practice SQLite handles equality predicates fine and the planner will use the partial index, but this is worth verifying with `EXPLAIN QUERY PLAN SELECT ... WHERE orchestrator_id = 'abc'`.
- **`isProcessAlive` in `use-dashboard-data.ts:49` runs `process.kill(pid, 0)` per RUNNING orchestration on every 1Hz poll** — Not strictly a database issue, but inflates the per-tick work and pairs with the per-poll prepared-statement compilations to make the dashboard hot loop expensive (Confidence: 65%).

---

## Verification Notes

Migration safety review of v18 + v19:

- **v18** (`ALTER TABLE tasks ADD COLUMN orchestrator_id TEXT REFERENCES orchestrations(id) ON DELETE SET NULL`):
  - Forward-only: yes (consistent with codebase convention).
  - Nullable: yes (no default, no NOT NULL) — safe for existing rows.
  - SQLite restriction compliance: when adding a column with `REFERENCES` while
    `foreign_keys = ON`, the column must default to NULL. This migration's column
    has no explicit default, which means implicit NULL — compliant.
  - FK enforcement: SQLite does NOT validate the FK against existing rows when
    added via ALTER TABLE; future inserts/updates are validated. Existing rows
    all have `orchestrator_id = NULL` (the only valid value at migration time),
    so no risk of orphans.
  - Partial index `WHERE orchestrator_id IS NOT NULL`: correct pattern for a
    column that is NULL in the vast majority of rows. SQLite 3.8.0+ required.
- **v19** (`CREATE TABLE task_usage`):
  - `task_id PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE`: correct.
    Cascade ensures usage rows are removed when their parent task is deleted,
    so the cleanup path in `task-repository.ts:cleanupOldTasks` does not orphan
    usage rows.
  - `captured_at INTEGER NOT NULL` with `idx_task_usage_captured_at`: correct
    for time-window aggregates.
  - `total_cost_usd REAL NOT NULL DEFAULT 0`: REAL is fine for USD costs at
    Claude's scale; floating-point precision is not a concern at the cents
    level for $0.01-$10/task amounts.
  - No CHECK constraints on token counts (e.g. `>= 0`). Defense-in-depth would
    add `CHECK (input_tokens >= 0)` etc., but pre-existing tables also lack
    CHECK constraints on numeric fields, so this is consistency-preserving.

Both migrations are well-formed, idempotent (`IF NOT EXISTS`), and respect
the project's forward-only convention. **No migration-level blockers.**

Parameterization review:
- All queries reviewed use `?` positional or `@named` parameters.
  No string interpolation anywhere in this PR's diff. **No SQL injection risk.**
- The dynamic `IN (?, ?, ...)` placeholder construction in
  `task-repository.ts:findByOrchestratorId` is built from
  `opts.statuses.map(() => '?').join(', ')` — placeholder count comes from the
  array length, values are passed via spread. Safe.

Transaction review:
- `getOrchestratorChildren`, `countOrchestratorChildren`, `sumByOrchestrationId`,
  `sumByLoopId`, `sumGlobal`, `topOrchestrationsByCost`, `findUpdatedSince`
  (all four), `getThroughputStats`, `findByOrchestratorId` are all read-only
  and run outside any transaction — correct, since they don't need TOCTOU
  protection and WAL mode allows them to run concurrently with writes.
- `UsageCaptureHandler.captureUsage` writes via `usageRepository.save` outside
  any transaction. This is correct because (a) the save is idempotent
  (UPSERT on `task_id` PK) and (b) it must not block the event-handler chain
  with a write lock.
- `OrchestrationManagerService.cancelAttributedTasks` does N sequential
  `taskManager.cancel(...)` calls in a `for` loop — not wrapped in a transaction.
  This is fine because each cancel emits its own event and the loop is a
  best-effort cascade ("errors logged, never block").
- Migration v18 and v19 run inside `db.transaction(...)` per `applyMigrations`
  — correct.

WAL checkpoint review:
- No new long-running transactions introduced. The longest write path is
  `OrchestrationManagerService.createOrchestration` which is sequential async
  calls with each repo write in its own implicit transaction.
- The recursive CTE in `sumByOrchestrationId` runs as a read query under WAL
  snapshot — does not hold a write lock, does not block checkpoints.

---

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 4 | 1 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Database Score**: 7/10
- Schema migrations: clean, safe, conformant. (+)
- Parameterization: no injection vectors. (+)
- Transaction usage: appropriate (read-only queries outside transactions, writes idempotent). (+)
- Index hygiene: regression. New hot queries (1Hz polling) lack indexes on `retry_of`, `updated_at`, and the `COALESCE` activity-time expression. (-)
- Prepared-statement caching: regression. New v1.3.0 query methods abandon the constructor-cached pattern used elsewhere in the same files. (-)

**Recommendation**: **APPROVED_WITH_CONDITIONS**

The migrations themselves are solid and the schema design (FK with CASCADE/SET NULL,
partial index on `orchestrator_id`, captured_at index) is appropriate. The
blockers are all index-and-caching issues that surface only under sustained
1Hz polling — which is exactly what this PR introduces.

Conditions before merge:
1. Cache the prepared statements introduced in v1.3.0 in their respective
   constructors (HIGH severity #2 above) — small mechanical change, matches
   existing pattern in the same files.
2. File a follow-up migration v20 that adds the missing indexes:
   - `idx_tasks_retry_of` (partial, for the recursive CTE)
   - `idx_loops_updated_at`, `idx_schedules_updated_at`, `idx_orchestrations_updated_at`
     (for the activity feed)
   - Optionally: an expression index on `tasks(COALESCE(completed_at, started_at, created_at))`
     or a real `tasks.updated_at` column.

If the team prefers a single follow-up PR for both fixes, that is acceptable —
none of these issues cause data corruption or correctness bugs, only
performance regressions that scale with usage.
