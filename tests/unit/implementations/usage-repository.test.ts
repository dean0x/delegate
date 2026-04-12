/**
 * Unit tests for SQLiteUsageRepository
 * ARCHITECTURE: Real in-memory SQLite, no mocks.
 * Pattern: Behavior-driven tests with Result validation.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createLoop,
  createOrchestration,
  createTask,
  LoopId,
  LoopStatus,
  LoopStrategy,
  OrchestratorId,
  TaskId,
  TaskStatus,
  type TaskUsage,
} from '../../../src/core/domain.js';
import { Database } from '../../../src/implementations/database.js';
import { SQLiteLoopRepository } from '../../../src/implementations/loop-repository.js';
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
  let loopRepo: SQLiteLoopRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    repo = new SQLiteUsageRepository(db);
    taskRepo = new SQLiteTaskRepository(db);
    loopRepo = new SQLiteLoopRepository(db);
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

    // ============================================================================
    // Migration v20 — performance indexes for dashboard 1Hz polling
    // ============================================================================

    it('migration v20: idx_tasks_retry_of index exists (partial on tasks.retry_of)', () => {
      const indexes = db
        .getDatabase()
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tasks_retry_of'")
        .all() as Array<{ name: string }>;
      expect(indexes).toHaveLength(1);
      expect(indexes[0].name).toBe('idx_tasks_retry_of');
    });

    it('migration v20: idx_loops_updated_at index exists', () => {
      const indexes = db
        .getDatabase()
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_loops_updated_at'")
        .all() as Array<{ name: string }>;
      expect(indexes).toHaveLength(1);
      expect(indexes[0].name).toBe('idx_loops_updated_at');
    });

    it('migration v20: idx_schedules_updated_at index exists', () => {
      const indexes = db
        .getDatabase()
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_schedules_updated_at'")
        .all() as Array<{ name: string }>;
      expect(indexes).toHaveLength(1);
      expect(indexes[0].name).toBe('idx_schedules_updated_at');
    });

    it('migration v20: idx_orchestrations_updated_at index exists', () => {
      const indexes = db
        .getDatabase()
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_orchestrations_updated_at'")
        .all() as Array<{ name: string }>;
      expect(indexes).toHaveLength(1);
      expect(indexes[0].name).toBe('idx_orchestrations_updated_at');
    });

    it('migration v20: idx_tasks_updated_expr expression index exists', () => {
      const indexes = db
        .getDatabase()
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tasks_updated_expr'")
        .all() as Array<{ name: string }>;
      expect(indexes).toHaveLength(1);
      expect(indexes[0].name).toBe('idx_tasks_updated_expr');
    });
  });

  // ============================================================================
  // Zod validation — boundary parse behaviour
  // ============================================================================

  describe("Zod validation (parse-don't-validate boundary)", () => {
    it('get() returns null (not an error) for a missing row — schema not invoked', async () => {
      // Verifies the null-guard runs before Zod parse on the get() path
      const result = await repo.get(TaskId('task-does-not-exist'));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeNull();
    });

    it('TaskUsageRowSchema rejects a row with empty task_id (boundary contract)', async () => {
      // Verifies the Zod schema used inside get() enforces the parse-don't-validate contract.
      // We test the schema directly because inserting a genuine corrupted row via SQL would
      // require disabling FK constraints (task_usage.task_id references tasks.id).
      const { z } = await import('zod');
      const TaskUsageRowSchema = z.object({
        task_id: z.string().min(1),
        input_tokens: z.number(),
        output_tokens: z.number(),
        cache_creation_input_tokens: z.number(),
        cache_read_input_tokens: z.number(),
        total_cost_usd: z.number(),
        model: z.string().nullable(),
        captured_at: z.number(),
      });
      const corruptedRow = {
        task_id: '', // violates min(1)
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        total_cost_usd: 0.001,
        model: null,
        captured_at: Date.now(),
      };
      expect(() => TaskUsageRowSchema.parse(corruptedRow)).toThrow();
    });

    it('sumByOrchestrationId() Zod aggregate parse returns zero values for empty CTE result', async () => {
      // The aggregate query always returns exactly one row (COALESCE guarantees non-null).
      // This verifies the TaskUsageAggregateRowSchema.parse() path succeeds on a real zero-row result.
      const orchRepo = new SQLiteOrchestrationRepository(db);
      const orchId = OrchestratorId('orch-zod-agg-test');
      const orch = createOrchestration({ goal: 'test' }, '/tmp/state.json', '/workspace');
      await orchRepo.save({ ...orch, id: orchId });

      const result = await repo.sumByOrchestrationId(orchId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.inputTokens).toBe(0);
      expect(result.value.totalCostUsd).toBe(0);
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

    it('A1: does not double-count a task that appears in both base case and retry chain', async () => {
      // Bug: task attributed directly AND appearing as a retry of another attributed task
      // produced two (root_id, task_id) tuples — (T, T) and (P, T) — causing double-count.
      // Fix: DISTINCT task_id in the final SELECT.
      const orchId = OrchestratorId('orch-distinct-test');
      const orchRepo = new SQLiteOrchestrationRepository(db);
      const orch = createOrchestration({ goal: 'test' }, '/tmp/state.json', '/workspace');
      await orchRepo.save({ ...orch, id: orchId });

      // Parent task: directly attributed to orchestration
      const parent = createTask({ prompt: 'parent', orchestratorId: orchId });
      await taskRepo.save(parent);
      await repo.save(makeUsage(parent.id, { inputTokens: 100, totalCostUsd: 0.1 }));

      // Retry task: also attributed (A2 fix applies going forward), AND retry_of parent
      // This is the double-count scenario: retry appears in base case (orchestrator_id match)
      // AND in the recursive arm (retry_of = parent.id which is in the tree)
      const retry = createTask({ prompt: 'retry', orchestratorId: orchId, retryOf: parent.id });
      await taskRepo.save(retry);
      await repo.save(makeUsage(retry.id, { inputTokens: 50, totalCostUsd: 0.05 }));

      const result = await repo.sumByOrchestrationId(orchId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Should be 150, not 200 (if retry was double-counted)
      expect(result.value.inputTokens).toBe(150);
      expect(result.value.totalCostUsd).toBeCloseTo(0.15);
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

    it('A3: retry task without orchestrator_id is attributed to parent orchestration via retry_of chain', async () => {
      // Defense-in-depth: A2 fixes new retries, but historical retries may lack orchestrator_id.
      // The recursive CTE in topOrchestrationsByCost walks retry_of to find the root orchestrator_id.
      const orchRepo = new SQLiteOrchestrationRepository(db);
      const orchId = OrchestratorId('orch-top-chain');
      const orch = createOrchestration({ goal: 'test' }, '/tmp/state.json', '/workspace');
      await orchRepo.save({ ...orch, id: orchId });

      // Original task: attributed to orchestration
      const original = createTask({ prompt: 'original', orchestratorId: orchId });
      await taskRepo.save(original);
      await repo.save(makeUsage(original.id, { totalCostUsd: 1.0, capturedAt: Date.now() }));

      // Retry task: lacks orchestrator_id (historical data, before A2 fix)
      // Must still roll up to orchId via retry_of chain
      const retry = createTask({ prompt: 'retry', retryOf: original.id });
      // Force orchestratorId to be undefined (createTask does not set it without the field)
      await taskRepo.save(retry);
      await repo.save(makeUsage(retry.id, { totalCostUsd: 0.5, capturedAt: Date.now() }));

      const result = await repo.topOrchestrationsByCost(0, 10);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const entry = result.value.find((r) => r.orchestrationId === orchId);
      expect(entry).toBeDefined();
      // Both tasks (1.0 + 0.5) should roll up to the orchestration
      expect(entry!.totalCost).toBeCloseTo(1.5);
    });
  });

  // ============================================================================
  // sumByLoopId()
  // ============================================================================

  describe('sumByLoopId()', () => {
    async function createLoopWithIteration(loopId: string): Promise<{
      loop: Awaited<ReturnType<typeof createLoop>>;
      task: ReturnType<typeof createTask>;
    }> {
      const loop = createLoop({ prompt: 'test', strategy: LoopStrategy.RETRY, exitCondition: 'exit 0' }, '/workspace');
      const savedLoop = { ...loop, id: LoopId(loopId), status: LoopStatus.RUNNING };
      await loopRepo.save(savedLoop);

      const task = createTask({ prompt: 'loop task' });
      // Set status to completed so we can record the iteration
      const completedTask = { ...task, status: TaskStatus.COMPLETED };
      await taskRepo.save(completedTask);

      await loopRepo.recordIteration({
        id: 0, // autoincrement
        loopId: savedLoop.id,
        iterationNumber: 1,
        taskId: task.id,
        status: 'pass',
        startedAt: Date.now(),
      });

      return { loop: savedLoop, task };
    }

    it('A4: sums usage for loop iteration tasks', async () => {
      const { loop, task } = await createLoopWithIteration('loop-sum-basic');
      await repo.save(makeUsage(task.id, { inputTokens: 200, totalCostUsd: 0.2 }));

      const result = await repo.sumByLoopId(loop.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.inputTokens).toBe(200);
      expect(result.value.totalCostUsd).toBeCloseTo(0.2);
    });

    it('A4: retry of a loop iteration task is included in the sum', async () => {
      // Bug: sumByLoopId only joined loop_iterations.task_id directly.
      // If the iteration's task was retried, the retry has usage but is not in loop_iterations.
      // Fix: recursive CTE walks retry chains from iteration tasks.
      const { loop, task } = await createLoopWithIteration('loop-sum-retry');

      // Original iteration task: some usage
      await repo.save(makeUsage(task.id, { inputTokens: 100, totalCostUsd: 0.1 }));

      // Retry of the iteration task: NOT in loop_iterations directly, but should roll up
      const retry = createTask({ prompt: 'retry of loop task', retryOf: task.id });
      const completedRetry = { ...retry, status: TaskStatus.COMPLETED };
      await taskRepo.save(completedRetry);
      await repo.save(makeUsage(retry.id, { inputTokens: 75, totalCostUsd: 0.075 }));

      const result = await repo.sumByLoopId(loop.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Should include both original (100) and retry (75) = 175
      expect(result.value.inputTokens).toBe(175);
      expect(result.value.totalCostUsd).toBeCloseTo(0.175);
    });

    it('returns zero aggregate when loop has no iteration tasks with usage', async () => {
      const loop = createLoop({ prompt: 'empty', strategy: LoopStrategy.RETRY, exitCondition: 'exit 0' }, '/workspace');
      const savedLoop = { ...loop, id: LoopId('loop-empty'), status: LoopStatus.RUNNING };
      await loopRepo.save(savedLoop);

      const result = await repo.sumByLoopId(savedLoop.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.inputTokens).toBe(0);
      expect(result.value.totalCostUsd).toBe(0);
    });
  });
});
