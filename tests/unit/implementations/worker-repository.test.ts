/**
 * Unit tests for SQLiteWorkerRepository
 * ARCHITECTURE: Tests repository operations in isolation with in-memory database
 * Pattern: Behavior-driven testing with Result pattern validation
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkerRegistration } from '../../../src/core/domain';
import { TaskId, WorkerId } from '../../../src/core/domain';
import { Database } from '../../../src/implementations/database';
import { SQLiteWorkerRepository } from '../../../src/implementations/worker-repository';

describe('SQLiteWorkerRepository - Unit Tests', () => {
  let db: Database;
  let repo: SQLiteWorkerRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    repo = new SQLiteWorkerRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  /**
   * Insert a stub task row to satisfy FK constraint on workers.task_id
   * ARCHITECTURE: Minimal row insertion - only required fields for FK satisfaction
   */
  function ensureTaskExists(taskId: string): void {
    db.getDatabase()
      .prepare(
        `INSERT OR IGNORE INTO tasks (id, prompt, status, priority, created_at, agent) VALUES (?, 'test', 'running', 'P2', ?, 'claude')`,
      )
      .run(taskId, Date.now());
  }

  function createRegistration(overrides: Partial<WorkerRegistration> = {}): WorkerRegistration {
    const defaults: WorkerRegistration = {
      workerId: WorkerId('worker-1'),
      taskId: TaskId('task-1'),
      pid: 12345,
      ownerPid: 99999,
      agent: 'claude',
      startedAt: Date.now(),
    };
    const reg = { ...defaults, ...overrides };
    ensureTaskExists(reg.taskId);
    return reg;
  }

  // ============================================================================
  // register() + findByTaskId()
  // ============================================================================

  describe('register and findByTaskId', () => {
    it('should register a worker and find it by task ID', () => {
      // Arrange
      const reg = createRegistration();

      // Act
      const registerResult = repo.register(reg);
      const findResult = repo.findByTaskId(reg.taskId);

      // Assert
      expect(registerResult.ok).toBe(true);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      expect(findResult.value).not.toBeNull();
      expect(findResult.value!.workerId).toBe(reg.workerId);
      expect(findResult.value!.taskId).toBe(reg.taskId);
      expect(findResult.value!.pid).toBe(reg.pid);
      expect(findResult.value!.ownerPid).toBe(reg.ownerPid);
      expect(findResult.value!.agent).toBe(reg.agent);
      expect(findResult.value!.startedAt).toBe(reg.startedAt);
    });
  });

  // ============================================================================
  // register() + getGlobalCount()
  // ============================================================================

  describe('register multiple and getGlobalCount', () => {
    it('should register multiple workers and return correct global count', () => {
      // Arrange
      const reg1 = createRegistration({ workerId: WorkerId('w-1'), taskId: TaskId('t-1') });
      const reg2 = createRegistration({ workerId: WorkerId('w-2'), taskId: TaskId('t-2') });
      const reg3 = createRegistration({ workerId: WorkerId('w-3'), taskId: TaskId('t-3') });

      // Act
      repo.register(reg1);
      repo.register(reg2);
      repo.register(reg3);
      const countResult = repo.getGlobalCount();

      // Assert
      expect(countResult.ok).toBe(true);
      if (!countResult.ok) return;
      expect(countResult.value).toBe(3);
    });
  });

  // ============================================================================
  // unregister()
  // ============================================================================

  describe('unregister', () => {
    it('should unregister a worker so it is no longer found', () => {
      // Arrange
      const reg = createRegistration();
      repo.register(reg);

      // Act
      const unregisterResult = repo.unregister(reg.workerId);
      const findResult = repo.findByTaskId(reg.taskId);

      // Assert
      expect(unregisterResult.ok).toBe(true);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;
      expect(findResult.value).toBeNull();
    });

    it('should succeed when unregistering a non-existent worker (idempotent)', () => {
      // Act
      const result = repo.unregister(WorkerId('non-existent-worker'));

      // Assert
      expect(result.ok).toBe(true);
    });
  });

  // ============================================================================
  // findBySessionName()
  // ============================================================================

  describe('findBySessionName', () => {
    it('should return matching registration when session name exists', () => {
      // Arrange
      const reg = createRegistration({
        workerId: WorkerId('w-sess'),
        taskId: TaskId('t-sess'),
        sessionName: 'beat-task-abc',
      });
      repo.register(reg);

      // Act
      const result = repo.findBySessionName('beat-task-abc');

      // Assert
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).not.toBeNull();
      expect(result.value!.workerId).toBe(WorkerId('w-sess'));
      expect(result.value!.sessionName).toBe('beat-task-abc');
    });

    it('should return null for non-existent session name', () => {
      // Act
      const result = repo.findBySessionName('beat-nonexistent');

      // Assert
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeNull();
    });

    it('should return null for workers with NULL session_name (legacy rows)', () => {
      // Insert a row without session_name (simulating pre-Phase 3 row)
      const taskId = 't-legacy-sess';
      ensureTaskExists(taskId);
      db.getDatabase()
        .prepare(
          `INSERT INTO workers (worker_id, task_id, pid, owner_pid, agent, started_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run('w-legacy-sess', taskId, 111, 222, 'claude', Date.now());

      // Act — searching by NULL session_name should not match
      const result = repo.findBySessionName('beat-anything');

      // Assert
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeNull();
    });

    it('should find the correct worker when multiple workers exist', () => {
      // Arrange
      const reg1 = createRegistration({
        workerId: WorkerId('w-multi-1'),
        taskId: TaskId('t-multi-1'),
        sessionName: 'beat-task-111',
      });
      const reg2 = createRegistration({
        workerId: WorkerId('w-multi-2'),
        taskId: TaskId('t-multi-2'),
        sessionName: 'beat-task-222',
      });
      repo.register(reg1);
      repo.register(reg2);

      // Act
      const result = repo.findBySessionName('beat-task-222');

      // Assert
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).not.toBeNull();
      expect(result.value!.workerId).toBe(WorkerId('w-multi-2'));
    });
  });

  // ============================================================================
  // findAll()
  // ============================================================================

  describe('findAll', () => {
    it('should return all registered workers', () => {
      // Arrange
      const reg1 = createRegistration({ workerId: WorkerId('w-1'), taskId: TaskId('t-1') });
      const reg2 = createRegistration({ workerId: WorkerId('w-2'), taskId: TaskId('t-2') });
      repo.register(reg1);
      repo.register(reg2);

      // Act
      const result = repo.findAll();

      // Assert
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(2);
    });

    it('should return empty array when no workers are registered', () => {
      // Act
      const result = repo.findAll();

      // Assert
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(0);
    });
  });

  // ============================================================================
  // UNIQUE constraint on task_id
  // ============================================================================

  describe('UNIQUE constraint on task_id', () => {
    it('should return error when registering duplicate task_id', () => {
      // Arrange
      const taskId = TaskId('shared-task');
      const reg1 = createRegistration({ workerId: WorkerId('w-1'), taskId });
      const reg2 = createRegistration({ workerId: WorkerId('w-2'), taskId });
      repo.register(reg1);

      // Act
      const result = repo.register(reg2);

      // Assert
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('Another process already has a worker for this task');
    });
  });

  // ============================================================================
  // getGlobalCount() edge case
  // ============================================================================

  describe('getGlobalCount edge case', () => {
    it('should return 0 for empty table', () => {
      // Act
      const result = repo.getGlobalCount();

      // Assert
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(0);
    });
  });

  // ============================================================================
  // sessionName field (migration v29)
  // ============================================================================

  describe('sessionName (Phase 3 tmux field)', () => {
    it('should persist and retrieve sessionName when provided', () => {
      // Arrange
      const reg = createRegistration({
        workerId: WorkerId('w-session'),
        taskId: TaskId('t-session'),
        sessionName: 'beat-t-session',
      });

      // Act
      const registerResult = repo.register(reg);
      const found = repo.findByTaskId(TaskId('t-session'));

      // Assert
      expect(registerResult.ok).toBe(true);
      expect(found.ok).toBe(true);
      if (!found.ok || found.value === null) return;
      expect(found.value.sessionName).toBe('beat-t-session');
    });

    it('should return undefined sessionName for rows without sessionName (pre-Phase 3 rows)', () => {
      // Arrange — register without sessionName
      const reg = createRegistration({ workerId: WorkerId('w-nosess'), taskId: TaskId('t-nosess') });

      // Act
      repo.register(reg);
      const found = repo.findByTaskId(TaskId('t-nosess'));

      // Assert
      expect(found.ok).toBe(true);
      if (!found.ok || found.value === null) return;
      expect(found.value.sessionName).toBeUndefined();
    });

    it('should handle NULL session_name from existing rows gracefully', () => {
      // Direct DB insertion (simulating a pre-Phase 3 row without session_name)
      const taskId = 't-legacy';
      ensureTaskExists(taskId);
      db.getDatabase()
        .prepare(
          `INSERT INTO workers (worker_id, task_id, pid, owner_pid, agent, started_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run('w-legacy', taskId, 111, 222, 'claude', Date.now());

      // Act
      const found = repo.findByTaskId(TaskId(taskId));

      // Assert
      expect(found.ok).toBe(true);
      if (!found.ok || found.value === null) return;
      expect(found.value.sessionName).toBeUndefined();
    });
  });

  // ============================================================================
  // updateHeartbeat()
  // ============================================================================

  describe('updateHeartbeat', () => {
    it('should write a timestamp and round-trip through rowToRegistration', () => {
      // Arrange
      const reg = createRegistration({ workerId: WorkerId('w-hb'), taskId: TaskId('t-hb') });
      repo.register(reg);

      const before = Date.now();

      // Act
      const result = repo.updateHeartbeat(WorkerId('w-hb'));

      const after = Date.now();

      // Assert result ok
      expect(result.ok).toBe(true);

      // Round-trip: findByTaskId should return lastHeartbeat in [before, after]
      const found = repo.findByTaskId(TaskId('t-hb'));
      expect(found.ok).toBe(true);
      if (!found.ok || found.value === null) return;

      expect(found.value.lastHeartbeat).toBeDefined();
      expect(found.value.lastHeartbeat!).toBeGreaterThanOrEqual(before);
      expect(found.value.lastHeartbeat!).toBeLessThanOrEqual(after);
    });

    it('should return ok(undefined) and be a no-op for an unknown workerId', () => {
      // Act — updating a non-existent worker should not error (UPDATE affects 0 rows)
      const result = repo.updateHeartbeat(WorkerId('non-existent'));

      // Assert
      expect(result.ok).toBe(true);
    });

    it('should return undefined lastHeartbeat on newly registered worker (no heartbeat yet)', () => {
      // Arrange
      const reg = createRegistration({ workerId: WorkerId('w-no-hb'), taskId: TaskId('t-no-hb') });
      repo.register(reg);

      // Act — retrieve without ever calling updateHeartbeat
      const found = repo.findByTaskId(TaskId('t-no-hb'));

      // Assert
      expect(found.ok).toBe(true);
      if (!found.ok || found.value === null) return;
      expect(found.value.lastHeartbeat).toBeUndefined();
    });
  });
});
