/**
 * SQLite-based pipeline repository implementation
 * ARCHITECTURE: Pure Result pattern for all operations, pure data access layer
 * Pattern: Repository pattern with prepared statements for performance
 * Rationale: Efficient pipeline persistence for first-class pipeline entity tracking (Phase A)
 */

import SQLite from 'better-sqlite3';
import { z } from 'zod';
import { AGENT_PROVIDERS_TUPLE, type AgentProvider } from '../core/agents.js';
import {
  LoopId,
  OrchestratorId,
  type Pipeline,
  PipelineId,
  PipelineStatus,
  type PipelineStepDefinition,
  type Priority,
  ScheduleId,
  TaskId,
} from '../core/domain.js';
import { operationErrorHandler } from '../core/errors.js';
import type { PipelineRepository } from '../core/interfaces.js';
import { Result, tryCatchAsync } from '../core/result.js';
import { Database } from './database.js';

// ============================================================================
// Zod schemas for boundary validation
// Pattern: Parse, don't validate — ensures type safety at system boundary
// Hoisted to module level to avoid recreation on every row conversion
// ============================================================================

const PipelineRowSchema = z.object({
  id: z.string().min(1),
  steps: z.string(), // JSON serialized PipelineStepDefinition[]
  step_task_ids: z.string(), // JSON serialized (string | null)[]
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']),
  schedule_id: z.string().nullable(),
  loop_id: z.string().nullable(),
  loop_iteration: z.number().nullable(),
  orchestrator_id: z.string().nullable(),
  priority: z.string().nullable(),
  working_directory: z.string().nullable(),
  agent: z.enum(AGENT_PROVIDERS_TUPLE).nullable(),
  model: z.string().nullable(),
  system_prompt: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
  completed_at: z.number().nullable(),
});

/**
 * Zod schema for validating steps JSON from database
 * Pattern: Boundary validation for step definition arrays
 */
const StepDefinitionSchema = z.array(
  z.object({
    index: z.number().int().nonnegative(),
    prompt: z.string().min(1),
    priority: z.string().optional(),
    workingDirectory: z.string().optional(),
    agent: z.enum(AGENT_PROVIDERS_TUPLE).optional(),
    model: z.string().optional(),
    systemPrompt: z.string().optional(),
    // Optional: schedule ID for immediate pipelines (createPipeline path)
    scheduleId: z.string().optional(),
  }),
);

/**
 * Zod schema for validating step_task_ids JSON from database
 */
const StepTaskIdsSchema = z.array(z.string().nullable());

// ============================================================================
// Row types for type-safe database interaction
// ============================================================================

interface PipelineRow {
  readonly id: string;
  readonly steps: string;
  readonly step_task_ids: string;
  readonly status: string;
  readonly schedule_id: string | null;
  readonly loop_id: string | null;
  readonly loop_iteration: number | null;
  readonly orchestrator_id: string | null;
  readonly priority: string | null;
  readonly working_directory: string | null;
  readonly agent: string | null;
  readonly model: string | null;
  readonly system_prompt: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly completed_at: number | null;
}

export class SQLitePipelineRepository implements PipelineRepository {
  /** Default pagination limit for findAll() */
  private static readonly DEFAULT_LIMIT = 100;

  private readonly db: SQLite.Database;
  private readonly saveStmt: SQLite.Statement;
  private readonly updateStmt: SQLite.Statement;
  private readonly findByIdStmt: SQLite.Statement;
  private readonly findAllStmt: SQLite.Statement;
  private readonly findByStatusStmt: SQLite.Statement;
  private readonly findByScheduleIdStmt: SQLite.Statement;
  private readonly findByLoopIdStmt: SQLite.Statement;
  private readonly deleteStmt: SQLite.Statement;
  private readonly countByStatusStmt: SQLite.Statement;
  private readonly findUpdatedSinceStmt: SQLite.Statement;
  private readonly findActiveStmt: SQLite.Statement;

