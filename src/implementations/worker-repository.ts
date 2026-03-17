/**
 * SQLite-based worker repository for cross-process coordination
 * ARCHITECTURE: Tracks active workers across all processes sharing the same SQLite DB.
 * Enables PID-based crash recovery and cross-process resource checks.
 *
 * Pattern: Repository with prepared statements, synchronous Result<T> returns
 * (better-sqlite3 is synchronous, enables use inside runInTransaction)
 */

import SQLite from 'better-sqlite3';
import { z } from 'zod';
import { TaskId, WorkerId, WorkerRegistration } from '../core/domain.js';
import { BackbeatError, ErrorCode, operationErrorHandler } from '../core/errors.js';
import { WorkerRepository } from '../core/interfaces.js';
import { Result, tryCatch } from '../core/result.js';
import { Database } from './database.js';

/**
 * Zod schema for validating worker rows from database
 * Pattern: Parse, don't validate - ensures type safety at system boundary
 */
const WorkerRowSchema = z.object({
  worker_id: z.string().min(1),
  task_id: z.string().min(1),
  pid: z.number(),
  owner_pid: z.number(),
  agent: z.string(),
  started_at: z.number(),
});

/** Database row type inferred from Zod schema (single source of truth) */
type WorkerRow = z.infer<typeof WorkerRowSchema>;

export class SQLiteWorkerRepository implements WorkerRepository {
  private readonly db: SQLite.Database;
  private readonly registerStmt: SQLite.Statement;
  private readonly unregisterStmt: SQLite.Statement;
  private readonly findByTaskIdStmt: SQLite.Statement;
  private readonly findByOwnerPidStmt: SQLite.Statement;
  private readonly findAllStmt: SQLite.Statement;
  private readonly countStmt: SQLite.Statement;
  private readonly deleteByOwnerPidStmt: SQLite.Statement;

  constructor(database: Database) {
    this.db = database.getDatabase();

    this.registerStmt = this.db.prepare(`
      INSERT INTO workers (worker_id, task_id, pid, owner_pid, agent, started_at)
      VALUES (@workerId, @taskId, @pid, @ownerPid, @agent, @startedAt)
    `);

    this.unregisterStmt = this.db.prepare(`
      DELETE FROM workers WHERE worker_id = ?
    `);

    this.findByTaskIdStmt = this.db.prepare(`
      SELECT * FROM workers WHERE task_id = ?
    `);

    this.findByOwnerPidStmt = this.db.prepare(`
      SELECT * FROM workers WHERE owner_pid = ?
    `);

    this.findAllStmt = this.db.prepare(`
      SELECT * FROM workers ORDER BY started_at ASC
    `);

    this.countStmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM workers
    `);

    this.deleteByOwnerPidStmt = this.db.prepare(`
      DELETE FROM workers WHERE owner_pid = ?
    `);
  }

  /**
   * Register a worker in the coordination table.
   * Uses plain INSERT (NOT INSERT OR REPLACE) — UNIQUE violation on task_id
   * means another process already owns this task, which is a real coordination error.
   */
  register(registration: WorkerRegistration): Result<void> {
    return tryCatch(
      () => {
        this.registerStmt.run({
          workerId: registration.workerId,
          taskId: registration.taskId,
          pid: registration.pid,
          ownerPid: registration.ownerPid,
          agent: registration.agent,
          startedAt: registration.startedAt,
        });
      },
      (error) => {
        const message = error instanceof Error ? error.message : String(error);
        // Detect UNIQUE constraint violation for task_id
        if (message.includes('UNIQUE constraint failed')) {
          return new BackbeatError(
            ErrorCode.WORKER_SPAWN_FAILED,
            `Another process already has a worker for this task: ${registration.taskId}`,
            { taskId: registration.taskId, ownerPid: registration.ownerPid },
          );
        }
        return new BackbeatError(ErrorCode.SYSTEM_ERROR, `Failed to register worker: ${message}`, {
          workerId: registration.workerId,
        });
      },
    );
  }

  unregister(workerId: WorkerId): Result<void> {
    return tryCatch(
      () => {
        this.unregisterStmt.run(workerId);
      },
      operationErrorHandler('unregister worker', { workerId }),
    );
  }

  findByTaskId(taskId: TaskId): Result<WorkerRegistration | null> {
    return tryCatch(
      () => {
        const row = this.findByTaskIdStmt.get(taskId) as WorkerRow | undefined;
        return row ? this.rowToRegistration(row) : null;
      },
      operationErrorHandler('find worker by task', { taskId }),
    );
  }

  findByOwnerPid(ownerPid: number): Result<readonly WorkerRegistration[]> {
    return tryCatch(
      () => {
        const rows = this.findByOwnerPidStmt.all(ownerPid) as WorkerRow[];
        return rows.map((row) => this.rowToRegistration(row));
      },
      operationErrorHandler('find workers by owner PID', { ownerPid }),
    );
  }

  findAll(): Result<readonly WorkerRegistration[]> {
    return tryCatch(
      () => {
        const rows = this.findAllStmt.all() as WorkerRow[];
        return rows.map((row) => this.rowToRegistration(row));
      },
      operationErrorHandler('find all workers'),
    );
  }

  getGlobalCount(): Result<number> {
    return tryCatch(
      () => {
        const row = this.countStmt.get() as { count: number };
        return row.count;
      },
      operationErrorHandler('get global worker count'),
    );
  }

  deleteByOwnerPid(ownerPid: number): Result<number> {
    return tryCatch(
      () => {
        const result = this.deleteByOwnerPidStmt.run(ownerPid);
        return result.changes;
      },
      operationErrorHandler('delete workers by owner PID', { ownerPid }),
    );
  }

  /**
   * Convert database row to WorkerRegistration domain object
   * Pattern: Validate at boundary - ensures data integrity from database
   * @throws Error if row data is invalid (indicates database corruption)
   */
  private rowToRegistration(row: WorkerRow): WorkerRegistration {
    // Validate row data at system boundary (parse throws ZodError on invalid data)
    const data = WorkerRowSchema.parse(row);
    return {
      workerId: WorkerId(data.worker_id),
      taskId: TaskId(data.task_id),
      pid: data.pid,
      ownerPid: data.owner_pid,
      agent: data.agent,
      startedAt: data.started_at,
    };
  }
}
