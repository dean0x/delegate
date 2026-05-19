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
  // findByOwnerPid()
  // ============================================================================

  describe('findByOwnerPid', () => {
    it('should return workers belonging to the specified owner PID', () => {
      // Arrange
      const ownerA = 1000;
      const ownerB = 2000;
      const reg1 = createRegistration({ workerId: WorkerId('w-1'), taskId: TaskId('t-1'), ownerPid: ownerA });
      const reg2 = createRegistration({ workerId: WorkerId('w-2'), taskId: TaskId('t-2'), ownerPid: ownerA });
      const reg3 = createRegistration({ workerId: WorkerId('w-3'), taskId: TaskId('t-3'), ownerPid: ownerB });
      repo.register(reg1);
      repo.register(reg2);
      repo.register(reg3);

      // Act
      const resultA = repo.findByOwnerPid(ownerA);
      const resultB = repo.findByOwnerPid(ownerB);

      // Assert
      expect(resultA.ok).toBe(true);
      expect(resultB.ok).toBe(true);
      if (!resultA.ok || !resultB.ok) return;

      expect(resultA.value).toHaveLength(2);
      expect(resultA.value.every((r) => r.ownerPid === ownerA)).toBe(true);
      expect(resultB.value).toHaveLength(1);
      expect(resultB.value[0].workerId).toBe(WorkerId('w-3'));
    });

    it('should return empty array when no workers match the owner PID', () => {
      // Act
      const result = repo.findByOwnerPid(99999);

      // Assert
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(0);
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
  // deleteByOwnerPid()
  // ============================================================================

  describe('deleteByOwnerPid', () => {
    it('should delete matching workers and return count', () => {
      // Arrange
      const ownerToDelete = 1000;
      const ownerToKeep = 2000;
      const reg1 = createRegistration({ workerId: WorkerId('w-1'), taskId: TaskId('t-1'), ownerPid: ownerToDelete });
      const reg2 = createRegistration({ workerId: WorkerId('w-2'), taskId: TaskId('t-2'), ownerPid: ownerToDelete });
      const reg3 = createRegistration({ workerId: WorkerId('w-3'), taskId: TaskId('t-3'), ownerPid: ownerToKeep });
      repo.register(reg1);
      repo.register(reg2);
      repo.register(reg3);

      // Act
      const deleteResult = repo.deleteByOwnerPid(ownerToDelete);

      // Assert
      expect(deleteResult.ok).toBe(true);
      if (!deleteResult.ok) return;
      expect(deleteResult.value).toBe(2);

      // Verify remaining workers
      const remaining = repo.findAll();
      expect(remaining.ok).toBe(true);
      if (!remaining.ok) return;
      expect(remaining.value).toHaveLength(1);
      expect(remaining.value[0].ownerPid).toBe(ownerToKeep);
    });

    it('should return 0 when no workers match the owner PID', () => {
      // Act
      const result = repo.deleteByOwnerPid(99999);

      // Assert
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(0);
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
