/**
 * SQLite-based schedule repository implementation
 * ARCHITECTURE: Pure Result pattern for all operations, pure data access layer
 * Pattern: Repository pattern with prepared statements for performance
 * Rationale: Efficient schedule persistence for task scheduling system
 */

import SQLite from 'better-sqlite3';
import { z } from 'zod';
import { AGENT_PROVIDERS_TUPLE } from '../core/agents.js';
import {
  EvalMode,
  type LoopCreateRequest,
  LoopId,
  LoopStrategy,
  MissedRunPolicy,
  OptimizeDirection,
  type PipelineStepRequest,
  Priority,
  Schedule,
  ScheduleId,
  ScheduleStatus,
  ScheduleType,
  TaskId,
  TaskRequest,
} from '../core/domain.js';
import { AutobeatError, ErrorCode, operationErrorHandler } from '../core/errors.js';
import { ScheduleExecution, ScheduleRepository, SyncScheduleOperations } from '../core/interfaces.js';
import { err, ok, Result, tryCatchAsync } from '../core/result.js';
import { Database } from './database.js';

/**
 * Zod schema for validating schedule rows from database
 * Pattern: Parse, don't validate - ensures type safety at system boundary
 */
const ScheduleRowSchema = z.object({
  id: z.string().min(1),
  task_template: z.string(), // JSON serialized TaskRequest
  schedule_type: z.enum(['cron', 'one_time']),
  cron_expression: z.string().nullable(),
  scheduled_at: z.number().nullable(),
  timezone: z.string(),
  missed_run_policy: z.enum(['skip', 'catchup', 'fail']),
  status: z.enum(['active', 'paused', 'completed', 'cancelled', 'expired']),
  max_runs: z.number().nullable(),
  run_count: z.number(),
  last_run_at: z.number().nullable(),
  next_run_at: z.number().nullable(),
  expires_at: z.number().nullable(),
  after_schedule_id: z.string().nullable(),
  pipeline_steps: z.string().nullable(), // JSON serialized PipelineStepRequest[]
  loop_config: z.string().nullable(), // JSON serialized LoopCreateRequest (v0.8.0)
  created_at: z.number(),
  updated_at: z.number(),
});

/**
 * Zod schema for validating schedule execution rows from database
 */
const ScheduleExecutionRowSchema = z.object({
  id: z.number(),
  schedule_id: z.string().min(1),
  task_id: z.string().nullable(),
  scheduled_for: z.number(),
  executed_at: z.number().nullable(),
  status: z.enum(['pending', 'triggered', 'completed', 'failed', 'missed', 'skipped']),
  error_message: z.string().nullable(),
  pipeline_task_ids: z.string().nullable(), // JSON serialized TaskId[]
  loop_id: z.string().nullable(), // Loop ID created by this execution (v0.8.0)
  created_at: z.number(),
});

/**
 * Zod schema for validating task_template JSON from database
 * Pattern: Parse, don't validate - ensures type safety at system boundary
 * Hoisted to module level to avoid recreation on every rowToSchedule() call
 */
const TaskRequestSchema = z.object({
  prompt: z.string().min(1),
  priority: z.enum(['P0', 'P1', 'P2']).optional(),
  workingDirectory: z.string().optional(),
  timeout: z.number().optional(),
  maxOutputBuffer: z.number().optional(),
  parentTaskId: z.string().optional(),
  retryCount: z.number().optional(),
  retryOf: z.string().optional(),
  dependsOn: z.array(z.string()).optional(),
  continueFrom: z.string().optional(),
  agent: z.enum(AGENT_PROVIDERS_TUPLE).optional(),
  model: z.string().optional(),
  // v1.3.0: Orchestration attribution — preserved through DB round-trip for consistency
  // with loop.taskTemplate. Schedules rarely carry this today, but the field must survive
  // serialization for parity across the three taskTemplate sinks (tasks, loops, schedules).
  orchestratorId: z.string().optional(),
  // System prompt override: must survive DB round-trip so scheduled triggers inject the
  // correct prompt into each task agent. Omitted here = silent data loss on every trigger.
  systemPrompt: z.string().optional(),
});

