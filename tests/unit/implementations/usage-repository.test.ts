/**
 * Unit tests for SQLiteUsageRepository
 * ARCHITECTURE: Real in-memory SQLite, no mocks.
 * Pattern: Behavior-driven tests with Result validation.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createOrchestration,
  createTask,
  LoopId,
  OrchestratorId,
  TaskId,
  type TaskUsage,
} from '../../../src/core/domain.js';
import { Database } from '../../../src/implementations/database.js';
import { SQLiteOrchestrationRepository } from '../../../src/implementations/orchestration-repository.js';
import { SQLiteTaskRepository } from '../../../src/implementations/task-repository.js';
import { SQLiteUsageRepository } from '../../../src/implementations/usage-repository.js';

function makeUsage(taskId: string, overrides: Partial<TaskUsage> = {}): TaskUsage {
  return {
    taskId: TaskId(taskId),
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationInputTokens: 10,
    cacheReadInputTokens: 5,
    totalCostUsd: 0.001234,
    model: 'claude-3-5-sonnet',
    capturedAt: Date.now(),
    ...overrides,
  };
}

describe('SQLiteUsageRepository', () => {
  let db: Database;
  let repo: SQLiteUsageRepository;
  let taskRepo: SQLiteTaskRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    repo = new SQLiteUsageRepository(db);
    taskRepo = new SQLiteTaskRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  // ============================================================================
  // Schema migration verification (v18 + v19)
  // ============================================================================

  describe('migrations', () => {
    it('tasks table should have orchestrator_id column (v18)', () => {
      const columns = db.getDatabase().prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
      const names = columns.map((c) => c.name);
      expect(names).toContain('orchestrator_id');
    });

    it('task_usage table should exist with all expected columns (v19)', () => {
      const tables = db.getTables();
      expect(tables).toContain('task_usage');

      const columns = db.getDatabase().prepare('PRAGMA table_info(task_usage)').all() as Array<{ name: string }>;
      const names = columns.map((c) => c.name);
      expect(names).toContain('task_id');
      expect(names).toContain('input_tokens');
      expect(names).toContain('output_tokens');
      expect(names).toContain('cache_creation_input_tokens');
      expect(names).toContain('cache_read_input_tokens');
      expect(names).toContain('total_cost_usd');
      expect(names).toContain('model');
      expect(names).toContain('captured_at');
    });
  });

  // ============================================================================
  // save() and get()
  // ============================================================================

  describe('save() and get()', () => {
    it('saves and retrieves usage by taskId', async () => {
      const task = createTask({ prompt: 'test' });
      await taskRepo.save(task);

      const usage = makeUsage(task.id);
      const saveResult = await repo.save(usage);
      expect(saveResult.ok).toBe(true);

      const getResult = await repo.get(task.id);
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.value).not.toBeNull();

      const fetched = getResult.value!;
      expect(fetched.taskId).toBe(task.id);
      expect(fetched.inputTokens).toBe(100);
      expect(fetched.outputTokens).toBe(50);
      expect(fetched.cacheCreationInputTokens).toBe(10);
      expect(fetched.cacheReadInputTokens).toBe(5);
      expect(fetched.totalCostUsd).toBeCloseTo(0.001234);
      expect(fetched.model).toBe('claude-3-5-sonnet');
    });

    it('returns null for unknown taskId', async () => {
      const result = await repo.get(TaskId('task-nonexistent'));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeNull();
    });

    it('is idempotent — upserts on duplicate taskId', async () => {
      const task = createTask({ prompt: 'test' });
      await taskRepo.save(task);

      await repo.save(makeUsage(task.id, { inputTokens: 100, totalCostUsd: 0.001 }));
      // Overwrite with updated values
      await repo.save(makeUsage(task.id, { inputTokens: 999, totalCostUsd: 9.99 }));

      const result = await repo.get(task.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value!.inputTokens).toBe(999);
      expect(result.value!.totalCostUsd).toBeCloseTo(9.99);
    });

    it('accepts null model (stored as NULL, returned as undefined)', async () => {
      const task = createTask({ prompt: 'test' });
      await taskRepo.save(task);

      const usage = makeUsage(task.id, { model: undefined });
      await repo.save(usage);

      const result = await repo.get(task.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value!.model).toBeUndefined();
    });
  });

  // ============================================================================
  // sumGlobal()
  // ============================================================================

  describe('sumGlobal()', () => {
    it('returns zero aggregate when no usage rows', async () => {
      const result = await repo.sumGlobal();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.inputTokens).toBe(0);
      expect(result.value.totalCostUsd).toBe(0);
    });

    it('sums across all tasks', async () => {
      for (let i = 0; i < 3; i++) {
        const task = createTask({ prompt: `task ${i}` });
        await taskRepo.save(task);
        await repo.save(makeUsage(task.id, { inputTokens: 10, totalCostUsd: 0.01 }));
      }

      const result = await repo.sumGlobal();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.inputTokens).toBe(30);
      expect(result.value.totalCostUsd).toBeCloseTo(0.03);
    });

    it('filters by sinceMs when provided', async () => {
      const now = Date.now();
      const past = now - 10000;

      const oldTask = createTask({ prompt: 'old' });
      await taskRepo.save(oldTask);
      await repo.save(makeUsage(oldTask.id, { inputTokens: 100, capturedAt: past }));

      const newTask = createTask({ prompt: 'new' });
      await taskRepo.save(newTask);
      await repo.save(makeUsage(newTask.id, { inputTokens: 50, capturedAt: now }));

      const result = await repo.sumGlobal(now - 1000);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Only the new task's usage should be included
      expect(result.value.inputTokens).toBe(50);
    });
  });

  // ============================================================================
  // sumByOrchestrationId()
  // ============================================================================

  describe('sumByOrchestrationId()', () => {
    it('returns zero aggregate when orchestration has no tasks', async () => {
      const orchId = OrchestratorId('orchestrator-no-tasks');
      const orchRepo = new SQLiteOrchestrationRepository(db);
      const orch = createOrchestration({ goal: 'test' }, '/tmp/state.json', '/workspace');
      // Update with our specific ID for testing
      await orchRepo.save({ ...orch, id: orchId });

      const result = await repo.sumByOrchestrationId(orchId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.inputTokens).toBe(0);
      expect(result.value.totalCostUsd).toBe(0);
    });

    it('sums usage for tasks directly attributed to orchestration', async () => {
      const orchId = OrchestratorId('orchestrator-test-1');
      const orchRepo = new SQLiteOrchestrationRepository(db);
      const orch = createOrchestration({ goal: 'test' }, '/tmp/state.json', '/workspace');
      await orchRepo.save({ ...orch, id: orchId });

      // Create 2 tasks attributed to this orchestration
      for (let i = 0; i < 2; i++) {
        const task = createTask({ prompt: `task ${i}`, orchestratorId: orchId });
        await taskRepo.save(task);
        await repo.save(makeUsage(task.id, { inputTokens: 100, totalCostUsd: 0.5 }));
      }

      // Create a task NOT attributed to this orchestration
      const unrelated = createTask({ prompt: 'unrelated' });
      await taskRepo.save(unrelated);
      await repo.save(makeUsage(unrelated.id, { inputTokens: 9999 }));

      const result = await repo.sumByOrchestrationId(orchId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.inputTokens).toBe(200);
      expect(result.value.totalCostUsd).toBeCloseTo(1.0);
    });
  });

  // ============================================================================
  // topOrchestrationsByCost()
  // ============================================================================

  describe('topOrchestrationsByCost()', () => {
    it('returns empty array when no usage data', async () => {
      const result = await repo.topOrchestrationsByCost(0, 5);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(0);
    });

    it('returns top N orchestrations sorted by cost descending', async () => {
      const orchRepo = new SQLiteOrchestrationRepository(db);
      const costs = [0.1, 5.0, 0.5]; // orchestration 1, 2, 3
      const orchIds: OrchestratorId[] = [];

      for (let i = 0; i < 3; i++) {
        const orchId = OrchestratorId(`orchestrator-cost-${i}`);
        orchIds.push(orchId);
        const orch = createOrchestration({ goal: 'test' }, '/tmp/state.json', '/workspace');
        await orchRepo.save({ ...orch, id: orchId });

        const task = createTask({ prompt: `task for orch ${i}`, orchestratorId: orchId });
        await taskRepo.save(task);
        await repo.save(makeUsage(task.id, { totalCostUsd: costs[i], capturedAt: Date.now() }));
      }

      const result = await repo.topOrchestrationsByCost(0, 2);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(2);
      // Should be sorted descending by cost: $5.0, $0.5
      expect(result.value[0].orchestrationId).toBe(orchIds[1]); // cost 5.0
      expect(result.value[1].orchestrationId).toBe(orchIds[2]); // cost 0.5
    });
  });
});
