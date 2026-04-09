/**
 * SQLite-based orchestration repository implementation
 * ARCHITECTURE: Pure Result pattern for all operations, pure data access layer
 * Pattern: Repository pattern with prepared statements for performance
 * Rationale: Efficient orchestration persistence for orchestrator mode (v0.9.0)
 */

import SQLite from 'better-sqlite3';
import { unlink } from 'fs/promises';
import os from 'os';
import path from 'path';
import { z } from 'zod';
import { type AgentProvider, isAgentProvider } from '../core/agents.js';
import { LoopId, Orchestration, OrchestratorId, OrchestratorStatus } from '../core/domain.js';
import { operationErrorHandler } from '../core/errors.js';
import { OrchestrationRepository, SyncOrchestrationOperations } from '../core/interfaces.js';
import { type Result, tryCatchAsync } from '../core/result.js';
import { Database } from './database.js';

// ============================================================================
// Zod schemas for boundary validation
// Pattern: Parse, don't validate — ensures type safety at system boundary
// ============================================================================

const OrchestrationRowSchema = z.object({
  id: z.string().min(1),
  goal: z.string().min(1),
  loop_id: z.string().nullable(),
  state_file_path: z.string().min(1),
  working_directory: z.string().min(1),
  agent: z.string().nullable(),
  model: z.string().nullable(),
  max_depth: z.number(),
  max_workers: z.number(),
  max_iterations: z.number(),
  status: z.enum(['planning', 'running', 'completed', 'failed', 'cancelled']),
  created_at: z.number(),
  updated_at: z.number(),
  completed_at: z.number().nullable(),
});

// ============================================================================
// Row types for type-safe database interaction
// ============================================================================

interface OrchestrationRow {
  readonly id: string;
  readonly goal: string;
  readonly loop_id: string | null;
  readonly state_file_path: string;
  readonly working_directory: string;
  readonly agent: string | null;
  readonly model: string | null;
  readonly max_depth: number;
  readonly max_workers: number;
  readonly max_iterations: number;
  readonly status: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly completed_at: number | null;
}

export class SQLiteOrchestrationRepository implements OrchestrationRepository, SyncOrchestrationOperations {
  /** Default pagination limit for findAll() */
  private static readonly DEFAULT_LIMIT = 100;

  private readonly db: SQLite.Database;
  private readonly saveStmt: SQLite.Statement;
  private readonly updateStmt: SQLite.Statement;
  private readonly findByIdStmt: SQLite.Statement;
  private readonly findAllPaginatedStmt: SQLite.Statement;
  private readonly findByStatusPaginatedStmt: SQLite.Statement;
  private readonly findByLoopIdStmt: SQLite.Statement;
  private readonly deleteStmt: SQLite.Statement;
  private readonly cleanupStmt: SQLite.Statement;
  private readonly countByStatusStmt: SQLite.Statement;

  constructor(database: Database) {
    this.db = database.getDatabase();

    this.saveStmt = this.db.prepare(`
      INSERT INTO orchestrations (
        id, goal, loop_id, state_file_path, working_directory,
        agent, model, max_depth, max_workers, max_iterations,
        status, created_at, updated_at, completed_at
      ) VALUES (
        @id, @goal, @loopId, @stateFilePath, @workingDirectory,
        @agent, @model, @maxDepth, @maxWorkers, @maxIterations,
        @status, @createdAt, @updatedAt, @completedAt
      )
    `);

    this.updateStmt = this.db.prepare(`
      UPDATE orchestrations SET
        goal = @goal,
        loop_id = @loopId,
        state_file_path = @stateFilePath,
        working_directory = @workingDirectory,
        agent = @agent,
        model = @model,
        max_depth = @maxDepth,
        max_workers = @maxWorkers,
        max_iterations = @maxIterations,
        status = @status,
        updated_at = @updatedAt,
        completed_at = @completedAt
      WHERE id = @id
    `);

    this.findByIdStmt = this.db.prepare(`
      SELECT * FROM orchestrations WHERE id = ?
    `);

    this.findAllPaginatedStmt = this.db.prepare(`
      SELECT * FROM orchestrations ORDER BY created_at DESC LIMIT ? OFFSET ?
    `);

    this.findByStatusPaginatedStmt = this.db.prepare(`
      SELECT * FROM orchestrations WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?
    `);

    this.findByLoopIdStmt = this.db.prepare(`
      SELECT * FROM orchestrations WHERE loop_id = ?
    `);

    this.deleteStmt = this.db.prepare(`
      DELETE FROM orchestrations WHERE id = ?
    `);

    // NOTE: Excludes 'planning' and 'running' orchestrations — only terminal states
    this.cleanupStmt = this.db.prepare(`
      SELECT id, state_file_path FROM orchestrations
      WHERE status IN ('completed', 'failed', 'cancelled') AND completed_at < ?
    `);

    this.countByStatusStmt = this.db.prepare(`
      SELECT status, COUNT(*) as count FROM orchestrations GROUP BY status
    `);
  }

