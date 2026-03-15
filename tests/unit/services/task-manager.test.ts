/**
 * Unit tests for TaskManagerService
 * ARCHITECTURE: Tests the pure event-driven orchestrator with mock EventBus
 * Pattern: Behavior-driven testing with Result pattern validation
 *
 * The TaskManagerService NEVER accesses repositories directly.
 * All operations go through EventBus emit() for commands and request() for queries.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Configuration } from '../../../src/core/configuration';
import type { Task, TaskCheckpoint, TaskRequest } from '../../../src/core/domain';
import { Priority, TaskId, TaskStatus } from '../../../src/core/domain';
import { BackbeatError, ErrorCode } from '../../../src/core/errors';
import type { EventBus } from '../../../src/core/events/event-bus';
import type { CheckpointRepository, Logger } from '../../../src/core/interfaces';
import { err, ok } from '../../../src/core/result';
import { TaskManagerService } from '../../../src/services/task-manager';
import { ConfigFactory } from '../../fixtures/factories';
import { createMockLogger } from '../../fixtures/mocks';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Minimal EventBus mock: only the methods TaskManagerService actually calls.
 * Defaults: emit resolves ok, request resolves ok(null).
 */
const createTestEventBus = () => ({
  emit: vi.fn().mockResolvedValue(ok(undefined)),
  request: vi.fn().mockResolvedValue(ok(null)),
  subscribe: vi.fn().mockReturnValue(ok('sub-1')),
  dispose: vi.fn(),
});

const createMockCheckpointRepo = (): CheckpointRepository => ({
  save: vi.fn().mockResolvedValue(ok(undefined)),
  findLatest: vi.fn().mockResolvedValue(ok(null)),
  findAll: vi.fn().mockResolvedValue(ok([])),
  deleteByTask: vi.fn().mockResolvedValue(ok(undefined)),
});

