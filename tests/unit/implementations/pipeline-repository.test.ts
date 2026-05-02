/**
 * Unit tests for SQLitePipelineRepository
 * ARCHITECTURE: Tests repository operations in isolation with in-memory database
 * Pattern: Behavior-driven testing with Result pattern validation
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createPipeline,
  type Pipeline,
  PipelineId,
  PipelineStatus,
  Priority,
  ScheduleId,
  TaskId,
} from '../../../src/core/domain.js';
import { Database } from '../../../src/implementations/database.js';
import { SQLitePipelineRepository } from '../../../src/implementations/pipeline-repository.js';

describe('SQLitePipelineRepository - Unit Tests', () => {
  let db: Database;
  let repo: SQLitePipelineRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    repo = new SQLitePipelineRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function buildPipeline(overrides: Partial<Pipeline> = {}): Pipeline {
    return createPipeline({
      steps: [
        { index: 0, prompt: 'Step one' },
        { index: 1, prompt: 'Step two' },
      ],
      ...overrides,
    });
  }

  // ============================================================================
  // save / findById
  // ============================================================================

  describe('save + findById', () => {
    it('saves and retrieves a pipeline by ID', async () => {
      const pipeline = buildPipeline();
      const saveResult = await repo.save(pipeline);
      expect(saveResult.ok).toBe(true);

      const findResult = await repo.findById(pipeline.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) throw new Error('findById failed');
      expect(findResult.value).not.toBeNull();
      expect(findResult.value!.id).toBe(pipeline.id);
      expect(findResult.value!.status).toBe(PipelineStatus.PENDING);
      expect(findResult.value!.steps).toHaveLength(2);
      expect(findResult.value!.steps[0].prompt).toBe('Step one');
    });

    it('returns null for unknown pipeline ID', async () => {
      const result = await repo.findById(PipelineId('nonexistent'));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('findById failed');
      expect(result.value).toBeNull();
    });

    it('persists optional fields', async () => {
      const pipeline = createPipeline({
        steps: [
          { index: 0, prompt: 'A' },
          { index: 1, prompt: 'B' },
        ],
        priority: Priority.P0,
        workingDirectory: '/workspace',
        agent: 'claude',
        model: 'claude-opus-4-5',
        systemPrompt: 'be precise',
        stepTaskIds: [TaskId('task-aaa'), null],
      });
      await repo.save(pipeline);

      const result = await repo.findById(pipeline.id);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error();
      const found = result.value!;
      expect(found.priority).toBe(Priority.P0);
      expect(found.workingDirectory).toBe('/workspace');
      expect(found.agent).toBe('claude');
      expect(found.model).toBe('claude-opus-4-5');
      expect(found.systemPrompt).toBe('be precise');
      expect(found.stepTaskIds[0]).toBe('task-aaa');
      expect(found.stepTaskIds[1]).toBeNull();
    });
  });

  // ============================================================================
  // update
  // ============================================================================

  describe('update', () => {
    it('updates pipeline status and updatedAt', async () => {
      const pipeline = buildPipeline();
      await repo.save(pipeline);

      const updated: Pipeline = {
        ...pipeline,
        status: PipelineStatus.RUNNING,
        updatedAt: Date.now() + 1000,
      };
      const updateResult = await repo.update(updated);
      expect(updateResult.ok).toBe(true);

      const found = await repo.findById(pipeline.id);
      expect(found.ok).toBe(true);
      if (!found.ok) throw new Error();
      expect(found.value!.status).toBe(PipelineStatus.RUNNING);
    });

    it('updates stepTaskIds', async () => {
      const pipeline = buildPipeline();
      await repo.save(pipeline);

      const taskId = TaskId('task-step0');
      const updated: Pipeline = {
        ...pipeline,
        stepTaskIds: [taskId, null],
        updatedAt: Date.now() + 1000,
      };
      await repo.update(updated);

      const found = await repo.findById(pipeline.id);
      expect(found.ok).toBe(true);
      if (!found.ok) throw new Error();
      expect(found.value!.stepTaskIds[0]).toBe(taskId);
    });
  });

  // ============================================================================
  // findAll
  // ============================================================================

  describe('findAll', () => {
    it('returns all pipelines ordered by createdAt DESC', async () => {
      const p1 = createPipeline({
        steps: [
          { index: 0, prompt: 'A' },
          { index: 1, prompt: 'B' },
        ],
      });
      const p2 = createPipeline({
        steps: [
          { index: 0, prompt: 'C' },
          { index: 1, prompt: 'D' },
        ],
      });
      await repo.save(p1);
      await repo.save(p2);

      const result = await repo.findAll();
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error();
      expect(result.value).toHaveLength(2);
    });

    it('respects limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await repo.save(
          createPipeline({
            steps: [
              { index: 0, prompt: `A${i}` },
              { index: 1, prompt: `B${i}` },
            ],
          }),
        );
      }

      const result = await repo.findAll(3);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error();
      expect(result.value).toHaveLength(3);
    });

    it('returns empty array when no pipelines', async () => {
      const result = await repo.findAll();
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error();
      expect(result.value).toHaveLength(0);
    });
  });

  // ============================================================================
  // findByStatus
  // ============================================================================

  describe('findByStatus', () => {
    it('returns only pipelines with matching status', async () => {
      const pending = buildPipeline();
      const running = { ...buildPipeline(), status: PipelineStatus.RUNNING, updatedAt: Date.now() };
      await repo.save(pending);
      await repo.save(running);

      const result = await repo.findByStatus(PipelineStatus.RUNNING);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error();
      expect(result.value).toHaveLength(1);
      expect(result.value[0].status).toBe(PipelineStatus.RUNNING);
    });

    it('returns empty array when no matching pipelines', async () => {
      const result = await repo.findByStatus(PipelineStatus.COMPLETED);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error();
      expect(result.value).toHaveLength(0);
    });
  });

  // ============================================================================
  // countByStatus
  // ============================================================================

  describe('countByStatus', () => {
    it('returns accurate counts per status', async () => {
      await repo.save(buildPipeline());
      await repo.save(buildPipeline());
      const running = { ...buildPipeline(), status: PipelineStatus.RUNNING, updatedAt: Date.now() };
      await repo.save(running);

      const result = await repo.countByStatus();
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error();
      expect(result.value['pending']).toBe(2);
      expect(result.value['running']).toBe(1);
    });

    it('returns empty object when no pipelines', async () => {
      const result = await repo.countByStatus();
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error();
      expect(Object.keys(result.value)).toHaveLength(0);
    });
  });

  // ============================================================================
  // findUpdatedSince
  // ============================================================================

  describe('findUpdatedSince', () => {
    it('returns pipelines updated at or after sinceMs', async () => {
      const old = createPipeline({
        steps: [
          { index: 0, prompt: 'old' },
          { index: 1, prompt: 'B' },
        ],
      });
      const fresh = createPipeline({
        steps: [
          { index: 0, prompt: 'fresh' },
          { index: 1, prompt: 'C' },
        ],
      });

      const oldTime = Date.now() - 10000;
      const freshTime = Date.now();

      await repo.save({ ...old, createdAt: oldTime, updatedAt: oldTime });
      await repo.save({ ...fresh, createdAt: freshTime, updatedAt: freshTime });

      const sinceMs = freshTime - 1;
      const result = await repo.findUpdatedSince(sinceMs, 10);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error();
      expect(result.value.some((p) => p.id === fresh.id)).toBe(true);
      expect(result.value.some((p) => p.id === old.id)).toBe(false);
    });
  });

  // ============================================================================
  // delete
  // ============================================================================

  describe('delete', () => {
    it('removes pipeline from store', async () => {
      const pipeline = buildPipeline();
      await repo.save(pipeline);

      const deleteResult = await repo.delete(pipeline.id);
      expect(deleteResult.ok).toBe(true);

      const found = await repo.findById(pipeline.id);
      expect(found.ok).toBe(true);
      if (!found.ok) throw new Error();
      expect(found.value).toBeNull();
    });

    it('returns ok for deleting non-existent pipeline (idempotent)', async () => {
      const result = await repo.delete(PipelineId('ghost'));
      expect(result.ok).toBe(true);
    });
  });

  // ============================================================================
  // findActiveByStepScheduleId
  // ============================================================================

  describe('findActiveByStepScheduleId', () => {
    it('returns active pipeline whose step carries the target scheduleId', async () => {
      const scheduleId = ScheduleId('sched-find-active');
      const pipeline = createPipeline({
        steps: [
          { index: 0, prompt: 'step 0', scheduleId },
          { index: 1, prompt: 'step 1' },
        ],
      });
      await repo.save({ ...pipeline, status: PipelineStatus.RUNNING });

      const result = await repo.findActiveByStepScheduleId(scheduleId);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error();
      expect(result.value).toHaveLength(1);
      expect(result.value[0].id).toBe(pipeline.id);
    });

    it('returns empty array when no active pipeline has the scheduleId', async () => {
      const scheduleId = ScheduleId('sched-no-match');
      const other = ScheduleId('sched-other');
      const pipeline = createPipeline({
        steps: [{ index: 0, prompt: 'step', scheduleId: other }],
      });
      await repo.save({ ...pipeline, status: PipelineStatus.RUNNING });

      const result = await repo.findActiveByStepScheduleId(scheduleId);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error();
      expect(result.value).toHaveLength(0);
    });

    it('does not return terminal (completed/failed/cancelled) pipelines', async () => {
      const scheduleId = ScheduleId('sched-terminal');
      const completedPipeline = createPipeline({
        steps: [{ index: 0, prompt: 'step', scheduleId }],
      });
      const failedPipeline = createPipeline({
        steps: [{ index: 0, prompt: 'step', scheduleId }],
      });
      const cancelledPipeline = createPipeline({
        steps: [{ index: 0, prompt: 'step', scheduleId }],
      });
      const runningPipeline = createPipeline({
        steps: [{ index: 0, prompt: 'step', scheduleId }],
      });

      await repo.save({ ...completedPipeline, status: PipelineStatus.COMPLETED });
      await repo.save({ ...failedPipeline, status: PipelineStatus.FAILED });
      await repo.save({ ...cancelledPipeline, status: PipelineStatus.CANCELLED });
      await repo.save({ ...runningPipeline, status: PipelineStatus.RUNNING });

      const result = await repo.findActiveByStepScheduleId(scheduleId);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error();
      // Only the running pipeline is active
      expect(result.value).toHaveLength(1);
      expect(result.value[0].id).toBe(runningPipeline.id);
    });

    it('handles multi-step pipelines correctly — matches on any step not just step 0', async () => {
      const scheduleId = ScheduleId('sched-middle-step');
      const pipeline = createPipeline({
        steps: [
          { index: 0, prompt: 'step 0' }, // no scheduleId
          { index: 1, prompt: 'step 1', scheduleId }, // target
          { index: 2, prompt: 'step 2' }, // no scheduleId
        ],
      });
      await repo.save({ ...pipeline, status: PipelineStatus.PENDING });

      const result = await repo.findActiveByStepScheduleId(scheduleId);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error();
      expect(result.value).toHaveLength(1);
      expect(result.value[0].id).toBe(pipeline.id);
    });
  });

  // ============================================================================
  // step round-trip integrity
  // ============================================================================

  describe('step round-trip', () => {
    it('preserves all step fields', async () => {
      const pipeline = createPipeline({
        steps: [
          {
            index: 0,
            prompt: 'Build feature',
            priority: Priority.P1,
            workingDirectory: '/src',
            agent: 'claude',
            model: 'claude-3-5-sonnet-20241022',
            systemPrompt: 'focus',
          },
          { index: 1, prompt: 'Run tests' },
        ],
      });
      await repo.save(pipeline);

      const found = await repo.findById(pipeline.id);
      expect(found.ok).toBe(true);
      if (!found.ok) throw new Error();
      const step0 = found.value!.steps[0];
      expect(step0.priority).toBe(Priority.P1);
      expect(step0.workingDirectory).toBe('/src');
      expect(step0.agent).toBe('claude');
      expect(step0.model).toBe('claude-3-5-sonnet-20241022');
      expect(step0.systemPrompt).toBe('focus');
    });
  });
});