  // ============================================================================
  // Async operations (wrapped in tryCatchAsync)
  // ============================================================================

  async save(orchestration: Orchestration): Promise<Result<void>> {
    return tryCatchAsync(
      async () => {
        this.saveStmt.run(this.toRow(orchestration));
      },
      operationErrorHandler('save orchestration', { orchestratorId: orchestration.id }),
    );
  }

  async update(orchestration: Orchestration): Promise<Result<void>> {
    return tryCatchAsync(
      async () => {
        this.updateStmt.run(this.toRow(orchestration));
      },
      operationErrorHandler('update orchestration', { orchestratorId: orchestration.id }),
    );
  }

  async findById(id: OrchestratorId): Promise<Result<Orchestration | null>> {
    return tryCatchAsync(
      async () => {
        const row = this.findByIdStmt.get(id) as OrchestrationRow | undefined;
        if (!row) return null;
        return this.rowToOrchestration(row);
      },
      operationErrorHandler('find orchestration', { orchestratorId: id }),
    );
  }

  async findAll(limit?: number, offset?: number): Promise<Result<readonly Orchestration[]>> {
    return tryCatchAsync(async () => {
      const effectiveLimit = limit ?? SQLiteOrchestrationRepository.DEFAULT_LIMIT;
      const effectiveOffset = offset ?? 0;
      const rows = this.findAllPaginatedStmt.all(effectiveLimit, effectiveOffset) as OrchestrationRow[];
      return rows.map((row) => this.rowToOrchestration(row));
    }, operationErrorHandler('find all orchestrations'));
  }

  async findByStatus(
    status: OrchestratorStatus,
    limit?: number,
    offset?: number,
  ): Promise<Result<readonly Orchestration[]>> {
    return tryCatchAsync(
      async () => {
        const effectiveLimit = limit ?? SQLiteOrchestrationRepository.DEFAULT_LIMIT;
        const effectiveOffset = offset ?? 0;
        const rows = this.findByStatusPaginatedStmt.all(status, effectiveLimit, effectiveOffset) as OrchestrationRow[];
        return rows.map((row) => this.rowToOrchestration(row));
      },
      operationErrorHandler('find orchestrations by status', { status }),
    );
  }

  async findByLoopId(loopId: LoopId): Promise<Result<Orchestration | null>> {
    return tryCatchAsync(
      async () => {
        const row = this.findByLoopIdStmt.get(loopId) as OrchestrationRow | undefined;
        if (!row) return null;
        return this.rowToOrchestration(row);
      },
      operationErrorHandler('find orchestration by loop ID', { loopId }),
    );
  }

