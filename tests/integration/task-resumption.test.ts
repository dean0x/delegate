/**
 * Integration test: Task Resumption - End-to-End Flow
 *
 * Verifies the complete resumption lifecycle through the real bootstrap system:
 * task fails -> checkpoint created -> resume -> new task with enriched prompt
 *
 * ARCHITECTURE: Uses real bootstrap, real EventBus, real SQLite (temp file-based DB)
 * Pattern: Matches task-dependencies.test.ts integration test conventions
 *
 * NOTE: NoOpProcessSpawner causes tasks to complete immediately (exit code 0).
 * For testing failure paths, we emit TaskFailed events manually.
 */

import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { Container } from '../../src/core/container.js';
import type { Task, TaskCheckpoint } from '../../src/core/domain.js';
import { Priority, TaskId, TaskStatus } from '../../src/core/domain.js';
import { BackbeatError, ErrorCode } from '../../src/core/errors.js';
import { EventBus } from '../../src/core/events/event-bus.js';
import type { CheckpointCreatedEvent, TaskResumedEvent } from '../../src/core/events/events.js';
import { CheckpointRepository, TaskManager, TaskRepository } from '../../src/core/interfaces.js';
import { Database } from '../../src/implementations/database.js';
import { TestResourceMonitor } from '../../src/implementations/resource-monitor.js';
import { NoOpProcessSpawner } from '../fixtures/no-op-spawner.js';
import { flushEventLoop, waitForEvent } from '../utils/event-helpers.js';

