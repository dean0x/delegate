/**
 * SQLite-based task repository implementation
 * Handles persistence of tasks to database
 */

import SQLite from 'better-sqlite3';
import { z } from 'zod';
import { AGENT_PROVIDERS_TUPLE, AgentProvider } from '../core/agents.js';
import { OrchestratorId, Priority, Task, TaskId, TaskStatus, WorkerId } from '../core/domain.js';
import { AutobeatError, ErrorCode, operationErrorHandler } from '../core/errors.js';
import { SyncTaskOperations, TaskRepository } from '../core/interfaces.js';
import { err, ok, Result, tryCatchAsync } from '../core/result.js';
import { Database } from './database.js';

/**
 * Zod schema for validating database rows
 * Pattern: Parse, don't validate - ensures type safety at system boundary
 */
const TaskRowSchema = z.object({
  id: z.string().min(1),
  prompt: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
  priority: z.enum(['P0', 'P1', 'P2']),
  working_directory: z.string().nullable(),
  timeout: z.number().nullable(),
  max_output_buffer: z.number().nullable(),
  parent_task_id: z.string().nullable(),
  retry_count: z.number().nullable(),
  retry_of: z.string().nullable(),
  created_at: z.number(),
  started_at: z.number().nullable(),
  completed_at: z.number().nullable(),
  worker_id: z.string().nullable(),
  exit_code: z.number().nullable(),
  dependencies: z.string().nullable(),
  continue_from: z.string().nullable(),
  agent: z.enum(AGENT_PROVIDERS_TUPLE).nullable(),
  model: z.string().nullable(),
  orchestrator_id: z.string().nullable().optional(),
  system_prompt: z.string().nullable().optional(),
});

/**
 * Database row type for tasks table
 * TYPE-SAFETY: Explicit typing instead of Record<string, any>
 */
interface TaskRow {
  readonly id: string;
  readonly prompt: string;
  readonly status: string;
  readonly priority: string;
  readonly working_directory: string | null;
  readonly timeout: number | null;
  readonly max_output_buffer: number | null;
  readonly parent_task_id: string | null;
  readonly retry_count: number | null;
  readonly retry_of: string | null;
  readonly created_at: number;
  readonly started_at: number | null;
  readonly completed_at: number | null;
  readonly worker_id: string | null;
  readonly exit_code: number | null;
  readonly dependencies: string | null;
  readonly continue_from: string | null;
  readonly agent: string | null;
  readonly model: string | null;
  readonly orchestrator_id?: string | null;
  readonly system_prompt?: string | null;
}

export class SQLiteTaskRepository implements TaskRepository, SyncTaskOperations {
  private readonly db: SQLite.Database;
  private readonly saveStmt: SQLite.Statement;
  private readonly updateStmt: SQLite.Statement;
  private readonly findByIdStmt: SQLite.Statement;
  private readonly findAllUnboundedStmt: SQLite.Statement;
  private readonly findByStatusStmt: SQLite.Statement;
  private readonly deleteStmt: SQLite.Statement;
  private readonly cleanupOldTasksStmt: SQLite.Statement;
  private readonly countStmt: SQLite.Statement;
  private readonly countByStatusStmt: SQLite.Statement;
  private readonly findAllPaginatedStmt: SQLite.Statement;
  private readonly findUpdatedSinceStmt: SQLite.Statement;
  // v1.3.0 additions — cached to avoid re-prepare on every 1s dashboard poll
  private readonly findByOrchestratorIdStmt: SQLite.Statement;
  private readonly taskThroughputStmt: SQLite.Statement;
  private readonly loopThroughputStmt: SQLite.Statement;

  /** Default pagination limit for findAll() */
  private static readonly DEFAULT_LIMIT = 100;

