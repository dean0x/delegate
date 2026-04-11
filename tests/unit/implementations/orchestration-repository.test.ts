/**
 * Unit tests for SQLiteOrchestrationRepository
 * ARCHITECTURE: Tests repository operations in isolation with in-memory database
 * Pattern: Behavior-driven testing with Result pattern validation
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createLoop,
  createOrchestration,
  createTask,
  LoopId,
  LoopStrategy,
  type Orchestration,
  OrchestratorId,
  OrchestratorStatus,
  updateOrchestration,
} from '../../../src/core/domain.js';
import { Database } from '../../../src/implementations/database.js';
import { SQLiteLoopRepository } from '../../../src/implementations/loop-repository.js';
import { SQLiteOrchestrationRepository } from '../../../src/implementations/orchestration-repository.js';
import { SQLiteTaskRepository } from '../../../src/implementations/task-repository.js';

describe('SQLiteOrchestrationRepository - Unit Tests', () => {
  let db: Database;
  let repo: SQLiteOrchestrationRepository;
  let loopRepo: SQLiteLoopRepository;
  let taskRepo: SQLiteTaskRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    repo = new SQLiteOrchestrationRepository(db);
    loopRepo = new SQLiteLoopRepository(db);
    taskRepo = new SQLiteTaskRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function createTestOrchestration(overrides: Partial<Orchestration> = {}): Orchestration {
    return {
      ...createOrchestration({ goal: 'Build a new feature' }, '/tmp/state.json', '/workspace'),
      ...overrides,
    } as Orchestration;
  }

  describe('save() and findById()', () => {
    it('should save and retrieve an orchestration by ID', async () => {
      const orch = createTestOrchestration();
      const saveResult = await repo.save(orch);
      expect(saveResult.ok).toBe(true);

      const findResult = await repo.findById(orch.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;
      expect(findResult.value).not.toBeNull();
      expect(findResult.value?.id).toBe(orch.id);
      expect(findResult.value?.goal).toBe('Build a new feature');
      expect(findResult.value?.status).toBe(OrchestratorStatus.PLANNING);
      expect(findResult.value?.maxDepth).toBe(3);
      expect(findResult.value?.maxWorkers).toBe(5);
      expect(findResult.value?.maxIterations).toBe(50);
    });

    it('should return null for non-existent ID', async () => {
      const result = await repo.findById(OrchestratorId('orchestrator-nonexistent'));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeNull();
    });
  });

  describe('update()', () => {
    it('should update an existing orchestration', async () => {
      const orch = createTestOrchestration();
      await repo.save(orch);

      // Create a loop first for FK constraint
      const loop = createLoop({ prompt: 'test', strategy: LoopStrategy.RETRY, exitCondition: 'true' }, '/tmp');
      await loopRepo.save(loop);

      const updated = updateOrchestration(orch, {
        status: OrchestratorStatus.RUNNING,
        loopId: loop.id,
      });
      const updateResult = await repo.update(updated);
      expect(updateResult.ok).toBe(true);

      const findResult = await repo.findById(orch.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;
      expect(findResult.value?.status).toBe(OrchestratorStatus.RUNNING);
    });
  });

  describe('findAll()', () => {
    it('should return all orchestrations with pagination', async () => {
      const o1 = createTestOrchestration();
      const o2 = createTestOrchestration();
      await repo.save(o1);
      await repo.save(o2);

      const result = await repo.findAll();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(2);
    });

    it('should respect limit and offset', async () => {
      for (let i = 0; i < 5; i++) {
        await repo.save(createTestOrchestration());
      }

      const result = await repo.findAll(2, 1);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(2);
    });
  });

  describe('findByStatus()', () => {
    it('should filter by status', async () => {
      const planning = createTestOrchestration();
      await repo.save(planning);

      const running = createTestOrchestration();
      const runningUpdated = updateOrchestration(running, { status: OrchestratorStatus.RUNNING });
      await repo.save(runningUpdated);

      const result = await repo.findByStatus(OrchestratorStatus.PLANNING);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(1);
      expect(result.value[0].status).toBe(OrchestratorStatus.PLANNING);
    });
  });

  describe('findByLoopId()', () => {
    it('should find orchestration by loop ID', async () => {
      // Create a loop first for FK constraint
      const loop = createLoop({ prompt: 'test', strategy: LoopStrategy.RETRY, exitCondition: 'true' }, '/tmp');
      await loopRepo.save(loop);

      const orch = createTestOrchestration();
      const withLoop = updateOrchestration(orch, { loopId: loop.id });
      await repo.save(withLoop);

      const result = await repo.findByLoopId(loop.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).not.toBeNull();
      expect(result.value?.id).toBe(orch.id);
    });

    it('should return null for unknown loop ID', async () => {
      const result = await repo.findByLoopId(LoopId('loop-unknown'));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeNull();
    });
  });

  describe('delete()', () => {
    it('should delete an orchestration', async () => {
      const orch = createTestOrchestration();
      await repo.save(orch);

      const deleteResult = await repo.delete(orch.id);
      expect(deleteResult.ok).toBe(true);

      const findResult = await repo.findById(orch.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;
      expect(findResult.value).toBeNull();
    });
  });

  describe('cleanupOldOrchestrations()', () => {
    it('should delete terminal orchestrations older than retention', async () => {
      const oldOrch = createTestOrchestration();
      const oldCompleted = updateOrchestration(oldOrch, {
        status: OrchestratorStatus.COMPLETED,
        completedAt: Date.now() - 10 * 24 * 60 * 60 * 1000, // 10 days ago
      });
      await repo.save(oldCompleted);

      const recentOrch = createTestOrchestration();
      const recentCompleted = updateOrchestration(recentOrch, {
        status: OrchestratorStatus.COMPLETED,
        completedAt: Date.now(),
      });
      await repo.save(recentCompleted);

      const result = await repo.cleanupOldOrchestrations(7 * 24 * 60 * 60 * 1000);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(1);
    });

    it('should not delete running orchestrations', async () => {
      const running = createTestOrchestration();
      const updated = updateOrchestration(running, { status: OrchestratorStatus.RUNNING });
      await repo.save(updated);

      const result = await repo.cleanupOldOrchestrations(0); // Even with 0 retention
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(0);
    });
  });

  describe('sync operations', () => {
    it('saveSync and findByIdSync should work', () => {
      const orch = createTestOrchestration();
      repo.saveSync(orch);

      const found = repo.findByIdSync(orch.id);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(orch.id);
    });

    it('updateSync should update orchestration', () => {
      const orch = createTestOrchestration();
      repo.saveSync(orch);

      const updated = updateOrchestration(orch, { status: OrchestratorStatus.FAILED });
      repo.updateSync(updated);

      const found = repo.findByIdSync(orch.id);
      expect(found?.status).toBe(OrchestratorStatus.FAILED);
    });

    it('findByLoopIdSync should find by loop ID', async () => {
      const loop = createLoop({ prompt: 'test', strategy: LoopStrategy.RETRY, exitCondition: 'true' }, '/tmp');
      await loopRepo.save(loop);

      const orch = createTestOrchestration();
      const withLoop = updateOrchestration(orch, { loopId: loop.id });
      repo.saveSync(withLoop);

      const found = repo.findByLoopIdSync(loop.id);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(orch.id);
    });
  });

  // ===========================================================================
  // Paginated getOrchestratorChildren + countOrchestratorChildren (v1.3.0)
  // ===========================================================================

  describe('getOrchestratorChildren — pagination (v1.3.0)', () => {
    it('returns first page of children with limit=5, offset=0', async () => {
      const orch = createTestOrchestration();
      await repo.save(orch);

      // Seed 12 tasks attributed to this orchestration
      for (let i = 0; i < 12; i++) {
        const task = createTask({ prompt: `task ${i}`, orchestratorId: orch.id as OrchestratorId });
        await taskRepo.save(task);
      }

      const result = await repo.getOrchestratorChildren(orch.id, 5, 0);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(5);
    });

    it('returns second page of children with limit=5, offset=5', async () => {
      const orch = createTestOrchestration();
      await repo.save(orch);

      for (let i = 0; i < 12; i++) {
        const task = createTask({ prompt: `task ${i}`, orchestratorId: orch.id as OrchestratorId });
        await taskRepo.save(task);
      }

      const page0 = await repo.getOrchestratorChildren(orch.id, 5, 0);
      const page1 = await repo.getOrchestratorChildren(orch.id, 5, 5);
      expect(page0.ok && page1.ok).toBe(true);
      if (!page0.ok || !page1.ok) return;

      const page0Ids = new Set(page0.value.map((c) => c.taskId));
      const page1Ids = new Set(page1.value.map((c) => c.taskId));

      // Pages must be disjoint
      for (const id of page1Ids) {
        expect(page0Ids.has(id)).toBe(false);
      }
      expect(page1.value).toHaveLength(5);
    });

    it('returns last partial page correctly', async () => {
      const orch = createTestOrchestration();
      await repo.save(orch);

      for (let i = 0; i < 7; i++) {
        const task = createTask({ prompt: `task ${i}`, orchestratorId: orch.id as OrchestratorId });
        await taskRepo.save(task);
      }

      const result = await repo.getOrchestratorChildren(orch.id, 5, 5);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(2);
    });

    it('offset defaults to 0 for backward compatibility (2-arg call)', async () => {
      const orch = createTestOrchestration();
      await repo.save(orch);

      for (let i = 0; i < 3; i++) {
        const task = createTask({ prompt: `task ${i}`, orchestratorId: orch.id as OrchestratorId });
        await taskRepo.save(task);
      }

      const result = await repo.getOrchestratorChildren(orch.id, 10);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(3);
    });

    it('ordering is stable across pages — no overlap, no gaps', async () => {
      const orch = createTestOrchestration();
      await repo.save(orch);

      for (let i = 0; i < 10; i++) {
        const task = createTask({ prompt: `task ${i}`, orchestratorId: orch.id as OrchestratorId });
        await taskRepo.save(task);
      }

      const page0 = await repo.getOrchestratorChildren(orch.id, 5, 0);
      const page1 = await repo.getOrchestratorChildren(orch.id, 5, 5);
      expect(page0.ok && page1.ok).toBe(true);
      if (!page0.ok || !page1.ok) return;

      const allIds = [...page0.value.map((c) => c.taskId), ...page1.value.map((c) => c.taskId)];
      const unique = new Set(allIds);
      expect(unique.size).toBe(10); // No duplicates, no gaps
    });

    it('handles empty orchestration gracefully', async () => {
      const orch = createTestOrchestration();
      await repo.save(orch);

      const result = await repo.getOrchestratorChildren(orch.id, 10, 0);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(0);
    });

    it('deduplicates INSIDE the UNION CTE so pagination stays correct across pages', async () => {
      // Invariant: seed 20 unique direct tasks + 5 of them also attributed via
      // loop iteration. Raw UNION rows = 25; unique task_ids = 20. With page size
      // 15, pages 0 and 1 must return 20 disjoint unique rows total — duplicates
      // must be collapsed inside the CTE, not after LIMIT/OFFSET.
      const orch = createTestOrchestration();
      await repo.save(orch);

      const loop = createLoop({ prompt: 'loop task', strategy: LoopStrategy.RETRY, exitCondition: 'true' }, '/tmp');
      await loopRepo.save(loop);
      const orchWithLoop = updateOrchestration(orch, { loopId: loop.id });
      await repo.update(orchWithLoop);

      const tasks = [];
      for (let i = 0; i < 20; i++) {
        const task = createTask({ prompt: `task ${i}`, orchestratorId: orchWithLoop.id as OrchestratorId });
        await taskRepo.save(task);
        tasks.push(task);
      }

      // Record loop_iteration rows for the FIRST 5 tasks — dual attribution.
      for (let i = 0; i < 5; i++) {
        await loopRepo.recordIteration({
          id: 0,
          loopId: loop.id,
          iterationNumber: i + 1,
          taskId: tasks[i].id,
          status: 'running' as const,
          startedAt: Date.now(),
        });
      }

      // Count must be 20 (unique), not 25 (raw UNION)
      const countResult = await repo.countOrchestratorChildren(orchWithLoop.id);
      expect(countResult.ok).toBe(true);
      if (!countResult.ok) return;
      expect(countResult.value).toBe(20);

      // Fetch both pages with PAGE_SIZE=15
      const page0 = await repo.getOrchestratorChildren(orchWithLoop.id, 15, 0);
      const page1 = await repo.getOrchestratorChildren(orchWithLoop.id, 15, 15);
      expect(page0.ok && page1.ok).toBe(true);
      if (!page0.ok || !page1.ok) return;

      // Page 0 full, page 1 partial (20 - 15 = 5)
      expect(page0.value).toHaveLength(15);
      expect(page1.value).toHaveLength(5);

      // Pages must be disjoint (no taskId appears in both pages)
      const page0Ids = new Set(page0.value.map((c) => c.taskId));
      const page1Ids = new Set(page1.value.map((c) => c.taskId));
      for (const id of page1Ids) {
        expect(page0Ids.has(id)).toBe(false);
      }

      // Union of both pages must contain exactly 20 distinct taskIds
      const unionSize = new Set([...page0Ids, ...page1Ids]).size;
      expect(unionSize).toBe(20);
    });
  });

  describe('countOrchestratorChildren (v1.3.0)', () => {
    it('returns 0 for orchestration with no children', async () => {
      const orch = createTestOrchestration();
      await repo.save(orch);

      const result = await repo.countOrchestratorChildren(orch.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(0);
    });

    it('returns total count matching non-paginated fetch length', async () => {
      const orch = createTestOrchestration();
      await repo.save(orch);

      for (let i = 0; i < 8; i++) {
        const task = createTask({ prompt: `task ${i}`, orchestratorId: orch.id as OrchestratorId });
        await taskRepo.save(task);
      }

      const countResult = await repo.countOrchestratorChildren(orch.id);
      const fetchResult = await repo.getOrchestratorChildren(orch.id, 100);
      expect(countResult.ok && fetchResult.ok).toBe(true);
      if (!countResult.ok || !fetchResult.ok) return;
      expect(countResult.value).toBe(fetchResult.value.length);
    });

    it('count matches sum of paginated fetches', async () => {
      const orch = createTestOrchestration();
      await repo.save(orch);

      for (let i = 0; i < 12; i++) {
        const task = createTask({ prompt: `task ${i}`, orchestratorId: orch.id as OrchestratorId });
        await taskRepo.save(task);
      }

      const countResult = await repo.countOrchestratorChildren(orch.id);
      const page0 = await repo.getOrchestratorChildren(orch.id, 5, 0);
      const page1 = await repo.getOrchestratorChildren(orch.id, 5, 5);
      const page2 = await repo.getOrchestratorChildren(orch.id, 5, 10);

      expect(countResult.ok && page0.ok && page1.ok && page2.ok).toBe(true);
      if (!countResult.ok || !page0.ok || !page1.ok || !page2.ok) return;

      const totalFetched = page0.value.length + page1.value.length + page2.value.length;
      expect(countResult.value).toBe(12);
      expect(totalFetched).toBe(12);
    });

    it('does not double-count a task that appears in both direct and loop_chain attribution', async () => {
      const orch = createTestOrchestration();
      await repo.save(orch);

      // Create a loop attributed to this orchestration
      const loop = createLoop({ prompt: 'loop task', strategy: LoopStrategy.RETRY, exitCondition: 'true' }, '/tmp');
      await loopRepo.save(loop);
      const orchWithLoop = updateOrchestration(orch, { loopId: loop.id });
      await repo.update(orchWithLoop);

      // Create a task attributed directly to the orchestration
      const task = createTask({ prompt: 'direct task', orchestratorId: orch.id as OrchestratorId });
      await taskRepo.save(task);

      // Also record a loop_iteration row for the SAME task (simulating dual attribution)
      const iteration = {
        id: 0, // Autoincrement — set to 0, ignored on insert
        loopId: loop.id,
        iterationNumber: 1,
        taskId: task.id,
        status: 'running' as const,
        startedAt: Date.now(),
      };
      await loopRepo.recordIteration(iteration);

      // Count should be 1, not 2 (dedup by task_id)
      const countResult = await repo.countOrchestratorChildren(orchWithLoop.id);
      expect(countResult.ok).toBe(true);
      if (!countResult.ok) return;
      expect(countResult.value).toBe(1);
    });
  });
});