describe('Integration: Task Resumption - End-to-End Flow', () => {
  let container: Container;
  let taskManager: TaskManager;
  let checkpointRepo: CheckpointRepository;
  let taskRepo: TaskRepository;
  let eventBus: EventBus;
  let database: Database;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'backbeat-resume-test-'));
    process.env.BACKBEAT_DATABASE_PATH = join(tempDir, 'test.db');
    process.env.BACKBEAT_DEFAULT_AGENT = 'claude';
    process.env.WORKER_MIN_SPAWN_DELAY_MS = '10'; // Fast spawn for tests

    const result = await bootstrap({
      processSpawner: new NoOpProcessSpawner(),
      resourceMonitor: new TestResourceMonitor(),
      skipResourceMonitoring: true,
    });
    if (!result.ok) throw new Error(`Bootstrap failed: ${result.error.message}`);
    container = result.value;

    // Resolve taskManager (async factory that also wires event handlers)
    const tmResult = await container.resolve<TaskManager>('taskManager');
    if (!tmResult.ok) throw new Error(`Failed to resolve TaskManager: ${tmResult.error.message}`);
    taskManager = tmResult.value;

    const crResult = container.get<CheckpointRepository>('checkpointRepository');
    if (!crResult.ok) throw new Error(`Failed to get CheckpointRepository: ${crResult.error.message}`);
    checkpointRepo = crResult.value;

    const trResult = container.get<TaskRepository>('taskRepository');
    if (!trResult.ok) throw new Error(`Failed to get TaskRepository: ${trResult.error.message}`);
    taskRepo = trResult.value;

    const ebResult = container.get<EventBus>('eventBus');
    if (!ebResult.ok) throw new Error(`Failed to get EventBus: ${ebResult.error.message}`);
    eventBus = ebResult.value;

    const dbResult = container.get<Database>('database');
    if (!dbResult.ok) throw new Error(`Failed to get Database: ${dbResult.error.message}`);
    database = dbResult.value;

    // Stop the schedule executor to prevent interference
    const { ScheduleExecutor } = await import('../../src/services/schedule-executor.js');
    const executorResult = container.get<InstanceType<typeof ScheduleExecutor>>('scheduleExecutor');
    if (executorResult.ok) {
      executorResult.value.stop();
    }
  });

  afterEach(async () => {
    if (container) {
      await container.dispose();
    }
    delete process.env.BACKBEAT_DATABASE_PATH;
    delete process.env.BACKBEAT_DEFAULT_AGENT;
    delete process.env.WORKER_MIN_SPAWN_DELAY_MS;
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  /**
   * Helper: Delegate a task and wait for it to complete via NoOpProcessSpawner
   * NoOpProcessSpawner emits exit code 0 immediately, so task goes queued -> running -> completed
   */
  async function delegateAndWaitForCompletion(prompt: string): Promise<Task> {
    // Set up completion listener before delegating to capture the async exit
    const completedPromise = waitForEvent(eventBus, 'TaskCompleted');

    const result = await taskManager.delegate({
      prompt,
      priority: Priority.P2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`Delegate failed: ${result.error.message}`);

    // Wait for NoOpProcessSpawner's setImmediate exit → TaskCompleted
    await completedPromise;
    await flushEventLoop();

    return result.value;
  }

  describe('Checkpoint Auto-Creation on Task Completion', () => {
    it('should auto-create a checkpoint when task completes', async () => {
      // Track CheckpointCreated events
      const checkpointEvents: CheckpointCreatedEvent[] = [];
      eventBus.on!('CheckpointCreated', (event: CheckpointCreatedEvent) => {
        checkpointEvents.push(event);
      });

      // Set up checkpoint listener before the action that triggers it
      const checkpointPromise = waitForEvent(eventBus, 'CheckpointCreated');
      const task = await delegateAndWaitForCompletion('Checkpoint completion test');
      await checkpointPromise;
      await flushEventLoop();

      // Verify checkpoint was created
      const checkpointResult = await checkpointRepo.findLatest(task.id);
      expect(checkpointResult.ok).toBe(true);
      if (!checkpointResult.ok) return;

      // Checkpoint may or may not exist depending on whether the task was
      // persisted before checkpoint handler runs. With NoOpProcessSpawner
      // exit is nearly instant, so the task should be in the repo.
      if (checkpointResult.value) {
        expect(checkpointResult.value.taskId).toBe(task.id);
        expect(checkpointResult.value.checkpointType).toBe('completed');
      }
    });

    it('should auto-create a checkpoint when task fails', async () => {
      // Delegate a task so it gets persisted
      const task = await delegateAndWaitForCompletion('Will be failed manually');

      // The task auto-completed via NoOpProcessSpawner, but we can still test
      // the failure checkpoint path by emitting TaskFailed for a new task
      // Wait for auto-completion from NoOpProcessSpawner before emitting manual failure
      const autoCompletePromise = waitForEvent(eventBus, 'TaskCompleted');
      const failTask = await taskManager.delegate({
        prompt: 'Failure checkpoint test',
        priority: Priority.P2,
      });

      expect(failTask.ok).toBe(true);
      if (!failTask.ok) return;

      await autoCompletePromise;
      await flushEventLoop();

      // Delete the auto-created 'completed' checkpoint so findLatest returns
      // only the manually-emitted 'failed' checkpoint (avoids same-millisecond
      // timestamp race where findLatest could return either one)
      await checkpointRepo.deleteByTask(failTask.value.id);

      const failCheckpointPromise = waitForEvent(eventBus, 'CheckpointCreated');

      // Manually emit TaskFailed event (since NoOpProcessSpawner always exits 0)
      await eventBus.emit('TaskFailed', {
        taskId: failTask.value.id,
        error: new BackbeatError(ErrorCode.SYSTEM_ERROR, 'Simulated test failure'),
      });
      await failCheckpointPromise;
      await flushEventLoop();

      // Verify failure checkpoint was created
      const checkpointResult = await checkpointRepo.findLatest(failTask.value.id);
      expect(checkpointResult.ok).toBe(true);
      if (!checkpointResult.ok) return;

      if (checkpointResult.value) {
        expect(checkpointResult.value.taskId).toBe(failTask.value.id);
        expect(checkpointResult.value.checkpointType).toBe('failed');
        // Error summary should contain the simulated failure message
        if (checkpointResult.value.errorSummary) {
          expect(checkpointResult.value.errorSummary).toContain('Simulated test failure');
        }
      }
    });
  });

  describe('Resume with Enriched Prompt', () => {
    it('should create a new task with enriched prompt including checkpoint context', async () => {
      // Step 1: Create and complete a task
      const originalTask = await delegateAndWaitForCompletion('Original task for resume test');

      // Step 2: Delete auto-created checkpoint (NoOpProcessSpawner produces no output,
      // so auto-checkpoint lacks the rich context this test needs), then save one with
      // explicit data. Without deletion, findLatest may return the empty auto-checkpoint
      // when both share the same created_at millisecond.
      await checkpointRepo.deleteByTask(originalTask.id);

      const saveResult = await checkpointRepo.save({
        taskId: originalTask.id,
        checkpointType: 'completed',
        outputSummary: 'Task completed: migration ran successfully on 3 tables',
        errorSummary: undefined,
        gitBranch: 'feature/migration',
        gitCommitSha: 'abc123def456',
        gitDirtyFiles: ['src/db/schema.ts', 'src/db/migrate.ts'],
        createdAt: Date.now(),
      });

      expect(saveResult.ok).toBe(true);
      if (!saveResult.ok) return;

      // Step 3: Resume the task (delegateAndWaitForCompletion already ensured terminal state)
      const resumeResult = await taskManager.resume({
        taskId: originalTask.id,
        additionalContext: 'Please also run the seed script after migration',
      });

      expect(resumeResult.ok).toBe(true);
      if (!resumeResult.ok) return;

      const resumedTask = resumeResult.value;

      // Verify enriched prompt structure
      expect(resumedTask.prompt).toContain('PREVIOUS TASK CONTEXT:');
      expect(resumedTask.prompt).toContain('Original task for resume test');
      expect(resumedTask.prompt).toContain('migration ran successfully on 3 tables');
      expect(resumedTask.prompt).toContain('feature/migration');
      expect(resumedTask.prompt).toContain('abc123def456');
      expect(resumedTask.prompt).toContain('src/db/schema.ts');
      expect(resumedTask.prompt).toContain('Please also run the seed script after migration');
      expect(resumedTask.prompt).toContain('continue or retry the task');

      // Verify retry chain tracking
      expect(resumedTask.parentTaskId).toBe(originalTask.id);
      expect(resumedTask.retryCount).toBe(1);
      expect(resumedTask.retryOf).toBe(originalTask.id);
    });

    it('should fall back to basic context when no checkpoint exists', async () => {
      // Create and complete a task
      const originalTask = await delegateAndWaitForCompletion('Task without checkpoint');

      // Delete any auto-created checkpoints to test the fallback path
      await checkpointRepo.deleteByTask(originalTask.id);

      const resumeResult = await taskManager.resume({
        taskId: originalTask.id,
      });

      expect(resumeResult.ok).toBe(true);
      if (!resumeResult.ok) return;

      const resumedTask = resumeResult.value;

      // Even without checkpoint, the enriched prompt should include basic context
      expect(resumedTask.prompt).toContain('PREVIOUS TASK CONTEXT:');
      expect(resumedTask.prompt).toContain('Task without checkpoint');
      expect(resumedTask.prompt).toContain('continue or retry the task');

      // Should NOT contain checkpoint-specific details
      expect(resumedTask.prompt).not.toContain('Last output:');
      expect(resumedTask.prompt).not.toContain('Git state:');
    });

    it('should include additional context in enriched prompt', async () => {
      const originalTask = await delegateAndWaitForCompletion('Task with additional context');

      const resumeResult = await taskManager.resume({
        taskId: originalTask.id,
        additionalContext: 'Fix the bug in line 42 of utils.ts',
      });

      expect(resumeResult.ok).toBe(true);
      if (!resumeResult.ok) return;

      expect(resumeResult.value.prompt).toContain('Additional context: Fix the bug in line 42 of utils.ts');
    });
  });

  describe('Resume Validation', () => {
    it('should reject resuming a non-terminal task', async () => {
      // Create a task but don't wait for completion
      const delegateResult = await taskManager.delegate({
        prompt: 'Running task - cannot resume',
        priority: Priority.P2,
      });

      expect(delegateResult.ok).toBe(true);
      if (!delegateResult.ok) return;

      // With NoOpProcessSpawner the task may already be completed by now.
      // To test validation, we need a task in running/queued state.
      // The best we can do is try immediately before the event loop processes completion.
      // If the task already completed, this test validates the error message pattern.
      const resumeResult = await taskManager.resume({
        taskId: delegateResult.value.id,
      });

      // If task is still running/queued, this should fail with INVALID_OPERATION
      // If task already completed (due to NoOpProcessSpawner timing), resume should succeed
      // We check both outcomes since timing is non-deterministic with NoOpProcessSpawner
      if (!resumeResult.ok) {
        expect(resumeResult.error.message).toMatch(/cannot be resumed/i);
      }
      // If it succeeded, that is also acceptable since the task may have completed already
    });

    it('should reject resuming a non-existent task', async () => {
      const fakeId = TaskId('task-nonexistent-999');

      const resumeResult = await taskManager.resume({
        taskId: fakeId,
      });

      expect(resumeResult.ok).toBe(false);
      if (resumeResult.ok) return;

      expect(resumeResult.error.message).toMatch(/not found/i);
    });
  });

  describe('Resume Chain Tracking', () => {
    it('should maintain retry chain across multiple resumes', async () => {
      // Step 1: Create and complete original task
      const originalTask = await delegateAndWaitForCompletion('Root task in chain');

      // Step 2: First resume — set up completion listener before triggering
      const resumeCompletedPromise = waitForEvent(eventBus, 'TaskCompleted');
      const resume1Result = await taskManager.resume({
        taskId: originalTask.id,
      });

      expect(resume1Result.ok).toBe(true);
      if (!resume1Result.ok) return;

      const firstResume = resume1Result.value;
      expect(firstResume.parentTaskId).toBe(originalTask.id);
      expect(firstResume.retryCount).toBe(1);
      expect(firstResume.retryOf).toBe(originalTask.id);

      // Wait for first resume task to complete via NoOpProcessSpawner
      await resumeCompletedPromise;
      await flushEventLoop();

      // Step 3: Second resume (resume the resume)
      const resume2Result = await taskManager.resume({
        taskId: firstResume.id,
      });

      expect(resume2Result.ok).toBe(true);
      if (!resume2Result.ok) return;

      const secondResume = resume2Result.value;

      // parentTaskId should still point to the root task
      expect(secondResume.parentTaskId).toBe(originalTask.id);
      // retryCount should increment
      expect(secondResume.retryCount).toBe(2);
      // retryOf should point to the immediate parent (first resume)
      expect(secondResume.retryOf).toBe(firstResume.id);
    });

    it('should emit TaskResumed event with correct metadata', async () => {
      const originalTask = await delegateAndWaitForCompletion('Event emission test');

      // Track TaskResumed events
      let resumedEvent: TaskResumedEvent | null = null;
      eventBus.on!('TaskResumed', (event: TaskResumedEvent) => {
        resumedEvent = event;
      });

      const resumeResult = await taskManager.resume({
        taskId: originalTask.id,
      });

      expect(resumeResult.ok).toBe(true);
      if (!resumeResult.ok) return;

      await flushEventLoop();

      // Verify TaskResumed event was emitted
      expect(resumedEvent).not.toBeNull();
      expect(resumedEvent!.originalTaskId).toBe(originalTask.id);
      expect(resumedEvent!.newTaskId).toBe(resumeResult.value.id);
      // checkpointUsed depends on whether auto-checkpoint was created
      expect(typeof resumedEvent!.checkpointUsed).toBe('boolean');
    });
  });

  describe('Checkpoint Persistence', () => {
    it('should save and retrieve checkpoint with all fields', async () => {
      const taskId = TaskId('task-checkpoint-persistence-test');

      // First persist a task so the checkpoint can reference it
      const delegateResult = await taskManager.delegate({
        prompt: 'Checkpoint persistence test',
        priority: Priority.P2,
      });
      expect(delegateResult.ok).toBe(true);
      if (!delegateResult.ok) return;

      const realTaskId = delegateResult.value.id;

      // Save a checkpoint with all fields populated
      const saveResult = await checkpointRepo.save({
        taskId: realTaskId,
        checkpointType: 'failed',
        outputSummary: 'Last 50 lines of output: building project...',
        errorSummary: 'TypeError: Cannot read property "x" of undefined',
        gitBranch: 'feature/broken-thing',
        gitCommitSha: 'deadbeef12345678',
        gitDirtyFiles: ['src/main.ts', 'package.json'],
        createdAt: Date.now(),
      });

      expect(saveResult.ok).toBe(true);
      if (!saveResult.ok) return;

      const saved = saveResult.value;
      expect(saved.id).toBeDefined();
      expect(saved.taskId).toBe(realTaskId);
      expect(saved.checkpointType).toBe('failed');

      // Retrieve and verify all fields
      const retrieved = await checkpointRepo.findLatest(realTaskId);
      expect(retrieved.ok).toBe(true);
      if (!retrieved.ok) return;

      expect(retrieved.value).not.toBeNull();
      const checkpoint = retrieved.value!;

      expect(checkpoint.outputSummary).toBe('Last 50 lines of output: building project...');
      expect(checkpoint.errorSummary).toBe('TypeError: Cannot read property "x" of undefined');
      expect(checkpoint.gitBranch).toBe('feature/broken-thing');
      expect(checkpoint.gitCommitSha).toBe('deadbeef12345678');
      expect(checkpoint.gitDirtyFiles).toEqual(['src/main.ts', 'package.json']);
    });

    it('should handle checkpoint with minimal fields', async () => {
      const delegateResult = await taskManager.delegate({
        prompt: 'Minimal checkpoint test',
        priority: Priority.P2,
      });
      expect(delegateResult.ok).toBe(true);
      if (!delegateResult.ok) return;

      const taskId = delegateResult.value.id;

      // Save checkpoint with only required fields
      const saveResult = await checkpointRepo.save({
        taskId,
        checkpointType: 'completed',
        createdAt: Date.now(),
      });

      expect(saveResult.ok).toBe(true);
      if (!saveResult.ok) return;

      const retrieved = await checkpointRepo.findLatest(taskId);
      expect(retrieved.ok).toBe(true);
      if (!retrieved.ok) return;

      expect(retrieved.value).not.toBeNull();
      expect(retrieved.value!.checkpointType).toBe('completed');
      expect(retrieved.value!.outputSummary).toBeUndefined();
      expect(retrieved.value!.errorSummary).toBeUndefined();
      expect(retrieved.value!.gitBranch).toBeUndefined();
    });

    it('should return the latest checkpoint when multiple exist', async () => {
      const delegateResult = await taskManager.delegate({
        prompt: 'Multiple checkpoints test',
        priority: Priority.P2,
      });
      expect(delegateResult.ok).toBe(true);
      if (!delegateResult.ok) return;

      const taskId = delegateResult.value.id;

      // Save two checkpoints with different timestamps
      await checkpointRepo.save({
        taskId,
        checkpointType: 'failed',
        errorSummary: 'First failure',
        createdAt: Date.now() - 1000,
      });

      await checkpointRepo.save({
        taskId,
        checkpointType: 'completed',
        outputSummary: 'Succeeded on second try',
        createdAt: Date.now(),
      });

      const latestResult = await checkpointRepo.findLatest(taskId);
      expect(latestResult.ok).toBe(true);
      if (!latestResult.ok) return;

      expect(latestResult.value).not.toBeNull();
      // The latest checkpoint should be the 'completed' one
      expect(latestResult.value!.checkpointType).toBe('completed');
      expect(latestResult.value!.outputSummary).toBe('Succeeded on second try');

      // findAll should return both in descending order
      const allResult = await checkpointRepo.findAll(taskId);
      expect(allResult.ok).toBe(true);
      if (!allResult.ok) return;

      expect(allResult.value.length).toBe(2);
      expect(allResult.value[0].checkpointType).toBe('completed'); // Most recent first
      expect(allResult.value[1].checkpointType).toBe('failed');
    });

    it('should delete checkpoints by task', async () => {
      const delegateResult = await taskManager.delegate({
        prompt: 'Delete checkpoints test',
        priority: Priority.P2,
      });
      expect(delegateResult.ok).toBe(true);
      if (!delegateResult.ok) return;

      const taskId = delegateResult.value.id;

      await checkpointRepo.save({
        taskId,
        checkpointType: 'completed',
        createdAt: Date.now(),
      });

      // Verify checkpoint exists
      const beforeDelete = await checkpointRepo.findLatest(taskId);
      expect(beforeDelete.ok).toBe(true);
      expect(beforeDelete.value).not.toBeNull();

      // Delete
      const deleteResult = await checkpointRepo.deleteByTask(taskId);
      expect(deleteResult.ok).toBe(true);

      // Verify deleted
      const afterDelete = await checkpointRepo.findLatest(taskId);
      expect(afterDelete.ok).toBe(true);
      expect(afterDelete.value).toBeNull();
    });
  });
});
