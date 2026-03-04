/**
 * SQLite-based task repository implementation
 * Handles persistence of tasks to database
 */

import SQLite from 'better-sqlite3';
import { z } from 'zod';
import { AgentProvider } from '../core/agents.js';
import { Priority, Task, TaskId, TaskStatus, WorkerId } from '../core/domain.js';
import { BackbeatError, ErrorCode, operationErrorHandler } from '../core/errors.js';
import { TaskRepository } from '../core/interfaces.js';
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
  agent: z.enum(['claude', 'codex', 'gemini']).nullable(),
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
}

export class SQLiteTaskRepository implements TaskRepository {
  private readonly db: SQLite.Database;
  private readonly saveStmt: SQLite.Statement;
  private readonly updateStmt: SQLite.Statement;
  private readonly findByIdStmt: SQLite.Statement;
  private readonly findAllUnboundedStmt: SQLite.Statement;
  private readonly findByStatusStmt: SQLite.Statement;
  private readonly deleteStmt: SQLite.Statement;
  private readonly cleanupOldTasksStmt: SQLite.Statement;
  private readonly countStmt: SQLite.Statement;
  private readonly findAllPaginatedStmt: SQLite.Statement;

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
        parent_task_id, retry_count, retry_of, continue_from, agent
      ) VALUES (
        @id, @prompt, @status, @priority, @workingDirectory,
        @timeout, @maxOutputBuffer,
        @createdAt, @startedAt, @completedAt, @workerId, @exitCode, @dependencies,
        @parentTaskId, @retryCount, @retryOf, @continueFrom, @agent
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
        agent = @agent
      WHERE id = @id
    `);

    this.findByIdStmt = this.db.prepare(`
      SELECT id, prompt, status, priority, working_directory,
             timeout, max_output_buffer, parent_task_id, retry_count, retry_of,
             created_at, started_at, completed_at, worker_id, exit_code,
             dependencies, continue_from, agent
      FROM tasks WHERE id = ?
    `);

    this.findAllUnboundedStmt = this.db.prepare(`
      SELECT id, prompt, status, priority, working_directory,
             timeout, max_output_buffer, parent_task_id, retry_count, retry_of,
             created_at, started_at, completed_at, worker_id, exit_code,
             dependencies, continue_from, agent
      FROM tasks ORDER BY created_at DESC
    `);

    this.findByStatusStmt = this.db.prepare(`
      SELECT id, prompt, status, priority, working_directory,
             timeout, max_output_buffer, parent_task_id, retry_count, retry_of,
             created_at, started_at, completed_at, worker_id, exit_code,
             dependencies, continue_from, agent
      FROM tasks WHERE status = ? ORDER BY created_at DESC
    `);

    this.countStmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM tasks
    `);

    this.findAllPaginatedStmt = this.db.prepare(`
      SELECT id, prompt, status, priority, working_directory,
             timeout, max_output_buffer, parent_task_id, retry_count, retry_of,
             created_at, started_at, completed_at, worker_id, exit_code,
             dependencies, continue_from, agent
      FROM tasks ORDER BY created_at DESC LIMIT ? OFFSET ?
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

  async save(task: Task): Promise<Result<void>> {
    return tryCatchAsync(
      async () => {
        // Convert task to database format
        const dbTask = {
          id: task.id,
          prompt: task.prompt,
          status: task.status,
          priority: task.priority,
          workingDirectory: task.workingDirectory || null,
          timeout: task.timeout || null,
          maxOutputBuffer: task.maxOutputBuffer || null,
          createdAt: task.createdAt,
          startedAt: task.startedAt || null,
          completedAt: task.completedAt || null,
          workerId: task.workerId || null,
          exitCode: task.exitCode ?? null,
          dependencies: null, // Dependencies stored in task_dependencies table
          parentTaskId: task.parentTaskId || null,
          retryCount: task.retryCount || null,
          retryOf: task.retryOf || null,
          continueFrom: task.continueFrom || null,
          agent: task.agent || null,
        };

        this.saveStmt.run(dbTask);
      },
      operationErrorHandler('save task', { taskId: task.id }),
    );
  }

  async update(taskId: TaskId, update: Partial<Task>): Promise<Result<void>> {
    // First get the existing task
    const existingResult = await this.findById(taskId);

    if (!existingResult.ok) {
      return existingResult;
    }

    if (!existingResult.value) {
      return err(new BackbeatError(ErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`));
    }

    // Merge updates with existing task
    const updatedTask = { ...existingResult.value, ...update };

    // Use UPDATE (not INSERT OR REPLACE) to preserve child rows
    return tryCatchAsync(
      async () => {
        this.updateStmt.run({
          id: updatedTask.id,
          prompt: updatedTask.prompt,
          status: updatedTask.status,
          priority: updatedTask.priority,
          workingDirectory: updatedTask.workingDirectory || null,
          timeout: updatedTask.timeout || null,
          maxOutputBuffer: updatedTask.maxOutputBuffer || null,
          startedAt: updatedTask.startedAt || null,
          completedAt: updatedTask.completedAt || null,
          workerId: updatedTask.workerId || null,
          exitCode: updatedTask.exitCode ?? null,
          dependencies: null,
          parentTaskId: updatedTask.parentTaskId || null,
          retryCount: updatedTask.retryCount || null,
          retryOf: updatedTask.retryOf || null,
          continueFrom: updatedTask.continueFrom || null,
          agent: updatedTask.agent || null,
        });
      },
      operationErrorHandler('update task', { taskId }),
    );
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

  async transaction<T>(fn: (repo: TaskRepository) => Promise<Result<T>>): Promise<Result<T>> {
    try {
      const transactionFn = this.db.transaction(async () => {
        // Create a transaction-wrapped repository
        const txRepo = new TransactionTaskRepository(this);
        return await fn(txRepo);
      });

      // Execute the transaction and return the result
      return await transactionFn();
    } catch (error) {
      return err(new BackbeatError(ErrorCode.SYSTEM_ERROR, `Transaction failed: ${error}`));
    }
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
      timeout: data.timeout || undefined,
      maxOutputBuffer: data.max_output_buffer || undefined,
      parentTaskId: data.parent_task_id ? (data.parent_task_id as TaskId) : undefined,
      retryCount: data.retry_count || undefined,
      retryOf: data.retry_of ? (data.retry_of as TaskId) : undefined,
      continueFrom: data.continue_from ? (data.continue_from as TaskId) : undefined,
      agent: (data.agent as AgentProvider) || undefined,
      createdAt: data.created_at,
      startedAt: data.started_at || undefined,
      completedAt: data.completed_at || undefined,
      workerId: data.worker_id ? (data.worker_id as WorkerId) : undefined,
      exitCode: data.exit_code ?? undefined,
    };
  }
}

