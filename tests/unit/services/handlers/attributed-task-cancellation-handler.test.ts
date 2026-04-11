/**
 * Unit tests for AttributedTaskCancellationHandler
 * ARCHITECTURE: Tests event-driven cancel cascade on OrchestrationCancelled.
 * Pattern: Behavior-driven, verifying that cancellation requests are issued for
 * attributed tasks when the orchestration is cancelled.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorId, TaskId } from '../../../../src/core/domain.js';
import { err, ok } from '../../../../src/core/result.js';
import { AttributedTaskCancellationHandler } from '../../../../src/services/handlers/attributed-task-cancellation-handler.js';
import { TestEventBus, TestLogger } from '../../../fixtures/test-doubles.js';
import { flushEventLoop } from '../../../utils/event-helpers.js';

// ============================================================================
// Mock factories
// ============================================================================

const makeTask = (id: string, status: 'queued' | 'running') => ({
  id: id as TaskId,
  status,
  orchestratorId: 'orch-1' as OrchestratorId,
});

const makeTaskRepo = (tasks: ReturnType<typeof makeTask>[] = []) => ({
  findByOrchestratorId: vi.fn().mockResolvedValue(ok(tasks)),
});

const makeTaskManager = () => ({
  cancel: vi.fn().mockResolvedValue(ok(undefined)),
});

// ============================================================================
// Tests
// ============================================================================

describe('AttributedTaskCancellationHandler', () => {
  let eventBus: TestEventBus;
  let logger: TestLogger;

  beforeEach(() => {
    eventBus = new TestEventBus();
    logger = new TestLogger();
  });

  afterEach(() => {
    eventBus.dispose();
  });

  it('creates successfully and subscribes to OrchestrationCancelled', async () => {
    const taskRepo = makeTaskRepo();
    const taskManager = makeTaskManager();

    const result = await AttributedTaskCancellationHandler.create({
      taskRepository: taskRepo as never,
      taskManager: taskManager as never,
      eventBus,
      logger,
    });

    expect(result.ok).toBe(true);
  });

  it('cancels all attributed queued and running tasks on OrchestrationCancelled', async () => {
    const tasks = [makeTask('task-1', 'queued'), makeTask('task-2', 'running')];
    const taskRepo = makeTaskRepo(tasks);
    const taskManager = makeTaskManager();

    const handlerResult = await AttributedTaskCancellationHandler.create({
      taskRepository: taskRepo as never,
      taskManager: taskManager as never,
      eventBus,
      logger,
    });
    expect(handlerResult.ok).toBe(true);

    // Emit OrchestrationCancelled
    await eventBus.emit('OrchestrationCancelled', {
      orchestratorId: 'orch-1' as OrchestratorId,
      reason: 'user cancelled',
    });

    await flushEventLoop();

    // Both tasks should be cancelled
    expect(taskManager.cancel).toHaveBeenCalledTimes(2);
    expect(taskManager.cancel).toHaveBeenCalledWith('task-1', 'user cancelled');
    expect(taskManager.cancel).toHaveBeenCalledWith('task-2', 'user cancelled');
  });

  it('uses default reason when none provided', async () => {
    const tasks = [makeTask('task-1', 'queued')];
    const taskRepo = makeTaskRepo(tasks);
    const taskManager = makeTaskManager();

    const handlerResult = await AttributedTaskCancellationHandler.create({
      taskRepository: taskRepo as never,
      taskManager: taskManager as never,
      eventBus,
      logger,
    });
    expect(handlerResult.ok).toBe(true);

    await eventBus.emit('OrchestrationCancelled', {
      orchestratorId: 'orch-1' as OrchestratorId,
      reason: undefined,
    });

    await flushEventLoop();

    expect(taskManager.cancel).toHaveBeenCalledWith('task-1', 'Orchestration cancelled');
  });

  it('does not cancel tasks when findByOrchestratorId returns empty list', async () => {
    const taskRepo = makeTaskRepo([]);
    const taskManager = makeTaskManager();

    const handlerResult = await AttributedTaskCancellationHandler.create({
      taskRepository: taskRepo as never,
      taskManager: taskManager as never,
      eventBus,
      logger,
    });
    expect(handlerResult.ok).toBe(true);

    await eventBus.emit('OrchestrationCancelled', {
      orchestratorId: 'orch-1' as OrchestratorId,
      reason: 'cancelled',
    });

    await flushEventLoop();

    expect(taskManager.cancel).not.toHaveBeenCalled();
  });

  it('logs warning and continues when findByOrchestratorId fails', async () => {
    const taskRepo = {
      findByOrchestratorId: vi.fn().mockResolvedValue(err(new Error('DB error'))),
    };
    const taskManager = makeTaskManager();

    const handlerResult = await AttributedTaskCancellationHandler.create({
      taskRepository: taskRepo as never,
      taskManager: taskManager as never,
      eventBus,
      logger,
    });
    expect(handlerResult.ok).toBe(true);

    // Should not throw
    await eventBus.emit('OrchestrationCancelled', {
      orchestratorId: 'orch-1' as OrchestratorId,
      reason: 'cancelled',
    });

    await flushEventLoop();

    expect(taskManager.cancel).not.toHaveBeenCalled();
    expect(logger.logs.some((e) => e.level === 'warn')).toBe(true);
  });

  it('logs warning and continues when individual task cancel fails', async () => {
    const tasks = [makeTask('task-1', 'queued'), makeTask('task-2', 'running')];
    const taskRepo = makeTaskRepo(tasks);
    const taskManager = {
      cancel: vi
        .fn()
        .mockResolvedValueOnce(err(new Error('cancel failed')))
        .mockResolvedValueOnce(ok(undefined)),
    };

    const handlerResult = await AttributedTaskCancellationHandler.create({
      taskRepository: taskRepo as never,
      taskManager: taskManager as never,
      eventBus,
      logger,
    });
    expect(handlerResult.ok).toBe(true);

    await eventBus.emit('OrchestrationCancelled', {
      orchestratorId: 'orch-1' as OrchestratorId,
      reason: 'cancelled',
    });

    await flushEventLoop();

    // Both cancels attempted despite first failure
    expect(taskManager.cancel).toHaveBeenCalledTimes(2);
    expect(logger.logs.some((e) => e.level === 'warn')).toBe(true);
  });

  it('queries only for queued and running statuses', async () => {
    const taskRepo = makeTaskRepo([]);
    const taskManager = makeTaskManager();

    const handlerResult = await AttributedTaskCancellationHandler.create({
      taskRepository: taskRepo as never,
      taskManager: taskManager as never,
      eventBus,
      logger,
    });
    expect(handlerResult.ok).toBe(true);

    await eventBus.emit('OrchestrationCancelled', {
      orchestratorId: 'orch-1' as OrchestratorId,
      reason: 'cancelled',
    });

    await flushEventLoop();

    expect(taskRepo.findByOrchestratorId).toHaveBeenCalledWith('orch-1', { statuses: ['queued', 'running'] });
  });
});
