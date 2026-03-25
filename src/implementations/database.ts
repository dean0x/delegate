/**
 * SQLite database initialization and management
 * Handles database creation, schema setup, and connection management
 */

import SQLite from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BackbeatError, ErrorCode } from '../core/errors.js';
import { Logger, TransactionRunner } from '../core/interfaces.js';
import { Result, tryCatch } from '../core/result.js';

/**
 * Silent no-op logger for when no logger is provided
 * Pattern: Null Object - avoids null checks throughout code
 */
const noOpLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noOpLogger,
};

/**
 * SQLite database wrapper for Backbeat task persistence.
 *
 * @remarks
 * Database location can be configured via environment variables:
 * - `BACKBEAT_DATABASE_PATH`: Full absolute path to database file (e.g., `/tmp/test.db`)
 * - `BACKBEAT_DATA_DIR`: Directory to store `backbeat.db` (e.g., `~/.backbeat`)
 * - Default: `~/.backbeat/backbeat.db`
 *
 * Security: Both environment variables are validated to prevent path traversal attacks.
 * Paths must be absolute and cannot contain `..` sequences.
 *
 * @example
 * ```typescript
 * // Use default path (~/.backbeat/backbeat.db)
 * const db = new Database();
 *
 * // Use custom path (for testing)
 * process.env.BACKBEAT_DATABASE_PATH = '/tmp/test.db';
 * const testDb = new Database();
 * ```
 */
export class Database implements TransactionRunner {
  private db: SQLite.Database;
  private readonly dbPath: string;
  private readonly logger: Logger;

