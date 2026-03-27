/**
 * Unit tests for CheckpointHandler
 * ARCHITECTURE: Tests event-driven checkpoint creation on task terminal events
 * Pattern: Behavior-driven testing with real event bus and in-memory database
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../../../src/core/domain';
import { createTask, TaskId } from '../../../../src/core/domain';
import { AutobeatError, ErrorCode } from '../../../../src/core/errors';
import { InMemoryEventBus } from '../../../../src/core/events/event-bus';
import { err, ok } from '../../../../src/core/result';
import { SQLiteCheckpointRepository } from '../../../../src/implementations/checkpoint-repository';
import { Database } from '../../../../src/implementations/database';
import { SQLiteTaskRepository } from '../../../../src/implementations/task-repository';
import { CheckpointHandler } from '../../../../src/services/handlers/checkpoint-handler';
import { createTestConfiguration } from '../../../fixtures/factories';
import { TestLogger, TestOutputCapture } from '../../../fixtures/test-doubles';
import { flushEventLoop } from '../../../utils/event-helpers';

// Mock captureGitState to avoid real git commands
vi.mock('../../../../src/utils/git-state', () => ({
  captureGitState: vi.fn().mockResolvedValue(
    ok({
      branch: 'main',
      commitSha: 'abc123',
      dirtyFiles: ['file1.ts'],
    }),
  ),
}));

import { captureGitState } from '../../../../src/utils/git-state';

const mockCaptureGitState = vi.mocked(captureGitState);

/**
 * Helper to create a task with a known working directory
 * Uses createTask (frozen object) and references the generated ID
 */
function buildTask(overrides?: { workingDirectory?: string }): Task {
  return createTask({
    prompt: 'test prompt',
    workingDirectory: overrides?.workingDirectory ?? '/workspace',
  });
}