  constructor(database: Database) {
    this.db = database.getDatabase();

    this.saveStmt = this.db.prepare(`
      INSERT INTO pipelines (
        id, steps, step_task_ids, status,
        schedule_id, loop_id, loop_iteration, orchestrator_id,
        priority, working_directory, agent, model, system_prompt,
        created_at, updated_at, completed_at
      ) VALUES (
        @id, @steps, @stepTaskIds, @status,
        @scheduleId, @loopId, @loopIteration, @orchestratorId,
        @priority, @workingDirectory, @agent, @model, @systemPrompt,
        @createdAt, @updatedAt, @completedAt
      )
    `);

    this.updateStmt = this.db.prepare(`
      UPDATE pipelines SET
        steps = @steps,
        step_task_ids = @stepTaskIds,
        status = @status,
        schedule_id = @scheduleId,
        loop_id = @loopId,
        loop_iteration = @loopIteration,
        orchestrator_id = @orchestratorId,
        priority = @priority,
        working_directory = @workingDirectory,
        agent = @agent,
        model = @model,
        system_prompt = @systemPrompt,
        updated_at = @updatedAt,
        completed_at = @completedAt
      WHERE id = @id
    `);

    this.findByIdStmt = this.db.prepare(`
      SELECT * FROM pipelines WHERE id = ?
    `);

    this.findAllStmt = this.db.prepare(`
      SELECT * FROM pipelines ORDER BY created_at DESC LIMIT ?
    `);

    this.findByStatusStmt = this.db.prepare(`
      SELECT * FROM pipelines WHERE status = ? ORDER BY created_at DESC LIMIT ?
    `);

    this.findByScheduleIdStmt = this.db.prepare(`
      SELECT * FROM pipelines WHERE schedule_id = ? ORDER BY created_at DESC
    `);

    this.findByLoopIdStmt = this.db.prepare(`
      SELECT * FROM pipelines WHERE loop_id = ? ORDER BY loop_iteration ASC
    `);

    this.deleteStmt = this.db.prepare(`
      DELETE FROM pipelines WHERE id = ?
    `);

    this.countByStatusStmt = this.db.prepare(`
      SELECT status, COUNT(*) as count FROM pipelines GROUP BY status
    `);

    // idx_pipelines_updated_at (migration v24) covers WHERE + ORDER BY
    this.findUpdatedSinceStmt = this.db.prepare(`
      SELECT * FROM pipelines
      WHERE updated_at >= ?
      ORDER BY updated_at DESC
      LIMIT ?
    `);

    // Active pipelines only — used by PipelineHandler to find pipelines containing a task ID
    // ARCHITECTURE: Scans only pending/running rows (bounded in practice) to avoid full-table JSON search
    this.findActiveStmt = this.db.prepare(`
      SELECT * FROM pipelines
      WHERE status IN ('pending', 'running')
      ORDER BY created_at DESC
    `);
  }

  // ============================================================================
  // Pipeline CRUD (async, wrapped in tryCatchAsync)
  // ============================================================================

  async save(pipeline: Pipeline): Promise<Result<void>> {
    return tryCatchAsync(
      async () => {
        this.saveStmt.run(this.pipelineToRow(pipeline));
      },
      operationErrorHandler('save pipeline', { pipelineId: pipeline.id }),
    );
  }

  async update(pipeline: Pipeline): Promise<Result<void>> {
    return tryCatchAsync(
      async () => {
        this.updateStmt.run(this.pipelineToRow(pipeline));
      },
      operationErrorHandler('update pipeline', { pipelineId: pipeline.id }),
    );
  }

  async findById(id: PipelineId): Promise<Result<Pipeline | null>> {
    return tryCatchAsync(
      async () => {
        const row = this.findByIdStmt.get(id) as PipelineRow | undefined;
        if (!row) return null;
        return this.rowToPipeline(row);
      },
      operationErrorHandler('find pipeline', { pipelineId: id }),
    );
  }

