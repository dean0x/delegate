/**
 * SQLite-based loop repository implementation
 * ARCHITECTURE: Pure Result pattern for all operations, pure data access layer
 * Pattern: Repository pattern with prepared statements for performance
 * Rationale: Efficient loop persistence for iterative task execution system (v0.7.0)
 */

import SQLite from 'better-sqlite3';
import { z } from 'zod';
import { AGENT_PROVIDERS_TUPLE } from '../core/agents.js';
import {
  Loop,
  LoopId,
  LoopIteration,
  LoopStatus,
  LoopStrategy,
  OptimizeDirection,
  ScheduleId,
  TaskId,
  type TaskRequest,
} from '../core/domain.js';
import { operationErrorHandler } from '../core/errors.js';
import { LoopRepository, SyncLoopOperations } from '../core/interfaces.js';
import { Result, tryCatchAsync } from '../core/result.js';
import { Database } from './database.js';

// ============================================================================
// Zod schemas for boundary validation
// Pattern: Parse, don't validate — ensures type safety at system boundary
// Hoisted to module level to avoid recreation on every row conversion
// ============================================================================

const LoopRowSchema = z.object({
  id: z.string().min(1),
  strategy: z.enum(['retry', 'optimize']),
  task_template: z.string(), // JSON serialized TaskRequest
  pipeline_steps: z.string().nullable(),
  exit_condition: z.string().min(1),
  eval_direction: z.string().nullable(),
  eval_timeout: z.number(),
  working_directory: z.string(),
  max_iterations: z.number(),
  max_consecutive_failures: z.number(),
  cooldown_ms: z.number(),
  fresh_context: z.number(), // SQLite boolean: 0 or 1
  status: z.enum(['running', 'paused', 'completed', 'failed', 'cancelled']),
  current_iteration: z.number(),
  best_score: z.number().nullable(),
  best_iteration_id: z.number().nullable(),
  consecutive_failures: z.number(),
  created_at: z.number(),
  updated_at: z.number(),
  completed_at: z.number().nullable(),
  git_branch: z.string().nullable(),
  git_base_branch: z.string().nullable(),
  git_start_commit_sha: z.string().nullable(),
  schedule_id: z.string().nullable(),
});

const LoopIterationRowSchema = z.object({
  id: z.number(),
  loop_id: z.string().min(1),
  iteration_number: z.number(),
  task_id: z.string().nullable(),
  pipeline_task_ids: z.string().nullable(),
  status: z.enum(['running', 'pass', 'fail', 'keep', 'discard', 'crash', 'cancelled']),
  score: z.number().nullable(),
  exit_code: z.number().nullable(),
  error_message: z.string().nullable(),
  started_at: z.number(),
  completed_at: z.number().nullable(),
  git_branch: z.string().nullable(),
  git_commit_sha: z.string().nullable(),
  pre_iteration_commit_sha: z.string().nullable(),
  git_diff_summary: z.string().nullable(),
});

/**
 * Zod schema for validating task_template JSON from database
 * Pattern: Boundary validation for TaskRequest objects
 */
const TaskRequestSchema = z.object({
  prompt: z.string(),
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
});

/**
 * Zod schema for validating pipeline_steps JSON from database
 * Pattern: Boundary validation for pipeline step prompt arrays
 */
const PipelineStepsSchema = z.array(z.string().min(1)).min(2).max(20);

/**
 * Zod schema for validating pipeline_task_ids JSON from database
 */
const PipelineTaskIdsSchema = z.array(z.string().min(1)).min(1);

// ============================================================================
// Row types for type-safe database interaction
// ============================================================================

interface LoopRow {
  readonly id: string;
  readonly strategy: string;
  readonly task_template: string;
  readonly pipeline_steps: string | null;
  readonly exit_condition: string;
  readonly eval_direction: string | null;
  readonly eval_timeout: number;
  readonly working_directory: string;
  readonly max_iterations: number;
  readonly max_consecutive_failures: number;
  readonly cooldown_ms: number;
  readonly fresh_context: number;
  readonly status: string;
  readonly current_iteration: number;
  readonly best_score: number | null;
  readonly best_iteration_id: number | null;
  readonly consecutive_failures: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly completed_at: number | null;
  readonly git_branch: string | null;
  readonly git_base_branch: string | null;
  readonly git_start_commit_sha: string | null;
  readonly schedule_id: string | null;
}