describe('CheckpointHandler - Behavioral Tests', () => {
  let handler: CheckpointHandler;
  let eventBus: InMemoryEventBus;
  let checkpointRepo: SQLiteCheckpointRepository;
  let taskRepo: SQLiteTaskRepository;
  let outputCapture: TestOutputCapture;
  let logger: TestLogger;
  let db: Database;

  beforeEach(async () => {
    logger = new TestLogger();
    const config = createTestConfiguration();
    eventBus = new InMemoryEventBus(config, logger);

    db = new Database(':memory:');
    checkpointRepo = new SQLiteCheckpointRepository(db);
    taskRepo = new SQLiteTaskRepository(db);
    outputCapture = new TestOutputCapture();

    // Reset the mock before each test
    mockCaptureGitState.mockResolvedValue(
      ok({
        branch: 'main',
        commitSha: 'abc123',
        dirtyFiles: ['file1.ts'],
      }),
    );

    // Create handler using factory pattern
    const handlerResult = await CheckpointHandler.create({ checkpointRepo, outputCapture, taskRepo, eventBus, logger });

    if (!handlerResult.ok) {
      throw new Error(`Failed to create CheckpointHandler: ${handlerResult.error.message}`);
    }
    handler = handlerResult.value;
  });

  afterEach(() => {
    eventBus.dispose();
    db.close();
    vi.clearAllMocks();
  });

  // ============================================================================
  // Factory and initialization
  // ============================================================================

  describe('Factory create()', () => {
    it('should create handler and subscribe to TaskCompleted, TaskFailed, and TaskCancelled events', async () => {
      // Arrange
      const freshLogger = new TestLogger();
      const freshConfig = createTestConfiguration();
      const freshEventBus = new InMemoryEventBus(freshConfig, freshLogger);

      // Act
      const result = await CheckpointHandler.create({
        checkpointRepo,
        outputCapture,
        taskRepo,
        eventBus: freshEventBus,
        logger: freshLogger,
      });

      // Assert
      expect(result.ok).toBe(true);
      expect(freshLogger.hasLogContaining('CheckpointHandler initialized')).toBe(true);

      // Cleanup
      freshEventBus.dispose();
    });
  });

  // ============================================================================
  // TaskCompleted event handling
  // ============================================================================

  describe('on TaskCompleted', () => {
    it('should create a checkpoint with type completed and capture output and git state', async () => {
      // Arrange
      const task = buildTask();
      await taskRepo.save(task);

      outputCapture.capture(task.id, 'stdout', 'Build succeeded');

      // Act
      await eventBus.emit('TaskCompleted', {
        taskId: task.id,
        exitCode: 0,
        duration: 5000,
      });
      await flushEventLoop();

      // Assert - checkpoint was saved in the repository
      const checkpoint = await checkpointRepo.findLatest(task.id);
      expect(checkpoint.ok).toBe(true);
      if (!checkpoint.ok) return;

      expect(checkpoint.value).not.toBeNull();
      expect(checkpoint.value!.taskId).toBe(task.id);
      expect(checkpoint.value!.checkpointType).toBe('completed');
      expect(checkpoint.value!.outputSummary).toBe('Build succeeded');
      expect(checkpoint.value!.gitBranch).toBe('main');
      expect(checkpoint.value!.gitCommitSha).toBe('abc123');
      expect(checkpoint.value!.gitDirtyFiles).toEqual(['file1.ts']);
    });

    it('should emit CheckpointCreated event after saving', async () => {
      // Arrange
      const task = buildTask();
      await taskRepo.save(task);

      // Act
      await eventBus.emit('TaskCompleted', {
        taskId: task.id,
        exitCode: 0,
        duration: 1000,
      });
      await flushEventLoop();

      // Assert - verify CheckpointCreated was logged
      expect(logger.hasLogContaining('Checkpoint created')).toBe(true);
    });
  });

  // ============================================================================
  // TaskFailed event handling
  // ============================================================================

  describe('on TaskFailed', () => {
    it('should create a checkpoint with type failed and include error message', async () => {
      // Arrange
      const task = buildTask();
      await taskRepo.save(task);

      // Act
      await eventBus.emit('TaskFailed', {
        taskId: task.id,
        error: new AutobeatError(ErrorCode.SYSTEM_ERROR, 'Process exited with code 1'),
        exitCode: 1,
      });
      await flushEventLoop();

      // Assert
      const checkpoint = await checkpointRepo.findLatest(task.id);
      expect(checkpoint.ok).toBe(true);
      if (!checkpoint.ok) return;

      expect(checkpoint.value).not.toBeNull();
      expect(checkpoint.value!.checkpointType).toBe('failed');
      expect(checkpoint.value!.errorSummary).toBe('Process exited with code 1');
    });

    it('should prefer stderr output over event error message for errorSummary', async () => {
      // Arrange
      const task = buildTask();
      await taskRepo.save(task);

      outputCapture.capture(task.id, 'stderr', 'Detailed stack trace line 1');

      // Act
      await eventBus.emit('TaskFailed', {
        taskId: task.id,
        error: new AutobeatError(ErrorCode.SYSTEM_ERROR, 'Generic failure'),
        exitCode: 1,
      });
      await flushEventLoop();

      // Assert - stderr should take priority over event error message
      const checkpoint = await checkpointRepo.findLatest(task.id);
      expect(checkpoint.ok).toBe(true);
      if (!checkpoint.ok) return;

      expect(checkpoint.value!.errorSummary).toBe('Detailed stack trace line 1');
    });
  });

  // ============================================================================
  // TaskCancelled event handling
  // ============================================================================

  describe('on TaskCancelled', () => {
    it('should create a checkpoint with type cancelled and include cancellation reason', async () => {
      // Arrange
      const task = buildTask();
      await taskRepo.save(task);

      // Act
      await eventBus.emit('TaskCancelled', {
        taskId: task.id,
        reason: 'User requested cancellation',
      });
      await flushEventLoop();

      // Assert
      const checkpoint = await checkpointRepo.findLatest(task.id);
      expect(checkpoint.ok).toBe(true);
      if (!checkpoint.ok) return;

      expect(checkpoint.value).not.toBeNull();
      expect(checkpoint.value!.checkpointType).toBe('cancelled');
      expect(checkpoint.value!.errorSummary).toBe('User requested cancellation');
    });

    it('should create checkpoint without errorSummary when no reason provided', async () => {
      // Arrange
      const task = buildTask();
      await taskRepo.save(task);

      // Act
      await eventBus.emit('TaskCancelled', {
        taskId: task.id,
      });
      await flushEventLoop();

      // Assert
      const checkpoint = await checkpointRepo.findLatest(task.id);
      expect(checkpoint.ok).toBe(true);
      if (!checkpoint.ok) return;

      expect(checkpoint.value).not.toBeNull();
      expect(checkpoint.value!.checkpointType).toBe('cancelled');
      expect(checkpoint.value!.errorSummary).toBeUndefined();
    });
  });

  // ============================================================================
  // Missing task handling
  // ============================================================================

  describe('missing task handling', () => {
    it('should return ok when task is not found (graceful degradation)', async () => {
      // Act - emit event for a task that does not exist in the repository
      const ghostId = TaskId('ghost-task');
      await eventBus.emit('TaskCompleted', {
        taskId: ghostId,
        exitCode: 0,
        duration: 1000,
      });
      await flushEventLoop();

      // Assert - handler logs a warning but does not fail
      expect(logger.hasLog('warn', 'Task not found for checkpoint creation')).toBe(true);

      // No checkpoint should be created
      const checkpoint = await checkpointRepo.findLatest(ghostId);
      expect(checkpoint.ok).toBe(true);
      if (!checkpoint.ok) return;
      expect(checkpoint.value).toBeNull();
    });
  });

  // ============================================================================
  // Output truncation
  // ============================================================================

  describe('output truncation', () => {
    it('should truncate output summary to MAX_SUMMARY_LENGTH (2000 chars)', async () => {
      // Arrange
      const task = buildTask();
      await taskRepo.save(task);

      // Create output larger than 2000 characters
      const longOutput = 'X'.repeat(3000);
      outputCapture.capture(task.id, 'stdout', longOutput);

      // Act
      await eventBus.emit('TaskCompleted', {
        taskId: task.id,
        exitCode: 0,
        duration: 1000,
      });
      await flushEventLoop();

      // Assert
      const checkpoint = await checkpointRepo.findLatest(task.id);
      expect(checkpoint.ok).toBe(true);
      if (!checkpoint.ok) return;

      expect(checkpoint.value).not.toBeNull();
      // The handler truncates from the end (takes the last 2000 chars)
      expect(checkpoint.value!.outputSummary!.length).toBe(2000);
    });

    it('should truncate error summary to MAX_SUMMARY_LENGTH', async () => {
      // Arrange
      const task = buildTask();
      await taskRepo.save(task);

      const longError = 'E'.repeat(3000);
      outputCapture.capture(task.id, 'stderr', longError);

      // Act
      await eventBus.emit('TaskFailed', {
        taskId: task.id,
        error: new AutobeatError(ErrorCode.SYSTEM_ERROR, 'Short error message'),
        exitCode: 1,
      });
      await flushEventLoop();

      // Assert
      const checkpoint = await checkpointRepo.findLatest(task.id);
      expect(checkpoint.ok).toBe(true);
      if (!checkpoint.ok) return;

      expect(checkpoint.value).not.toBeNull();
      expect(checkpoint.value!.errorSummary!.length).toBe(2000);
    });
  });

  // ============================================================================
  // Git state capture skipping
  // ============================================================================

  describe('git state capture', () => {
    it('should skip git state capture when task has no workingDirectory', async () => {
      // Arrange - create task without workingDirectory
      const task = createTask({ prompt: 'no workdir task' });
      await taskRepo.save(task);

      // Act
      await eventBus.emit('TaskCompleted', {
        taskId: task.id,
        exitCode: 0,
        duration: 1000,
      });
      await flushEventLoop();

      // Assert
      expect(mockCaptureGitState).not.toHaveBeenCalled();

      const checkpoint = await checkpointRepo.findLatest(task.id);
      expect(checkpoint.ok).toBe(true);
      if (!checkpoint.ok) return;

      expect(checkpoint.value).not.toBeNull();
      expect(checkpoint.value!.gitBranch).toBeUndefined();
      expect(checkpoint.value!.gitCommitSha).toBeUndefined();
      expect(checkpoint.value!.gitDirtyFiles).toBeUndefined();
    });

    it('should handle git state capture failure gracefully', async () => {
      // Arrange
      mockCaptureGitState.mockResolvedValue(err(new AutobeatError(ErrorCode.SYSTEM_ERROR, 'git not available')));

      const task = buildTask();
      await taskRepo.save(task);

      // Act
      await eventBus.emit('TaskCompleted', {
        taskId: task.id,
        exitCode: 0,
        duration: 1000,
      });
      await flushEventLoop();

      // Assert - checkpoint should still be created without git state
      const checkpoint = await checkpointRepo.findLatest(task.id);
      expect(checkpoint.ok).toBe(true);
      if (!checkpoint.ok) return;

      expect(checkpoint.value).not.toBeNull();
      expect(checkpoint.value!.gitBranch).toBeUndefined();
      expect(checkpoint.value!.gitCommitSha).toBeUndefined();
      expect(checkpoint.value!.gitDirtyFiles).toBeUndefined();

      // Should log a warning about the git failure
      expect(logger.hasLogContaining('Failed to capture git state')).toBe(true);
    });

    it('should handle captureGitState returning null (not a git repo)', async () => {
      // Arrange
      mockCaptureGitState.mockResolvedValue(ok(null));

      const task = buildTask();
      await taskRepo.save(task);

      // Act
      await eventBus.emit('TaskCompleted', {
        taskId: task.id,
        exitCode: 0,
        duration: 1000,
      });
      await flushEventLoop();

      // Assert - checkpoint should still be created, no git state
      const checkpoint = await checkpointRepo.findLatest(task.id);
      expect(checkpoint.ok).toBe(true);
      if (!checkpoint.ok) return;

      expect(checkpoint.value).not.toBeNull();
      expect(checkpoint.value!.gitBranch).toBeUndefined();
    });
  });

  // ============================================================================
  // Task repo error handling
  // ============================================================================

  describe('task repository error handling', () => {
    it('should handle task repository findById failure', async () => {
      // Arrange - spy on findById to simulate failure
      const findByIdSpy = vi
        .spyOn(taskRepo, 'findById')
        .mockResolvedValue(err(new AutobeatError(ErrorCode.SYSTEM_ERROR, 'Database connection lost')));

      // Act
      const ghostId = TaskId('task-repo-err');
      await eventBus.emit('TaskCompleted', {
        taskId: ghostId,
        exitCode: 0,
        duration: 1000,
      });
      await flushEventLoop();

      // Assert - handler logs error but does not crash
      expect(logger.hasLogContaining('Failed to fetch task for checkpoint')).toBe(true);

      // Restore spy so findLatest works
      findByIdSpy.mockRestore();

      // No checkpoint should be created
      const checkpoint = await checkpointRepo.findLatest(ghostId);
      expect(checkpoint.ok).toBe(true);
      if (!checkpoint.ok) return;
      expect(checkpoint.value).toBeNull();
    });
  });
});