  constructor(dbPath?: string, logger?: Logger) {
    this.dbPath = dbPath || this.getDefaultDbPath();
    this.logger = logger ?? noOpLogger;

    // Ensure data directory exists
    // Note: We intentionally keep sync operation in constructor
    // Async constructors are not supported in JS/TS
    // This runs once at startup, not in hot path
    const dataDir = path.dirname(this.dbPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Initialize SQLite database
    this.db = new SQLite(this.dbPath);

    // SECURITY: Enable foreign key constraints (disabled by default in SQLite)
    // This prevents dependencies from referencing non-existent tasks
    this.db.pragma('foreign_keys = ON');

    // Configure for better performance and concurrency
    // Fall back to DELETE mode in test environments where WAL might fail
    try {
      this.db.pragma('journal_mode = WAL');
    } catch (error) {
      // WAL mode failed (common in CI environments), use DELETE mode
      this.logger.warn('WAL mode failed, falling back to DELETE mode', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.db.pragma('journal_mode = DELETE');
    }
    this.db.pragma('synchronous = NORMAL');

    // Create tables if they don't exist
    this.createTables();
  }

  private getDefaultDbPath(): string {
    // Allow override via environment variables
    // SECURITY: Validate environment variables to prevent path traversal

    // BACKBEAT_DATABASE_PATH: Full path to database file (used by tests)
    if (process.env.BACKBEAT_DATABASE_PATH) {
      const dbPath = process.env.BACKBEAT_DATABASE_PATH;

      // Validate path is absolute and doesn't contain traversal
      if (!path.isAbsolute(dbPath)) {
        throw new Error('BACKBEAT_DATABASE_PATH must be an absolute path');
      }

      const normalized = path.normalize(dbPath);
      if (normalized.includes('..')) {
        throw new Error('BACKBEAT_DATABASE_PATH must not contain path traversal sequences (..)');
      }

      return normalized;
    }

    // BACKBEAT_DATA_DIR: Directory containing backbeat.db
    if (process.env.BACKBEAT_DATA_DIR) {
      const dataDir = process.env.BACKBEAT_DATA_DIR;

      // Validate path is absolute and doesn't contain traversal
      if (!path.isAbsolute(dataDir)) {
        throw new Error('BACKBEAT_DATA_DIR must be an absolute path');
      }

      const normalized = path.normalize(dataDir);
      if (normalized.includes('..')) {
        throw new Error('BACKBEAT_DATA_DIR must not contain path traversal sequences (..)');
      }

      return path.join(normalized, 'backbeat.db');
    }

    // Platform-specific defaults
    const homeDir = os.homedir();

    if (process.platform === 'win32') {
      // Windows: %APPDATA%/backbeat
      const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
      return path.join(appData, 'backbeat', 'backbeat.db');
    } else {
      // Linux/Mac: ~/.backbeat
      return path.join(homeDir, '.backbeat', 'backbeat.db');
    }
  }

  private createTables(): void {
    // SCHEMA MIGRATIONS: Only create migrations table here
    // All other tables are created through migrations (single source of truth)
    // Pattern: Version-based migrations with timestamps
    // Rationale: Enables safe schema evolution without data loss
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL,
        description TEXT
      )
    `);

    // Get current schema version
    const currentVersion = this.getCurrentSchemaVersion();

    // Apply all pending migrations (schema lives in migrations)
    this.applyMigrations(currentVersion);
  }

  isOpen(): boolean {
    return this.db.open;
  }

  close(): void {
    if (this.db && this.db.open) {
      this.db.close();
    }
  }

  getTables(): string[] {
    const result = this.db
      .prepare(`
      SELECT name FROM sqlite_master 
      WHERE type='table' 
      ORDER BY name
    `)
      .all() as Array<{ name: string }>;

    return result.map((row) => row.name);
  }

  getJournalMode(): string {
    const result = this.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    return result.journal_mode;
  }

  getDatabase(): SQLite.Database {
    return this.db;
  }

  /**
   * Get current schema version from migrations table
   * Returns 0 if no migrations have been applied (fresh database)
   */
  private getCurrentSchemaVersion(): number {
    try {
      const result = this.db
        .prepare(`
        SELECT MAX(version) as version FROM schema_migrations
      `)
        .get() as { version: number | null };

      return result?.version || 0;
    } catch (error: unknown) {
      // Only return 0 if the table doesn't exist (fresh database)
      // Re-throw all other errors (permissions, corruption, connection issues)
      if (error instanceof Error && error.message.includes('no such table')) {
        return 0;
      }
      throw error;
    }
  }

  /**
   * Apply migrations incrementally from current version to latest
   * Pattern: Version-based migrations with idempotent operations
   * Rationale: Safe incremental upgrades without data loss
   */
  private applyMigrations(currentVersion: number): void {
    const migrations = this.getMigrations();

    // Apply migrations in order
    for (const migration of migrations) {
      if (migration.version > currentVersion) {
        this.logger.info('Applying database migration', {
          version: migration.version,
          description: migration.description,
        });

        // Run migration in transaction for safety
        const applyMigration = this.db.transaction(() => {
          // Execute migration SQL
          migration.up(this.db);

          // Record migration as applied
          this.db
            .prepare(`
            INSERT INTO schema_migrations (version, applied_at, description)
            VALUES (?, ?, ?)
          `)
            .run(migration.version, Date.now(), migration.description);
        });

        applyMigration();
        this.logger.info('Database migration applied successfully', {
          version: migration.version,
        });
      }
    }
  }

  /**
   * Define all schema migrations
   * Add new migrations here with incrementing version numbers
   *
   * ARCHITECTURE: Migrations are the single source of truth for schema
   * - Fresh databases: All migrations run in order
   * - Existing databases: Only new migrations run (skips already applied)
   * - Uses IF NOT EXISTS for idempotency (safe if migration runs twice)
   */
  private getMigrations(): Array<{
    version: number;
    description: string;
    up: (db: SQLite.Database) => void;
  }> {
    return [
      {
        version: 1,
        description: 'Baseline schema with tasks, dependencies, and output tables',
        up: (db) => {
          // Tasks table - core task data
          db.exec(`
            CREATE TABLE IF NOT EXISTS tasks (
              id TEXT PRIMARY KEY,
              prompt TEXT NOT NULL,
              status TEXT NOT NULL,
              priority TEXT NOT NULL,
              working_directory TEXT,
              timeout INTEGER,
              max_output_buffer INTEGER,
              parent_task_id TEXT,
              retry_count INTEGER,
              retry_of TEXT,
              created_at INTEGER NOT NULL,
              started_at INTEGER,
              completed_at INTEGER,
              worker_id TEXT,
              exit_code INTEGER,
              dependencies TEXT
            )
          `);

          // Task output table - stdout/stderr capture
          db.exec(`
            CREATE TABLE IF NOT EXISTS task_output (
              task_id TEXT PRIMARY KEY,
              stdout TEXT,
              stderr TEXT,
              total_size INTEGER,
              file_path TEXT,
              FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
            )
          `);

          // Task dependencies table - DAG for dependency tracking
          // Pattern: Normalized dependency tracking with resolution states
          // Rationale: Enables efficient cycle detection, dependency queries, and state tracking
          db.exec(`
            CREATE TABLE IF NOT EXISTS task_dependencies (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              task_id TEXT NOT NULL,
              depends_on_task_id TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              resolved_at INTEGER,
              resolution TEXT NOT NULL DEFAULT 'pending',
              FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
              FOREIGN KEY (depends_on_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
              UNIQUE(task_id, depends_on_task_id)
            )
          `);

          // Performance indexes
          db.exec(`
            CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
            CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
            CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
            CREATE INDEX IF NOT EXISTS idx_task_dependencies_task_id ON task_dependencies(task_id);
            CREATE INDEX IF NOT EXISTS idx_task_dependencies_depends_on ON task_dependencies(depends_on_task_id);
            CREATE INDEX IF NOT EXISTS idx_task_dependencies_resolution ON task_dependencies(resolution);
            CREATE INDEX IF NOT EXISTS idx_task_dependencies_blocked ON task_dependencies(task_id, resolution);
            CREATE INDEX IF NOT EXISTS idx_task_dependencies_depends_on_resolution ON task_dependencies(depends_on_task_id, resolution);
          `);
        },
      },
      {
        version: 2,
        description: 'Add CHECK constraint on resolution column for defense-in-depth',
        up: (db) => {
          // SQLite doesn't support adding CHECK constraints to existing columns
          // So we recreate the table with the constraint
          // Pattern: Safe table migration with data preservation
          db.exec(`
            -- Create new table with CHECK constraint
            CREATE TABLE task_dependencies_new (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              task_id TEXT NOT NULL,
              depends_on_task_id TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              resolved_at INTEGER,
              resolution TEXT NOT NULL DEFAULT 'pending'
                CHECK (resolution IN ('pending', 'completed', 'failed', 'cancelled')),
              FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
              FOREIGN KEY (depends_on_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
              UNIQUE(task_id, depends_on_task_id)
            );

            -- Copy existing data (all existing values should be valid)
            INSERT INTO task_dependencies_new
              SELECT * FROM task_dependencies;

            -- Drop old table
            DROP TABLE task_dependencies;

            -- Rename new table
            ALTER TABLE task_dependencies_new RENAME TO task_dependencies;

            -- Recreate indexes (indexes don't survive table rename)
            CREATE INDEX IF NOT EXISTS idx_task_dependencies_task_id ON task_dependencies(task_id);
            CREATE INDEX IF NOT EXISTS idx_task_dependencies_depends_on ON task_dependencies(depends_on_task_id);
            CREATE INDEX IF NOT EXISTS idx_task_dependencies_resolution ON task_dependencies(resolution);
            CREATE INDEX IF NOT EXISTS idx_task_dependencies_blocked ON task_dependencies(task_id, resolution);
            CREATE INDEX IF NOT EXISTS idx_task_dependencies_depends_on_resolution ON task_dependencies(depends_on_task_id, resolution);
          `);
        },
      },
      {
        version: 3,
        description: 'Add CHECK constraints on status and priority columns for defense-in-depth',
        up: (db) => {
          // SQLite doesn't support adding CHECK constraints to existing columns
          // So we recreate the table with the constraints
          // Pattern: Safe table migration with data preservation
          db.exec(`
            -- Create new table with CHECK constraints
            CREATE TABLE tasks_new (
              id TEXT PRIMARY KEY,
              prompt TEXT NOT NULL,
              status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
              priority TEXT NOT NULL CHECK (priority IN ('P0', 'P1', 'P2')),
              working_directory TEXT,
              timeout INTEGER,
              max_output_buffer INTEGER,
              parent_task_id TEXT,
              retry_count INTEGER,
              retry_of TEXT,
              created_at INTEGER NOT NULL,
              started_at INTEGER,
              completed_at INTEGER,
              worker_id TEXT,
              exit_code INTEGER,
              dependencies TEXT
            );

            -- Copy existing data (all existing values should be valid)
            INSERT INTO tasks_new SELECT * FROM tasks;

            -- Drop old table
            DROP TABLE tasks;

            -- Rename new table
            ALTER TABLE tasks_new RENAME TO tasks;

            -- Recreate indexes (indexes don't survive table rename)
            CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
            CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
            CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
          `);
        },
      },
      {
        version: 4,
        description: 'Add schedules and schedule_executions tables for task scheduling',
        up: (db) => {
          // Schedules table - stores schedule definitions
          // ARCHITECTURE: Supports both cron-based recurring and one-time schedules
          // Pattern: task_template stored as JSON for TaskRequest serialization
          db.exec(`
            CREATE TABLE IF NOT EXISTS schedules (
              id TEXT PRIMARY KEY,
              task_template TEXT NOT NULL,
              schedule_type TEXT NOT NULL CHECK (schedule_type IN ('cron', 'one_time')),
              cron_expression TEXT,
              scheduled_at INTEGER,
              timezone TEXT NOT NULL DEFAULT 'UTC',
              missed_run_policy TEXT NOT NULL DEFAULT 'skip' CHECK (missed_run_policy IN ('skip', 'catchup', 'fail')),
              status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'cancelled', 'expired')),
              max_runs INTEGER CHECK (max_runs > 0),
              run_count INTEGER NOT NULL DEFAULT 0 CHECK (run_count >= 0),
              last_run_at INTEGER,
              next_run_at INTEGER,
              expires_at INTEGER,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            )
          `);

          // Schedule executions table - audit trail of schedule triggers
          // ARCHITECTURE: Tracks each execution attempt for debugging and monitoring
          // Pattern: References schedule and optionally created task
          db.exec(`
            CREATE TABLE IF NOT EXISTS schedule_executions (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              schedule_id TEXT NOT NULL,
              task_id TEXT,
              scheduled_for INTEGER NOT NULL,
              executed_at INTEGER,
              status TEXT NOT NULL CHECK (status IN ('pending', 'triggered', 'completed', 'failed', 'missed', 'skipped')),
              error_message TEXT,
              created_at INTEGER NOT NULL,
              FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE,
              FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
            )
          `);

          // Performance indexes for schedule queries
          db.exec(`
            CREATE INDEX IF NOT EXISTS idx_schedules_status ON schedules(status);
            CREATE INDEX IF NOT EXISTS idx_schedules_next_run ON schedules(next_run_at);
            CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(status, next_run_at);
            CREATE INDEX IF NOT EXISTS idx_schedule_executions_schedule ON schedule_executions(schedule_id);
            CREATE INDEX IF NOT EXISTS idx_schedule_executions_schedule_time ON schedule_executions(schedule_id, scheduled_for DESC);
            CREATE INDEX IF NOT EXISTS idx_schedule_executions_status ON schedule_executions(status);
          `);
        },
      },
      {
        version: 5,
        description: 'Add task_checkpoints table and after_schedule_id column for v0.4.0',
        up: (db) => {
          // Task checkpoints table for "smart retry" resumption
          // ARCHITECTURE: Captures task state snapshots for enriched retry prompts
          db.exec(`
            CREATE TABLE IF NOT EXISTS task_checkpoints (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              task_id TEXT NOT NULL,
              checkpoint_type TEXT NOT NULL CHECK (checkpoint_type IN ('completed', 'failed', 'cancelled')),
              output_summary TEXT,
              error_summary TEXT,
              git_branch TEXT,
              git_commit_sha TEXT,
              git_dirty_files TEXT,
              context_note TEXT,
              created_at INTEGER NOT NULL,
              FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
            )
          `);

          // Performance indexes for checkpoint queries
          db.exec(`
            CREATE INDEX IF NOT EXISTS idx_task_checkpoints_task_id ON task_checkpoints(task_id);
            CREATE INDEX IF NOT EXISTS idx_task_checkpoints_task_time ON task_checkpoints(task_id, created_at DESC);
          `);

          // Add after_schedule_id column for schedule chaining
          db.exec(`
            ALTER TABLE schedules ADD COLUMN after_schedule_id TEXT
          `);
        },
      },
      {
        version: 6,
        description: 'Add continue_from column for session continuation through dependency chains',
        up: (db) => {
          db.exec(`ALTER TABLE tasks ADD COLUMN continue_from TEXT`);
        },
      },
      {
        version: 7,
        description: 'Add agent column for multi-agent support (v0.5.0)',
        up: (db) => {
          db.exec(`ALTER TABLE tasks ADD COLUMN agent TEXT DEFAULT 'claude'`);
        },
      },
      {
        version: 8,
        description: 'Add pipeline_steps to schedules and pipeline_task_ids to executions (v0.6.0)',
        up: (db) => {
          // Nullable JSON array of pipeline step definitions
          db.exec(`ALTER TABLE schedules ADD COLUMN pipeline_steps TEXT`);
          // Nullable JSON array of TaskIds created by a pipeline trigger
          db.exec(`ALTER TABLE schedule_executions ADD COLUMN pipeline_task_ids TEXT`);
        },
      },
      {
        version: 9,
        description: 'Add workers table for cross-process coordination (v1.0)',
        up: (db) => {
          // Workers table - tracks active workers across all processes
          // ARCHITECTURE: Enables cross-process coordination and PID-based crash recovery
          // Pattern: Each worker row represents a live worker process; removed on completion/kill
          db.exec(`
            CREATE TABLE IF NOT EXISTS workers (
              worker_id TEXT PRIMARY KEY,
              task_id TEXT NOT NULL UNIQUE,
              pid INTEGER NOT NULL,
              owner_pid INTEGER NOT NULL,
              agent TEXT NOT NULL DEFAULT 'claude',
              started_at INTEGER NOT NULL,
              FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
            )
          `);

          // Indexes for common queries
          db.exec(`
            CREATE INDEX IF NOT EXISTS idx_workers_owner_pid ON workers(owner_pid);
            CREATE INDEX IF NOT EXISTS idx_workers_pid ON workers(pid);
          `);
        },
      },
      {
        version: 10,
        description: 'Add loops and loop_iterations tables for iterative task execution (v0.7.0)',
        up: (db) => {
          // Loops table - stores loop definitions and current state
          // ARCHITECTURE: Supports retry and optimize strategies with exit condition evaluation
          // Pattern: task_template stored as JSON for TaskRequest serialization (same as schedules)
          db.exec(`
            CREATE TABLE IF NOT EXISTS loops (
              id TEXT PRIMARY KEY,
              strategy TEXT NOT NULL CHECK(strategy IN ('retry', 'optimize')),
              task_template TEXT NOT NULL,
              pipeline_steps TEXT,
              exit_condition TEXT NOT NULL,
              eval_direction TEXT,
              eval_timeout INTEGER NOT NULL DEFAULT 60000,
              working_directory TEXT NOT NULL,
              max_iterations INTEGER NOT NULL DEFAULT 10,
              max_consecutive_failures INTEGER NOT NULL DEFAULT 3,
              cooldown_ms INTEGER NOT NULL DEFAULT 0,
              fresh_context INTEGER NOT NULL DEFAULT 1,
              status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'failed', 'cancelled')),
              current_iteration INTEGER NOT NULL DEFAULT 0,
              best_score REAL,
              best_iteration_id INTEGER,
              consecutive_failures INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              completed_at INTEGER
            )
          `);

          // Loop iterations table - tracks individual iteration execution and results
          // ARCHITECTURE: Each iteration spawns a task; results evaluated by exit condition
          db.exec(`
            CREATE TABLE IF NOT EXISTS loop_iterations (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              loop_id TEXT NOT NULL REFERENCES loops(id) ON DELETE CASCADE,
              iteration_number INTEGER NOT NULL,
              task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
              pipeline_task_ids TEXT,
              status TEXT NOT NULL CHECK(status IN ('running', 'pass', 'fail', 'keep', 'discard', 'crash', 'cancelled')),
              score REAL,
              exit_code INTEGER,
              error_message TEXT,
              started_at INTEGER NOT NULL,
              completed_at INTEGER,
              UNIQUE(loop_id, iteration_number)
            )
          `);

          // Performance indexes for loop queries
          db.exec(`
            CREATE INDEX IF NOT EXISTS idx_loops_status ON loops(status);
            CREATE INDEX IF NOT EXISTS idx_loop_iterations_loop_id ON loop_iterations(loop_id);
            CREATE INDEX IF NOT EXISTS idx_loop_iterations_task_id ON loop_iterations(task_id);
            CREATE INDEX IF NOT EXISTS idx_loop_iterations_status ON loop_iterations(status);
            CREATE INDEX IF NOT EXISTS idx_loop_iterations_loop_iteration ON loop_iterations(loop_id, iteration_number DESC);
          `);
        },
      },
      {
        version: 11,
        description:
          'Add PAUSED to loop status, git/schedule fields to loops/iterations, loopConfig to schedules (v0.8.0)',
        up: (db) => {
          // 1. Recreate loops table with 'paused' in status CHECK + new columns
          // Pattern: Safe table migration with data preservation (same as v2/v3)
          db.exec(`
            CREATE TABLE loops_new (
              id TEXT PRIMARY KEY,
              strategy TEXT NOT NULL CHECK(strategy IN ('retry', 'optimize')),
              task_template TEXT NOT NULL,
              pipeline_steps TEXT,
              exit_condition TEXT NOT NULL,
              eval_direction TEXT,
              eval_timeout INTEGER NOT NULL DEFAULT 60000,
              working_directory TEXT NOT NULL,
              max_iterations INTEGER NOT NULL DEFAULT 10,
              max_consecutive_failures INTEGER NOT NULL DEFAULT 3,
              cooldown_ms INTEGER NOT NULL DEFAULT 0,
              fresh_context INTEGER NOT NULL DEFAULT 1,
              status TEXT NOT NULL DEFAULT 'running'
                CHECK(status IN ('running', 'paused', 'completed', 'failed', 'cancelled')),
              current_iteration INTEGER NOT NULL DEFAULT 0,
              best_score REAL,
              best_iteration_id INTEGER,
              consecutive_failures INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              completed_at INTEGER,
              git_branch TEXT,
              git_base_branch TEXT,
              schedule_id TEXT REFERENCES schedules(id) ON DELETE SET NULL
            )
          `);

          // Copy existing data — explicit column list for safety (NULL for new v11 columns)
          db.exec(`
            INSERT INTO loops_new (
              id, strategy, task_template, pipeline_steps, exit_condition,
              eval_direction, eval_timeout, working_directory, max_iterations,
              max_consecutive_failures, cooldown_ms, fresh_context, status,
              current_iteration, best_score, best_iteration_id, consecutive_failures,
              created_at, updated_at, completed_at,
              git_branch, git_base_branch, schedule_id
            )
            SELECT
              id, strategy, task_template, pipeline_steps, exit_condition,
              eval_direction, eval_timeout, working_directory, max_iterations,
              max_consecutive_failures, cooldown_ms, fresh_context, status,
              current_iteration, best_score, best_iteration_id, consecutive_failures,
              created_at, updated_at, completed_at,
              NULL, NULL, NULL
            FROM loops
          `);

          db.exec(`DROP TABLE loops`);
          db.exec(`ALTER TABLE loops_new RENAME TO loops`);

          // Recreate loops table indexes (dropped with table) + new schedule_id index
          // NOTE: loop_iterations indexes survive since that table was not recreated
          db.exec(`
            CREATE INDEX idx_loops_status ON loops(status);
            CREATE INDEX idx_loops_schedule_id ON loops(schedule_id);
          `);

          // 2. Add git fields to loop_iterations
          db.exec(`ALTER TABLE loop_iterations ADD COLUMN git_branch TEXT`);
          db.exec(`ALTER TABLE loop_iterations ADD COLUMN git_diff_summary TEXT`);

          // 3. Add loop_config to schedules (JSON: LoopCreateRequest)
          db.exec(`ALTER TABLE schedules ADD COLUMN loop_config TEXT`);

          // 4. Add loop_id to schedule_executions
          db.exec(`ALTER TABLE schedule_executions ADD COLUMN loop_id TEXT`);
        },
      },
      {
        version: 12,
        description: 'Add commit-per-iteration git columns to loops and loop_iterations (v0.8.1)',
        up: (db) => {
          // New column on loops: captures HEAD SHA at loop creation
          db.exec(`ALTER TABLE loops ADD COLUMN git_start_commit_sha TEXT`);

          // New columns on loop_iterations: commit SHA after changes, pre-iteration snapshot
          db.exec(`ALTER TABLE loop_iterations ADD COLUMN git_commit_sha TEXT`);
          db.exec(`ALTER TABLE loop_iterations ADD COLUMN pre_iteration_commit_sha TEXT`);

          // Old columns (git_base_branch on loops, git_branch on iterations) kept —
          // SQLite cannot DROP COLUMN easily and dead columns are harmless
        },
      },
    ];
  }

  /**
   * Run a synchronous function inside a SQLite transaction.
   * If the function throws, the transaction is rolled back and an err Result is returned.
   * If the function returns, the transaction is committed and the return value is wrapped in ok.
   *
   * ARCHITECTURE: Uses better-sqlite3's synchronous transaction API.
   * All operations inside fn must be synchronous (use *Sync repo methods).
   * BackbeatErrors thrown inside fn are preserved; other errors are wrapped.
   */
  runInTransaction<T>(fn: () => T): Result<T> {
    return tryCatch(
      () => this.db.transaction(fn)(),
      (error) =>
        error instanceof BackbeatError
          ? error
          : new BackbeatError(
              ErrorCode.SYSTEM_ERROR,
              `Transaction failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
    );
  }

  /**
   * Get current schema version (public method for monitoring/debugging)
   */
  getSchemaVersion(): number {
    return this.getCurrentSchemaVersion();
  }
}