interface LoopIterationRow {
  readonly id: number;
  readonly loop_id: string;
  readonly iteration_number: number;
  readonly task_id: string | null;
  readonly pipeline_task_ids: string | null;
  readonly status: string;
  readonly score: number | null;
  readonly exit_code: number | null;
  readonly error_message: string | null;
  readonly started_at: number;
  readonly completed_at: number | null;
  readonly git_branch: string | null;
  readonly git_commit_sha: string | null;
  readonly pre_iteration_commit_sha: string | null;
  readonly git_diff_summary: string | null;
}

export class SQLiteLoopRepository implements LoopRepository, SyncLoopOperations {
  /** Default pagination limit for findAll() */
  private static readonly DEFAULT_LIMIT = 100;

  private readonly db: SQLite.Database;
  private readonly saveStmt: SQLite.Statement;
  private readonly updateStmt: SQLite.Statement;
  private readonly findByIdStmt: SQLite.Statement;
  private readonly findAllPaginatedStmt: SQLite.Statement;
  private readonly findByStatusStmt: SQLite.Statement;
  private readonly countStmt: SQLite.Statement;
  private readonly deleteStmt: SQLite.Statement;
  private readonly recordIterationStmt: SQLite.Statement;
  private readonly updateIterationStmt: SQLite.Statement;
  private readonly getIterationsStmt: SQLite.Statement;
  private readonly findIterationByTaskIdStmt: SQLite.Statement;
  private readonly findRunningIterationsStmt: SQLite.Statement;
  private readonly findByScheduleIdStmt: SQLite.Statement;
  private readonly cleanupOldLoopsStmt: SQLite.Statement;

