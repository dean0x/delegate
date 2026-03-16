/**
 * Unit tests for TaskManagerService
 * ARCHITECTURE: Tests the hybrid orchestrator (commands via events, queries direct)
 * Pattern: Behavior-driven testing with Result pattern validation
 *
 * The TaskManagerService uses EventBus for commands (delegate, cancel) and
 * direct repository/outputCapture calls for queries (getStatus, getLogs, retry, resume).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Configuration } from '../../../src/core/configuration';
import type { Task, TaskCheckpoint, TaskRequest } from '../../../src/core/domain';
import { Priority, TaskId, TaskStatus } from '../../../src/core/domain';
import { BackbeatError, ErrorCode } from '../../../src/core/errors';
import type { EventBus } from '../../../src/core/events/event-bus';
import type { CheckpointRepository, Logger, OutputCapture, TaskRepository } from '../../../src/core/interfaces';
import { err, ok } from '../../../src/core/result';
import { TaskManagerService } from '../../../src/services/task-manager';
import { ConfigFactory } from '../../fixtures/factories';
import { createMockLogger } from '../../fixtures/mocks';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Minimal EventBus mock: only the methods TaskManagerService actually calls.
 * Defaults: emit resolves ok.
 */
const createTestEventBus = () => ({
  emit: vi.fn().mockResolvedValue(ok(undefined)),
  subscribe: vi.fn().mockReturnValue(ok('sub-1')),
  dispose: vi.fn(),
});

const createMockCheckpointRepo = (): CheckpointRepository => ({
  save: vi.fn().mockResolvedValue(ok(undefined)),
  findLatest: vi.fn().mockResolvedValue(ok(null)),
  findAll: vi.fn().mockResolvedValue(ok([])),
  deleteByTask: vi.fn().mockResolvedValue(ok(undefined)),
});

const createMockTaskRepo = (): TaskRepository => ({
  save: vi.fn().mockResolvedValue(ok(undefined)),
  update: vi.fn().mockResolvedValue(ok(undefined)),
  findById: vi.fn().mockResolvedValue(ok(null)),
  findAll: vi.fn().mockResolvedValue(ok([])),
  findAllUnbounded: vi.fn().mockResolvedValue(ok([])),
  count: vi.fn().mockResolvedValue(ok(0)),
  findByStatus: vi.fn().mockResolvedValue(ok([])),
});

const createMockOutputCapture = (): OutputCapture => ({
  capture: vi.fn().mockReturnValue(ok(undefined)),
  getOutput: vi.fn().mockReturnValue(
    ok({
      taskId: TaskId('mock'),
      stdout: [],
      stderr: [],
      totalSize: 0,
    }),
  ),
  clear: vi.fn().mockReturnValue(ok(undefined)),
});

/**
 * Build a plain (unfrozen) Task-like object for use as mock return values.
 * NOTE: We avoid TaskFactory.withId() because createTask() returns Object.freeze()
 * objects, and the factory's .withId() tries to mutate the frozen object's id field.
 * For mock return values from repo calls, we need unfrozen plain objects.
 */