/**
 * Transaction-wrapped repository that delegates to the main repository
 * All operations run within the same SQLite transaction
 */
class TransactionTaskRepository implements TaskRepository {
  constructor(private readonly mainRepo: SQLiteTaskRepository) {}

  async save(task: Task): Promise<Result<void>> {
    return this.mainRepo.save(task);
  }

  async update(taskId: TaskId, update: Partial<Task>): Promise<Result<void>> {
    return this.mainRepo.update(taskId, update);
  }

  async findById(taskId: TaskId): Promise<Result<Task | null>> {
    return this.mainRepo.findById(taskId);
  }

  async findAll(limit?: number, offset?: number): Promise<Result<readonly Task[]>> {
    return this.mainRepo.findAll(limit, offset);
  }

  async findAllUnbounded(): Promise<Result<readonly Task[]>> {
    return this.mainRepo.findAllUnbounded();
  }

  async count(): Promise<Result<number>> {
    return this.mainRepo.count();
  }

  async findByStatus(status: string): Promise<Result<readonly Task[]>> {
    return this.mainRepo.findByStatus(status);
  }

  async delete(taskId: TaskId): Promise<Result<void>> {
    return this.mainRepo.delete(taskId);
  }

  async cleanupOldTasks(olderThanMs: number): Promise<Result<number>> {
    return this.mainRepo.cleanupOldTasks(olderThanMs);
  }

  async transaction<T>(fn: (repo: TaskRepository) => Promise<Result<T>>): Promise<Result<T>> {
    // Nested transactions not supported - just execute the function
    return fn(this);
  }
}