  constructor(database: Database) {
    this.db = database.getDatabase();

    // Prepare statements for better performance
    this.saveStmt = this.db.prepare(`
      INSERT OR IGNORE INTO tasks (
        id, prompt, status, priority, working_directory,
        timeout, max_output_buffer,
        created_at, started_at, completed_at, worker_id, exit_code, dependencies,
        parent_task_id, retry_count, retry_of, continue_from, agent, model, orchestrator_id,
        system_prompt
      ) VALUES (
        @id, @prompt, @status, @priority, @workingDirectory,
        @timeout, @maxOutputBuffer,
        @createdAt, @startedAt, @completedAt, @workerId, @exitCode, @dependencies,
        @parentTaskId, @retryCount, @retryOf, @continueFrom, @agent, @model, @orchestratorId,
        @systemPrompt
      )
    `);

    // UPDATE preserves the row (unlike INSERT OR REPLACE which deletes + inserts,
    // triggering ON DELETE CASCADE/SET NULL on child tables like schedule_executions, task_checkpoints)
    this.updateStmt = this.db.prepare(`
      UPDATE tasks SET
        prompt = @prompt,
        status = @status,
        priority = @priority,
        working_directory = @workingDirectory,
        timeout = @timeout,
        max_output_buffer = @maxOutputBuffer,
        started_at = @startedAt,
        completed_at = @completedAt,
        worker_id = @workerId,
        exit_code = @exitCode,
        dependencies = @dependencies,
        parent_task_id = @parentTaskId,
        retry_count = @retryCount,
        retry_of = @retryOf,
        continue_from = @continueFrom,
        agent = @agent,
        model = @model,
        orchestrator_id = @orchestratorId,
        system_prompt = @systemPrompt
      WHERE id = @id
    `);

    this.findByIdStmt = this.db.prepare(`
      SELECT id, prompt, status, priority, working_directory,
             timeout, max_output_buffer, parent_task_id, retry_count, retry_of,
             created_at, started_at, completed_at, worker_id, exit_code,
             dependencies, continue_from, agent, model, orchestrator_id, system_prompt
      FROM tasks WHERE id = ?
    `);

    this.findAllUnboundedStmt = this.db.prepare(`
      SELECT id, prompt, status, priority, working_directory,
             timeout, max_output_buffer, parent_task_id, retry_count, retry_of,
             created_at, started_at, completed_at, worker_id, exit_code,
             dependencies, continue_from, agent, model, orchestrator_id, system_prompt
      FROM tasks ORDER BY created_at DESC
    `);

    this.findByStatusStmt = this.db.prepare(`
      SELECT id, prompt, status, priority, working_directory,
             timeout, max_output_buffer, parent_task_id, retry_count, retry_of,
             created_at, started_at, completed_at, worker_id, exit_code,
             dependencies, continue_from, agent, model, orchestrator_id, system_prompt
      FROM tasks WHERE status = ? ORDER BY created_at DESC
    `);

    this.countStmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM tasks
    `);

    this.countByStatusStmt = this.db.prepare(`
      SELECT status, COUNT(*) as count FROM tasks GROUP BY status
    `);

    this.findAllPaginatedStmt = this.db.prepare(`
      SELECT id, prompt, status, priority, working_directory,
             timeout, max_output_buffer, parent_task_id, retry_count, retry_of,
             created_at, started_at, completed_at, worker_id, exit_code,
             dependencies, continue_from, agent, model, orchestrator_id, system_prompt
      FROM tasks ORDER BY created_at DESC LIMIT ? OFFSET ?
    `);

    // NOTE: tasks table has no updated_at column — use completed_at (transition time) or created_at.
    // idx_tasks_updated_expr (migration v20) is a SQLite expression index on
    // COALESCE(completed_at, started_at, created_at) that covers this WHERE + ORDER BY.
    this.findUpdatedSinceStmt = this.db.prepare(`
      SELECT id, prompt, status, priority, working_directory,
             timeout, max_output_buffer, parent_task_id, retry_count, retry_of,
             created_at, started_at, completed_at, worker_id, exit_code,
             dependencies, continue_from, agent, model, orchestrator_id, system_prompt
      FROM tasks
      WHERE COALESCE(completed_at, started_at, created_at) >= ?
      ORDER BY COALESCE(completed_at, started_at, created_at) DESC
      LIMIT ?
    `);

    // findByOrchestratorId (no status filter) — cached for the common path.
    // The status-filter branch uses a dynamic IN-list and cannot share a single
    // prepared statement; it remains inline with a TODO comment below.
    this.findByOrchestratorIdStmt = this.db.prepare(`
      SELECT id, prompt, status, priority, working_directory,
             timeout, max_output_buffer, parent_task_id, retry_count, retry_of,
             created_at, started_at, completed_at, worker_id, exit_code,
             dependencies, continue_from, agent, model, orchestrator_id, system_prompt
      FROM tasks
      WHERE orchestrator_id = ?
      ORDER BY created_at DESC
    `);

    // getThroughputStats — two statements (tasks + loops), both cached.
    // COALESCE(completed_at, created_at) is covered by idx_tasks_updated_expr (v20)
    // for the WHERE clause filter.
    this.taskThroughputStmt = this.db.prepare(`
      SELECT
        COUNT(*)                                             AS total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
        AVG(CASE WHEN completed_at IS NOT NULL AND started_at IS NOT NULL
                 THEN completed_at - started_at END)         AS avg_duration_ms
      FROM tasks
      WHERE COALESCE(completed_at, created_at) >= ?
        AND status IN ('completed', 'failed', 'cancelled')
    `);

    this.loopThroughputStmt = this.db.prepare(`
      SELECT COUNT(*) AS total
      FROM loops
      WHERE COALESCE(completed_at, created_at) >= ?
        AND status IN ('completed', 'failed', 'cancelled')
    `);

    this.deleteStmt = this.db.prepare(`
      DELETE FROM tasks WHERE id = ?
    `);

    this.cleanupOldTasksStmt = this.db.prepare(`
      DELETE FROM tasks
      WHERE status IN ('completed', 'failed', 'cancelled')
      AND completed_at < ?
    `);
  }

  /**
   * Convert Task domain object to database parameter format.
   * Shared by both async (save/update) and sync (saveSync/updateSync) methods.
   * Includes createdAt — better-sqlite3 ignores named params not referenced by the statement.
   */
  private toDbFormat(task: Task): Record<string, unknown> {
    return {
      id: task.id,
      prompt: task.prompt,
      status: task.status,
      priority: task.priority,
      workingDirectory: task.workingDirectory || null,
      timeout: task.timeout ?? null,
      maxOutputBuffer: task.maxOutputBuffer ?? null,
      createdAt: task.createdAt,
      startedAt: task.startedAt || null,
      completedAt: task.completedAt || null,
      workerId: task.workerId || null,
      exitCode: task.exitCode ?? null,
      dependencies: null, // Dependencies stored in task_dependencies table
      parentTaskId: task.parentTaskId || null,
      retryCount: task.retryCount ?? null,
      retryOf: task.retryOf || null,
      continueFrom: task.continueFrom || null,
      agent: task.agent || null,
      model: task.model || null,
      orchestratorId: task.orchestratorId ?? null,
      systemPrompt: task.systemPrompt ?? null,
    };
  }

  async save(task: Task): Promise<Result<void>> {
    return tryCatchAsync(
      async () => {
        this.saveStmt.run(this.toDbFormat(task));
      },
      operationErrorHandler('save task', { taskId: task.id }),
    );
  }

  async update(taskId: TaskId, update: Partial<Task>): Promise<Result<void>> {
    const existingResult = await this.findById(taskId);

    if (!existingResult.ok) {
      return existingResult;
    }

    if (!existingResult.value) {
      return err(new AutobeatError(ErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`));
    }

    const updatedTask = { ...existingResult.value, ...update };

    return tryCatchAsync(
      async () => {
        this.updateStmt.run(this.toDbFormat(updatedTask));
      },
      operationErrorHandler('update task', { taskId }),
    );
  }

  // ============================================================================
  // SYNC METHODS (for use inside Database.runInTransaction())
  // These throw on error — the transaction wrapper catches and converts to Result.
  // ============================================================================

  saveSync(task: Task): void {
    this.saveStmt.run(this.toDbFormat(task));
  }

  findByIdSync(taskId: TaskId): Task | null {
    const row = this.findByIdStmt.get(taskId) as TaskRow | undefined;
    if (!row) return null;
    return this.rowToTask(row);
  }

  updateSync(taskId: TaskId, update: Partial<Task>): void {
    const existing = this.findByIdSync(taskId);
    if (!existing) {
      throw new AutobeatError(ErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`);
    }
    const updatedTask = { ...existing, ...update };
    this.updateStmt.run(this.toDbFormat(updatedTask));
  }

  async findById(taskId: TaskId): Promise<Result<Task | null>> {
    return tryCatchAsync(
      async () => {
        const row = this.findByIdStmt.get(taskId) as TaskRow | undefined;

        if (!row) {
          return null;
        }

        return this.rowToTask(row);
      },
      operationErrorHandler('find task', { taskId }),
    );
  }

  async findAll(limit?: number, offset?: number): Promise<Result<readonly Task[]>> {
    return tryCatchAsync(async () => {
      const effectiveLimit = limit ?? SQLiteTaskRepository.DEFAULT_LIMIT;
      const effectiveOffset = offset ?? 0;

      const rows = this.findAllPaginatedStmt.all(effectiveLimit, effectiveOffset) as TaskRow[];
      return rows.map((row) => this.rowToTask(row));
    }, operationErrorHandler('find all tasks'));
  }

  async findAllUnbounded(): Promise<Result<readonly Task[]>> {
    return tryCatchAsync(async () => {
      const rows = this.findAllUnboundedStmt.all() as TaskRow[];
      return rows.map((row) => this.rowToTask(row));
    }, operationErrorHandler('find all tasks (unbounded)'));
  }

  async count(): Promise<Result<number>> {
    return tryCatchAsync(async () => {
      const result = this.countStmt.get() as { count: number };
      return result.count;
    }, operationErrorHandler('count tasks'));
  }

  async findByStatus(status: string): Promise<Result<readonly Task[]>> {
    return tryCatchAsync(
      async () => {
        const rows = this.findByStatusStmt.all(status) as TaskRow[];
        return rows.map((row) => this.rowToTask(row));
      },
      operationErrorHandler('find tasks by status', { status }),
    );
  }

  async delete(taskId: TaskId): Promise<Result<void>> {
    return tryCatchAsync(
      async () => {
        this.deleteStmt.run(taskId);
      },
      operationErrorHandler('delete task', { taskId }),
    );
  }

  async cleanupOldTasks(olderThanMs: number): Promise<Result<number>> {
    return tryCatchAsync(async () => {
      const cutoffTime = Date.now() - olderThanMs;
      const result = this.cleanupOldTasksStmt.run(cutoffTime);
      return result.changes || 0;
    }, operationErrorHandler('cleanup old tasks'));
  }

  async countByStatus(): Promise<Result<Record<string, number>>> {
    return tryCatchAsync(async () => {
      const rows = this.countByStatusStmt.all() as Array<{ status: string; count: number }>;
      const counts: Record<string, number> = {};
      for (const row of rows) {
        counts[row.status] = row.count;
      }
      return counts;
    }, operationErrorHandler('count tasks by status'));
  }

  /**
   * Convert database row to Task domain object
   * Pattern: Validate at boundary - ensures data integrity from database
   * @throws Error if row data is invalid (indicates database corruption)
   */
  private rowToTask(row: TaskRow): Task {
    // Validate row data at system boundary (parse throws ZodError on invalid data)
    const data = TaskRowSchema.parse(row);
    return {
      id: data.id as TaskId,
      prompt: data.prompt,
      status: data.status as TaskStatus,
      priority: data.priority as Priority,
      workingDirectory: data.working_directory || undefined,
      timeout: data.timeout ?? undefined,
      maxOutputBuffer: data.max_output_buffer ?? undefined,
      parentTaskId: data.parent_task_id ? (data.parent_task_id as TaskId) : undefined,
      retryCount: data.retry_count ?? undefined,
      retryOf: data.retry_of ? (data.retry_of as TaskId) : undefined,
      continueFrom: data.continue_from ? (data.continue_from as TaskId) : undefined,
      agent: data.agent ?? undefined,
      model: data.model ?? undefined,
      orchestratorId: data.orchestrator_id ? (data.orchestrator_id as OrchestratorId) : undefined,
      systemPrompt: data.system_prompt ?? undefined,
      createdAt: data.created_at,
      startedAt: data.started_at || undefined,
      completedAt: data.completed_at || undefined,
      workerId: data.worker_id ? (data.worker_id as WorkerId) : undefined,
      exitCode: data.exit_code ?? undefined,
    };
  }

  async findByOrchestratorId(
    orchId: OrchestratorId,
    opts?: { statuses?: readonly string[] },
  ): Promise<Result<readonly Task[]>> {
    return tryCatchAsync(
      async () => {
        if (opts?.statuses && opts.statuses.length > 0) {
          // TODO: Dynamic IN-list prevents a single cached statement here.
          // Cache would require per-length variants or a different query strategy
          // (e.g., temp table or JSON-each). Left inline as the status-filter
          // path is only used by the drill-through view, not the 1s activity poll.
          const placeholders = opts.statuses.map(() => '?').join(', ');
          const stmt = this.db.prepare(`
            SELECT id, prompt, status, priority, working_directory,
                   timeout, max_output_buffer, parent_task_id, retry_count, retry_of,
                   created_at, started_at, completed_at, worker_id, exit_code,
                   dependencies, continue_from, agent, model, orchestrator_id, system_prompt
            FROM tasks
            WHERE orchestrator_id = ? AND status IN (${placeholders})
            ORDER BY created_at DESC
          `);
          const rows = stmt.all(orchId, ...opts.statuses) as TaskRow[];
          return rows.map((row) => this.rowToTask(row));
        }

        // Common (no status filter) path — uses cached statement.
        const rows = this.findByOrchestratorIdStmt.all(orchId) as TaskRow[];
        return rows.map((row) => this.rowToTask(row));
      },
      operationErrorHandler('find tasks by orchestrator', { orchestratorId: orchId }),
    );
  }

  async getThroughputStats(
    windowMs: number,
  ): Promise<Result<{ tasksPerHour: number; loopsPerHour: number; successRate: number; avgDurationMs: number }>> {
    return tryCatchAsync(async () => {
      const since = Date.now() - windowMs;
      const windowHours = windowMs / 3_600_000;

      // Count completed/failed tasks in window — uses cached statements.
      const taskStats = this.taskThroughputStmt.get(since) as {
        total: number;
        completed: number;
        avg_duration_ms: number | null;
      };

      const loopStats = this.loopThroughputStmt.get(since) as { total: number };

      const total = taskStats.total ?? 0;
      const completed = taskStats.completed ?? 0;
      const loopsTotal = loopStats.total ?? 0;

      return {
        tasksPerHour: windowHours > 0 ? total / windowHours : 0,
        loopsPerHour: windowHours > 0 ? loopsTotal / windowHours : 0,
        successRate: total > 0 ? completed / total : 0,
        avgDurationMs: taskStats.avg_duration_ms ?? 0,
      };
    }, operationErrorHandler('get throughput stats'));
  }

  async findUpdatedSince(sinceMs: number, limit: number): Promise<Result<readonly Task[]>> {
    return tryCatchAsync(
      async () => {
        const rows = this.findUpdatedSinceStmt.all(sinceMs, limit) as TaskRow[];
        return rows.map((row) => this.rowToTask(row));
      },
      operationErrorHandler('find tasks updated since', { sinceMs }),
    );
  }
}