  async findAll(limit?: number): Promise<Result<readonly Pipeline[]>> {
    return tryCatchAsync(async () => {
      const effectiveLimit = limit ?? SQLitePipelineRepository.DEFAULT_LIMIT;
      const rows = this.findAllStmt.all(effectiveLimit) as PipelineRow[];
      return rows.map((row) => this.rowToPipeline(row));
    }, operationErrorHandler('find all pipelines'));
  }

  async findByStatus(status: PipelineStatus, limit?: number): Promise<Result<readonly Pipeline[]>> {
    return tryCatchAsync(
      async () => {
        const effectiveLimit = limit ?? SQLitePipelineRepository.DEFAULT_LIMIT;
        const rows = this.findByStatusStmt.all(status, effectiveLimit) as PipelineRow[];
        return rows.map((row) => this.rowToPipeline(row));
      },
      operationErrorHandler('find pipelines by status', { status }),
    );
  }

  async findByScheduleId(scheduleId: ScheduleId): Promise<Result<readonly Pipeline[]>> {
    return tryCatchAsync(
      async () => {
        const rows = this.findByScheduleIdStmt.all(scheduleId) as PipelineRow[];
        return rows.map((row) => this.rowToPipeline(row));
      },
      operationErrorHandler('find pipelines by schedule ID', { scheduleId }),
    );
  }

  async findByLoopId(loopId: LoopId): Promise<Result<readonly Pipeline[]>> {
    return tryCatchAsync(
      async () => {
        const rows = this.findByLoopIdStmt.all(loopId) as PipelineRow[];
        return rows.map((row) => this.rowToPipeline(row));
      },
      operationErrorHandler('find pipelines by loop ID', { loopId }),
    );
  }

  async delete(id: PipelineId): Promise<Result<void>> {
    return tryCatchAsync(
      async () => {
        this.deleteStmt.run(id);
      },
      operationErrorHandler('delete pipeline', { pipelineId: id }),
    );
  }

  async countByStatus(): Promise<Result<Record<string, number>>> {
    return tryCatchAsync(async () => {
      const rows = this.countByStatusStmt.all() as Array<{ status: string; count: number }>;
      const counts: Record<string, number> = {};
      for (const row of rows) {
        counts[row.status] = row.count;
      }
      return counts;
    }, operationErrorHandler('count pipelines by status'));
  }

  async findUpdatedSince(sinceMs: number, limit: number): Promise<Result<readonly Pipeline[]>> {
    return tryCatchAsync(
      async () => {
        const rows = this.findUpdatedSinceStmt.all(sinceMs, limit) as PipelineRow[];
        return rows.map((row) => this.rowToPipeline(row));
      },
      operationErrorHandler('find pipelines updated since', { sinceMs }),
    );
  }

  /**
   * Find all active (non-terminal) pipelines that contain the given task ID in step_task_ids.
   * ARCHITECTURE: Scans only running/pending pipelines (bounded set) — no index needed for
   * JSON array search since active pipelines are always a small count in practice.
   */
  async findActiveByTaskId(taskId: TaskId): Promise<Result<readonly Pipeline[]>> {
    return tryCatchAsync(
      async () => {
        const rows = this.findActiveStmt.all() as PipelineRow[];
        const pipelines = rows.map((row) => this.rowToPipeline(row));
        // Filter in-process: scan JSON step_task_ids for the given taskId string
        return pipelines.filter((p) => p.stepTaskIds.includes(taskId));
      },
      operationErrorHandler('find active pipelines by task ID', { taskId }),
    );
  }