  constructor(database: Database) {
    this.db = database.getDatabase();

    this.saveStmt = this.db.prepare(`
      INSERT INTO loops (
        id, strategy, task_template, pipeline_steps, exit_condition,
        eval_direction, eval_timeout, working_directory, max_iterations,
        max_consecutive_failures, cooldown_ms, fresh_context, status,
        current_iteration, best_score, best_iteration_id, consecutive_failures,
        created_at, updated_at, completed_at,
        git_branch, git_base_branch, git_start_commit_sha, schedule_id
      ) VALUES (
        @id, @strategy, @taskTemplate, @pipelineSteps, @exitCondition,
        @evalDirection, @evalTimeout, @workingDirectory, @maxIterations,
        @maxConsecutiveFailures, @cooldownMs, @freshContext, @status,
        @currentIteration, @bestScore, @bestIterationId, @consecutiveFailures,
        @createdAt, @updatedAt, @completedAt,
        @gitBranch, @gitBaseBranch, @gitStartCommitSha, @scheduleId
      )
    `);

    this.updateStmt = this.db.prepare(`
      UPDATE loops SET
        strategy = @strategy,
        task_template = @taskTemplate,
        pipeline_steps = @pipelineSteps,
        exit_condition = @exitCondition,
        eval_direction = @evalDirection,
        eval_timeout = @evalTimeout,
        working_directory = @workingDirectory,
        max_iterations = @maxIterations,
        max_consecutive_failures = @maxConsecutiveFailures,
        cooldown_ms = @cooldownMs,
        fresh_context = @freshContext,
        status = @status,
        current_iteration = @currentIteration,
        best_score = @bestScore,
        best_iteration_id = @bestIterationId,
        consecutive_failures = @consecutiveFailures,
        updated_at = @updatedAt,
        completed_at = @completedAt,
        git_branch = @gitBranch,
        git_base_branch = @gitBaseBranch,
        git_start_commit_sha = @gitStartCommitSha,
        schedule_id = @scheduleId
      WHERE id = @id
    `);

    this.findByIdStmt = this.db.prepare(`
      SELECT * FROM loops WHERE id = ?
    `);

    this.findAllPaginatedStmt = this.db.prepare(`
      SELECT * FROM loops ORDER BY created_at DESC LIMIT ? OFFSET ?
    `);

    this.findByStatusStmt = this.db.prepare(`
      SELECT * FROM loops WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?
    `);

    this.countStmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM loops
    `);

    this.deleteStmt = this.db.prepare(`
      DELETE FROM loops WHERE id = ?
    `);

    this.recordIterationStmt = this.db.prepare(`
      INSERT INTO loop_iterations (
        loop_id, iteration_number, task_id, pipeline_task_ids,
        status, score, exit_code, error_message, started_at, completed_at,
        git_branch, git_commit_sha, pre_iteration_commit_sha, git_diff_summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.updateIterationStmt = this.db.prepare(`
      UPDATE loop_iterations SET
        status = @status,
        score = @score,
        exit_code = @exitCode,
        error_message = @errorMessage,
        completed_at = @completedAt,
        git_branch = @gitBranch,
        git_commit_sha = @gitCommitSha,
        pre_iteration_commit_sha = @preIterationCommitSha,
        git_diff_summary = @gitDiffSummary
      WHERE id = @id
    `);

    this.getIterationsStmt = this.db.prepare(`
      SELECT * FROM loop_iterations
      WHERE loop_id = ?
      ORDER BY iteration_number DESC
      LIMIT ? OFFSET ?
    `);

    this.findIterationByTaskIdStmt = this.db.prepare(`
      SELECT * FROM loop_iterations WHERE task_id = ?
    `);

    // ARCHITECTURE: Find running iterations for active loops (used by recovery manager)
    this.findRunningIterationsStmt = this.db.prepare(`
      SELECT li.* FROM loop_iterations li
      JOIN loops l ON li.loop_id = l.id
      WHERE l.status = 'running' AND li.status = 'running'
    `);

    this.findByScheduleIdStmt = this.db.prepare(`
      SELECT * FROM loops WHERE schedule_id = ? ORDER BY created_at DESC
    `);

    // ARCHITECTURE: FK cascade (ON DELETE CASCADE) auto-deletes associated iterations
    // NOTE: Excludes 'paused' loops — paused loops should survive cleanup
    this.cleanupOldLoopsStmt = this.db.prepare(`
      DELETE FROM loops WHERE status IN ('completed', 'failed', 'cancelled') AND completed_at < ?
    `);
  }

  // ============================================================================
  // Loop CRUD (async, wrapped in tryCatchAsync)
  // ============================================================================

  async save(loop: Loop): Promise<Result<void>> {
    return tryCatchAsync(
      async () => {
        this.saveStmt.run(this.loopToRow(loop));
      },
      operationErrorHandler('save loop', { loopId: loop.id }),
    );
  }

  async update(loop: Loop): Promise<Result<void>> {
    return tryCatchAsync(
      async () => {
        this.updateStmt.run(this.loopToRow(loop));
      },
      operationErrorHandler('update loop', { loopId: loop.id }),
    );
  }

  async findById(id: LoopId): Promise<Result<Loop | null>> {
    return tryCatchAsync(
      async () => {
        const row = this.findByIdStmt.get(id) as LoopRow | undefined;
        if (!row) return null;
        return this.rowToLoop(row);
      },
      operationErrorHandler('find loop', { loopId: id }),
    );
  }

  async findAll(limit?: number, offset?: number): Promise<Result<readonly Loop[]>> {
    return tryCatchAsync(async () => {
      const effectiveLimit = limit ?? SQLiteLoopRepository.DEFAULT_LIMIT;
      const effectiveOffset = offset ?? 0;
      const rows = this.findAllPaginatedStmt.all(effectiveLimit, effectiveOffset) as LoopRow[];
      return rows.map((row) => this.rowToLoop(row));
    }, operationErrorHandler('find all loops'));
  }

  async findByStatus(status: LoopStatus, limit?: number, offset?: number): Promise<Result<readonly Loop[]>> {
    return tryCatchAsync(
      async () => {
        const effectiveLimit = limit ?? SQLiteLoopRepository.DEFAULT_LIMIT;
        const effectiveOffset = offset ?? 0;
        const rows = this.findByStatusStmt.all(status, effectiveLimit, effectiveOffset) as LoopRow[];
        return rows.map((row) => this.rowToLoop(row));
      },
      operationErrorHandler('find loops by status', { status }),
    );
  }

  async count(): Promise<Result<number>> {
    return tryCatchAsync(async () => {
      const result = this.countStmt.get() as { count: number };
      return result.count;
    }, operationErrorHandler('count loops'));
  }

  async delete(id: LoopId): Promise<Result<void>> {
    return tryCatchAsync(
      async () => {
        this.deleteStmt.run(id);
      },
      operationErrorHandler('delete loop', { loopId: id }),
    );
  }

  async cleanupOldLoops(olderThanMs: number): Promise<Result<number>> {
    return tryCatchAsync(async () => {
      const cutoff = Date.now() - olderThanMs;
      const result = this.cleanupOldLoopsStmt.run(cutoff);
      return result.changes;
    }, operationErrorHandler('cleanup old loops'));
  }

  async findByScheduleId(scheduleId: ScheduleId): Promise<Result<readonly Loop[]>> {
    return tryCatchAsync(
      async () => {
        const rows = this.findByScheduleIdStmt.all(scheduleId) as LoopRow[];
        return rows.map((row) => this.rowToLoop(row));
      },
      operationErrorHandler('find loops by schedule ID', { scheduleId }),
    );
  }

  // ============================================================================
  // Iteration CRUD (async, wrapped in tryCatchAsync)
  // ============================================================================

  async recordIteration(iteration: LoopIteration): Promise<Result<void>> {
    return tryCatchAsync(
      async () => {
        this.recordIterationStmt.run(
          iteration.loopId,
          iteration.iterationNumber,
          iteration.taskId ?? null,
          iteration.pipelineTaskIds ? JSON.stringify(iteration.pipelineTaskIds) : null,
          iteration.status,
          iteration.score ?? null,
          iteration.exitCode ?? null,
          iteration.errorMessage ?? null,
          iteration.startedAt,
          iteration.completedAt ?? null,
          iteration.gitBranch ?? null,
          iteration.gitCommitSha ?? null,
          iteration.preIterationCommitSha ?? null,
          iteration.gitDiffSummary ?? null,
        );
      },
      operationErrorHandler('record loop iteration', {
        loopId: iteration.loopId,
        iterationNumber: iteration.iterationNumber,
      }),
    );
  }

  async getIterations(loopId: LoopId, limit?: number, offset?: number): Promise<Result<readonly LoopIteration[]>> {
    return tryCatchAsync(
      async () => {
        const effectiveLimit = limit ?? SQLiteLoopRepository.DEFAULT_LIMIT;
        const effectiveOffset = offset ?? 0;
        const rows = this.getIterationsStmt.all(loopId, effectiveLimit, effectiveOffset) as LoopIterationRow[];
        return rows.map((row) => this.rowToIteration(row));
      },
      operationErrorHandler('get loop iterations', { loopId }),
    );
  }

  async findIterationByTaskId(taskId: TaskId): Promise<Result<LoopIteration | null>> {
    return tryCatchAsync(
      async () => {
        const row = this.findIterationByTaskIdStmt.get(taskId) as LoopIterationRow | undefined;
        if (!row) return null;
        return this.rowToIteration(row);
      },
      operationErrorHandler('find iteration by task ID', { taskId }),
    );
  }

  async findRunningIterations(): Promise<Result<readonly LoopIteration[]>> {
    return tryCatchAsync(async () => {
      const rows = this.findRunningIterationsStmt.all() as LoopIterationRow[];
      return rows.map((row) => this.rowToIteration(row));
    }, operationErrorHandler('find running iterations'));
  }

  async updateIteration(iteration: LoopIteration): Promise<Result<void>> {
    return tryCatchAsync(
      async () => {
        this.updateIterationStmt.run({
          id: iteration.id,
          status: iteration.status,
          score: iteration.score ?? null,
          exitCode: iteration.exitCode ?? null,
          errorMessage: iteration.errorMessage ?? null,
          completedAt: iteration.completedAt ?? null,
          gitBranch: iteration.gitBranch ?? null,
          gitCommitSha: iteration.gitCommitSha ?? null,
          preIterationCommitSha: iteration.preIterationCommitSha ?? null,
          gitDiffSummary: iteration.gitDiffSummary ?? null,
        });
      },
      operationErrorHandler('update loop iteration', {
        loopId: iteration.loopId,
        iterationId: iteration.id,
      }),
    );
  }

  // ============================================================================
  // SYNC METHODS (for use inside Database.runInTransaction())
  // These throw on error — the transaction wrapper catches and converts to Result.
  // ============================================================================

  updateSync(loop: Loop): void {
    this.updateStmt.run(this.loopToRow(loop));
  }

  recordIterationSync(iteration: LoopIteration): void {
    this.recordIterationStmt.run(
      iteration.loopId,
      iteration.iterationNumber,
      iteration.taskId ?? null,
      iteration.pipelineTaskIds ? JSON.stringify(iteration.pipelineTaskIds) : null,
      iteration.status,
      iteration.score ?? null,
      iteration.exitCode ?? null,
      iteration.errorMessage ?? null,
      iteration.startedAt,
      iteration.completedAt ?? null,
      iteration.gitBranch ?? null,
      iteration.gitCommitSha ?? null,
      iteration.preIterationCommitSha ?? null,
      iteration.gitDiffSummary ?? null,
    );
  }

  findByIdSync(id: LoopId): Loop | null {
    const row = this.findByIdStmt.get(id) as LoopRow | undefined;
    if (!row) return null;
    return this.rowToLoop(row);
  }

  updateIterationSync(iteration: LoopIteration): void {
    this.updateIterationStmt.run({
      id: iteration.id,
      status: iteration.status,
      score: iteration.score ?? null,
      exitCode: iteration.exitCode ?? null,
      errorMessage: iteration.errorMessage ?? null,
      completedAt: iteration.completedAt ?? null,
      gitBranch: iteration.gitBranch ?? null,
      gitCommitSha: iteration.gitCommitSha ?? null,
      preIterationCommitSha: iteration.preIterationCommitSha ?? null,
      gitDiffSummary: iteration.gitDiffSummary ?? null,
    });
  }

  // ============================================================================
  // Row conversion helpers
  // Pattern: Validate at boundary — ensures data integrity from database
  // ============================================================================

  /**
   * Convert Loop domain object to database parameter format.
   * Shared by both async and sync methods.
   */
  private loopToRow(loop: Loop): Record<string, unknown> {
    return {
      id: loop.id,
      strategy: loop.strategy,
      taskTemplate: JSON.stringify(loop.taskTemplate),
      pipelineSteps: loop.pipelineSteps ? JSON.stringify(loop.pipelineSteps) : null,
      exitCondition: loop.exitCondition,
      evalDirection: loop.evalDirection ?? null,
      evalTimeout: loop.evalTimeout,
      workingDirectory: loop.workingDirectory,
      maxIterations: loop.maxIterations,
      maxConsecutiveFailures: loop.maxConsecutiveFailures,
      cooldownMs: loop.cooldownMs,
      freshContext: loop.freshContext ? 1 : 0,
      status: loop.status,
      currentIteration: loop.currentIteration,
      bestScore: loop.bestScore ?? null,
      bestIterationId: loop.bestIterationId ?? null,
      consecutiveFailures: loop.consecutiveFailures,
      createdAt: loop.createdAt,
      updatedAt: loop.updatedAt,
      completedAt: loop.completedAt ?? null,
      gitBranch: loop.gitBranch ?? null,
      gitBaseBranch: loop.gitBaseBranch ?? null,
      gitStartCommitSha: loop.gitStartCommitSha ?? null,
      scheduleId: loop.scheduleId ?? null,
    };
  }

  /**
   * Convert database row to Loop domain object
   * Pattern: Validate at boundary — ensures data integrity from database
   * @throws Error if row data is invalid (indicates database corruption)
   */
  private rowToLoop(row: LoopRow): Loop {
    const data = LoopRowSchema.parse(row);

    // Parse and validate taskTemplate JSON at system boundary
    let taskTemplate: TaskRequest;
    try {
      const parsed = JSON.parse(data.task_template);
      taskTemplate = TaskRequestSchema.parse(parsed) as TaskRequest;
    } catch (e) {
      throw new Error(`Invalid task_template JSON for loop ${data.id}: ${e}`);
    }

    // Parse pipeline_steps JSON if present
    let pipelineSteps: readonly string[] | undefined;
    if (data.pipeline_steps) {
      try {
        const parsed = JSON.parse(data.pipeline_steps);
        pipelineSteps = PipelineStepsSchema.parse(parsed);
      } catch (e) {
        throw new Error(`Invalid pipeline_steps JSON for loop ${data.id}: ${e}`);
      }
    }

    return {
      id: LoopId(data.id),
      strategy: this.toLoopStrategy(data.strategy),
      taskTemplate,
      pipelineSteps,
      exitCondition: data.exit_condition,
      evalDirection: data.eval_direction ? this.toOptimizeDirection(data.eval_direction) : undefined,
      evalTimeout: data.eval_timeout,
      workingDirectory: data.working_directory,
      maxIterations: data.max_iterations,
      maxConsecutiveFailures: data.max_consecutive_failures,
      cooldownMs: data.cooldown_ms,
      freshContext: data.fresh_context === 1,
      status: this.toLoopStatus(data.status),
      currentIteration: data.current_iteration,
      bestScore: data.best_score ?? undefined,
      bestIterationId: data.best_iteration_id ?? undefined,
      consecutiveFailures: data.consecutive_failures,
      gitBranch: data.git_branch ?? undefined,
      gitBaseBranch: data.git_base_branch ?? undefined,
      gitStartCommitSha: data.git_start_commit_sha ?? undefined,
      scheduleId: data.schedule_id ? ScheduleId(data.schedule_id) : undefined,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      completedAt: data.completed_at ?? undefined,
    };
  }

  /**
   * Convert database row to LoopIteration domain object
   * Pattern: Validate at boundary
   */
  private rowToIteration(row: LoopIterationRow): LoopIteration {
    const data = LoopIterationRowSchema.parse(row);

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
      loopId: LoopId(data.loop_id),
      iterationNumber: data.iteration_number,
      taskId: data.task_id ? TaskId(data.task_id) : undefined, // undefined when ON DELETE SET NULL cleans up task
      pipelineTaskIds,
      status: data.status as LoopIteration['status'],
      score: data.score ?? undefined,
      exitCode: data.exit_code ?? undefined,
      errorMessage: data.error_message ?? undefined,
      gitBranch: data.git_branch ?? undefined,
      gitCommitSha: data.git_commit_sha ?? undefined,
      preIterationCommitSha: data.pre_iteration_commit_sha ?? undefined,
      gitDiffSummary: data.git_diff_summary ?? undefined,
      startedAt: data.started_at,
      completedAt: data.completed_at ?? undefined,
    };
  }

