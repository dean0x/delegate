/**
 * SQLite-based usage repository implementation
 * Handles persistence and aggregation of task token/cost usage.
 *
 * ARCHITECTURE: Follows SQLiteOutputRepository pattern — prepared statements,
 * Result-wrapped, operationErrorHandler, no exceptions in business logic.
 * Pattern: Repository pattern with UPSERT for idempotency.
 * Rationale: Usage capture is best-effort at task completion; may be replayed
 * on retry, so idempotency is critical.
 */

import SQLite from 'better-sqlite3';
import { z } from 'zod';
import { LoopId, OrchestratorId, TaskId, TaskUsage } from '../core/domain.js';
import { operationErrorHandler } from '../core/errors.js';
import { UsageRepository } from '../core/interfaces.js';
import { Result, tryCatchAsync } from '../core/result.js';
import { Database } from './database.js';

// ============================================================================
// Zod schemas for boundary validation
// Pattern: Parse, don't validate — ensures type safety at system boundary
// ============================================================================

/**
 * Validates a raw task_usage row from the database.
 * All numeric columns are coerced via z.number() — SQLite returns JS numbers
 * for INTEGER/REAL columns so no coerce is needed, but the schema makes the
 * contract explicit and catches database corruption at the boundary.
 */
const TaskUsageRowSchema = z.object({
  task_id: z.string().min(1),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_creation_input_tokens: z.number(),
  cache_read_input_tokens: z.number(),
  total_cost_usd: z.number(),
  model: z.string().nullable(),
  captured_at: z.number(),
});

/**
 * Validates an aggregate row (SUM queries — no task_id or captured_at).
 * COALESCE in the SQL guarantees non-null numbers; schema confirms that
 * invariant at the boundary so downstream code never needs null-guards.
 */
const TaskUsageAggregateRowSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_creation_input_tokens: z.number(),
  cache_read_input_tokens: z.number(),
  total_cost_usd: z.number(),
});

/**
 * Validates a row returned by topOrchestrationsByCost (GROUP BY aggregate).
 */
const TopOrchestrationRowSchema = z.object({
  orchestration_id: z.string().min(1),
  total_cost: z.number(),
});

/**
 * Zero-value aggregate returned when no usage rows match a query.
 * Avoids null in aggregate methods — callers can always read numeric fields.
 */
const ZERO_USAGE = (taskId: TaskId = TaskId(''), capturedAt = 0): TaskUsage => ({
  taskId,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  totalCostUsd: 0,
  capturedAt,
});

export class SQLiteUsageRepository implements UsageRepository {
  private readonly db: SQLite.Database;
  private readonly saveStmt: SQLite.Statement;
  private readonly getStmt: SQLite.Statement;
  private readonly sumByOrchestrationStmt: SQLite.Statement;
  private readonly sumByLoopStmt: SQLite.Statement;
  private readonly sumGlobalStmt: SQLite.Statement;
  private readonly sumGlobalSinceStmt: SQLite.Statement;
  private readonly topOrchsByCostStmt: SQLite.Statement;

