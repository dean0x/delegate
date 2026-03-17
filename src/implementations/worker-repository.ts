/**
 * SQLite-based worker repository for cross-process coordination
 * ARCHITECTURE: Tracks active workers across all processes sharing the same SQLite DB.
 * Enables PID-based crash recovery and cross-process resource checks.
 *
 * Pattern: Repository with prepared statements, synchronous Result<T> returns
 * (better-sqlite3 is synchronous, enables use inside runInTransaction)
 */

import SQLite from 'better-sqlite3';
import { TaskId, WorkerId, WorkerRegistration } from '../core/domain.js';
import { BackbeatError, ErrorCode } from '../core/errors.js';
import { WorkerRepository } from '../core/interfaces.js';
import { Result, tryCatch } from '../core/result.js';
import { Database } from './database.js';

/**
 * Database row type for workers table
 */
interface WorkerRow {
  readonly worker_id: string;
  readonly task_id: string;
  readonly pid: number;
  readonly owner_pid: number;
  readonly agent: string;
  readonly started_at: number;
}

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
      (error) =>
        new BackbeatError(
          ErrorCode.SYSTEM_ERROR,
          `Failed to unregister worker: ${error instanceof Error ? error.message : String(error)}`,
          { workerId },
        ),
    );
  }

  findByTaskId(taskId: TaskId): Result<WorkerRegistration | null> {
    return tryCatch(
      () => {
        const row = this.findByTaskIdStmt.get(taskId) as WorkerRow | undefined;
        return row ? this.rowToRegistration(row) : null;
      },
      (error) =>
        new BackbeatError(
          ErrorCode.SYSTEM_ERROR,
          `Failed to find worker by task: ${error instanceof Error ? error.message : String(error)}`,
          { taskId },
        ),
    );
  }

  findByOwnerPid(ownerPid: number): Result<readonly WorkerRegistration[]> {
    return tryCatch(
      () => {
        const rows = this.findByOwnerPidStmt.all(ownerPid) as WorkerRow[];
        return rows.map((row) => this.rowToRegistration(row));
      },
      (error) =>
        new BackbeatError(
          ErrorCode.SYSTEM_ERROR,
          `Failed to find workers by owner PID: ${error instanceof Error ? error.message : String(error)}`,
          { ownerPid },
        ),
    );
  }

  findAll(): Result<readonly WorkerRegistration[]> {
    return tryCatch(
      () => {
        const rows = this.findAllStmt.all() as WorkerRow[];
        return rows.map((row) => this.rowToRegistration(row));
      },
      (error) =>
        new BackbeatError(
          ErrorCode.SYSTEM_ERROR,
          `Failed to find all workers: ${error instanceof Error ? error.message : String(error)}`,
        ),
    );
  }

  getGlobalCount(): Result<number> {
    return tryCatch(
      () => {
        const row = this.countStmt.get() as { count: number };
        return row.count;
      },
      (error) =>
        new BackbeatError(
          ErrorCode.SYSTEM_ERROR,
          `Failed to get global worker count: ${error instanceof Error ? error.message : String(error)}`,
        ),
    );
  }

  deleteByOwnerPid(ownerPid: number): Result<number> {
    return tryCatch(
      () => {
        const result = this.deleteByOwnerPidStmt.run(ownerPid);
        return result.changes;
      },
      (error) =>
        new BackbeatError(
          ErrorCode.SYSTEM_ERROR,
          `Failed to delete workers by owner PID: ${error instanceof Error ? error.message : String(error)}`,
          { ownerPid },
        ),
    );
  }

  private rowToRegistration(row: WorkerRow): WorkerRegistration {
    return {
      workerId: WorkerId(row.worker_id),
      taskId: TaskId(row.task_id),
      pid: row.pid,
      ownerPid: row.owner_pid,
      agent: row.agent,
      startedAt: row.started_at,
    };
  }
}
