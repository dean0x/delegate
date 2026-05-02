/**
 * Unit tests for PipelineHandler
 * ARCHITECTURE: Real in-memory SQLite + InMemoryEventBus — no process spawning.
 * Pattern: Behavior-driven, testing observable pipeline status transitions.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createPipeline,
  createTask,
  type Pipeline,
  PipelineId,
  PipelineStatus,
  TaskId,
  TaskStatus,
} from '../../../../src/core/domain.js';
import { InMemoryEventBus } from '../../../../src/core/events/event-bus.js';
import { Database } from '../../../../src/implementations/database.js';
import { SQLitePipelineRepository } from '../../../../src/implementations/pipeline-repository.js';
import { SQLiteTaskRepository } from '../../../../src/implementations/task-repository.js';
import { PipelineHandler } from '../../../../src/services/handlers/pipeline-handler.js';
import { createTestConfiguration } from '../../../fixtures/factories.js';
import { TestLogger } from '../../../fixtures/test-doubles.js';
import { flushEventLoop } from '../../../utils/event-helpers.js';

describe('PipelineHandler', () => {
  let eventBus: InMemoryEventBus;
  let db: Database;
  let pipelineRepo: SQLitePipelineRepository;
  let taskRepo: SQLiteTaskRepository;
  let logger: TestLogger;

  beforeEach(async () => {
    logger = new TestLogger();
    const config = createTestConfiguration();
    eventBus = new InMemoryEventBus(config, logger);
    db = new Database(':memory:');
    pipelineRepo = new SQLitePipelineRepository(db);
    taskRepo = new SQLiteTaskRepository(db);

    const createResult = await PipelineHandler.create({
      pipelineRepository: pipelineRepo,
      taskRepository: taskRepo,
      eventBus,
      logger,
    });
    expect(createResult.ok).toBe(true);
  });

  afterEach(() => {
    eventBus.dispose();
    db.close();
  });

  // Helpers

  async function savePipelineWithTasks(taskIds: TaskId[], status = PipelineStatus.RUNNING): Promise<Pipeline> {
    const pipeline = createPipeline({
      steps: taskIds.map((_, i) => ({ index: i, prompt: `Step ${i}` })),
      stepTaskIds: taskIds,
    });
    const stored: Pipeline = { ...pipeline, status };
    await pipelineRepo.save(stored);

    for (const tid of taskIds) {
      const task = createTask({ prompt: 'step task' });
      await taskRepo.save({ ...task, id: tid });
    }

    return stored;
  }

  // ============================================================================
  // TaskCompleted — last step completing triggers PipelineCompleted
  // ============================================================================

  describe('TaskCompleted — all steps complete', () => {
    it('marks pipeline as COMPLETED when last step task completes', async () => {
      const taskId = TaskId('task-step-0');
      const pipeline = await savePipelineWithTasks([taskId]);

      // Mark the task as completed in the repo
      await taskRepo.update(taskId, { status: TaskStatus.COMPLETED });

      await eventBus.emit('TaskCompleted', { taskId, exitCode: 0, duration: 1000 });
      await flushEventLoop();

      const result = await pipelineRepo.findById(pipeline.id);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error();
      expect(result.value?.status).toBe(PipelineStatus.COMPLETED);
    });

    it('emits PipelineCompleted event', async () => {
      const completedPipelineIds: PipelineId[] = [];
      eventBus.on('PipelineCompleted', (evt) => {
        completedPipelineIds.push((evt as { pipelineId: PipelineId }).pipelineId);
      });

      const taskId = TaskId('task-step-x');
      await savePipelineWithTasks([taskId]);

      await taskRepo.update(taskId, { status: TaskStatus.COMPLETED });

      await eventBus.emit('TaskCompleted', { taskId, exitCode: 0, duration: 500 });
      await flushEventLoop();

      expect(completedPipelineIds).toHaveLength(1);
    });
  });

  // ============================================================================
  // TaskFailed — step failing triggers PipelineFailed
  // ============================================================================

  describe('TaskFailed — step fails', () => {
    it('marks pipeline as FAILED when a step task fails', async () => {
      const taskId = TaskId('task-fail-step');
      const pipeline = await savePipelineWithTasks([taskId]);

      await taskRepo.update(taskId, { status: TaskStatus.FAILED });

      const { AutobeatError, ErrorCode } = await import('../../../../src/core/errors.js');
      await eventBus.emit('TaskFailed', {
        taskId,
        error: new AutobeatError(ErrorCode.SYSTEM_ERROR, 'something broke'),
      });
      await flushEventLoop();

      const result = await pipelineRepo.findById(pipeline.id);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error();
      expect(result.value?.status).toBe(PipelineStatus.FAILED);
    });
  });

  // ============================================================================
  // TaskCancelled — step cancellation triggers PipelineCancelled
  // ============================================================================

  describe('TaskCancelled — step cancelled', () => {
    it('marks pipeline as CANCELLED when a step task is cancelled', async () => {
      const taskId = TaskId('task-cancel-step');
      const pipeline = await savePipelineWithTasks([taskId]);

      await taskRepo.update(taskId, { status: TaskStatus.CANCELLED });

      await eventBus.emit('TaskCancelled', { taskId, reason: 'user request' });
      await flushEventLoop();

      const result = await pipelineRepo.findById(pipeline.id);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error();
      expect(result.value?.status).toBe(PipelineStatus.CANCELLED);
    });
  });

  // ============================================================================
  // No pipeline — task with no pipeline association is a no-op
  // ============================================================================

  describe('tasks not associated with any pipeline', () => {
    it('does not error when task does not belong to any pipeline', async () => {
      const taskId = TaskId('unrelated-task');
      const task = createTask({ prompt: 'unrelated' });
      await taskRepo.save({ ...task, id: taskId });

      await eventBus.emit('TaskCompleted', { taskId, exitCode: 0, duration: 100 });
      await flushEventLoop();

      // No pipelines should exist
      const allPipelines = await pipelineRepo.findAll();
      expect(allPipelines.ok).toBe(true);
      if (!allPipelines.ok) throw new Error();
      expect(allPipelines.value).toHaveLength(0);
    });
  });

  // ============================================================================
  // ScheduleExecuted — populates stepTaskIds for matched step scheduleId
  // ============================================================================

  describe('ScheduleExecuted — populates stepTaskIds', () => {
    it('populates stepTaskIds slot when event carries taskId matching a step scheduleId', async () => {
      const scheduleId = 'sched-step-0' as import('../../../../src/core/domain.js').ScheduleId;
      const taskId = TaskId('task-from-sched');

      const pipeline = createPipeline({
        steps: [{ index: 0, prompt: 'step 0', scheduleId }],
        stepTaskIds: [null],
      });
      const stored: Pipeline = { ...pipeline, status: PipelineStatus.RUNNING };
      await pipelineRepo.save(stored);

      await eventBus.emit('ScheduleExecuted', {
        scheduleId,
        taskId,
        executedAt: Date.now(),
      });
      await flushEventLoop();

      const result = await pipelineRepo.findById(pipeline.id);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error();
      expect(result.value?.stepTaskIds[0]).toBe(taskId);
    });

    it('is a no-op when event has no taskId (loop trigger)', async () => {
      const scheduleId = 'sched-loop-trigger' as import('../../../../src/core/domain.js').ScheduleId;

      const pipeline = createPipeline({
        steps: [{ index: 0, prompt: 'step 0', scheduleId }],
        stepTaskIds: [null],
      });
      await pipelineRepo.save(pipeline);

      // ScheduleExecuted without taskId — loop trigger path
      await eventBus.emit('ScheduleExecuted', {
        scheduleId,
        // taskId deliberately omitted
        executedAt: Date.now(),
      });
      await flushEventLoop();

      const result = await pipelineRepo.findById(pipeline.id);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error();
      // stepTaskId must remain null — event was ignored
      expect(result.value?.stepTaskIds[0]).toBeNull();
    });

    it('is a no-op when no active pipeline has the scheduleId', async () => {
      const scheduleId = 'sched-unmatched' as import('../../../../src/core/domain.js').ScheduleId;
      const taskId = TaskId('task-unmatched');

      // Save a pipeline with a *different* scheduleId
      const otherScheduleId = 'sched-other' as import('../../../../src/core/domain.js').ScheduleId;
      const pipeline = createPipeline({
        steps: [{ index: 0, prompt: 'step 0', scheduleId: otherScheduleId }],
        stepTaskIds: [null],
      });
      await pipelineRepo.save(pipeline);

      await eventBus.emit('ScheduleExecuted', {
        scheduleId,
        taskId,
        executedAt: Date.now(),
      });
      await flushEventLoop();

      // Pipeline stepTaskIds should be unchanged
      const result = await pipelineRepo.findById(pipeline.id);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error();
      expect(result.value?.stepTaskIds[0]).toBeNull();
    });
  });

  // ============================================================================
  // PipelineStepCompleted — emitted when a step task successfully completes
  // ============================================================================

  describe('PipelineStepCompleted event', () => {
    it('emits PipelineStepCompleted with correct step index when step task completes', async () => {
      const capturedEvents: Array<{ pipelineId: PipelineId; stepIndex: number; taskId: TaskId }> = [];
      eventBus.on('PipelineStepCompleted', (evt) => {
        capturedEvents.push(evt as { pipelineId: PipelineId; stepIndex: number; taskId: TaskId });
      });

      const taskId0 = TaskId('task-step-evt-0');
      const taskId1 = TaskId('task-step-evt-1');
      const pipeline = await savePipelineWithTasks([taskId0, taskId1]);

      // Only step 0 completes — step 1 still queued
      await taskRepo.update(taskId0, { status: TaskStatus.COMPLETED });

      await eventBus.emit('TaskCompleted', { taskId: taskId0, exitCode: 0, duration: 300 });
      await flushEventLoop();

      expect(capturedEvents).toHaveLength(1);
      expect(capturedEvents[0].pipelineId).toBe(pipeline.id);
      expect(capturedEvents[0].stepIndex).toBe(0);
      expect(capturedEvents[0].taskId).toBe(taskId0);
    });

    it('does not emit PipelineStepCompleted when step task fails', async () => {
      const capturedEvents: unknown[] = [];
      eventBus.on('PipelineStepCompleted', (evt) => {
        capturedEvents.push(evt);
      });

      const taskId = TaskId('task-step-fail-evt');
      await savePipelineWithTasks([taskId]);

      await taskRepo.update(taskId, { status: TaskStatus.FAILED });

      const { AutobeatError, ErrorCode } = await import('../../../../src/core/errors.js');
      await eventBus.emit('TaskFailed', {
        taskId,
        error: new AutobeatError(ErrorCode.SYSTEM_ERROR, 'step failed'),
      });
      await flushEventLoop();

      expect(capturedEvents).toHaveLength(0);
    });
  });

  // ============================================================================
  // PipelineStatusChanged — emitted on every status transition
  // ============================================================================

  describe('PipelineStatusChanged event', () => {
    it('emits PipelineStatusChanged with correct fromStatus and toStatus on completion', async () => {
      const capturedEvents: Array<{
        pipelineId: PipelineId;
        fromStatus: PipelineStatus;
        toStatus: PipelineStatus;
      }> = [];
      eventBus.on('PipelineStatusChanged', (evt) => {
        capturedEvents.push(
          evt as {
            pipelineId: PipelineId;
            fromStatus: PipelineStatus;
            toStatus: PipelineStatus;
          },
        );
      });

      const taskId = TaskId('task-status-change');
      const pipeline = await savePipelineWithTasks([taskId]);

      await taskRepo.update(taskId, { status: TaskStatus.COMPLETED });

      await eventBus.emit('TaskCompleted', { taskId, exitCode: 0, duration: 100 });
      await flushEventLoop();

      expect(capturedEvents).toHaveLength(1);
      expect(capturedEvents[0].pipelineId).toBe(pipeline.id);
      expect(capturedEvents[0].fromStatus).toBe(PipelineStatus.RUNNING);
      expect(capturedEvents[0].toStatus).toBe(PipelineStatus.COMPLETED);
    });

    it('does not emit PipelineStatusChanged when status does not change', async () => {
      // A pipeline is RUNNING; a task from a different (unrelated) pipeline completes.
      // The running pipeline's task is still pending → status stays RUNNING → no event.
      const capturedEvents: unknown[] = [];
      eventBus.on('PipelineStatusChanged', (evt) => {
        capturedEvents.push(evt);
      });

      const taskIdRunning = TaskId('task-already-running');
      const taskIdOther = TaskId('task-unrelated-other');

      // Pipeline with two steps — step 0 in progress, step 1 null
      const runningPipeline = createPipeline({
        steps: [
          { index: 0, prompt: 'step 0' },
          { index: 1, prompt: 'step 1' },
        ],
        stepTaskIds: [taskIdRunning, null],
      });
      await pipelineRepo.save({ ...runningPipeline, status: PipelineStatus.RUNNING });

      const runningTask = createTask({ prompt: 'running step' });
      await taskRepo.save({ ...runningTask, id: taskIdRunning, status: TaskStatus.RUNNING });

      // Emit completed for a task NOT in this pipeline — no pipeline matches
      const otherTask = createTask({ prompt: 'other' });
      await taskRepo.save({ ...otherTask, id: taskIdOther });

      await taskRepo.update(taskIdOther, { status: TaskStatus.COMPLETED });
      await eventBus.emit('TaskCompleted', { taskId: taskIdOther, exitCode: 0, duration: 50 });
      await flushEventLoop();

      expect(capturedEvents).toHaveLength(0);
    });
  });

  // ============================================================================
  // Multi-step pipeline — partial completion does not complete pipeline
  // ============================================================================

  describe('multi-step pipeline', () => {
    it('stays running when only first step of two completes', async () => {
      const taskId0 = TaskId('task-multi-0');
      const taskId1 = TaskId('task-multi-1');
      const pipeline = await savePipelineWithTasks([taskId0, taskId1]);

      // Only task 0 completes — task 1 still queued
      await taskRepo.update(taskId0, { status: TaskStatus.COMPLETED });

      await eventBus.emit('TaskCompleted', { taskId: taskId0, exitCode: 0, duration: 500 });
      await flushEventLoop();

      const result = await pipelineRepo.findById(pipeline.id);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error();
      // Still running — second step pending (queued)
      expect(result.value?.status).toBe(PipelineStatus.RUNNING);
    });

    it('correctly aggregates status for a large pipeline (parallel lookups)', async () => {
      // Regression: updatePipelineStatus must correctly fetch all step statuses via parallel
      // Promise.all rather than serial N+1 queries. Uses a 5-step pipeline to exercise
      // the batch path: all-completed → COMPLETED, one-failed → FAILED.
      const taskIds = Array.from({ length: 5 }, (_, i) => TaskId(`task-large-${i}`));
      const pipeline = await savePipelineWithTasks(taskIds);

      // All five tasks complete
      for (const tid of taskIds) {
        await taskRepo.update(tid, { status: TaskStatus.COMPLETED });
      }

      await eventBus.emit('TaskCompleted', { taskId: taskIds[4], exitCode: 0, duration: 100 });
      await flushEventLoop();

      const completedResult = await pipelineRepo.findById(pipeline.id);
      expect(completedResult.ok).toBe(true);
      if (!completedResult.ok) throw new Error();
      expect(completedResult.value?.status).toBe(PipelineStatus.COMPLETED);
    });

    it('marks pipeline FAILED when one of many steps fails (parallel lookup path)', async () => {
      const taskIds = Array.from({ length: 4 }, (_, i) => TaskId(`task-fail-large-${i}`));
      const pipeline = await savePipelineWithTasks(taskIds);

      // Three complete, one fails
      await taskRepo.update(taskIds[0], { status: TaskStatus.COMPLETED });
      await taskRepo.update(taskIds[1], { status: TaskStatus.COMPLETED });
      await taskRepo.update(taskIds[2], { status: TaskStatus.COMPLETED });
      await taskRepo.update(taskIds[3], { status: TaskStatus.FAILED });

      const { AutobeatError, ErrorCode } = await import('../../../../src/core/errors.js');
      await eventBus.emit('TaskFailed', {
        taskId: taskIds[3],
        error: new AutobeatError(ErrorCode.SYSTEM_ERROR, 'step 4 failed'),
      });
      await flushEventLoop();

      const result = await pipelineRepo.findById(pipeline.id);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error();
      expect(result.value?.status).toBe(PipelineStatus.FAILED);
    });
  });
});