  constructor(database: Database) {
    this.db = database.getDatabase();

    // UPSERT: idempotent save — on conflict update all columns except task_id (PK)
    this.saveStmt = this.db.prepare(`
      INSERT INTO task_usage (
        task_id, input_tokens, output_tokens,
        cache_creation_input_tokens, cache_read_input_tokens,
        total_cost_usd, model, captured_at
      ) VALUES (
        @taskId, @inputTokens, @outputTokens,
        @cacheCreationInputTokens, @cacheReadInputTokens,
        @totalCostUsd, @model, @capturedAt
      )
      ON CONFLICT(task_id) DO UPDATE SET
        input_tokens                = excluded.input_tokens,
        output_tokens               = excluded.output_tokens,
        cache_creation_input_tokens = excluded.cache_creation_input_tokens,
        cache_read_input_tokens     = excluded.cache_read_input_tokens,
        total_cost_usd              = excluded.total_cost_usd,
        model                       = excluded.model,
        captured_at                 = excluded.captured_at
    `);

    this.getStmt = this.db.prepare(`
      SELECT * FROM task_usage WHERE task_id = ?
    `);

    // Recursive CTE walks the retry chain so retries roll up into root task cost.
    // idx_tasks_retry_of (migration v20) covers the recursive JOIN on tasks.retry_of.
    this.sumByOrchestrationStmt = this.db.prepare(`
      WITH RECURSIVE task_tree(root_id, task_id) AS (
        -- Base: tasks directly attributed OR via loop iterations
        SELECT id AS root_id, id AS task_id
          FROM tasks
          WHERE orchestrator_id = ?
             OR id IN (
               SELECT task_id FROM loop_iterations
                 WHERE loop_id = (SELECT loop_id FROM orchestrations WHERE id = ?)
                   AND task_id IS NOT NULL
             )
        UNION
        -- Recurse: retries of tasks already in the tree
        SELECT tt.root_id, t.id
          FROM tasks t
          INNER JOIN task_tree tt ON t.retry_of = tt.task_id
      )
      SELECT
        COALESCE(SUM(u.input_tokens), 0)                 AS input_tokens,
        COALESCE(SUM(u.output_tokens), 0)                AS output_tokens,
        COALESCE(SUM(u.cache_creation_input_tokens), 0)  AS cache_creation_input_tokens,
        COALESCE(SUM(u.cache_read_input_tokens), 0)      AS cache_read_input_tokens,
        COALESCE(SUM(u.total_cost_usd), 0)               AS total_cost_usd
      FROM task_tree tt
      LEFT JOIN task_usage u ON u.task_id = tt.task_id
    `);

    this.sumByLoopStmt = this.db.prepare(`
      SELECT
        COALESCE(SUM(u.input_tokens), 0)                 AS input_tokens,
        COALESCE(SUM(u.output_tokens), 0)                AS output_tokens,
        COALESCE(SUM(u.cache_creation_input_tokens), 0)  AS cache_creation_input_tokens,
        COALESCE(SUM(u.cache_read_input_tokens), 0)      AS cache_read_input_tokens,
        COALESCE(SUM(u.total_cost_usd), 0)               AS total_cost_usd
      FROM loop_iterations li
      LEFT JOIN task_usage u ON u.task_id = li.task_id
      WHERE li.loop_id = ?
    `);

    // sumGlobal has two variants (with/without sinceMs). Both are cached to
    // avoid re-preparing on every 1s poll. The calling method selects the
    // correct statement based on whether sinceMs is defined.
    this.sumGlobalStmt = this.db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0)                 AS input_tokens,
        COALESCE(SUM(output_tokens), 0)                AS output_tokens,
        COALESCE(SUM(cache_creation_input_tokens), 0)  AS cache_creation_input_tokens,
        COALESCE(SUM(cache_read_input_tokens), 0)      AS cache_read_input_tokens,
        COALESCE(SUM(total_cost_usd), 0)               AS total_cost_usd
      FROM task_usage
    `);

    this.sumGlobalSinceStmt = this.db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0)                 AS input_tokens,
        COALESCE(SUM(output_tokens), 0)                AS output_tokens,
        COALESCE(SUM(cache_creation_input_tokens), 0)  AS cache_creation_input_tokens,
        COALESCE(SUM(cache_read_input_tokens), 0)      AS cache_read_input_tokens,
        COALESCE(SUM(total_cost_usd), 0)               AS total_cost_usd
      FROM task_usage
      WHERE captured_at >= ?
    `);

    this.topOrchsByCostStmt = this.db.prepare(`
      SELECT
        t.orchestrator_id AS orchestration_id,
        COALESCE(SUM(u.total_cost_usd), 0) AS total_cost
      FROM task_usage u
      JOIN tasks t ON t.id = u.task_id
      WHERE u.captured_at >= ?
        AND t.orchestrator_id IS NOT NULL
      GROUP BY t.orchestrator_id
      ORDER BY total_cost DESC
      LIMIT ?
    `);
  }

  async save(usage: TaskUsage): Promise<Result<void>> {
    return tryCatchAsync(
      async () => {
        this.saveStmt.run({
          taskId: usage.taskId,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheCreationInputTokens: usage.cacheCreationInputTokens,
          cacheReadInputTokens: usage.cacheReadInputTokens,
          totalCostUsd: usage.totalCostUsd,
          model: usage.model ?? null,
          capturedAt: usage.capturedAt,
        });
      },
      operationErrorHandler('save task usage', { taskId: usage.taskId }),
    );
  }

  async get(taskId: TaskId): Promise<Result<TaskUsage | null>> {
    return tryCatchAsync(
      async () => {
        const row = this.getStmt.get(taskId);
        if (!row) return null;
        return this.rowToUsage(TaskUsageRowSchema.parse(row));
      },
      operationErrorHandler('get task usage', { taskId }),
    );
  }

  /**
   * Sum tokens/cost for all tasks attributed to an orchestration.
   * Follows retry_of chains so retries roll up into the root task cost.
   *
   * ARCHITECTURE: Uses a recursive CTE to walk the retry chain so that
   * each task is counted once, regardless of how many retries it has.
   * idx_tasks_retry_of (migration v20) covers the recursive JOIN.
   */
  async sumByOrchestrationId(orchId: OrchestratorId): Promise<Result<TaskUsage>> {
    return tryCatchAsync(
      async () => {
        const row = this.sumByOrchestrationStmt.get(orchId, orchId);
        return this.aggregateRowToUsage(TaskUsageAggregateRowSchema.parse(row));
      },
      operationErrorHandler('sum usage by orchestration', { orchestratorId: orchId }),
    );
  }

  async sumByLoopId(loopId: LoopId): Promise<Result<TaskUsage>> {
    return tryCatchAsync(
      async () => {
        const row = this.sumByLoopStmt.get(loopId);
        return this.aggregateRowToUsage(TaskUsageAggregateRowSchema.parse(row));
      },
      operationErrorHandler('sum usage by loop', { loopId }),
    );
  }

  async sumGlobal(sinceMs?: number): Promise<Result<TaskUsage>> {
    return tryCatchAsync(async () => {
      // Two cached statements: one with WHERE captured_at >= ?, one without.
      // Dynamic SQL (optional WHERE) prevents a single cached statement here.
      const row = sinceMs !== undefined ? this.sumGlobalSinceStmt.get(sinceMs) : this.sumGlobalStmt.get();
      return this.aggregateRowToUsage(TaskUsageAggregateRowSchema.parse(row));
    }, operationErrorHandler('sum global usage'));
  }

  async topOrchestrationsByCost(
    sinceMs: number,
    limit: number,
  ): Promise<Result<readonly { orchestrationId: OrchestratorId; totalCost: number }[]>> {
    return tryCatchAsync(async () => {
      const rows = this.topOrchsByCostStmt.all(sinceMs, limit) as unknown[];
      return rows.map((r) => {
        const parsed = TopOrchestrationRowSchema.parse(r);
        return {
          orchestrationId: parsed.orchestration_id as OrchestratorId,
          totalCost: parsed.total_cost,
        };
      });
    }, operationErrorHandler('top orchestrations by cost'));
  }

  // ============================================================================
  // Private helpers
  // ============================================================================

  private rowToUsage(row: z.infer<typeof TaskUsageRowSchema>): TaskUsage {
    return {
      taskId: row.task_id as TaskId,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheCreationInputTokens: row.cache_creation_input_tokens,
      cacheReadInputTokens: row.cache_read_input_tokens,
      totalCostUsd: row.total_cost_usd,
      model: row.model ?? undefined,
      capturedAt: row.captured_at,
    };
  }

  private aggregateRowToUsage(row: z.infer<typeof TaskUsageAggregateRowSchema>): TaskUsage {
    return {
      taskId: TaskId(''),
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheCreationInputTokens: row.cache_creation_input_tokens,
      cacheReadInputTokens: row.cache_read_input_tokens,
      totalCostUsd: row.total_cost_usd,
      capturedAt: 0,
    };
  }
}
