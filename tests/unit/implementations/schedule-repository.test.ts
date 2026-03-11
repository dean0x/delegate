/**
 * Unit tests for SQLiteScheduleRepository
 * ARCHITECTURE: Tests repository operations in isolation with in-memory database
 * Pattern: Behavior-driven testing with Result pattern validation
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Schedule } from '../../../src/core/domain.js';
import { createSchedule, MissedRunPolicy, ScheduleId, ScheduleStatus, ScheduleType, TaskId } from '../../../src/core/domain.js';
import { Database } from '../../../src/implementations/database.js';
import { SQLiteScheduleRepository } from '../../../src/implementations/schedule-repository.js';

describe('SQLiteScheduleRepository - Unit Tests', () => {
  let db: Database;
  let repo: SQLiteScheduleRepository;

  beforeEach(() => {
    // Use in-memory database for tests - real SQLite, no file I/O
    db = new Database(':memory:');
    repo = new SQLiteScheduleRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  // Helper to create a schedule
  function createTestSchedule(overrides: Partial<Parameters<typeof createSchedule>[0]> = {}) {
    return createSchedule({
      taskTemplate: {
        prompt: 'Test scheduled task',
        workingDirectory: '/tmp',
      },
      scheduleType: ScheduleType.CRON,
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      missedRunPolicy: MissedRunPolicy.SKIP,
      ...overrides,
    });
  }

  describe('save()', () => {
    it('should successfully save a schedule', async () => {
      const schedule = createTestSchedule();
      const result = await repo.save(schedule);

      expect(result.ok).toBe(true);
    });

    it('should persist all schedule fields', async () => {
      const schedule = createTestSchedule({
        maxRuns: 10,
        expiresAt: Date.now() + 86400000,
      });

      await repo.save(schedule);
      const findResult = await repo.findById(schedule.id);

      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      const found = findResult.value!;
      expect(found.id).toBe(schedule.id);
      expect(found.scheduleType).toBe(ScheduleType.CRON);
      expect(found.cronExpression).toBe('0 9 * * *');
      expect(found.timezone).toBe('UTC');
      expect(found.missedRunPolicy).toBe(MissedRunPolicy.SKIP);
      expect(found.status).toBe(ScheduleStatus.ACTIVE);
      expect(found.maxRuns).toBe(10);
      expect(found.runCount).toBe(0);
      expect(found.taskTemplate.prompt).toBe('Test scheduled task');
    });

    it('should handle one-time schedules', async () => {
      const scheduledAt = Date.now() + 3600000; // 1 hour from now
      const schedule = createTestSchedule({
        scheduleType: ScheduleType.ONE_TIME,
        cronExpression: undefined,
        scheduledAt,
      });

      await repo.save(schedule);
      const findResult = await repo.findById(schedule.id);

      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      const found = findResult.value!;
      expect(found.scheduleType).toBe(ScheduleType.ONE_TIME);
      expect(found.scheduledAt).toBe(scheduledAt);
      expect(found.cronExpression).toBeUndefined();
    });
  });

  describe('update()', () => {
    it('should update schedule fields', async () => {
      const schedule = createTestSchedule();
      await repo.save(schedule);

      const updateResult = await repo.update(schedule.id, {
        status: ScheduleStatus.PAUSED,
        runCount: 5,
      });

      expect(updateResult.ok).toBe(true);

      const findResult = await repo.findById(schedule.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      expect(findResult.value!.status).toBe(ScheduleStatus.PAUSED);
      expect(findResult.value!.runCount).toBe(5);
    });

    it('should return error for non-existent schedule', async () => {
      const result = await repo.update(ScheduleId('non-existent'), { status: ScheduleStatus.PAUSED });

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.message).toContain('not found');
    });

    it('should update lastRunAt and nextRunAt', async () => {
      const schedule = createTestSchedule();
      await repo.save(schedule);

      const lastRunAt = Date.now();
      const nextRunAt = Date.now() + 3600000;

      await repo.update(schedule.id, { lastRunAt, nextRunAt });

      const findResult = await repo.findById(schedule.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      expect(findResult.value!.lastRunAt).toBe(lastRunAt);
      expect(findResult.value!.nextRunAt).toBe(nextRunAt);
    });
  });

  describe('findById()', () => {
    it('should return schedule when found', async () => {
      const schedule = createTestSchedule();
      await repo.save(schedule);

      const result = await repo.findById(schedule.id);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).not.toBeNull();
      expect(result.value!.id).toBe(schedule.id);
    });

    it('should return null when not found', async () => {
      const result = await repo.findById(ScheduleId('non-existent'));

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toBeNull();
    });
  });

  describe('findAll()', () => {
    it('should return all schedules', async () => {
      const schedule1 = createTestSchedule();
      const schedule2 = createTestSchedule();
      const schedule3 = createTestSchedule();

      await repo.save(schedule1);
      await repo.save(schedule2);
      await repo.save(schedule3);

      const result = await repo.findAll();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(3);
    });

    it('should return empty array when no schedules exist', async () => {
      const result = await repo.findAll();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(0);
    });

    it('should apply default limit of 100', async () => {
      // Create more than 100 schedules
      for (let i = 0; i < 105; i++) {
        await repo.save(createTestSchedule());
      }

      const result = await repo.findAll();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(100);
    });

    it('should respect custom limit', async () => {
      for (let i = 0; i < 10; i++) {
        await repo.save(createTestSchedule());
      }

      const result = await repo.findAll(5);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(5);
    });

    it('should respect offset', async () => {
      const schedules: Schedule[] = [];
      for (let i = 0; i < 10; i++) {
        const s = createTestSchedule();
        schedules.push(s);
        await repo.save(s);
      }

      const result = await repo.findAll(5, 5);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(5);
    });
  });

  describe('findByStatus()', () => {
    it('should return schedules with matching status', async () => {
      const active = createTestSchedule();
      const paused = createTestSchedule();

      await repo.save(active);
      await repo.save(paused);
      await repo.update(paused.id, { status: ScheduleStatus.PAUSED });

      const result = await repo.findByStatus(ScheduleStatus.ACTIVE);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(1);
      expect(result.value[0].id).toBe(active.id);
    });

    it('should return empty array when no matching schedules', async () => {
      const schedule = createTestSchedule();
      await repo.save(schedule);

      const result = await repo.findByStatus(ScheduleStatus.CANCELLED);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(0);
    });
  });

  describe('findDue()', () => {
    it('should return schedules due for execution', async () => {
      const now = Date.now();

      // Due schedule (nextRunAt in the past)
      const due = createTestSchedule();
      await repo.save(due);
      await repo.update(due.id, { nextRunAt: now - 60000 }); // 1 minute ago

      // Not due schedule (nextRunAt in the future)
      const notDue = createTestSchedule();
      await repo.save(notDue);
      await repo.update(notDue.id, { nextRunAt: now + 3600000 }); // 1 hour from now

      const result = await repo.findDue(now);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(1);
      expect(result.value[0].id).toBe(due.id);
    });

    it('should not return paused schedules', async () => {
      const now = Date.now();

      const paused = createTestSchedule();
      await repo.save(paused);
      await repo.update(paused.id, {
        nextRunAt: now - 60000,
        status: ScheduleStatus.PAUSED,
      });

      const result = await repo.findDue(now);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(0);
    });

    it('should order by nextRunAt ascending', async () => {
      const now = Date.now();

      const later = createTestSchedule();
      const earlier = createTestSchedule();

      await repo.save(later);
      await repo.save(earlier);

      await repo.update(later.id, { nextRunAt: now - 1000 });
      await repo.update(earlier.id, { nextRunAt: now - 60000 });

      const result = await repo.findDue(now);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(2);
      // Earlier should come first
      expect(result.value[0].id).toBe(earlier.id);
      expect(result.value[1].id).toBe(later.id);
    });
  });

  describe('delete()', () => {
    it('should delete schedule', async () => {
      const schedule = createTestSchedule();
      await repo.save(schedule);

      const deleteResult = await repo.delete(schedule.id);
      expect(deleteResult.ok).toBe(true);

      const findResult = await repo.findById(schedule.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      expect(findResult.value).toBeNull();
    });

    it('should succeed even when schedule does not exist', async () => {
      const result = await repo.delete(ScheduleId('non-existent'));
      expect(result.ok).toBe(true);
    });
  });

  describe('count()', () => {
    it('should return total schedule count', async () => {
      await repo.save(createTestSchedule());
      await repo.save(createTestSchedule());
      await repo.save(createTestSchedule());

      const result = await repo.count();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toBe(3);
    });

    it('should return 0 for empty repository', async () => {
      const result = await repo.count();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toBe(0);
    });
  });

  describe('recordExecution()', () => {
    it('should record execution and return with ID', async () => {
      const schedule = createTestSchedule();
      await repo.save(schedule);

      const now = Date.now();
      // Note: taskId omitted because it has FK constraint to tasks table
      const result = await repo.recordExecution({
        scheduleId: schedule.id,
        scheduledFor: now,
        executedAt: now,
        status: 'triggered',
        createdAt: now,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.id).toBeDefined();
      expect(result.value.scheduleId).toBe(schedule.id);
      expect(result.value.status).toBe('triggered');
    });

    it('should record failed execution with error message', async () => {
      const schedule = createTestSchedule();
      await repo.save(schedule);

      const now = Date.now();
      const result = await repo.recordExecution({
        scheduleId: schedule.id,
        scheduledFor: now,
        status: 'failed',
        errorMessage: 'Task creation failed',
        createdAt: now,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.status).toBe('failed');
      expect(result.value.errorMessage).toBe('Task creation failed');
    });
  });

  describe('getExecutionHistory()', () => {
    it('should return execution history for schedule', async () => {
      const schedule = createTestSchedule();
      await repo.save(schedule);

      const now = Date.now();

      // Record multiple executions
      await repo.recordExecution({
        scheduleId: schedule.id,
        scheduledFor: now - 7200000,
        executedAt: now - 7200000,
        status: 'completed',
        createdAt: now - 7200000,
      });

      await repo.recordExecution({
        scheduleId: schedule.id,
        scheduledFor: now - 3600000,
        executedAt: now - 3600000,
        status: 'completed',
        createdAt: now - 3600000,
      });

      await repo.recordExecution({
        scheduleId: schedule.id,
        scheduledFor: now,
        executedAt: now,
        status: 'triggered',
        createdAt: now,
      });

      const result = await repo.getExecutionHistory(schedule.id);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(3);
      // Should be ordered by scheduledFor DESC (most recent first)
      expect(result.value[0].status).toBe('triggered');
    });

    it('should respect limit', async () => {
      const schedule = createTestSchedule();
      await repo.save(schedule);

      const now = Date.now();

      // Record 10 executions
      for (let i = 0; i < 10; i++) {
        await repo.recordExecution({
          scheduleId: schedule.id,
          scheduledFor: now - i * 3600000,
          executedAt: now - i * 3600000,
          status: 'completed',
          createdAt: now - i * 3600000,
        });
      }

      const result = await repo.getExecutionHistory(schedule.id, 5);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(5);
    });

    it('should return empty array for schedule with no executions', async () => {
      const schedule = createTestSchedule();
      await repo.save(schedule);

      const result = await repo.getExecutionHistory(schedule.id);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(0);
    });
  });

  describe('MissedRunPolicy mapping', () => {
    it('should correctly map SKIP policy', async () => {
      const schedule = createTestSchedule({ missedRunPolicy: MissedRunPolicy.SKIP });
      await repo.save(schedule);

      const result = await repo.findById(schedule.id);
      expect(result.ok && result.value?.missedRunPolicy).toBe(MissedRunPolicy.SKIP);
    });

    it('should correctly map CATCHUP policy', async () => {
      const schedule = createTestSchedule({ missedRunPolicy: MissedRunPolicy.CATCHUP });
      await repo.save(schedule);

      const result = await repo.findById(schedule.id);
      expect(result.ok && result.value?.missedRunPolicy).toBe(MissedRunPolicy.CATCHUP);
    });

    it('should correctly map FAIL policy', async () => {
      const schedule = createTestSchedule({ missedRunPolicy: MissedRunPolicy.FAIL });
      await repo.save(schedule);

      const result = await repo.findById(schedule.id);
      expect(result.ok && result.value?.missedRunPolicy).toBe(MissedRunPolicy.FAIL);
    });
  });

  describe('ScheduleStatus mapping', () => {
    it('should correctly map all status values', async () => {
      const statuses = [
        ScheduleStatus.ACTIVE,
        ScheduleStatus.PAUSED,
        ScheduleStatus.COMPLETED,
        ScheduleStatus.CANCELLED,
        ScheduleStatus.EXPIRED,
      ];

      for (const status of statuses) {
        const schedule = createTestSchedule();
        await repo.save(schedule);
        await repo.update(schedule.id, { status });

        const result = await repo.findById(schedule.id);
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.value?.status).toBe(status);
      }
    });
  });

  describe('pipeline_steps round-trip', () => {
    it('should save and retrieve schedule with pipelineSteps', async () => {
      const schedule = createTestSchedule({
        pipelineSteps: [
          { prompt: 'lint the codebase' },
          { prompt: 'run the tests' },
        ],
      });

      await repo.save(schedule);
      const findResult = await repo.findById(schedule.id);

      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      const found = findResult.value!;
      expect(found.pipelineSteps).toBeDefined();
      expect(found.pipelineSteps).toHaveLength(2);
      expect(found.pipelineSteps![0].prompt).toBe('lint the codebase');
      expect(found.pipelineSteps![1].prompt).toBe('run the tests');
    });

    it('should return undefined pipelineSteps for non-pipeline schedules', async () => {
      const schedule = createTestSchedule();

      await repo.save(schedule);
      const findResult = await repo.findById(schedule.id);

      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      expect(findResult.value!.pipelineSteps).toBeUndefined();
    });

    it('should record execution with pipelineTaskIds', async () => {
      const schedule = createTestSchedule();
      await repo.save(schedule);

      const now = Date.now();
      const taskIds = [TaskId('task-aaa-111'), TaskId('task-bbb-222'), TaskId('task-ccc-333')];

      const recordResult = await repo.recordExecution({
        scheduleId: schedule.id,
        scheduledFor: now,
        executedAt: now,
        status: 'triggered',
        pipelineTaskIds: taskIds,
        createdAt: now,
      });

      expect(recordResult.ok).toBe(true);
      if (!recordResult.ok) return;

      expect(recordResult.value.pipelineTaskIds).toBeDefined();
      expect(recordResult.value.pipelineTaskIds).toHaveLength(3);
      expect(recordResult.value.pipelineTaskIds![0]).toBe('task-aaa-111');
      expect(recordResult.value.pipelineTaskIds![2]).toBe('task-ccc-333');

      // Also verify via getExecutionHistory
      const historyResult = await repo.getExecutionHistory(schedule.id);
      expect(historyResult.ok).toBe(true);
      if (!historyResult.ok) return;

      expect(historyResult.value).toHaveLength(1);
      expect(historyResult.value[0].pipelineTaskIds).toHaveLength(3);
      expect(historyResult.value[0].pipelineTaskIds![1]).toBe('task-bbb-222');
    });

    it('should update schedule with pipelineSteps', async () => {
      // Save schedule without pipeline steps
      const schedule = createTestSchedule();
      await repo.save(schedule);

      // Verify no pipeline steps initially
      const initialResult = await repo.findById(schedule.id);
      expect(initialResult.ok).toBe(true);
      if (!initialResult.ok) return;
      expect(initialResult.value!.pipelineSteps).toBeUndefined();

      // Update to add pipeline steps
      const steps = [
        { prompt: 'step one' },
        { prompt: 'step two' },
        { prompt: 'step three' },
      ];
      await repo.update(schedule.id, { pipelineSteps: steps });

      // Verify pipeline steps persisted
      const updatedResult = await repo.findById(schedule.id);
      expect(updatedResult.ok).toBe(true);
      if (!updatedResult.ok) return;

      const found = updatedResult.value!;
      expect(found.pipelineSteps).toBeDefined();
      expect(found.pipelineSteps).toHaveLength(3);
      expect(found.pipelineSteps![0].prompt).toBe('step one');
      expect(found.pipelineSteps![1].prompt).toBe('step two');
      expect(found.pipelineSteps![2].prompt).toBe('step three');
    });
  });
});
