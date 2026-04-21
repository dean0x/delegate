/**
 * Unit tests for SQLiteTaskRepository
 *
 * ARCHITECTURE: Tests pagination, count, and unbounded query methods
 * Pattern: Mirrors dependency-repository.test.ts for consistency
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Task, TaskId, TaskStatus } from '../../../src/core/domain.js';
import { AutobeatError, ErrorCode } from '../../../src/core/errors.js';
import { Database } from '../../../src/implementations/database.js';
import { SQLiteTaskRepository } from '../../../src/implementations/task-repository.js';
import { createTestTask } from '../../fixtures/test-data.js';

describe('SQLiteTaskRepository', () => {
  let database: Database;
  let repo: SQLiteTaskRepository;

  beforeEach(() => {
    database = new Database(':memory:');
    repo = new SQLiteTaskRepository(database);
  });

  afterEach(() => {
    database.close();
  });

  describe('findAll() pagination', () => {
    it('should apply default limit of 100', async () => {
      // Create 105 tasks to test the boundary
      for (let i = 0; i < 105; i++) {
        const task = createTestTask({ id: `task-${i}` });
        await repo.save(task);
      }

      // Without explicit limit, should get 100 (default)
      const result = await repo.findAll();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(100);
    });

    it('should respect custom limit', async () => {
      // Create 10 tasks
      for (let i = 0; i < 10; i++) {
        const task = createTestTask({ id: `task-${i}` });
        await repo.save(task);
      }

      const result = await repo.findAll(5);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(5);
    });

    it('should respect offset', async () => {
      // Create 5 tasks with different timestamps
      const tasks: Task[] = [];
      for (let i = 0; i < 5; i++) {
        const task = createTestTask({
          id: `task-${i}`,
          createdAt: Date.now() + i * 100, // Ensure distinct timestamps
        });
        tasks.push(task);
        await repo.save(task);
      }

      // Skip first 2 (most recent), get next 2
      const result = await repo.findAll(2, 2);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(2);
      // Results are ordered by created_at DESC, so offset 2 skips the 2 newest
      expect(result.value[0].id).toBe('task-2');
      expect(result.value[1].id).toBe('task-1');
    });

    it('should return empty array when offset exceeds count', async () => {
      // Create 5 tasks
      for (let i = 0; i < 5; i++) {
        const task = createTestTask({ id: `task-${i}` });
        await repo.save(task);
      }

      const result = await repo.findAll(100, 1000);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(0);
    });

    it('should order by created_at DESC (newest first)', async () => {
      // Create tasks with specific timestamps
      const task1 = createTestTask({ id: 'old-task', createdAt: 1000 });
      const task2 = createTestTask({ id: 'new-task', createdAt: 2000 });

      await repo.save(task1);
      await repo.save(task2);

      const result = await repo.findAll();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value[0].id).toBe('new-task'); // Newest first
      expect(result.value[1].id).toBe('old-task');
    });
  });

  describe('findAllUnbounded()', () => {
    it('should return all tasks without limit', async () => {
      // Create 105 tasks (more than default limit of 100)
      for (let i = 0; i < 105; i++) {
        const task = createTestTask({ id: `task-${i}` });
        await repo.save(task);
      }

      const result = await repo.findAllUnbounded();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(105);
    });

    it('should return empty array when no tasks exist', async () => {
      const result = await repo.findAllUnbounded();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(0);
    });
  });

  describe('count()', () => {
    it('should return total task count', async () => {
      // Create 7 tasks
      for (let i = 0; i < 7; i++) {
        const task = createTestTask({ id: `task-${i}` });
        await repo.save(task);
      }

      const result = await repo.count();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(7);
    });

    it('should return 0 when no tasks exist', async () => {
      const result = await repo.count();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(0);
    });

    it('should reflect deletions', async () => {
      // Create 5 tasks
      for (let i = 0; i < 5; i++) {
        const task = createTestTask({ id: `task-${i}` });
        await repo.save(task);
      }

      // Delete 2 tasks
      await repo.delete(TaskId('task-0'));
      await repo.delete(TaskId('task-1'));

      const result = await repo.count();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(3);
    });
  });

  describe('continueFrom field', () => {
    it('should save and retrieve task with continueFrom', async () => {
      const task = createTestTask({
        id: 'task-with-continue',
        continueFrom: 'task-parent-123',
      });
      await repo.save(task);

      const result = await repo.findById(TaskId('task-with-continue'));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).not.toBeNull();
      expect(result.value!.continueFrom).toBe('task-parent-123');
    });

    it('should save and retrieve task without continueFrom as undefined', async () => {
      const task = createTestTask({
        id: 'task-no-continue',
      });
      await repo.save(task);

      const result = await repo.findById(TaskId('task-no-continue'));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).not.toBeNull();
      expect(result.value!.continueFrom).toBeUndefined();
    });

    it('should update continueFrom via update()', async () => {
      const task = createTestTask({
        id: 'task-update-continue',
      });
      await repo.save(task);

      // Update with continueFrom
      const updateResult = await repo.update(TaskId('task-update-continue'), {
        continueFrom: TaskId('task-dep-456'),
      });
      expect(updateResult.ok).toBe(true);

      const result = await repo.findById(TaskId('task-update-continue'));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value!.continueFrom).toBe('task-dep-456');
    });

    it('should apply migration v6 correctly (column exists)', async () => {
      const task = createTestTask({
        id: 'task-migration-test',
        continueFrom: 'task-parent-migration',
      });
      const saveResult = await repo.save(task);
      expect(saveResult.ok).toBe(true);

      const findResult = await repo.findById(TaskId('task-migration-test'));
      expect(findResult.ok).toBe(true);
      if (findResult.ok && findResult.value) {
        expect(findResult.value.continueFrom).toBe('task-parent-migration');
      }
    });
  });

  describe('Sync methods (for transactions)', () => {
    it('saveSync should persist a task', () => {
      const task = createTestTask({ id: 'sync-save-1' });
      repo.saveSync(task);

      const found = repo.findByIdSync(TaskId('sync-save-1'));
      expect(found).not.toBeNull();
      expect(found!.prompt).toBe(task.prompt);
    });

    it('findByIdSync should return null for non-existent task', () => {
      const found = repo.findByIdSync(TaskId('no-such-task'));
      expect(found).toBeNull();
    });

    it('updateSync should merge fields', () => {
      const task = createTestTask({ id: 'sync-update-1' });
      repo.saveSync(task);

      repo.updateSync(TaskId('sync-update-1'), { status: TaskStatus.RUNNING });

      const found = repo.findByIdSync(TaskId('sync-update-1'));
      expect(found).not.toBeNull();
      expect(found!.status).toBe(TaskStatus.RUNNING);
      expect(found!.prompt).toBe(task.prompt); // Other fields preserved
    });

    it('updateSync should throw AutobeatError for non-existent task', () => {
      expect(() => {
        repo.updateSync(TaskId('no-such-task'), { status: TaskStatus.CANCELLED });
      }).toThrow(AutobeatError);

      try {
        repo.updateSync(TaskId('no-such-task'), { status: TaskStatus.CANCELLED });
      } catch (e) {
        expect((e as AutobeatError).code).toBe(ErrorCode.TASK_NOT_FOUND);
      }
    });

    it('should work correctly inside Database.runInTransaction', () => {
      const task1 = createTestTask({ id: 'tx-task-1' });
      const task2 = createTestTask({ id: 'tx-task-2' });

      const result = database.runInTransaction(() => {
        repo.saveSync(task1);
        repo.saveSync(task2);
        repo.updateSync(TaskId('tx-task-1'), { status: TaskStatus.RUNNING });
      });

      expect(result.ok).toBe(true);

      // Both tasks committed
      const found1 = repo.findByIdSync(TaskId('tx-task-1'));
      const found2 = repo.findByIdSync(TaskId('tx-task-2'));
      expect(found1).not.toBeNull();
      expect(found1!.status).toBe(TaskStatus.RUNNING);
      expect(found2).not.toBeNull();
    });

    it('should rollback all saves when transaction fails', () => {
      const task1 = createTestTask({ id: 'tx-rollback-1' });

      const result = database.runInTransaction(() => {
        repo.saveSync(task1);
        throw new Error('simulated failure');
      });

      expect(result.ok).toBe(false);

      // Task should not exist
      const found = repo.findByIdSync(TaskId('tx-rollback-1'));
      expect(found).toBeNull();
    });
  });

  describe('model field persistence', () => {
    it('should save and retrieve task with model', async () => {
      const task = createTestTask({
        id: 'task-with-model',
        model: 'claude-opus-4-5',
      });
      await repo.save(task);

      const result = await repo.findById(TaskId('task-with-model'));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).not.toBeNull();
      expect(result.value!.model).toBe('claude-opus-4-5');
    });

    it('should save and retrieve task without model as undefined', async () => {
      const task = createTestTask({
        id: 'task-no-model',
      });
      await repo.save(task);

      const result = await repo.findById(TaskId('task-no-model'));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).not.toBeNull();
      expect(result.value!.model).toBeUndefined();
    });

    it('should update model via update()', async () => {
      const task = createTestTask({ id: 'task-update-model' });
      await repo.save(task);

      const updateResult = await repo.update(TaskId('task-update-model'), {
        model: 'gpt-4o',
      });
      expect(updateResult.ok).toBe(true);

      const result = await repo.findById(TaskId('task-update-model'));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value!.model).toBe('gpt-4o');
    });

    it('should return model in findAll results', async () => {
      const task = createTestTask({ id: 'findall-model-task', model: 'gemini-2.0-flash' });
      await repo.save(task);

      const result = await repo.findAll();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const found = result.value.find((t) => t.id === 'findall-model-task');
      expect(found).toBeDefined();
      expect(found!.model).toBe('gemini-2.0-flash');
    });

    it('should preserve model on tasks without model (backward compat)', async () => {
      // Tasks created before migration v16 would have model=NULL
      // Test that they deserialize to undefined (not null)
      const task = createTestTask({ id: 'legacy-task' });
      await repo.save(task);

      const result = await repo.findById(TaskId('legacy-task'));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value!.model).toBeUndefined();
    });
  });

  describe('systemPrompt field persistence', () => {
    it('should save and retrieve task with systemPrompt', async () => {
      const task = createTestTask({
        id: 'task-with-systemprompt',
        systemPrompt: 'Always respond in JSON',
      });
      await repo.save(task);

      const result = await repo.findById(TaskId('task-with-systemprompt'));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).not.toBeNull();
      expect(result.value!.systemPrompt).toBe('Always respond in JSON');
    });

    it('should save and retrieve task without systemPrompt as undefined', async () => {
      const task = createTestTask({
        id: 'task-no-systemprompt',
      });
      await repo.save(task);

      const result = await repo.findById(TaskId('task-no-systemprompt'));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).not.toBeNull();
      expect(result.value!.systemPrompt).toBeUndefined();
    });

    it('should update systemPrompt via update()', async () => {
      const task = createTestTask({ id: 'task-update-systemprompt' });
      await repo.save(task);

      const updateResult = await repo.update(TaskId('task-update-systemprompt'), {
        systemPrompt: 'Be concise',
      });
      expect(updateResult.ok).toBe(true);

      const result = await repo.findById(TaskId('task-update-systemprompt'));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value!.systemPrompt).toBe('Be concise');
    });

    it('should return systemPrompt in findAll results', async () => {
      const task = createTestTask({ id: 'findall-systemprompt-task', systemPrompt: 'Use markdown' });
      await repo.save(task);

      const result = await repo.findAll();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const found = result.value.find((t) => t.id === 'findall-systemprompt-task');
      expect(found).toBeDefined();
      expect(found!.systemPrompt).toBe('Use markdown');
    });
  });

  describe('countByStatus()', () => {
    it('returns an empty record when no tasks exist', async () => {
      const result = await repo.countByStatus();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual({});
    });

    it('returns correct count for a single status', async () => {
      await repo.save(createTestTask({ id: 'task-q-1', status: TaskStatus.QUEUED }));
      await repo.save(createTestTask({ id: 'task-q-2', status: TaskStatus.QUEUED }));

      const result = await repo.countByStatus();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value['queued']).toBe(2);
    });

    it('counts tasks across multiple statuses', async () => {
      await repo.save(createTestTask({ id: 'r-1', status: TaskStatus.RUNNING }));
      await repo.save(createTestTask({ id: 'r-2', status: TaskStatus.RUNNING }));
      await repo.save(createTestTask({ id: 'q-1', status: TaskStatus.QUEUED }));
      await repo.save(createTestTask({ id: 'f-1', status: TaskStatus.FAILED }));

      const result = await repo.countByStatus();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value['running']).toBe(2);
      expect(result.value['queued']).toBe(1);
      expect(result.value['failed']).toBe(1);
    });

    it('reflects status changes via update()', async () => {
      const task = createTestTask({ id: 'status-change', status: TaskStatus.QUEUED });
      await repo.save(task);

      await repo.update(TaskId('status-change'), { status: TaskStatus.RUNNING });

      const result = await repo.countByStatus();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value['running']).toBe(1);
      expect(result.value['queued']).toBeUndefined();
    });
  });
});