/**
 * Zod schema for validating pipeline_task_ids JSON from database
 * Pattern: Boundary validation for pipeline task ID arrays
 */
const PipelineTaskIdsSchema = z.array(z.string().min(1)).min(1);

/**
 * Zod schema for validating pipeline_steps JSON from database
 * Pattern: Boundary validation for pipeline step definitions (2-20 steps)
 */
const PipelineStepsSchema = z
  .array(
    z.object({
      prompt: z.string().min(1),
      priority: z.enum(['P0', 'P1', 'P2']).optional(),
      workingDirectory: z.string().optional(),
      agent: z.enum(AGENT_PROVIDERS_TUPLE).optional(),
      model: z.string().optional(),
    }),
  )
  .min(2)
  .max(20);

/**
 * Zod schema for validating loop_config JSON from database
 * Pattern: Boundary validation for LoopCreateRequest objects (v0.8.0)
 */
const LoopConfigSchema = z.object({
  prompt: z.string().optional(),
  strategy: z.nativeEnum(LoopStrategy),
  exitCondition: z.string().min(1).optional(),
  evalDirection: z.nativeEnum(OptimizeDirection).optional(),
  evalTimeout: z.number().optional(),
  evalMode: z.nativeEnum(EvalMode).optional(),
  evalPrompt: z.string().optional(),
  workingDirectory: z.string().optional(),
  maxIterations: z.number().optional(),
  maxConsecutiveFailures: z.number().optional(),
  cooldownMs: z.number().optional(),
  freshContext: z.boolean().optional(),
  pipelineSteps: z.array(z.string()).optional(),
  priority: z.nativeEnum(Priority).optional(),
  agent: z.enum(AGENT_PROVIDERS_TUPLE).optional(),
  model: z.string().optional(),
  gitBranch: z.string().optional(),
  // System prompt override: must survive DB round-trip so scheduled loop triggers inject
  // the correct prompt. The satisfies guard does not catch missing optional fields.
  systemPrompt: z.string().optional(),
}) satisfies z.ZodType<LoopCreateRequest>;

/**
 * Database row type for schedules table
 * TYPE-SAFETY: Explicit typing instead of Record<string, any>
 */
interface ScheduleRow {
  readonly id: string;
  readonly task_template: string;
  readonly schedule_type: string;
  readonly cron_expression: string | null;
  readonly scheduled_at: number | null;
  readonly timezone: string;
  readonly missed_run_policy: string;
  readonly status: string;
  readonly max_runs: number | null;
  readonly run_count: number;
  readonly last_run_at: number | null;
  readonly next_run_at: number | null;
  readonly expires_at: number | null;
  readonly after_schedule_id: string | null;
  readonly pipeline_steps: string | null;
  readonly loop_config: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

/**
 * Database row type for schedule_executions table
 */
interface ScheduleExecutionRow {
  readonly id: number;
  readonly schedule_id: string;
  readonly task_id: string | null;
  readonly scheduled_for: number;
  readonly executed_at: number | null;
  readonly status: string;
  readonly error_message: string | null;
  readonly pipeline_task_ids: string | null;
  readonly loop_id: string | null;
  readonly created_at: number;
}

export class SQLiteScheduleRepository implements ScheduleRepository, SyncScheduleOperations {
  /** Default pagination limit for findAll() */
  private static readonly DEFAULT_LIMIT = 100;