  async delete(id: OrchestratorId): Promise<Result<void>> {
    return tryCatchAsync(
      async () => {
        this.deleteStmt.run(id);
      },
      operationErrorHandler('delete orchestration', { orchestratorId: id }),
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
    }, operationErrorHandler('count orchestrations by status'));
  }

  async cleanupOldOrchestrations(retentionMs: number): Promise<Result<number>> {
    return tryCatchAsync(async () => {
      const cutoff = Date.now() - retentionMs;
      const rows = this.cleanupStmt.all(cutoff) as Array<{ id: string; state_file_path: string }>;

      if (rows.length === 0) return 0;

      // DB is source of truth — delete rows first (crash-safe: orphan files are harmless)
      // Uses pre-prepared deleteStmt in a transaction — avoids dynamic db.prepare() inside loop
      const deleteInTransaction = this.db.transaction((ids: readonly string[]) => {
        for (const id of ids) {
          this.deleteStmt.run(id);
        }
      });

      const ids = rows.map((r) => r.id);
      deleteInTransaction(ids);

      // Best-effort async file cleanup — orphan files are harmless
      // Validate paths are within expected state directory before unlinking (defense against DB corruption)
      const expectedDir = path.resolve(path.join(os.homedir(), '.autobeat', 'orchestrator-state'));
      const isWithinStateDir = (filePath: string): boolean => {
        const resolved = path.resolve(filePath);
        return resolved.startsWith(expectedDir + path.sep);
      };

      // Delete per-orchestration state files and their corresponding exit condition scripts
      const filePaths = rows.map((r) => r.state_file_path).filter(isWithinStateDir);
      const scriptPaths = filePaths.map((fp) => {
        const dir = path.dirname(fp);
        const baseName = path.basename(fp, '.json');
        return path.join(dir, `check-complete-${baseName}.js`);
      });
      await Promise.allSettled([...filePaths, ...scriptPaths].map((p) => unlink(p)));

      return rows.length;
    }, operationErrorHandler('cleanup old orchestrations'));
  }

  // ============================================================================
  // SYNC METHODS (for use inside Database.runInTransaction())
  // These throw on error — the transaction wrapper catches and converts to Result.
  // ============================================================================

  saveSync(orchestration: Orchestration): void {
    this.saveStmt.run(this.toRow(orchestration));
  }

  updateSync(orchestration: Orchestration): void {
    this.updateStmt.run(this.toRow(orchestration));
  }

  findByIdSync(id: OrchestratorId): Orchestration | null {
    const row = this.findByIdStmt.get(id) as OrchestrationRow | undefined;
    if (!row) return null;
    return this.rowToOrchestration(row);
  }

  findByLoopIdSync(loopId: LoopId): Orchestration | null {
    const row = this.findByLoopIdStmt.get(loopId) as OrchestrationRow | undefined;
    if (!row) return null;
    return this.rowToOrchestration(row);
  }

  // ============================================================================
  // Row conversion helpers
  // ============================================================================

  private toRow(orchestration: Orchestration): Record<string, unknown> {
    return {
      id: orchestration.id,
      goal: orchestration.goal,
      loopId: orchestration.loopId ?? null,
      stateFilePath: orchestration.stateFilePath,
      workingDirectory: orchestration.workingDirectory,
      agent: orchestration.agent ?? null,
      model: orchestration.model ?? null,
      maxDepth: orchestration.maxDepth,
      maxWorkers: orchestration.maxWorkers,
      maxIterations: orchestration.maxIterations,
      status: orchestration.status,
      createdAt: orchestration.createdAt,
      updatedAt: orchestration.updatedAt,
      completedAt: orchestration.completedAt ?? null,
    };
  }

  private rowToOrchestration(row: OrchestrationRow): Orchestration {
    const data = OrchestrationRowSchema.parse(row);
    return {
      id: OrchestratorId(data.id),
      goal: data.goal,
      loopId: data.loop_id ? LoopId(data.loop_id) : undefined,
      stateFilePath: data.state_file_path,
      workingDirectory: data.working_directory,
      agent: data.agent ? this.toAgentProvider(data.agent) : undefined,
      model: data.model ?? undefined,
      maxDepth: data.max_depth,
      maxWorkers: data.max_workers,
      maxIterations: data.max_iterations,
      status: this.toOrchestratorStatus(data.status),
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      completedAt: data.completed_at ?? undefined,
    };
  }

  private toOrchestratorStatus(value: string): OrchestratorStatus {
    switch (value) {
      case 'planning':
        return OrchestratorStatus.PLANNING;
      case 'running':
        return OrchestratorStatus.RUNNING;
      case 'completed':
        return OrchestratorStatus.COMPLETED;
      case 'failed':
        return OrchestratorStatus.FAILED;
      case 'cancelled':
        return OrchestratorStatus.CANCELLED;
      default:
        throw new Error(`Unknown orchestrator status: ${value} - possible data corruption`);
    }
  }

  private toAgentProvider(value: string): AgentProvider {
    if (!isAgentProvider(value)) {
      throw new Error(`Unknown agent provider: ${value} - possible data corruption`);
    }
    return value;
  }
}
