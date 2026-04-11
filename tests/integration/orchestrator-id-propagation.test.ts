/**
 * Integration test: orchestratorId propagation (v1.3.0)
 *
 * ARCHITECTURE: Verifies the orchestratorId flows end-to-end from
 * TaskRequest → createTask() → TaskRepository save/load round-trip.
 *
 * Pattern: Real SQLite in-memory, no process spawning.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOrchestration, createTask, OrchestratorId, TaskStatus, updateTask } from '../../src/core/domain.js';
import { Database } from '../../src/implementations/database.js';
import { SQLiteOrchestrationRepository } from '../../src/implementations/orchestration-repository.js';
import { SQLiteTaskRepository } from '../../src/implementations/task-repository.js';

describe('Integration: orchestratorId propagation', () => {
  let db: Database;
  let taskRepo: SQLiteTaskRepository;
  let orchRepo: SQLiteOrchestrationRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    taskRepo = new SQLiteTaskRepository(db);
    orchRepo = new SQLiteOrchestrationRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('createTask() preserves orchestratorId from TaskRequest', () => {
    const orchId = OrchestratorId('orchestrator-test-prop');
    const task = createTask({ prompt: 'test', orchestratorId: orchId });
    expect(task.orchestratorId).toBe(orchId);
  });

  it('createTask() without orchestratorId leaves field undefined', () => {
    const task = createTask({ prompt: 'standalone task' });
    expect(task.orchestratorId).toBeUndefined();
  });

  it('TaskRepository persists and retrieves orchestratorId round-trip', async () => {
    // Create a real orchestration to satisfy the FK constraint
    const orch = createOrchestration({ goal: 'test' }, '/tmp/state.json', '/workspace');
    await orchRepo.save(orch);

    const task = createTask({ prompt: 'attributed task', orchestratorId: orch.id });
    const saveResult = await taskRepo.save(task);
    expect(saveResult.ok).toBe(true);

    const findResult = await taskRepo.findById(task.id);
    expect(findResult.ok).toBe(true);
    if (!findResult.ok) return;
    expect(findResult.value).not.toBeNull();
    expect(findResult.value!.orchestratorId).toBe(orch.id);
  });

  it('TaskRepository.findByOrchestratorId() returns only attributed tasks', async () => {
    const orch = createOrchestration({ goal: 'filter test' }, '/tmp/state.json', '/workspace');
    await orchRepo.save(orch);

    const attributed1 = createTask({ prompt: 'attr-1', orchestratorId: orch.id });
    const attributed2 = createTask({ prompt: 'attr-2', orchestratorId: orch.id });
    const unrelated = createTask({ prompt: 'standalone' });

    for (const t of [attributed1, attributed2, unrelated]) {
      await taskRepo.save(t);
    }

    const result = await taskRepo.findByOrchestratorId(orch.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.map((t) => t.id);
    expect(ids).toContain(attributed1.id);
    expect(ids).toContain(attributed2.id);
    expect(ids).not.toContain(unrelated.id);
  });

  it('TaskRepository.findByOrchestratorId() filters by status', async () => {
    const orch = createOrchestration({ goal: 'status filter' }, '/tmp/state.json', '/workspace');
    await orchRepo.save(orch);

    // createTask always starts QUEUED — update one to RUNNING via updateTask
    const runningBase = createTask({ prompt: 'running task', orchestratorId: orch.id });
    const running = updateTask(runningBase, { status: TaskStatus.RUNNING });
    const queued = createTask({ prompt: 'queued task', orchestratorId: orch.id });

    for (const t of [running, queued]) {
      await taskRepo.save(t);
    }

    const result = await taskRepo.findByOrchestratorId(orch.id, { statuses: ['running'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.map((t) => t.id);
    expect(ids).toContain(running.id);
    expect(ids).not.toContain(queued.id);
  });

  it('TaskRepository.findUpdatedSince() returns recently created tasks', async () => {
    const oldTask = createTask({ prompt: 'old' });
    const newTask = createTask({ prompt: 'new' });

    await taskRepo.save(oldTask);
    await taskRepo.save(newTask);

    // Backdate the old task by updating created_at directly (createTask always uses Date.now())
    const past = Date.now() - 60000; // 1 minute ago
    db.getDatabase().prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(past, oldTask.id);

    const cutoff = Date.now() - 5000; // 5 seconds ago
    const result = await taskRepo.findUpdatedSince(cutoff, 100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.map((t) => t.id);
    expect(ids).toContain(newTask.id);
    expect(ids).not.toContain(oldTask.id);
  });
});
