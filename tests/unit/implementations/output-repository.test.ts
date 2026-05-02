/**
 * Unit tests for SQLiteOutputRepository
 *
 * ARCHITECTURE: Tests output persistence with real Database + SQLite
 * Pattern: Mirrors task-repository.test.ts — real DB, no mocks
 * Note: task_output has FK to tasks — must insert task rows first
 */

import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Configuration, ConfigurationSchema } from '../../../src/core/configuration.js';
import { TaskId } from '../../../src/core/domain.js';
import { Database } from '../../../src/implementations/database.js';
import { SQLiteOutputRepository } from '../../../src/implementations/output-repository.js';
import { SQLiteTaskRepository } from '../../../src/implementations/task-repository.js';
import { createTestTask } from '../../fixtures/test-data.js';

describe('SQLiteOutputRepository', () => {
  let database: Database;
  let repo: SQLiteOutputRepository;
  let taskRepo: SQLiteTaskRepository;
  const taskId = TaskId('test-task-1');

  beforeEach(async () => {
    database = new Database(':memory:');
    const config: Configuration = ConfigurationSchema.parse({
      fileStorageThresholdBytes: 1024, // 1KB threshold for tests
    });
    repo = new SQLiteOutputRepository(config, database);
    taskRepo = new SQLiteTaskRepository(database);

    // Insert a task row to satisfy FK constraint
    await taskRepo.save(createTestTask({ id: taskId }));
  });

  afterEach(() => {
    database.close();
    // Clean up ./output/ directory created by file-backed storage with :memory: DB
    fs.rmSync('output', { recursive: true, force: true });
  });

  describe('save and get', () => {
    it('should save small output to DB and retrieve it', async () => {
      const output = {
        taskId,
        stdout: ['hello world'],
        stderr: [],
        totalSize: 11,
      };

      const saveResult = await repo.save(taskId, output);
      expect(saveResult.ok).toBe(true);

      const getResult = await repo.get(taskId);
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.value).not.toBeNull();
      expect(getResult.value!.stdout).toEqual(['hello world']);
      expect(getResult.value!.stderr).toEqual([]);
    });

    it('should save large output to file (above fileStorageThreshold)', async () => {
      const largeData = 'x'.repeat(2048); // 2KB > 1KB threshold
      const output = {
        taskId,
        stdout: [largeData],
        stderr: [],
        totalSize: 2048,
      };

      const saveResult = await repo.save(taskId, output);
      expect(saveResult.ok).toBe(true);

      const getResult = await repo.get(taskId);
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.value).not.toBeNull();
      expect(getResult.value!.stdout).toEqual([largeData]);
    });

    it('should return null for missing task', async () => {
      const result = await repo.get(TaskId('nonexistent'));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeNull();
    });
  });

  describe('append', () => {
    it('should append to existing output', async () => {
      const output = {
        taskId,
        stdout: ['line1'],
        stderr: [],
        totalSize: 5,
      };
      await repo.save(taskId, output);

      const appendResult = await repo.append(taskId, 'stdout', 'line2');
      expect(appendResult.ok).toBe(true);

      const getResult = await repo.get(taskId);
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.value!.stdout).toEqual(['line1', 'line2']);
    });

    it('should create new output if none exists', async () => {
      const newTaskId = TaskId('new-task');
      // Insert task row for FK
      await taskRepo.save(createTestTask({ id: newTaskId }));

      const appendResult = await repo.append(newTaskId, 'stderr', 'error msg');
      expect(appendResult.ok).toBe(true);

      const getResult = await repo.get(newTaskId);
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.value!.stderr).toEqual(['error msg']);
      expect(getResult.value!.stdout).toEqual([]);
    });
  });

  describe('getSize', () => {
    it('returns correct size for DB-stored output', async () => {
      const output = {
        taskId,
        stdout: ['hello world'],
        stderr: [],
        totalSize: 11,
      };
      await repo.save(taskId, output);

      const result = await repo.getSize(taskId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(11);
    });

    it('returns 0 for non-existent task', async () => {
      const result = await repo.getSize(TaskId('nonexistent'));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(0);
    });

    it('returns correct size for file-backed output (above threshold)', async () => {
      const largeData = 'x'.repeat(2048);
      const output = {
        taskId,
        stdout: [largeData],
        stderr: [],
        totalSize: 2048,
      };
      await repo.save(taskId, output);

      const result = await repo.getSize(taskId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(2048);
    });

    it('returns updated size after append', async () => {
      const output = {
        taskId,
        stdout: ['line1'],
        stderr: [],
        totalSize: 5,
      };
      await repo.save(taskId, output);
      await repo.append(taskId, 'stdout', 'line2');

      const result = await repo.getSize(taskId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // 'line1' = 5 bytes, 'line2' = 5 bytes → totalSize = 10
      expect(result.value).toBe(10);
    });
  });

  describe('delete', () => {
    it('should delete DB entry', async () => {
      const output = {
        taskId,
        stdout: ['data'],
        stderr: [],
        totalSize: 4,
      };
      await repo.save(taskId, output);

      const deleteResult = await repo.delete(taskId);
      expect(deleteResult.ok).toBe(true);

      const getResult = await repo.get(taskId);
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.value).toBeNull();
    });

    it('should delete file-backed output and clean up file', async () => {
      const largeData = 'x'.repeat(2048);
      const output = {
        taskId,
        stdout: [largeData],
        stderr: [],
        totalSize: 2048,
      };
      await repo.save(taskId, output);

      const deleteResult = await repo.delete(taskId);
      expect(deleteResult.ok).toBe(true);

      const getResult = await repo.get(taskId);
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.value).toBeNull();
    });

    it('should succeed when deleting non-existent task', async () => {
      const result = await repo.delete(TaskId('nonexistent'));
      expect(result.ok).toBe(true);
    });
  });
});