  /**
   * Find all active (non-terminal) pipelines that have a step with the given scheduleId.
   * Used by PipelineHandler to populate stepTaskIds when a scheduled step's task is first delegated.
   * ARCHITECTURE: Same bounded-scan pattern as findActiveByTaskId.
   */
  async findActiveByStepScheduleId(scheduleId: ScheduleId): Promise<Result<readonly Pipeline[]>> {
    return tryCatchAsync(
      async () => {
        const rows = this.findActiveStmt.all() as PipelineRow[];
        const pipelines = rows.map((row) => this.rowToPipeline(row));
        // Filter in-process: check if any step definition carries this scheduleId
        return pipelines.filter((p) => p.steps.some((s) => s.scheduleId === scheduleId));
      },
      operationErrorHandler('find active pipelines by step schedule ID', { scheduleId }),
    );
  }

  // ============================================================================
  // Row conversion helpers
  // Pattern: Validate at boundary — ensures data integrity from database
  // ============================================================================

  /**
   * Convert Pipeline domain object to database parameter format.
   */
  private pipelineToRow(pipeline: Pipeline): Record<string, unknown> {
    return {
      id: pipeline.id,
      steps: JSON.stringify(pipeline.steps),
      stepTaskIds: JSON.stringify(pipeline.stepTaskIds),
      status: pipeline.status,
      scheduleId: pipeline.scheduleId ?? null,
      loopId: pipeline.loopId ?? null,
      loopIteration: pipeline.loopIteration ?? null,
      orchestratorId: pipeline.orchestratorId ?? null,
      priority: pipeline.priority ?? null,
      workingDirectory: pipeline.workingDirectory ?? null,
      agent: pipeline.agent ?? null,
      model: pipeline.model ?? null,
      systemPrompt: pipeline.systemPrompt ?? null,
      createdAt: pipeline.createdAt,
      updatedAt: pipeline.updatedAt,
      completedAt: pipeline.completedAt ?? null,
    };
  }

  /**
   * Convert database row to Pipeline domain object.
   * Pattern: Validate at boundary — ensures data integrity from database.
   * @throws Error if row data is invalid (indicates database corruption)
   */
  private rowToPipeline(row: PipelineRow): Pipeline {
    const data = PipelineRowSchema.parse(row);

    // Parse and validate steps JSON at system boundary
    let steps: readonly PipelineStepDefinition[];
    try {
      const parsed = JSON.parse(data.steps);
      const validated = StepDefinitionSchema.parse(parsed);
      steps = validated.map((s) => ({
        index: s.index,
        prompt: s.prompt,
        priority: s.priority as Priority | undefined,
        workingDirectory: s.workingDirectory,
        agent: s.agent as AgentProvider | undefined,
        model: s.model,
        systemPrompt: s.systemPrompt,
        scheduleId: s.scheduleId ? ScheduleId(s.scheduleId) : undefined,
      }));
    } catch (e) {
      throw new Error(`Invalid steps JSON for pipeline ${data.id}: ${e}`);
    }

    // Parse and validate step_task_ids JSON at system boundary
    let stepTaskIds: readonly (TaskId | null)[];
    try {
      const parsed = JSON.parse(data.step_task_ids);
      const validated = StepTaskIdsSchema.parse(parsed);
      stepTaskIds = validated.map((id) => (id !== null ? TaskId(id) : null));
    } catch (e) {
      throw new Error(`Invalid step_task_ids JSON for pipeline ${data.id}: ${e}`);
    }

    return {
      id: PipelineId(data.id),
      steps,
      stepTaskIds,
      status: data.status as PipelineStatus,
      scheduleId: data.schedule_id ? ScheduleId(data.schedule_id) : undefined,
      loopId: data.loop_id ? LoopId(data.loop_id) : undefined,
      loopIteration: data.loop_iteration ?? undefined,
      orchestratorId: data.orchestrator_id ? OrchestratorId(data.orchestrator_id) : undefined,
      priority: data.priority as Priority | undefined,
      workingDirectory: data.working_directory ?? undefined,
      agent: data.agent as AgentProvider | undefined,
      model: data.model ?? undefined,
      systemPrompt: data.system_prompt ?? undefined,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      completedAt: data.completed_at ?? undefined,
    };
  }
}