  /**
   * Convert string to LoopStrategy enum
   */
  private toLoopStrategy(value: string): LoopStrategy {
    switch (value) {
      case 'retry':
        return LoopStrategy.RETRY;
      case 'optimize':
        return LoopStrategy.OPTIMIZE;
      default:
        throw new Error(`Unknown loop strategy: ${value} - possible data corruption`);
    }
  }

  /**
   * Convert string to LoopStatus enum
   */
  private toLoopStatus(value: string): LoopStatus {
    switch (value) {
      case 'running':
        return LoopStatus.RUNNING;
      case 'paused':
        return LoopStatus.PAUSED;
      case 'completed':
        return LoopStatus.COMPLETED;
      case 'failed':
        return LoopStatus.FAILED;
      case 'cancelled':
        return LoopStatus.CANCELLED;
      default:
        throw new Error(`Unknown loop status: ${value} - possible data corruption`);
    }
  }

  /**
   * Convert string to OptimizeDirection enum
   */
  private toOptimizeDirection(value: string): OptimizeDirection {
    switch (value) {
      case 'minimize':
        return OptimizeDirection.MINIMIZE;
      case 'maximize':
        return OptimizeDirection.MAXIMIZE;
      default:
        throw new Error(`Unknown optimize direction: ${value} - possible data corruption`);
    }
  }
}
