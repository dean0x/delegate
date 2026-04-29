/**
 * Integration test: workspace view data pipeline (Phase D)
 * ARCHITECTURE: Real SQLite in-memory, no process spawning
 * Pattern: Seed data → fetchAllData with workspace view → assert workspaceData
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ViewState } from '../../src/cli/dashboard/types.js';
import { fetchAllData } from '../../src/cli/dashboard/use-dashboard-data.js';
import type { ReadOnlyContext } from '../../src/cli/read-only-context.js';
import { loadConfiguration } from '../../src/core/configuration.js';
import type { LoopIteration } from '../../src/core/domain.js';
import {
  createLoop,
  createOrchestration,
  createTask,
  LoopId,
  LoopStatus,
  OrchestratorId,
  OrchestratorStatus,
  TaskId,
  TaskStatus,
  updateTask,
} from '../../src/core/domain.js';
import { Database } from '../../src/implementations/database.js';
import { SQLiteLoopRepository } from '../../src/implementations/loop-repository.js';
import { SQLiteOrchestrationRepository } from '../../src/implementations/orchestration-repository.js';
import { SQLiteOutputRepository } from '../../src/implementations/output-repository.js';
import { SQLitePipelineRepository } from '../../src/implementations/pipeline-repository.js';
import { SQLiteScheduleRepository } from '../../src/implementations/schedule-repository.js';
import { SQLiteTaskRepository } from '../../src/implementations/task-repository.js';
import { SQLiteUsageRepository } from '../../src/implementations/usage-repository.js';
import { SQLiteWorkerRepository } from '../../src/implementations/worker-repository.js';

// ============================================================================
// Suite
// ============================================================================

describe('Integration: orchestration workspace data pipeline', () => {
  let db: Database;
  let ctx: ReadOnlyContext;
  let orchRepo: SQLiteOrchestrationRepository;
  let taskRepo: SQLiteTaskRepository;
  let loopRepo: SQLiteLoopRepository;
  let usageRepo: SQLiteUsageRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    const config = loadConfiguration();

    taskRepo = new SQLiteTaskRepository(db);
    loopRepo = new SQLiteLoopRepository(db);
    orchRepo = new SQLiteOrchestrationRepository(db);
    const scheduleRepo = new SQLiteScheduleRepository(db);
    const workerRepo = new SQLiteWorkerRepository(db);
    const outputRepo = new SQLiteOutputRepository(config, db);
    usageRepo = new SQLiteUsageRepository(db);
    const pipelineRepo = new SQLitePipelineRepository(db);

    ctx = {
      taskRepository: taskRepo,
      loopRepository: loopRepo,
      scheduleRepository: scheduleRepo,
      orchestrationRepository: orchRepo,
      workerRepository: workerRepo,
      outputRepository: outputRepo,
      usageRepository: usageRepo,
      pipelineRepository: pipelineRepo,
      close: () => db.close(),
    };
  });

  afterEach(() => {
    db.close();
  });

  it('workspaceData contains focusedOrchestration and children', async () => {
    // 1. Create orchestration
    const orch = createOrchestration({ goal: 'build a feature' }, '/tmp/state.json', '/workspace');
    await orchRepo.save(orch);

    // 2. Create a loop attached to the orchestration
    const loop = createLoop(
      { strategy: 'optimize', prompt: 'improve the code', exitCondition: 'tests pass', maxIterations: 10 },
      '/workspace',
    );
    // Attach loop to orchestration
    const orchWithLoop = { ...orch, loopId: loop.id, status: OrchestratorStatus.RUNNING, updatedAt: Date.now() };
    await orchRepo.save(orchWithLoop);
    await loopRepo.save(loop);

    // 3. Create 2 iteration tasks (via loop chain)
    const iterTask1 = createTask({ prompt: 'iteration 1', orchestratorId: orch.id });
    const iterTask2 = createTask({ prompt: 'iteration 2', orchestratorId: orch.id });
    await taskRepo.save(iterTask1);
    await taskRepo.save(iterTask2);

    // 4. Record loop iterations linking tasks to the loop
    const iter1: LoopIteration = {
      id: 0, // autoincrement — ignored by INSERT
      loopId: loop.id,
      iterationNumber: 1,
      taskId: iterTask1.id,
      status: 'pass',
      startedAt: Date.now() - 5000,
      completedAt: Date.now() - 3000,
    };
    const iter2: LoopIteration = {
      id: 0,
      loopId: loop.id,
      iterationNumber: 2,
      taskId: iterTask2.id,
      status: 'running',
      startedAt: Date.now() - 2000,
    };
    await loopRepo.recordIteration(iter1);
    await loopRepo.recordIteration(iter2);

    // 5. Create 1 directly-attributed task (not via loop)
    const directTask = createTask({ prompt: 'direct attribution', orchestratorId: orch.id });
    await taskRepo.save(directTask);

    // 6. Seed usage rows for the tasks
    const now = Date.now();
    const usage1 = {
      taskId: iterTask1.id,
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalCostUsd: 0.015,
      capturedAt: now,
    };
    const usage2 = {
      taskId: directTask.id,
      inputTokens: 800,
      outputTokens: 400,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalCostUsd: 0.012,
      capturedAt: now,
    };
    await usageRepo.save(usage1);
    await usageRepo.save(usage2);

    // 7. Fetch workspace data
    const viewState: ViewState = { kind: 'workspace', orchestrationId: orch.id };
    const result = await fetchAllData(ctx, viewState);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { workspaceData } = result.value;
    expect(workspaceData).toBeDefined();
    if (!workspaceData) return;

    // focusedOrchestration matches the seeded orchestration
    expect(workspaceData.focusedOrchestration.id).toBe(orch.id);

    // children: union of loop iterations + direct attribution
    // iterations: iterTask1, iterTask2 via loop chain
    // direct: directTask via orchestrator_id
    // NOTE: iteration kind is preferred when both match — directTask is direct-only
    const childIds = workspaceData.childTaskIds;
    expect(childIds).toContain(iterTask1.id);
    expect(childIds).toContain(iterTask2.id);
    expect(childIds).toContain(directTask.id);
    expect(workspaceData.children.length).toBeGreaterThanOrEqual(3);

    // childTaskStatuses maps each task to its status string
    expect(workspaceData.childTaskStatuses.get(iterTask1.id)).toBeDefined();
    expect(workspaceData.childTaskStatuses.get(directTask.id)).toBeDefined();

    // costAggregate includes summed costs for the orchestration
    expect(workspaceData.costAggregate.totalCostUsd).toBeCloseTo(0.027, 5);
  });

  it('falls back to first running orchestration when no orchestrationId specified', async () => {
    const runningOrch = createOrchestration({ goal: 'running orch' }, '/tmp/state.json', '/workspace');
    const runningUpdated = { ...runningOrch, status: OrchestratorStatus.RUNNING, updatedAt: Date.now() };
    await orchRepo.save(runningUpdated);

    const viewState: ViewState = { kind: 'workspace' }; // no explicit ID
    const result = await fetchAllData(ctx, viewState);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.workspaceData).toBeDefined();
    expect(result.value.workspaceData?.focusedOrchestration.id).toBe(runningOrch.id);
  });

  it('returns empty workspaceData when no orchestrations exist', async () => {
    const viewState: ViewState = { kind: 'workspace' };
    const result = await fetchAllData(ctx, viewState);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // workspaceData should be undefined when no orchestrations
    expect(result.value.workspaceData).toBeUndefined();
  });
});
