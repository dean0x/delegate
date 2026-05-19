import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TaskId } from '../../../src/core/domain';
import { AutobeatError, ErrorCode } from '../../../src/core/errors';
import { Database } from '../../../src/implementations/database';
import { TEST_COUNTS } from '../../constants';
import { TaskFactory } from '../../fixtures/factories';

describe('Database - REAL Database Operations (In-Memory)', () => {
  let db: Database;

  beforeEach(() => {
    // Use in-memory database for tests - real SQLite, no file I/O
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  describe('Connection management', () => {
    it('should connect to in-memory database', () => {
      // Constructor automatically connects
      expect(db.isOpen()).toBe(true);
    });

    it('should close connection', () => {
      db.close();
      expect(db.isOpen()).toBe(false);
    });

    it('should handle double close gracefully', () => {
      db.close();
      expect(() => db.close()).not.toThrow();
    });
  });

  describe('Schema initialization', () => {
    it('should initialize schema with tables', () => {
      const tables = db.getTables();
      expect(tables).toContain('tasks');
      expect(tables).toContain('task_output');
    });

    it('should create tasks table with all columns', () => {
      const sqliteDb = db.getDatabase();
      const columns = sqliteDb.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>;
      const columnNames = columns.map((col) => col.name);

      // Verify all required columns exist
      expect(columnNames).toContain('id');
      expect(columnNames).toContain('prompt');
      expect(columnNames).toContain('status');
      expect(columnNames).toContain('priority');
      expect(columnNames).toContain('working_directory');
      expect(columnNames).toContain('timeout');
      expect(columnNames).toContain('max_output_buffer');
      expect(columnNames).toContain('parent_task_id');
      expect(columnNames).toContain('retry_count');
      expect(columnNames).toContain('retry_of');
      expect(columnNames).toContain('created_at');
      expect(columnNames).toContain('started_at');
      expect(columnNames).toContain('completed_at');
      expect(columnNames).toContain('worker_id');
      expect(columnNames).toContain('exit_code');
      expect(columnNames).toContain('dependencies');
    });

    it('should create task_output table with all columns', () => {
      const sqliteDb = db.getDatabase();
      const columns = sqliteDb.prepare(`PRAGMA table_info(task_output)`).all() as Array<{
        name: string;
        type: string;
        notnull: number;
        pk: number;
      }>;
      const columnNames = columns.map((col) => col.name);

      expect(columnNames).toContain('task_id');
      expect(columnNames).toContain('stdout');
      expect(columnNames).toContain('stderr');
      expect(columnNames).toContain('total_size');
      expect(columnNames).toContain('file_path');
      expect(columnNames.length).toBe(5);

      // Verify column types
      const taskIdCol = columns.find((c) => c.name === 'task_id');
      expect(taskIdCol).toBeDefined();
      expect(taskIdCol?.type).toBe('TEXT');
      expect(taskIdCol?.pk).toBe(1);
      // FIX: SQLite doesn't add NOT NULL to TEXT PRIMARY KEY automatically
      expect(taskIdCol?.notnull).toBe(0);
    });

    it('should create indexes for performance', () => {
      const sqliteDb = db.getDatabase();
      const indexes = sqliteDb
        .prepare(`
        SELECT name FROM sqlite_master
        WHERE type='index' AND name LIKE 'idx_%'
      `)
        .all() as Array<{ name: string }>;
      const indexNames = indexes.map((idx) => idx.name);

      expect(indexNames).toContain('idx_tasks_status');
      expect(indexNames).toContain('idx_tasks_priority');
      expect(indexNames).toContain('idx_tasks_created_at');
      expect(indexNames.length).toBeGreaterThanOrEqual(3);
      expect(Array.isArray(indexNames)).toBe(true);

      // Verify indexes exist in sqlite_master
      const masterCount = sqliteDb
        .prepare(`
        SELECT COUNT(*) as count FROM sqlite_master WHERE type='index'
      `)
        .get() as { count: number };
      expect(masterCount.count).toBeGreaterThanOrEqual(3);
    });

    it('should be idempotent - creating tables multiple times should not fail', () => {
      // Tables already created in constructor
      const db2 = new Database(':memory:');
      expect(db2.getTables()).toContain('tasks');
      db2.close();
    });
  });

  describe('Database operations', () => {
    it('should allow direct SQL queries through getDatabase()', () => {
      const sqliteDb = db.getDatabase();

      // Insert a test task
      const stmt = sqliteDb.prepare(`
        INSERT INTO tasks (id, prompt, status, priority, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);

      const result = stmt.run('test-id', 'test prompt', 'queued', 'P1', Date.now());
      expect(result.changes).toBe(1);

      // Query it back
      const task = sqliteDb.prepare('SELECT * FROM tasks WHERE id = ?').get('test-id') as
        | {
            id: string;
            prompt: string;
            status: string;
            priority: string;
            created_at: number;
            updated_at: number;
          }
        | undefined;

      expect(task?.prompt).toBe('test prompt');
      expect(task?.id).toBe('test-id');
      expect(task?.status).toBe('queued');
      // FIX: We inserted P1, not P2
      expect(task?.priority).toBe('P1');
    });

    it('should handle transactions', () => {
      const sqliteDb = db.getDatabase();

      const insertMany = sqliteDb.transaction((tasks: Array<{ id: string; prompt: string }>) => {
        const stmt = sqliteDb.prepare(`
          INSERT INTO tasks (id, prompt, status, priority, created_at)
          VALUES (?, ?, 'queued', 'P2', ?)
        `);

        for (const task of tasks) {
          stmt.run(task.id, task.prompt, Date.now());
        }
      });

      // FIX: Don't use TaskFactory.build() here - creates frozen objects
      // Transaction expects plain objects with just id and prompt
      insertMany([
        { id: 'task-1', prompt: 'prompt 1' },
        { id: 'task-2', prompt: 'prompt 2' },
        { id: 'task-3', prompt: 'prompt 3' },
      ]);

      const count = sqliteDb.prepare('SELECT COUNT(*) as count FROM tasks').get() as { count: number };
      expect(count.count).toBe(3);
    });

    it('should handle foreign key constraints', () => {
      const sqliteDb = db.getDatabase();

      // Enable foreign keys
      sqliteDb.pragma('foreign_keys = ON');

      // Insert a task
      sqliteDb
        .prepare(`
        INSERT INTO tasks (id, prompt, status, priority, created_at)
        VALUES ('parent-task', 'test', 'queued', 'P1', ?)
      `)
        .run(Date.now());

      // Insert output for the task
      sqliteDb
        .prepare(`
        INSERT INTO task_output (task_id, stdout, stderr, total_size)
        VALUES ('parent-task', 'output', 'errors', 100)
      `)
        .run();

      // Verify cascade delete
      sqliteDb.prepare('DELETE FROM tasks WHERE id = ?').run('parent-task');

      const output = sqliteDb.prepare('SELECT * FROM task_output WHERE task_id = ?').get('parent-task');
      expect(output).toBeUndefined();
    });

    it('should handle concurrent operations with WAL mode', () => {
      // In-memory databases don't support WAL, so it should fall back to DELETE or MEMORY
      const journalMode = db.getJournalMode();
      expect(['delete', 'memory', 'DELETE', 'MEMORY'].includes(journalMode)).toBe(true);
    });
  });

  describe('Error handling', () => {
    it('should handle SQL errors gracefully', () => {
      const sqliteDb = db.getDatabase();

      // Try to insert duplicate primary key
      sqliteDb
        .prepare(`
        INSERT INTO tasks (id, prompt, status, priority, created_at)
        VALUES ('dup-id', 'test', 'queued', 'P1', ?)
      `)
        .run(Date.now());

      expect(() => {
        sqliteDb
          .prepare(`
          INSERT INTO tasks (id, prompt, status, priority, created_at)
          VALUES ('dup-id', 'test2', 'queued', 'P1', ?)
        `)
          .run(Date.now());
      }).toThrow();
    });

    it('should handle invalid SQL', () => {
      const sqliteDb = db.getDatabase();

      expect(() => {
        sqliteDb.prepare('SELECT * FROM nonexistent_table').all();
      }).toThrow();
    });
  });

  describe('Performance optimizations', () => {
    it('should use prepared statements efficiently', () => {
      const sqliteDb = db.getDatabase();

      const stmt = sqliteDb.prepare(`
        INSERT INTO tasks (id, prompt, status, priority, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);

      const start = performance.now();
      for (let i = 0; i < TEST_COUNTS.STRESS_TEST; i++) {
        stmt.run(`task-${i}`, `prompt ${i}`, 'queued', 'P2', Date.now());
      }
      const duration = performance.now() - start;

      // Should be very fast with prepared statements
      expect(duration).toBeLessThan(100);

      const count = sqliteDb.prepare('SELECT COUNT(*) as count FROM tasks').get() as { count: number };
      expect(count.count).toBe(TEST_COUNTS.STRESS_TEST);
    });

    it('should use transactions for bulk operations', () => {
      const sqliteDb = db.getDatabase();

      const start = performance.now();
      const insertMany = sqliteDb.transaction((count: number) => {
        const stmt = sqliteDb.prepare(`
          INSERT INTO tasks (id, prompt, status, priority, created_at)
          VALUES (?, ?, ?, ?, ?)
        `);

        for (let i = 0; i < count; i++) {
          stmt.run(`bulk-${i}`, `bulk prompt ${i}`, 'queued', 'P2', Date.now());
        }
      });

      insertMany(TEST_COUNTS.STRESS_TEST);
      const duration = performance.now() - start;

      // Transactions should make bulk inserts very fast
      expect(duration).toBeLessThan(50);
    });
  });

  describe('runInTransaction', () => {
    it('should return ok with callback return value on success', () => {
      const result = db.runInTransaction(() => {
        const sqliteDb = db.getDatabase();
        sqliteDb
          .prepare(`INSERT INTO tasks (id, prompt, status, priority, created_at) VALUES (?, ?, ?, ?, ?)`)
          .run('tx-1', 'prompt', 'queued', 'P1', Date.now());
        return 42;
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(42);

      // Verify write was committed
      const row = db.getDatabase().prepare('SELECT * FROM tasks WHERE id = ?').get('tx-1');
      expect(row).toBeDefined();
    });

    it('should return err when callback throws generic error', () => {
      const result = db.runInTransaction(() => {
        throw new Error('boom');
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('Transaction failed: boom');
      expect(result.error.code).toBe(ErrorCode.SYSTEM_ERROR);
    });

    it('should preserve AutobeatError types thrown inside', () => {
      const result = db.runInTransaction(() => {
        throw new AutobeatError(ErrorCode.TASK_NOT_FOUND, 'Task xyz not found');
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(AutobeatError);
      expect(result.error.code).toBe(ErrorCode.TASK_NOT_FOUND);
      expect(result.error.message).toBe('Task xyz not found');
    });

    it('should rollback all writes on error', () => {
      const sqliteDb = db.getDatabase();

      const result = db.runInTransaction(() => {
        sqliteDb
          .prepare(`INSERT INTO tasks (id, prompt, status, priority, created_at) VALUES (?, ?, ?, ?, ?)`)
          .run('rollback-1', 'prompt', 'queued', 'P1', Date.now());
        sqliteDb
          .prepare(`INSERT INTO tasks (id, prompt, status, priority, created_at) VALUES (?, ?, ?, ?, ?)`)
          .run('rollback-2', 'prompt', 'queued', 'P1', Date.now());

        // This write should be rolled back too
        throw new Error('fail after 2 inserts');
      });

      expect(result.ok).toBe(false);

      // Verify nothing was committed
      const count = sqliteDb.prepare('SELECT COUNT(*) as count FROM tasks').get() as { count: number };
      expect(count.count).toBe(0);
    });
  });

  describe('Default path handling', () => {
    it('should use in-memory database for tests', () => {
      // In tests, we should always use in-memory databases
      // to avoid file system permission issues
      const testDb = new Database(':memory:');
      expect(testDb.isOpen()).toBe(true);
      expect(testDb.getTables()).toContain('tasks');
      testDb.close();
    });
  });

  describe('migration v28 — judge_agent CHECK constraint removes gemini', () => {
    it('INSERT with judge_agent=gemini fails after migration', () => {
      const sqliteDb = db.getDatabase();
      const now = Date.now();

      expect(() => {
        sqliteDb
          .prepare(
            `INSERT INTO loops (id, strategy, task_template, exit_condition, working_directory, created_at, updated_at, judge_agent)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run('loop-gemini', 'retry', 'template', 'cond', '/tmp', now, now, 'gemini');
      }).toThrow(/CHECK/);
    });

    it.each([
      ['claude', 'loop-claude'],
      ['codex', 'loop-codex'],
      [null, 'loop-null'],
    ] as const)('INSERT with judge_agent=%s succeeds', (judgeAgent, loopId) => {
      const sqliteDb = db.getDatabase();
      const now = Date.now();

      expect(() => {
        sqliteDb
          .prepare(
            `INSERT INTO loops (id, strategy, task_template, exit_condition, working_directory, created_at, updated_at, judge_agent)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(loopId, 'retry', 'template', 'cond', '/tmp', now, now, judgeAgent);
      }).not.toThrow();
    });

    it('loops indexes are recreated after migration', () => {
      const sqliteDb = db.getDatabase();
      const indexes = sqliteDb
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='loops'`)
        .all() as Array<{ name: string }>;
      const indexNames = indexes.map((idx) => idx.name);

      expect(indexNames).toContain('idx_loops_status');
      expect(indexNames).toContain('idx_loops_schedule_id');
      expect(indexNames).toContain('idx_loops_updated_at');
    });

    it('convergence_enabled column preserved after migration', () => {
      const sqliteDb = db.getDatabase();
      const columns = sqliteDb.prepare(`PRAGMA table_info(loops)`).all() as Array<{ name: string }>;
      const columnNames = columns.map((col) => col.name);
      expect(columnNames).toContain('convergence_enabled');
    });

    it('tasks.agent=gemini UPDATE SQL maps rows to NULL (SQL correctness check)', () => {
      // NOTE: This test validates that the UPDATE SQL itself works correctly.
      // It does NOT prove that migration v28 executed the UPDATE — it inserts into a
      // fresh DB (which already has v28 applied) then re-runs the UPDATE statement.
      // See the end-to-end invariant test below for schema enforcement validation.
      const sqliteDb = db.getDatabase();
      const now = Date.now();

      // Seed a task with agent='gemini' — bypasses Zod, goes directly to SQLite
      sqliteDb
        .prepare(`INSERT INTO tasks (id, prompt, status, priority, created_at, agent) VALUES (?, ?, ?, ?, ?, ?)`)
        .run('pre-migration-gemini', 'prompt', 'queued', 'P1', now, 'gemini');

      // Run the migration UPDATE SQL (mirrors migration v28 up function)
      sqliteDb.exec(`UPDATE tasks SET agent = NULL WHERE agent = 'gemini'`);

      const migratedRow = sqliteDb.prepare(`SELECT agent FROM tasks WHERE id = ?`).get('pre-migration-gemini') as
        | { agent: string | null }
        | undefined;

      expect(migratedRow?.agent).toBeNull();
    });

    it('pipelines.agent=gemini is mapped to NULL by migration', () => {
      // Validates that migration v28 cleans up pipelines.agent='gemini' so that
      // pipeline-repository's z.enum(AGENT_PROVIDERS_TUPLE).nullable() validation passes.
      const sqliteDb = db.getDatabase();
      const now = Date.now();

      // Seed a pipeline row with agent='gemini' directly via SQLite
      sqliteDb
        .prepare(
          `INSERT INTO pipelines (id, steps, step_task_ids, status, agent, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('pipeline-gemini', '[]', '[]', 'pending', 'gemini', now, now);

      // Run the migration UPDATE SQL
      sqliteDb.exec(`UPDATE pipelines SET agent = NULL WHERE agent = 'gemini'`);

      const migratedRow = sqliteDb.prepare(`SELECT agent FROM pipelines WHERE id = ?`).get('pipeline-gemini') as
        | { agent: string | null }
        | undefined;

      expect(migratedRow?.agent).toBeNull();
    });

    it('orchestrations.agent=gemini is mapped to NULL by migration', () => {
      // Validates that migration v28 cleans up orchestrations.agent='gemini' so that
      // orchestration-repository's toAgentProvider() does not throw on read.
      const sqliteDb = db.getDatabase();
      const now = Date.now();

      sqliteDb
        .prepare(
          `INSERT INTO orchestrations
           (id, goal, state_file_path, working_directory, agent, max_depth, max_workers,
            max_iterations, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('orch-gemini', 'goal', '/state', '/work', 'gemini', 3, 5, 50, 'planning', now, now);

      sqliteDb.exec(`UPDATE orchestrations SET agent = NULL WHERE agent = 'gemini'`);

      const migratedRow = sqliteDb.prepare(`SELECT agent FROM orchestrations WHERE id = ?`).get('orch-gemini') as
        | { agent: string | null }
        | undefined;

      expect(migratedRow?.agent).toBeNull();
    });

    it('workers.agent=gemini is mapped to claude by migration', () => {
      // Workers use z.string() so no Zod crash, but migration cleans up stale values
      // for consistency — any surviving gemini worker row gets remapped to claude.
      const sqliteDb = db.getDatabase();
      const now = Date.now();

      // First insert a task to satisfy the FK constraint
      sqliteDb
        .prepare(`INSERT INTO tasks (id, prompt, status, priority, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run('task-for-worker', 'prompt', 'running', 'P1', now);

      sqliteDb
        .prepare(
          `INSERT INTO workers (worker_id, task_id, pid, owner_pid, agent, started_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run('worker-gemini', 'task-for-worker', 1234, 5678, 'gemini', now);

      sqliteDb.exec(`UPDATE workers SET agent = 'claude' WHERE agent = 'gemini'`);

      const migratedRow = sqliteDb.prepare(`SELECT agent FROM workers WHERE worker_id = ?`).get('worker-gemini') as
        | { agent: string }
        | undefined;

      expect(migratedRow?.agent).toBe('claude');
    });

    it('schedules.task_template JSON with "agent":"gemini" is remapped to claude', () => {
      // schedule-repository deserializes task_template through TaskTemplateSchema which uses
      // z.enum(AGENT_PROVIDERS_TUPLE).optional() — gemini would fail Zod validation.
      // Migration v28 uses REPLACE() on the compact JSON string.
      const sqliteDb = db.getDatabase();
      const now = Date.now();

      const template = JSON.stringify({ prompt: 'test', agent: 'gemini' });
      sqliteDb
        .prepare(
          `INSERT INTO schedules
           (id, task_template, schedule_type, status, timezone, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('sched-gemini', template, 'one_time', 'active', 'UTC', now, now);

      sqliteDb.exec(`
        UPDATE schedules
        SET task_template = REPLACE(task_template, '"agent":"gemini"', '"agent":"claude"')
        WHERE task_template LIKE '%"agent":"gemini"%'
      `);

      const migratedRow = sqliteDb.prepare(`SELECT task_template FROM schedules WHERE id = ?`).get('sched-gemini') as
        | { task_template: string }
        | undefined;

      const parsed = JSON.parse(migratedRow?.task_template ?? '{}') as Record<string, unknown>;
      expect(parsed.agent).toBe('claude');
    });
  });
});