function buildMockTask(overrides: Partial<Task> = {}): Task {
  const now = Date.now();
  return {
    id: TaskId(`task-${crypto.randomUUID()}`),
    prompt: 'test task prompt',
    status: TaskStatus.QUEUED,
    priority: Priority.P2,
    workingDirectory: '/workspace',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Shortcut: build a failed task for retry/resume tests */
function buildFailedTask(overrides: Partial<Task> = {}): Task {
  return buildMockTask({
    status: TaskStatus.FAILED,
    exitCode: 1,
    error: { message: 'Task failed', name: 'Error' },
    completedAt: Date.now(),
    duration: 3000,
    ...overrides,
  });
}

/** Shortcut: build a completed task */
function buildCompletedTask(overrides: Partial<Task> = {}): Task {
  return buildMockTask({
    status: TaskStatus.COMPLETED,
    exitCode: 0,
    completedAt: Date.now(),
    duration: 5000,
    ...overrides,
  });
}

/** Shortcut: build a running task */
function buildRunningTask(overrides: Partial<Task> = {}): Task {
  return buildMockTask({
    status: TaskStatus.RUNNING,
    startedAt: Date.now(),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaskManagerService', () => {
  let eventBus: ReturnType<typeof createTestEventBus>;
  let logger: Logger;
  let config: Configuration;
  let taskRepo: ReturnType<typeof createMockTaskRepo>;
  let outputCapture: ReturnType<typeof createMockOutputCapture>;
  let service: TaskManagerService;

  beforeEach(() => {
    eventBus = createTestEventBus();
    logger = createMockLogger();
    config = new ConfigFactory().build();
    taskRepo = createMockTaskRepo();
    outputCapture = createMockOutputCapture();
    service = new TaskManagerService(
      eventBus as unknown as EventBus,
      logger,
      config,
      taskRepo as unknown as TaskRepository,
      outputCapture as unknown as OutputCapture,
    );
  });

  // ---------------------------------------------------------------------------
  // delegate()
  // ---------------------------------------------------------------------------
  describe('delegate()', () => {
    const baseRequest: TaskRequest = {
      prompt: 'implement feature X',
      priority: Priority.P1,
      workingDirectory: '/workspace',
    };

    it('should create a task and emit TaskDelegated event', async () => {
      const result = await service.delegate(baseRequest);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.prompt).toBe('implement feature X');
      expect(result.value.priority).toBe(Priority.P1);
      expect(result.value.status).toBe(TaskStatus.QUEUED);

      expect(eventBus.emit).toHaveBeenCalledOnce();
      expect(eventBus.emit).toHaveBeenCalledWith('TaskDelegated', {
        task: expect.objectContaining({
          prompt: 'implement feature X',
          priority: Priority.P1,
        }),
      });
    });

    it('should apply config timeout when request does not specify one', async () => {
      const result = await service.delegate({ prompt: 'test' });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.timeout).toBe(config.timeout);
    });

    it('should use request timeout when explicitly provided', async () => {
      const result = await service.delegate({ prompt: 'test', timeout: 5000 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.timeout).toBe(5000);
    });

    it('should apply config maxOutputBuffer when not specified in request', async () => {
      const result = await service.delegate({ prompt: 'test' });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.maxOutputBuffer).toBe(config.maxOutputBuffer);
    });

    it('should return error when event emission fails', async () => {
      const emitError = new BackbeatError(ErrorCode.SYSTEM_ERROR, 'bus failure');
      eventBus.emit.mockResolvedValue(err(emitError));

      const result = await service.delegate(baseRequest);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe(emitError);
    });

    describe('agent resolution', () => {
      it('should fail delegation when no agent specified and no default configured', async () => {
        const noDefaultConfig = new ConfigFactory().withDefaultAgent(undefined).build();
        const svc = new TaskManagerService(
          eventBus as unknown as EventBus,
          logger,
          noDefaultConfig,
          taskRepo as unknown as TaskRepository,
          outputCapture as unknown as OutputCapture,
        );

        const result = await svc.delegate({ prompt: 'test' });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBeInstanceOf(BackbeatError);
        expect((result.error as BackbeatError).code).toBe(ErrorCode.INVALID_INPUT);
        expect(result.error.message).toContain('No agent specified');
      });

      it('should use config defaultAgent when task does not specify one', async () => {
        const geminiConfig = new ConfigFactory().withDefaultAgent('gemini').build();
        const svc = new TaskManagerService(
          eventBus as unknown as EventBus,
          logger,
          geminiConfig,
          taskRepo as unknown as TaskRepository,
          outputCapture as unknown as OutputCapture,
        );

        const result = await svc.delegate({ prompt: 'test' });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.agent).toBe('gemini');
      });

      it('should prefer explicit task agent over config default', async () => {
        const claudeConfig = new ConfigFactory().withDefaultAgent('claude').build();
        const svc = new TaskManagerService(
          eventBus as unknown as EventBus,
          logger,
          claudeConfig,
          taskRepo as unknown as TaskRepository,
          outputCapture as unknown as OutputCapture,
        );

        const result = await svc.delegate({ prompt: 'test', agent: 'codex' });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.agent).toBe('codex');
      });
    });

    describe('continueFrom handling', () => {
      it('should validate continueFrom task exists via repository call', async () => {
        const existingTask = buildCompletedTask({
          id: TaskId('continue-task'),
        });
        (taskRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(ok(existingTask));

        const result = await service.delegate({
          prompt: 'continue work',
          continueFrom: TaskId('continue-task'),
        });

        expect(result.ok).toBe(true);
        expect(taskRepo.findById).toHaveBeenCalledWith(TaskId('continue-task'));
      });

      it('should return error when continueFrom task not found', async () => {
        // Default mock returns ok(null) for findById
        const result = await service.delegate({
          prompt: 'continue work',
          continueFrom: TaskId('nonexistent'),
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBeInstanceOf(BackbeatError);
        expect((result.error as BackbeatError).code).toBe(ErrorCode.TASK_NOT_FOUND);
      });

      it('should return error when continueFrom lookup fails', async () => {
        (taskRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(
          err(new BackbeatError(ErrorCode.SYSTEM_ERROR, 'query failed')),
        );

        const result = await service.delegate({
          prompt: 'continue work',
          continueFrom: TaskId('some-task'),
        });

        expect(result.ok).toBe(false);
      });

      it('should auto-add continueFrom to dependsOn when missing', async () => {
        const existingTask = buildCompletedTask({
          id: TaskId('dep-task'),
        });
        (taskRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(ok(existingTask));

        const result = await service.delegate({
          prompt: 'continue',
          continueFrom: TaskId('dep-task'),
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.dependsOn).toContain(TaskId('dep-task'));
      });

      it('should not duplicate continueFrom in dependsOn when already present', async () => {
        const existingTask = buildCompletedTask({
          id: TaskId('dep-task'),
        });
        (taskRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(ok(existingTask));

        const result = await service.delegate({
          prompt: 'continue',
          continueFrom: TaskId('dep-task'),
          dependsOn: [TaskId('dep-task')],
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const depTaskCount = result.value.dependsOn!.filter((id) => id === TaskId('dep-task')).length;
        expect(depTaskCount).toBe(1);
      });

      it('should preserve existing dependsOn when adding continueFrom', async () => {
        const existingTask = buildCompletedTask({
          id: TaskId('continue-from'),
        });
        (taskRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(ok(existingTask));

        const result = await service.delegate({
          prompt: 'continue',
          continueFrom: TaskId('continue-from'),
          dependsOn: [TaskId('other-dep')],
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.dependsOn).toContain(TaskId('other-dep'));
        expect(result.value.dependsOn).toContain(TaskId('continue-from'));
      });
    });
  });

  // ---------------------------------------------------------------------------
  // getStatus()
  // ---------------------------------------------------------------------------
  describe('getStatus()', () => {
    it('should return a single task when taskId is provided', async () => {
      const task = buildMockTask({ id: TaskId('status-1') });
      (taskRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(ok(task));

      const result = await service.getStatus(TaskId('status-1'));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect((result.value as Task).id).toBe(TaskId('status-1'));
      expect(taskRepo.findById).toHaveBeenCalledWith(TaskId('status-1'));
    });

    it('should return all tasks when no taskId provided', async () => {
      const tasks = [buildMockTask(), buildMockTask(), buildMockTask()];
      (taskRepo.findAllUnbounded as ReturnType<typeof vi.fn>).mockResolvedValue(ok(tasks));

      const result = await service.getStatus();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(Array.isArray(result.value)).toBe(true);
      expect((result.value as readonly Task[]).length).toBe(3);
      expect(taskRepo.findAllUnbounded).toHaveBeenCalled();
    });

    it('should return error when task not found (null from query)', async () => {
      // Default mock returns ok(null)
      const result = await service.getStatus(TaskId('missing'));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(BackbeatError);
      expect((result.error as BackbeatError).code).toBe(ErrorCode.TASK_NOT_FOUND);
    });

    it('should propagate repository errors', async () => {
      const repoError = new BackbeatError(ErrorCode.SYSTEM_ERROR, 'query failed');
      (taskRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(err(repoError));

      const result = await service.getStatus(TaskId('any'));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe(repoError);
    });
  });

  // ---------------------------------------------------------------------------
  // getLogs()
  // ---------------------------------------------------------------------------
  describe('getLogs()', () => {
    it('should query logs via repository and outputCapture', async () => {
      const task = buildMockTask({ id: TaskId('logs-1') });
      (taskRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(ok(task));

      const output = {
        taskId: TaskId('logs-1'),
        stdout: ['line 1', 'line 2'],
        stderr: [],
        totalSize: 14,
      };
      (outputCapture.getOutput as ReturnType<typeof vi.fn>).mockReturnValue(ok(output));

      const result = await service.getLogs(TaskId('logs-1'));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.taskId).toBe(TaskId('logs-1'));
      expect(result.value.stdout).toEqual(['line 1', 'line 2']);
      expect(taskRepo.findById).toHaveBeenCalledWith(TaskId('logs-1'));
      expect(outputCapture.getOutput).toHaveBeenCalledWith(TaskId('logs-1'), undefined);
    });

    it('should pass tail parameter to outputCapture', async () => {
      const task = buildMockTask({ id: TaskId('logs-1') });
      (taskRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(ok(task));

      await service.getLogs(TaskId('logs-1'), 50);

      expect(outputCapture.getOutput).toHaveBeenCalledWith(TaskId('logs-1'), 50);
    });

    it('should return taskNotFound when task does not exist', async () => {
      // Default mock returns ok(null)
      const result = await service.getLogs(TaskId('nonexistent'));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect((result.error as BackbeatError).code).toBe(ErrorCode.TASK_NOT_FOUND);
    });

    it('should propagate repository errors', async () => {
      const repoError = new BackbeatError(ErrorCode.SYSTEM_ERROR, 'logs failed');
      (taskRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(err(repoError));

      const result = await service.getLogs(TaskId('any'));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe(repoError);
    });
  });

  // ---------------------------------------------------------------------------
  // cancel()
  // ---------------------------------------------------------------------------
  describe('cancel()', () => {
    it('should emit TaskCancellationRequested event for cancellable task', async () => {
      const task = buildMockTask({ id: TaskId('cancel-1'), status: TaskStatus.QUEUED });
      (taskRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(ok(task));

      const result = await service.cancel(TaskId('cancel-1'));

      expect(result.ok).toBe(true);
      expect(eventBus.emit).toHaveBeenCalledWith('TaskCancellationRequested', {
        taskId: TaskId('cancel-1'),
        reason: undefined,
      });
    });

    it('should pass reason through to event', async () => {
      const task = buildRunningTask({ id: TaskId('cancel-1') });
      (taskRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(ok(task));

      await service.cancel(TaskId('cancel-1'), 'user requested');

      expect(eventBus.emit).toHaveBeenCalledWith('TaskCancellationRequested', {
        taskId: TaskId('cancel-1'),
        reason: 'user requested',
      });
    });

    it('should return error when event emission fails', async () => {
      const task = buildRunningTask({ id: TaskId('cancel-1') });
      (taskRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(ok(task));
      const emitError = new BackbeatError(ErrorCode.SYSTEM_ERROR, 'emit failed');
      eventBus.emit.mockResolvedValue(err(emitError));

      const result = await service.cancel(TaskId('cancel-1'));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe(emitError);
    });

    it('should return taskNotFound when task does not exist', async () => {
      // Default mock returns ok(null)
      const result = await service.cancel(TaskId('nonexistent'));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect((result.error as BackbeatError).code).toBe(ErrorCode.TASK_NOT_FOUND);
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it('should return TASK_CANNOT_CANCEL for terminal-state task', async () => {
      const completedTask = buildCompletedTask({ id: TaskId('done-1') });
      (taskRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(ok(completedTask));

      const result = await service.cancel(TaskId('done-1'));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect((result.error as BackbeatError).code).toBe(ErrorCode.TASK_CANNOT_CANCEL);
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it('should return TASK_CANNOT_CANCEL for cancelled task', async () => {
      const cancelledTask = buildMockTask({ id: TaskId('cancelled-1'), status: TaskStatus.CANCELLED });
      (taskRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(ok(cancelledTask));

      const result = await service.cancel(TaskId('cancelled-1'));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect((result.error as BackbeatError).code).toBe(ErrorCode.TASK_CANNOT_CANCEL);
    });

    it('should propagate repository errors on cancel', async () => {
      const repoError = new BackbeatError(ErrorCode.SYSTEM_ERROR, 'db down');
      (taskRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(err(repoError));

      const result = await service.cancel(TaskId('any'));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe(repoError);
      expect(eventBus.emit).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // retry()
  // ---------------------------------------------------------------------------
  describe('retry()', () => {
    it('should create a new task from a failed task', async () => {
      const failedTask = buildFailedTask({
        id: TaskId('failed-1'),
        prompt: 'do something',
        priority: Priority.P0,
        workingDirectory: '/project',
      });
      (taskRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(ok(failedTask));

      const result = await service.retry(TaskId('failed-1'));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.prompt).toBe('do something');
      expect(result.value.priority).toBe(Priority.P0);
      // New task must have a different ID
      expect(result.value.id).not.toBe(TaskId('failed-1'));
      // Retry tracking
      expect(result.value.parentTaskId).toBe(TaskId('failed-1'));
      expect(result.value.retryOf).toBe(TaskId('failed-1'));
      expect(result.value.retryCount).toBe(1);
      expect(result.value.status).toBe(TaskStatus.QUEUED);
    });

    it('should create a new task from a completed task', async () => {
      const completedTask = buildCompletedTask({
        id: TaskId('comp-1'),
      });
      (taskRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(ok(completedTask));

      const result = await service.retry(TaskId('comp-1'));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.retryOf).toBe(TaskId('comp-1'));
    });

    it('should allow retry for a cancelled task', async () => {
      const cancelledTask = buildMockTask({
        id: TaskId('cancelled-1'),
        status: TaskStatus.CANCELLED,
      });
      (taskRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(ok(cancelledTask));

      const result = await service.retry(TaskId('cancelled-1'));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.retryOf).toBe(TaskId('cancelled-1'));
    });

    it('should reject retry for a running task', async () => {
      const runningTask = buildRunningTask({
        id: TaskId('running-1'),
      });
      (taskRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(ok(runningTask));

      const result = await service.retry(TaskId('running-1'));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(BackbeatError);
      expect((result.error as BackbeatError).code).toBe(ErrorCode.INVALID_OPERATION);
    });

    it('should reject retry for a queued task', async () => {
      const queuedTask = buildMockTask({
        id: TaskId('queued-1'),
        status: TaskStatus.QUEUED,
      });
      (taskRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(ok(queuedTask));

      const result = await service.retry(TaskId('queued-1'));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect((result.error as BackbeatError).code).toBe(ErrorCode.INVALID_OPERATION);
    });

    it('should return error when task not found', async () => {
      // Default mock returns ok(null)
      const result = await service.retry(TaskId('nonexistent'));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect((result.error as BackbeatError).code).toBe(ErrorCode.TASK_NOT_FOUND);
    });

    it('should propagate repository errors', async () => {
      (taskRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(
        err(new BackbeatError(ErrorCode.SYSTEM_ERROR, 'bus down')),
      );

      const result = await service.retry(TaskId('any'));

      expect(result.ok).toBe(false);
    });

    it('should return error when TaskDelegated emission fails', async () => {
      const failedTask = buildFailedTask({ id: TaskId('fail-emit') });
      (taskRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(ok(failedTask));
      eventBus.emit.mockResolvedValue(err(new BackbeatError(ErrorCode.SYSTEM_ERROR, 'emit failed')));

      const result = await service.retry(TaskId('fail-emit'));

      expect(result.ok).toBe(false);
    });

    it('should emit TaskDelegated for the new retry task', async () => {
      const failedTask = buildFailedTask({ id: TaskId('f1') });
      (taskRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(ok(failedTask));

      const result = await service.retry(TaskId('f1'));

      expect(result.ok).toBe(true);
      expect(eventBus.emit).toHaveBeenCalledWith('TaskDelegated', {
        task: expect.objectContaining({
          parentTaskId: TaskId('f1'),
          retryOf: TaskId('f1'),
          retryCount: 1,
        }),
      });
    });

    describe('retry chain tracking', () => {
      it('should point parentTaskId to the root task on second retry', async () => {
        const firstRetry = buildFailedTask({
          id: TaskId('task-B'),
          parentTaskId: TaskId('task-A'),
          retryCount: 1,
          retryOf: TaskId('task-A'),
        });
        (taskRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(ok(firstRetry));

        const result = await service.retry(TaskId('task-B'));

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.parentTaskId).toBe(TaskId('task-A'));
        expect(result.value.retryOf).toBe(TaskId('task-B'));
        expect(result.value.retryCount).toBe(2);
      });

      it('should set parentTaskId to self for first retry (no existing chain)', async () => {
        const originalTask = buildFailedTask({
          id: TaskId('original'),
        });
        (taskRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(ok(originalTask));

        const result = await service.retry(TaskId('original'));

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.parentTaskId).toBe(TaskId('original'));
        expect(result.value.retryOf).toBe(TaskId('original'));
        expect(result.value.retryCount).toBe(1);
      });

      it('should increment retryCount from existing count', async () => {
        const thirdRetry = buildFailedTask({
          id: TaskId('retry-3'),
          parentTaskId: TaskId('root'),
          retryCount: 3,
          retryOf: TaskId('retry-2'),
        });
        (taskRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(ok(thirdRetry));

        const result = await service.retry(TaskId('retry-3'));

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.retryCount).toBe(4);
        expect(result.value.parentTaskId).toBe(TaskId('root'));
        expect(result.value.retryOf).toBe(TaskId('retry-3'));
      });
    });
  });

  // ---------------------------------------------------------------------------
  // resume()
  // ---------------------------------------------------------------------------
  describe('resume()', () => {
    let checkpointRepo: ReturnType<typeof createMockCheckpointRepo>;
    let svcWithCheckpoint: TaskManagerService;

    beforeEach(() => {
      checkpointRepo = createMockCheckpointRepo();
      svcWithCheckpoint = new TaskManagerService(
        eventBus as unknown as EventBus,
        logger,
        config,
        taskRepo as unknown as TaskRepository,
        outputCapture as unknown as OutputCapture,
        checkpointRepo,
      );
    });

    it('should return error when task not found', async () => {
      const result = await svcWithCheckpoint.resume({
        taskId: TaskId('missing'),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect((result.error as BackbeatError).code).toBe(ErrorCode.TASK_NOT_FOUND);
    });

    it('should reject resume for a running task', async () => {
      const running = buildRunningTask({ id: TaskId('r1') });
      (taskRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(ok(running));

      const result = await svcWithCheckpoint.resume({
        taskId: TaskId('r1'),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect((result.error as BackbeatError).code).toBe(ErrorCode.INVALID_OPERATION);
    });

    it('should reject resume for a queued task', async () => {
      const queued = buildMockTask({ id: TaskId('q1'), status: TaskStatus.QUEUED });
      (taskRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(ok(queued));

      const result = await svcWithCheckpoint.resume({
        taskId: TaskId('q1'),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect((result.error as BackbeatError).code).toBe(ErrorCode.INVALID_OPERATION);
    });

    it('should create enriched task without checkpoint when repo has none', async () => {
      const failed = buildFailedTask({
        id: TaskId('res-1'),
        prompt: 'original prompt',
      });
      (taskRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(ok(failed));

      const result = await svcWithCheckpoint.resume({
        taskId: TaskId('res-1'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.prompt).toContain('original prompt');
      expect(result.value.prompt).toContain('PREVIOUS TASK CONTEXT');
    });

    it('should enrich prompt with checkpoint data when available', async () => {
      const failed = buildFailedTask({
        id: TaskId('res-2'),
        prompt: 'build feature',
      });
      (taskRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(ok(failed));

      const checkpoint: TaskCheckpoint = {
        id: 1,
        taskId: TaskId('res-2'),
        checkpointType: 'failed',
        outputSummary: 'Compiled 5 files',
        errorSummary: 'TypeError: cannot read property',
        gitBranch: 'feat/my-feature',
        gitCommitSha: 'abc123',
        gitDirtyFiles: ['src/main.ts', 'src/utils.ts'],
        createdAt: Date.now(),
      };
      (checkpointRepo.findLatest as ReturnType<typeof vi.fn>).mockResolvedValue(ok(checkpoint));

      const result = await svcWithCheckpoint.resume({
        taskId: TaskId('res-2'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.prompt).toContain('build feature');
      expect(result.value.prompt).toContain('Compiled 5 files');
      expect(result.value.prompt).toContain('TypeError: cannot read property');
      expect(result.value.prompt).toContain('feat/my-feature');
      expect(result.value.prompt).toContain('abc123');
      expect(result.value.prompt).toContain('src/main.ts');
    });

    it('should include additional context in enriched prompt', async () => {
      const failed = buildFailedTask({ id: TaskId('res-3') });
      (taskRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(ok(failed));

      const result = await svcWithCheckpoint.resume({
        taskId: TaskId('res-3'),
        additionalContext: 'Try a different approach using streams',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.prompt).toContain('Try a different approach using streams');
    });

    it('should emit TaskDelegated event on resume', async () => {
      const failed = buildFailedTask({ id: TaskId('res-4') });
      (taskRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(ok(failed));

      const result = await svcWithCheckpoint.resume({
        taskId: TaskId('res-4'),
      });

      expect(result.ok).toBe(true);
      expect(eventBus.emit).toHaveBeenCalledTimes(1);
      expect(eventBus.emit).toHaveBeenCalledWith(
        'TaskDelegated',
        expect.objectContaining({ task: expect.any(Object) }),
      );
    });

    it('should maintain retry chain tracking', async () => {
      const failed = buildFailedTask({
        id: TaskId('chain-1'),
        parentTaskId: TaskId('root-task'),
        retryCount: 2,
      });
      (taskRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(ok(failed));

      const result = await svcWithCheckpoint.resume({
        taskId: TaskId('chain-1'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.parentTaskId).toBe(TaskId('root-task'));
      expect(result.value.retryOf).toBe(TaskId('chain-1'));
      expect(result.value.retryCount).toBe(3);
    });

    it('should return error when TaskDelegated emission fails', async () => {
      const failed = buildFailedTask({ id: TaskId('fail-emit') });
      (taskRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(ok(failed));
      eventBus.emit.mockResolvedValue(err(new BackbeatError(ErrorCode.SYSTEM_ERROR, 'emit failed')));

      const result = await svcWithCheckpoint.resume({
        taskId: TaskId('fail-emit'),
      });

      expect(result.ok).toBe(false);
    });

    it('should proceed without checkpoint when checkpoint lookup fails', async () => {
      const failed = buildFailedTask({
        id: TaskId('res-warn'),
        prompt: 'do work',
      });
      (taskRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(ok(failed));
      (checkpointRepo.findLatest as ReturnType<typeof vi.fn>).mockResolvedValue(
        err(new BackbeatError(ErrorCode.SYSTEM_ERROR, 'db error')),
      );

      const result = await svcWithCheckpoint.resume({
        taskId: TaskId('res-warn'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.prompt).toContain('do work');
      expect(result.value.prompt).toContain('PREVIOUS TASK CONTEXT');
      expect(logger.warn).toHaveBeenCalled();
    });

    it('should work without checkpointRepo (service created without it)', async () => {
      const failed = buildFailedTask({
        id: TaskId('no-repo'),
        prompt: 'task prompt',
      });
      (taskRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(ok(failed));

      const result = await service.resume({ taskId: TaskId('no-repo') });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.prompt).toContain('task prompt');
    });

    it('should propagate repository errors', async () => {
      (taskRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(
        err(new BackbeatError(ErrorCode.SYSTEM_ERROR, 'query failed')),
      );

      const result = await svcWithCheckpoint.resume({
        taskId: TaskId('any'),
      });

      expect(result.ok).toBe(false);
    });
  });
});