  private readonly db: SQLite.Database;
  private readonly saveStmt: SQLite.Statement;
  private readonly findByIdStmt: SQLite.Statement;
  private readonly findAllPaginatedStmt: SQLite.Statement;
  private readonly findByStatusStmt: SQLite.Statement;
  private readonly findDueStmt: SQLite.Statement;
  private readonly deleteStmt: SQLite.Statement;
  private readonly countStmt: SQLite.Statement;
  private readonly countByStatusStmt: SQLite.Statement;
  private readonly updateStmt: SQLite.Statement;
  private readonly recordExecutionStmt: SQLite.Statement;
  private readonly getExecutionByIdStmt: SQLite.Statement;
  private readonly getExecutionHistoryStmt: SQLite.Statement;
  // v1.3.0 addition — cached to avoid re-prepare on every 1s dashboard poll
  private readonly findUpdatedSinceStmt: SQLite.Statement;

  constructor(database: Database) {
    this.db = database.getDatabase();

    // Prepare statements for better performance
    this.saveStmt = this.db.prepare(`
      INSERT OR REPLACE INTO schedules (
        id, task_template, schedule_type, cron_expression, scheduled_at,
        timezone, missed_run_policy, status, max_runs, run_count,
        last_run_at, next_run_at, expires_at, after_schedule_id, pipeline_steps, loop_config,
        created_at, updated_at
      ) VALUES (
        @id, @taskTemplate, @scheduleType, @cronExpression, @scheduledAt,
        @timezone, @missedRunPolicy, @status, @maxRuns, @runCount,
        @lastRunAt, @nextRunAt, @expiresAt, @afterScheduleId, @pipelineSteps, @loopConfig,
        @createdAt, @updatedAt
      )
    `);

    // UPDATE preserves the row (unlike INSERT OR REPLACE which deletes + inserts,
    // triggering ON DELETE CASCADE on child tables like schedule_executions)
    this.updateStmt = this.db.prepare(`
      UPDATE schedules SET
        task_template = @taskTemplate,
        schedule_type = @scheduleType,
        cron_expression = @cronExpression,
        scheduled_at = @scheduledAt,
        timezone = @timezone,
        missed_run_policy = @missedRunPolicy,
        status = @status,
        max_runs = @maxRuns,
        run_count = @runCount,
        last_run_at = @lastRunAt,
        next_run_at = @nextRunAt,
        expires_at = @expiresAt,
        after_schedule_id = @afterScheduleId,
        pipeline_steps = @pipelineSteps,
        loop_config = @loopConfig,
        updated_at = @updatedAt
      WHERE id = @id
    `);

    this.findByIdStmt = this.db.prepare(`
      SELECT * FROM schedules WHERE id = ?
    `);

    this.findAllPaginatedStmt = this.db.prepare(`
      SELECT * FROM schedules ORDER BY created_at DESC LIMIT ? OFFSET ?
    `);

    this.findByStatusStmt = this.db.prepare(`
      SELECT * FROM schedules WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?
    `);

    // ARCHITECTURE: Critical query for scheduler tick - finds schedules ready to trigger
    // Uses composite index idx_schedules_due (status, next_run_at) for efficiency
    this.findDueStmt = this.db.prepare(`
      SELECT * FROM schedules
      WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?
      ORDER BY next_run_at ASC
    `);

    this.deleteStmt = this.db.prepare(`
      DELETE FROM schedules WHERE id = ?
    `);

    this.countStmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM schedules
    `);

    this.countByStatusStmt = this.db.prepare(`
      SELECT status, COUNT(*) as count FROM schedules GROUP BY status
    `);

    this.recordExecutionStmt = this.db.prepare(`
      INSERT INTO schedule_executions (
        schedule_id, task_id, scheduled_for, executed_at, status, error_message, pipeline_task_ids, loop_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.getExecutionByIdStmt = this.db.prepare(`
      SELECT * FROM schedule_executions WHERE id = ?
    `);

    this.getExecutionHistoryStmt = this.db.prepare(`
      SELECT * FROM schedule_executions
      WHERE schedule_id = ?
      ORDER BY scheduled_for DESC
      LIMIT ?
    `);

    // idx_schedules_updated_at (migration v20) covers WHERE + ORDER BY.
    this.findUpdatedSinceStmt = this.db.prepare(`
      SELECT * FROM schedules
      WHERE updated_at >= ?
      ORDER BY updated_at DESC
      LIMIT ?
    `);
  }

  /**
   * Convert Schedule domain object to database parameter format.
   * Shared by both async (save/update) and sync (updateSync) methods.
   * Includes createdAt — better-sqlite3 ignores named params not referenced by the statement.
   */
  private toDbFormat(schedule: Schedule): Record<string, unknown> {
    return {
      id: schedule.id,
      taskTemplate: JSON.stringify(schedule.taskTemplate),
      scheduleType: schedule.scheduleType,
      cronExpression: schedule.cronExpression ?? null,
      scheduledAt: schedule.scheduledAt ?? null,
      timezone: schedule.timezone,
      missedRunPolicy: schedule.missedRunPolicy,
      status: schedule.status,
      maxRuns: schedule.maxRuns ?? null,
      runCount: schedule.runCount,
      lastRunAt: schedule.lastRunAt ?? null,
      nextRunAt: schedule.nextRunAt ?? null,
      expiresAt: schedule.expiresAt ?? null,
      afterScheduleId: schedule.afterScheduleId ?? null,
      pipelineSteps: schedule.pipelineSteps ? JSON.stringify(schedule.pipelineSteps) : null,
      loopConfig: schedule.loopConfig ? JSON.stringify(schedule.loopConfig) : null,
      createdAt: schedule.createdAt,
      updatedAt: schedule.updatedAt,
    };
  }

  /**
   * Save a new schedule
   */
  async save(schedule: Schedule): Promise<Result<void>> {
    return tryCatchAsync(
      async () => {
        this.saveStmt.run(this.toDbFormat(schedule));
      },
      operationErrorHandler('save schedule', { scheduleId: schedule.id }),
    );
  }

  /**
   * Update an existing schedule
   */
  async update(id: ScheduleId, update: Partial<Schedule>): Promise<Result<void>> {
    const existingResult = await this.findById(id);

    if (!existingResult.ok) {
      return existingResult;
    }

    if (!existingResult.value) {
      return err(new AutobeatError(ErrorCode.TASK_NOT_FOUND, `Schedule ${id} not found`));
    }

    const updatedSchedule: Schedule = {
      ...existingResult.value,
      ...update,
      updatedAt: Date.now(),
    };

    return tryCatchAsync(
      async () => {
        this.updateStmt.run(this.toDbFormat(updatedSchedule));
      },
      operationErrorHandler('update schedule', { scheduleId: id }),
    );
  }

  // ============================================================================
  // SYNC METHODS (for use inside Database.runInTransaction())
  // These throw on error — the transaction wrapper catches and converts to Result.
  // ============================================================================

  findByIdSync(id: ScheduleId): Schedule | null {
    const row = this.findByIdStmt.get(id) as ScheduleRow | undefined;
    if (!row) return null;
    return this.rowToSchedule(row);
  }

  updateSync(id: ScheduleId, update: Partial<Schedule>, existing?: Schedule): void {
    const base = existing ?? this.findByIdSync(id);
    if (!base) {
      throw new AutobeatError(ErrorCode.TASK_NOT_FOUND, `Schedule ${id} not found`);
    }
    const updatedSchedule: Schedule = {
      ...base,
      ...update,
      updatedAt: Date.now(),
    };
    this.updateStmt.run(this.toDbFormat(updatedSchedule));
  }

  recordExecutionSync(execution: Omit<ScheduleExecution, 'id'>): ScheduleExecution {
    const result = this.recordExecutionStmt.run(
      execution.scheduleId,
      execution.taskId ?? null,
      execution.scheduledFor,
      execution.executedAt ?? null,
      execution.status,
      execution.errorMessage ?? null,
      execution.pipelineTaskIds ? JSON.stringify(execution.pipelineTaskIds) : null,
      execution.loopId ?? null,
      execution.createdAt,
    );

    const row = this.getExecutionByIdStmt.get(result.lastInsertRowid) as ScheduleExecutionRow | undefined;
    if (!row) {
      throw new AutobeatError(
        ErrorCode.SYSTEM_ERROR,
        `Failed to retrieve execution record after insert (rowid: ${result.lastInsertRowid})`,
      );
    }
    return this.rowToExecution(row);
  }

  /**
   * Find schedule by ID
   *
   * @param id - The schedule ID to find
   * @returns Result containing the schedule or null if not found
   */
  async findById(id: ScheduleId): Promise<Result<Schedule | null>> {
    return tryCatchAsync(
      async () => {
        const row = this.findByIdStmt.get(id) as ScheduleRow | undefined;

        if (!row) {
          return null;
        }

        return this.rowToSchedule(row);
      },
      operationErrorHandler('find schedule', { scheduleId: id }),
    );
  }

  /**
   * Find schedules with optional pagination
   *
   * @param limit Maximum results to return (default: 100)
   * @param offset Number of records to skip (default: 0)
   * @returns Result containing paginated array of schedules
   */
  async findAll(limit?: number, offset?: number): Promise<Result<readonly Schedule[]>> {
    return tryCatchAsync(async () => {
      const effectiveLimit = limit ?? SQLiteScheduleRepository.DEFAULT_LIMIT;
      const effectiveOffset = offset ?? 0;

      const rows = this.findAllPaginatedStmt.all(effectiveLimit, effectiveOffset) as ScheduleRow[];
      return rows.map((row) => this.rowToSchedule(row));
    }, operationErrorHandler('find all schedules'));
  }

  /**
   * Find schedules by status with optional pagination
   *
   * @param status - The schedule status to filter by
   * @param limit - Maximum results to return (default: 100)
   * @param offset - Number of records to skip (default: 0)
   * @returns Result containing paginated array of schedules matching status
   */
  async findByStatus(status: ScheduleStatus, limit?: number, offset?: number): Promise<Result<readonly Schedule[]>> {
    return tryCatchAsync(
      async () => {
        const effectiveLimit = limit ?? SQLiteScheduleRepository.DEFAULT_LIMIT;
        const effectiveOffset = offset ?? 0;

        const rows = this.findByStatusStmt.all(status, effectiveLimit, effectiveOffset) as ScheduleRow[];
        return rows.map((row) => this.rowToSchedule(row));
      },
      operationErrorHandler('find schedules by status', { status }),
    );
  }

  /**
   * Find schedules that are due to execute
   *
   * ARCHITECTURE: Critical for scheduler tick - finds active schedules with nextRunAt <= beforeTime
   * Orders by nextRunAt ASC to process oldest due schedules first
   *
   * @param beforeTime - Epoch ms - find schedules with nextRunAt before this time
   * @returns Result containing schedules due for execution ordered by nextRunAt ASC
   */
  async findDue(beforeTime: number): Promise<Result<readonly Schedule[]>> {
    return tryCatchAsync(
      async () => {
        const rows = this.findDueStmt.all(beforeTime) as ScheduleRow[];
        return rows.map((row) => this.rowToSchedule(row));
      },
      operationErrorHandler('find due schedules', { beforeTime }),
    );
  }

  /**
   * Delete a schedule
   *
   * @param id - The schedule ID to delete
   * @returns Result indicating success or error
   */
  async delete(id: ScheduleId): Promise<Result<void>> {
    return tryCatchAsync(
      async () => {
        this.deleteStmt.run(id);
      },
      operationErrorHandler('delete schedule', { scheduleId: id }),
    );
  }

  /**
   * Count total schedules
   *
   * @returns Result containing total schedule count
   */
  async count(): Promise<Result<number>> {
    return tryCatchAsync(async () => {
      const result = this.countStmt.get() as { count: number };
      return result.count;
    }, operationErrorHandler('count schedules'));
  }

  async countByStatus(): Promise<Result<Record<string, number>>> {
    return tryCatchAsync(async () => {
      const rows = this.countByStatusStmt.all() as Array<{ status: string; count: number }>;
      const counts: Record<string, number> = {};
      for (const row of rows) {
        counts[row.status] = row.count;
      }
      return counts;
    }, operationErrorHandler('count schedules by status'));
  }

  /**
   * Record a schedule execution attempt
   *
   * @param execution - Execution record without ID (ID auto-generated)
   * @returns Result containing created execution record with ID
   */
  async recordExecution(execution: Omit<ScheduleExecution, 'id'>): Promise<Result<ScheduleExecution>> {
    return tryCatchAsync(
      async () => {
        const result = this.recordExecutionStmt.run(
          execution.scheduleId,
          execution.taskId ?? null,
          execution.scheduledFor,
          execution.executedAt ?? null,
          execution.status,
          execution.errorMessage ?? null,
          execution.pipelineTaskIds ? JSON.stringify(execution.pipelineTaskIds) : null,
          execution.loopId ?? null,
          execution.createdAt,
        );

        const row = this.getExecutionByIdStmt.get(result.lastInsertRowid) as ScheduleExecutionRow | undefined;
        if (!row) {
          throw new AutobeatError(
            ErrorCode.SYSTEM_ERROR,
            `Failed to retrieve execution record after insert (rowid: ${result.lastInsertRowid})`,
          );
        }
        return this.rowToExecution(row);
      },
      operationErrorHandler('record schedule execution', { scheduleId: execution.scheduleId }),
    );
  }

  /**
   * Get execution history for a schedule
   *
   * @param scheduleId - Schedule to get history for
   * @param limit - Maximum records to return (default: 100)
   * @returns Result containing execution history ordered by scheduledFor DESC
   */
  async getExecutionHistory(scheduleId: ScheduleId, limit?: number): Promise<Result<readonly ScheduleExecution[]>> {
    return tryCatchAsync(
      async () => {
        const effectiveLimit = limit ?? SQLiteScheduleRepository.DEFAULT_LIMIT;
        const rows = this.getExecutionHistoryStmt.all(scheduleId, effectiveLimit) as ScheduleExecutionRow[];
        return rows.map((row) => this.rowToExecution(row));
      },
      operationErrorHandler('get execution history', { scheduleId }),
    );
  }

  /**
   * Convert database row to Schedule domain object
   * Pattern: Validate at boundary - ensures data integrity from database
   * @throws Error if row data is invalid (indicates database corruption)
   */
  private rowToSchedule(row: ScheduleRow): Schedule {
    // Validate row data at system boundary (parse throws ZodError on invalid data)
    // This catches database corruption or schema mismatches early
    const data = ScheduleRowSchema.parse(row);

    // Parse and validate taskTemplate JSON at system boundary
    let taskTemplate: TaskRequest;
    try {
      const parsed = JSON.parse(data.task_template);
      taskTemplate = TaskRequestSchema.parse(parsed) as TaskRequest;
    } catch (e) {
      throw new Error(`Invalid task_template JSON for schedule ${data.id}: ${e}`);
    }

    // Parse pipeline_steps JSON if present
    let pipelineSteps: readonly PipelineStepRequest[] | undefined;
    if (data.pipeline_steps) {
      try {
        const parsed = JSON.parse(data.pipeline_steps);
        pipelineSteps = PipelineStepsSchema.parse(parsed) as readonly PipelineStepRequest[];
      } catch (e) {
        throw new Error(`Invalid pipeline_steps JSON for schedule ${data.id}: ${e}`);
      }
    }

    // Parse loop_config JSON if present (v0.8.0)
    let loopConfig: LoopCreateRequest | undefined;
    if (data.loop_config) {
      try {
        const parsed = JSON.parse(data.loop_config);
        loopConfig = LoopConfigSchema.parse(parsed);
      } catch (e) {
        throw new Error(`Invalid loop_config JSON for schedule ${data.id}: ${e}`);
      }
    }

    return {
      id: ScheduleId(data.id),
      taskTemplate,
      scheduleType: data.schedule_type === 'cron' ? ScheduleType.CRON : ScheduleType.ONE_TIME,
      cronExpression: data.cron_expression ?? undefined,
      scheduledAt: data.scheduled_at ?? undefined,
      timezone: data.timezone,
      missedRunPolicy: this.toMissedRunPolicy(data.missed_run_policy),
      status: this.toScheduleStatus(data.status),
      maxRuns: data.max_runs ?? undefined,
      runCount: data.run_count,
      lastRunAt: data.last_run_at ?? undefined,
      nextRunAt: data.next_run_at ?? undefined,
      expiresAt: data.expires_at ?? undefined,
      afterScheduleId: data.after_schedule_id ? ScheduleId(data.after_schedule_id) : undefined,
      pipelineSteps,
      loopConfig,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }

  /**
   * Convert database row to ScheduleExecution domain object
   * Pattern: Validate at boundary
   */
  private rowToExecution(row: ScheduleExecutionRow): ScheduleExecution {
    const data = ScheduleExecutionRowSchema.parse(row);

    // Parse pipeline_task_ids JSON if present
    let pipelineTaskIds: readonly TaskId[] | undefined;
    if (data.pipeline_task_ids) {
      try {
        const parsed = JSON.parse(data.pipeline_task_ids);
        const validated = PipelineTaskIdsSchema.parse(parsed);
        pipelineTaskIds = validated.map((id) => TaskId(id));
      } catch {
        // Non-fatal: log but don't fail
        pipelineTaskIds = undefined;
      }
    }

    return {
      id: data.id,
      scheduleId: ScheduleId(data.schedule_id),
      taskId: data.task_id ? TaskId(data.task_id) : undefined,
      scheduledFor: data.scheduled_for,
      executedAt: data.executed_at ?? undefined,
      status: data.status as ScheduleExecution['status'],
      errorMessage: data.error_message ?? undefined,
      pipelineTaskIds,
      loopId: data.loop_id ? LoopId(data.loop_id) : undefined,
      createdAt: data.created_at,
    };
  }

  /**
   * Convert string to MissedRunPolicy enum
   */
  private toMissedRunPolicy(value: string): MissedRunPolicy {
    switch (value) {
      case 'skip':
        return MissedRunPolicy.SKIP;
      case 'catchup':
        return MissedRunPolicy.CATCHUP;
      case 'fail':
        return MissedRunPolicy.FAIL;
      default:
        throw new Error(`Unknown missed_run_policy: ${value} - possible data corruption`);
    }
  }

  /**
   * Convert string to ScheduleStatus enum
   */
  private toScheduleStatus(value: string): ScheduleStatus {
    switch (value) {
      case 'active':
        return ScheduleStatus.ACTIVE;
      case 'paused':
        return ScheduleStatus.PAUSED;
      case 'completed':
        return ScheduleStatus.COMPLETED;
      case 'cancelled':
        return ScheduleStatus.CANCELLED;
      case 'expired':
        return ScheduleStatus.EXPIRED;
      default:
        throw new Error(`Unknown schedule status: ${value} - possible data corruption`);
    }
  }

  // ============================================================================
  // v1.3.0 additions
  // ============================================================================

  async findUpdatedSince(sinceMs: number, limit: number): Promise<Result<readonly Schedule[]>> {
    return tryCatchAsync(
      async () => {
        const rows = this.findUpdatedSinceStmt.all(sinceMs, limit) as ScheduleRow[];
        return rows.map((row) => this.rowToSchedule(row));
      },
      operationErrorHandler('find schedules updated since', { sinceMs }),
    );
  }
}