/**
 * Build a plain (unfrozen) Task-like object for use as mock return values.
 * NOTE: We avoid TaskFactory.withId() because createTask() returns Object.freeze()
 * objects, and the factory's .withId() tries to mutate the frozen object's id field.
 * For mock return values from eventBus.request, we need unfrozen plain objects.
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
  let service: TaskManagerService;

  beforeEach(() => {
    eventBus = createTestEventBus();
    logger = createMockLogger();
    config = new ConfigFactory().build();
    service = new TaskManagerService(eventBus as unknown as EventBus, logger, config);
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
        const svc = new TaskManagerService(eventBus as unknown as EventBus, logger, noDefaultConfig);

        const result = await svc.delegate({ prompt: 'test' });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBeInstanceOf(BackbeatError);
        expect((result.error as BackbeatError).code).toBe(ErrorCode.INVALID_INPUT);
        expect(result.error.message).toContain('No agent specified');
      });

      it('should use config defaultAgent when task does not specify one', async () => {
        const geminiConfig = new ConfigFactory().withDefaultAgent('gemini').build();
        const svc = new TaskManagerService(eventBus as unknown as EventBus, logger, geminiConfig);

        const result = await svc.delegate({ prompt: 'test' });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.agent).toBe('gemini');
      });

      it('should prefer explicit task agent over config default', async () => {
        const claudeConfig = new ConfigFactory().withDefaultAgent('claude').build();
        const svc = new TaskManagerService(eventBus as unknown as EventBus, logger, claudeConfig);

        const result = await svc.delegate({ prompt: 'test', agent: 'codex' });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.agent).toBe('codex');
      });
    });

    describe('continueFrom handling', () => {
      it('should validate continueFrom task exists via event bus request', async () => {
        const existingTask = buildCompletedTask({
          id: TaskId('continue-task'),
        });
        eventBus.request.mockResolvedValue(ok(existingTask));

        const result = await service.delegate({
          prompt: 'continue work',
          continueFrom: TaskId('continue-task'),
        });

        expect(result.ok).toBe(true);
        expect(eventBus.request).toHaveBeenCalledWith('TaskStatusQuery', { taskId: TaskId('continue-task') });
      });

      it('should return error when continueFrom task not found', async () => {
        // Default mock returns ok(null) for request
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
        eventBus.request.mockResolvedValue(err(new BackbeatError(ErrorCode.SYSTEM_ERROR, 'query failed')));

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
        eventBus.request.mockResolvedValue(ok(existingTask));

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
        eventBus.request.mockResolvedValue(ok(existingTask));

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
        eventBus.request.mockResolvedValue(ok(existingTask));

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
      eventBus.request.mockResolvedValue(ok(task));

      const result = await service.getStatus(TaskId('status-1'));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect((result.value as Task).id).toBe(TaskId('status-1'));
      expect(eventBus.request).toHaveBeenCalledWith('TaskStatusQuery', {
        taskId: TaskId('status-1'),
      });
    });

    it('should return all tasks when no taskId provided', async () => {
      const tasks = [buildMockTask(), buildMockTask(), buildMockTask()];
      eventBus.request.mockResolvedValue(ok(tasks));

      const result = await service.getStatus();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(Array.isArray(result.value)).toBe(true);
      expect((result.value as readonly Task[]).length).toBe(3);
      expect(eventBus.request).toHaveBeenCalledWith('TaskStatusQuery', {
        taskId: undefined,
      });
    });

    it('should return error when task not found (null from query)', async () => {
      // Default mock returns ok(null)
      const result = await service.getStatus(TaskId('missing'));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(BackbeatError);
      expect((result.error as BackbeatError).code).toBe(ErrorCode.TASK_NOT_FOUND);
    });

    it('should propagate event bus errors', async () => {
      const busError = new BackbeatError(ErrorCode.SYSTEM_ERROR, 'query failed');
      eventBus.request.mockResolvedValue(err(busError));

      const result = await service.getStatus(TaskId('any'));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe(busError);
    });
  });

  // ---------------------------------------------------------------------------
  // getLogs()
  // ---------------------------------------------------------------------------
  describe('getLogs()', () => {
    it('should query logs via event bus', async () => {
      const output = {
        taskId: TaskId('logs-1'),
        stdout: ['line 1', 'line 2'],
        stderr: [],
        totalSize: 14,
      };
      eventBus.request.mockResolvedValue(ok(output));

      const result = await service.getLogs(TaskId('logs-1'));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.taskId).toBe(TaskId('logs-1'));
      expect(result.value.stdout).toEqual(['line 1', 'line 2']);
      expect(eventBus.request).toHaveBeenCalledWith('TaskLogsQuery', {
        taskId: TaskId('logs-1'),
        tail: undefined,
      });
    });

    it('should pass tail parameter to event bus query', async () => {
      eventBus.request.mockResolvedValue(ok({ taskId: TaskId('logs-1'), stdout: [], stderr: [], totalSize: 0 }));

      await service.getLogs(TaskId('logs-1'), 50);

      expect(eventBus.request).toHaveBeenCalledWith('TaskLogsQuery', {
        taskId: TaskId('logs-1'),
        tail: 50,
      });
    });

    it('should propagate event bus errors', async () => {
      const busError = new BackbeatError(ErrorCode.SYSTEM_ERROR, 'logs failed');
      eventBus.request.mockResolvedValue(err(busError));

      const result = await service.getLogs(TaskId('any'));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe(busError);
    });
  });

  // ---------------------------------------------------------------------------
  // cancel()
  // ---------------------------------------------------------------------------
  describe('cancel()', () => {
    it('should emit TaskCancellationRequested event', async () => {
      const result = await service.cancel(TaskId('cancel-1'));

      expect(result.ok).toBe(true);
      expect(eventBus.emit).toHaveBeenCalledWith('TaskCancellationRequested', {
        taskId: TaskId('cancel-1'),
        reason: undefined,
      });
    });

    it('should pass reason through to event', async () => {
      await service.cancel(TaskId('cancel-1'), 'user requested');

      expect(eventBus.emit).toHaveBeenCalledWith('TaskCancellationRequested', {
        taskId: TaskId('cancel-1'),
        reason: 'user requested',
      });
    });

    it('should return error when event emission fails', async () => {
      const emitError = new BackbeatError(ErrorCode.SYSTEM_ERROR, 'emit failed');
      eventBus.emit.mockResolvedValue(err(emitError));

      const result = await service.cancel(TaskId('cancel-1'));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe(emitError);
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
      eventBus.request.mockResolvedValue(ok(failedTask));

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
      eventBus.request.mockResolvedValue(ok(completedTask));

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
      eventBus.request.mockResolvedValue(ok(cancelledTask));

      const result = await service.retry(TaskId('cancelled-1'));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.retryOf).toBe(TaskId('cancelled-1'));
    });

    it('should reject retry for a running task', async () => {
      const runningTask = buildRunningTask({
        id: TaskId('running-1'),
      });
      eventBus.request.mockResolvedValue(ok(runningTask));

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
      eventBus.request.mockResolvedValue(ok(queuedTask));

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

    it('should propagate event bus query errors', async () => {
      eventBus.request.mockResolvedValue(err(new BackbeatError(ErrorCode.SYSTEM_ERROR, 'bus down')));

      const result = await service.retry(TaskId('any'));

      expect(result.ok).toBe(false);
    });

    it('should return error when TaskDelegated emission fails', async () => {
      const failedTask = buildFailedTask({ id: TaskId('fail-emit') });
      eventBus.request.mockResolvedValue(ok(failedTask));
      eventBus.emit.mockResolvedValue(err(new BackbeatError(ErrorCode.SYSTEM_ERROR, 'emit failed')));

      const result = await service.retry(TaskId('fail-emit'));

      expect(result.ok).toBe(false);
    });

    it('should emit TaskDelegated for the new retry task', async () => {
      const failedTask = buildFailedTask({ id: TaskId('f1') });
      eventBus.request.mockResolvedValue(ok(failedTask));

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
        // Original: task-A -> First retry: task-B (parentTaskId=task-A, retryCount=1)
        // Retrying task-B should produce parentTaskId=task-A (root), retryOf=task-B
        const firstRetry = buildFailedTask({
          id: TaskId('task-B'),
          parentTaskId: TaskId('task-A'),
          retryCount: 1,
          retryOf: TaskId('task-A'),
        });
        eventBus.request.mockResolvedValue(ok(firstRetry));

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
        // No parentTaskId set (undefined) -- first in chain
        eventBus.request.mockResolvedValue(ok(originalTask));

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
        eventBus.request.mockResolvedValue(ok(thirdRetry));

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
      svcWithCheckpoint = new TaskManagerService(eventBus as unknown as EventBus, logger, config, checkpointRepo);
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
      eventBus.request.mockResolvedValue(ok(running));

      const result = await svcWithCheckpoint.resume({
        taskId: TaskId('r1'),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect((result.error as BackbeatError).code).toBe(ErrorCode.INVALID_OPERATION);
    });

    it('should reject resume for a queued task', async () => {
      const queued = buildMockTask({ id: TaskId('q1'), status: TaskStatus.QUEUED });
      eventBus.request.mockResolvedValue(ok(queued));

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
      eventBus.request.mockResolvedValue(ok(failed));

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
      eventBus.request.mockResolvedValue(ok(failed));

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
      eventBus.request.mockResolvedValue(ok(failed));

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
      eventBus.request.mockResolvedValue(ok(failed));

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
      eventBus.request.mockResolvedValue(ok(failed));

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
      eventBus.request.mockResolvedValue(ok(failed));
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
      eventBus.request.mockResolvedValue(ok(failed));
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
      eventBus.request.mockResolvedValue(ok(failed));

      const result = await service.resume({ taskId: TaskId('no-repo') });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.prompt).toContain('task prompt');
    });

    it('should propagate event bus query errors', async () => {
      eventBus.request.mockResolvedValue(err(new BackbeatError(ErrorCode.SYSTEM_ERROR, 'query failed')));

      const result = await svcWithCheckpoint.resume({
        taskId: TaskId('any'),
      });

      expect(result.ok).toBe(false);
    });
  });
});
