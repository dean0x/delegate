/**
 * Unit tests for ScheduleManagerService
 * ARCHITECTURE: Tests service layer with real SQLite (in-memory) and TestEventBus
 * Pattern: Behavior-driven testing with Result pattern validation
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  PipelineCreateRequest,
  ScheduleCreateRequest,
  ScheduledLoopCreateRequest,
  ScheduledPipelineCreateRequest,
} from '../../../src/core/domain';
import {
  createSchedule,
  LoopStrategy,
  MissedRunPolicy,
  Priority,
  ScheduleId,
  ScheduleStatus,
  ScheduleType,
  TaskId,
} from '../../../src/core/domain';
import { Database } from '../../../src/implementations/database';
import { SQLiteScheduleRepository } from '../../../src/implementations/schedule-repository';
import { ScheduleManagerService } from '../../../src/services/schedule-manager';
import { toMissedRunPolicy } from '../../../src/utils/format';
import { createTestConfiguration } from '../../fixtures/factories';
import { TestEventBus, TestLogger } from '../../fixtures/test-doubles';

describe('ScheduleManagerService - Unit Tests', () => {
  let db: Database;
  let scheduleRepo: SQLiteScheduleRepository;
  let eventBus: TestEventBus;
  let logger: TestLogger;
  let service: ScheduleManagerService;

  beforeEach(() => {
    db = new Database(':memory:');
    scheduleRepo = new SQLiteScheduleRepository(db);
    eventBus = new TestEventBus();
    logger = new TestLogger();
    service = new ScheduleManagerService(eventBus, logger, scheduleRepo, createTestConfiguration());
  });

  afterEach(() => {
    eventBus.dispose();
    db.close();
  });

  // Helper: create a valid cron schedule request
  function cronRequest(overrides: Partial<ScheduleCreateRequest> = {}): ScheduleCreateRequest {
    return {
      prompt: 'Run daily report',
      scheduleType: ScheduleType.CRON,
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      ...overrides,
    };
  }

  // Helper: create a valid one-time schedule request
  function oneTimeRequest(overrides: Partial<ScheduleCreateRequest> = {}): ScheduleCreateRequest {
    const futureDate = new Date(Date.now() + 3600000); // 1 hour from now
    return {
      prompt: 'Run once',
      scheduleType: ScheduleType.ONE_TIME,
      scheduledAt: futureDate.toISOString(),
      timezone: 'UTC',
      ...overrides,
    };
  }

  describe('toMissedRunPolicy()', () => {
    it('should map "catchup" to CATCHUP', () => {
      expect(toMissedRunPolicy('catchup')).toBe(MissedRunPolicy.CATCHUP);
    });

    it('should map "fail" to FAIL', () => {
      expect(toMissedRunPolicy('fail')).toBe(MissedRunPolicy.FAIL);
    });

    it('should default to SKIP for "skip"', () => {
      expect(toMissedRunPolicy('skip')).toBe(MissedRunPolicy.SKIP);
    });

    it('should default to SKIP for undefined', () => {
      expect(toMissedRunPolicy(undefined)).toBe(MissedRunPolicy.SKIP);
    });

    it('should default to SKIP for unrecognized values', () => {
      expect(toMissedRunPolicy('invalid')).toBe(MissedRunPolicy.SKIP);
      expect(toMissedRunPolicy('')).toBe(MissedRunPolicy.SKIP);
    });
  });

  describe('createSchedule()', () => {
    it('should return error when cron type lacks cronExpression', async () => {
      const request = cronRequest({ cronExpression: undefined });

      const result = await service.createSchedule(request);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('cronExpression is required');
    });

    it('should return error when one_time type lacks scheduledAt', async () => {
      const request: ScheduleCreateRequest = {
        prompt: 'Run once',
        scheduleType: ScheduleType.ONE_TIME,
        timezone: 'UTC',
      };

      const result = await service.createSchedule(request);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('scheduledAt is required');
    });

    it('should return error for invalid cron expression', async () => {
      const request = cronRequest({ cronExpression: 'not-a-cron' });

      const result = await service.createSchedule(request);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('Invalid cron expression');
    });

    it('should return error for invalid timezone', async () => {
      const request = cronRequest({ timezone: 'Fake/Zone' });

      const result = await service.createSchedule(request);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('Invalid timezone');
    });

    it('should return error for invalid scheduledAt datetime', async () => {
      const request = oneTimeRequest({ scheduledAt: 'not-a-date' });

      const result = await service.createSchedule(request);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('Invalid scheduledAt datetime');
    });

    it('should return error when scheduledAt is in the past', async () => {
      const pastDate = new Date(Date.now() - 3600000); // 1 hour ago
      const request = oneTimeRequest({ scheduledAt: pastDate.toISOString() });

      const result = await service.createSchedule(request);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('must be in the future');
    });

    it('should return error for invalid expiresAt datetime', async () => {
      const request = cronRequest({ expiresAt: 'not-a-date' });

      const result = await service.createSchedule(request);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('Invalid expiresAt datetime');
    });

    it('should successfully create a cron schedule', async () => {
      const request = cronRequest();

      const result = await service.createSchedule(request);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const schedule = result.value;
      expect(schedule.scheduleType).toBe(ScheduleType.CRON);
      expect(schedule.cronExpression).toBe('0 9 * * *');
      expect(schedule.timezone).toBe('UTC');
      expect(schedule.status).toBe(ScheduleStatus.ACTIVE);
      expect(schedule.missedRunPolicy).toBe(MissedRunPolicy.SKIP);
    });

    it('should successfully create a one-time schedule', async () => {
      const request = oneTimeRequest();

      const result = await service.createSchedule(request);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const schedule = result.value;
      expect(schedule.scheduleType).toBe(ScheduleType.ONE_TIME);
      expect(schedule.scheduledAt).toBeDefined();
    });

    it('should emit ScheduleCreated event on success', async () => {
      const request = cronRequest();

      const result = await service.createSchedule(request);

      expect(result.ok).toBe(true);
      expect(eventBus.hasEmitted('ScheduleCreated')).toBe(true);
      expect(eventBus.getEventCount('ScheduleCreated')).toBe(1);
    });

    it('should return error when event emission fails', async () => {
      eventBus.setEmitFailure('ScheduleCreated', true);
      const request = cronRequest();

      const result = await service.createSchedule(request);

      expect(result.ok).toBe(false);
    });

    it('should default timezone to UTC when not provided', async () => {
      const request = cronRequest({ timezone: undefined });

      const result = await service.createSchedule(request);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.timezone).toBe('UTC');
    });

    it('should parse valid expiresAt', async () => {
      const expiresAt = new Date(Date.now() + 86400000).toISOString(); // 24h from now
      const request = cronRequest({ expiresAt });

      const result = await service.createSchedule(request);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.expiresAt).toBeDefined();
    });

    it('should apply missedRunPolicy from request', async () => {
      const request = cronRequest({ missedRunPolicy: MissedRunPolicy.CATCHUP });

      const result = await service.createSchedule(request);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.missedRunPolicy).toBe(MissedRunPolicy.CATCHUP);
    });

    it('should respect maxRuns when provided', async () => {
      const request = cronRequest({ maxRuns: 5 });

      const result = await service.createSchedule(request);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.maxRuns).toBe(5);
    });

    it('should thread model into taskTemplate when provided', async () => {
      const request = cronRequest({ model: 'claude-opus-4-5' });

      const result = await service.createSchedule(request);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.taskTemplate.model).toBe('claude-opus-4-5');
    });

    it('should leave model undefined in taskTemplate when not provided', async () => {
      const request = cronRequest();

      const result = await service.createSchedule(request);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.taskTemplate.model).toBeUndefined();
    });

    it('should thread systemPrompt into taskTemplate when provided', async () => {
      const request = cronRequest({ systemPrompt: 'You are a senior engineer.' });

      const result = await service.createSchedule(request);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.taskTemplate.systemPrompt).toBe('You are a senior engineer.');
    });

    it('should leave systemPrompt undefined in taskTemplate when not provided', async () => {
      const request = cronRequest();

      const result = await service.createSchedule(request);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.taskTemplate.systemPrompt).toBeUndefined();
    });
  });

  describe('listSchedules()', () => {
    it('should delegate to findByStatus when status provided', async () => {
      // Arrange: create and persist two schedules with different statuses
      const s1 = createSchedule({
        taskTemplate: { prompt: 'task1' },
        scheduleType: ScheduleType.CRON,
        cronExpression: '0 9 * * *',
      });
      const s2 = createSchedule({
        taskTemplate: { prompt: 'task2' },
        scheduleType: ScheduleType.CRON,
        cronExpression: '0 10 * * *',
      });
      await scheduleRepo.save(s1);
      await scheduleRepo.save(s2);
      await scheduleRepo.update(s2.id, { status: ScheduleStatus.PAUSED });

      const result = await service.listSchedules(ScheduleStatus.ACTIVE);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
      expect(result.value[0].id).toBe(s1.id);
    });

    it('should delegate to findAll when no status provided', async () => {
      const s1 = createSchedule({
        taskTemplate: { prompt: 'task1' },
        scheduleType: ScheduleType.CRON,
        cronExpression: '0 9 * * *',
      });
      const s2 = createSchedule({
        taskTemplate: { prompt: 'task2' },
        scheduleType: ScheduleType.CRON,
        cronExpression: '0 10 * * *',
      });
      await scheduleRepo.save(s1);
      await scheduleRepo.save(s2);

      const result = await service.listSchedules();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(2);
    });
  });

  describe('getSchedule()', () => {
    it('should return schedule when found', async () => {
      const schedule = createSchedule({
        taskTemplate: { prompt: 'test' },
        scheduleType: ScheduleType.CRON,
        cronExpression: '0 9 * * *',
      });
      await scheduleRepo.save(schedule);

      const result = await service.getSchedule(schedule.id);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.schedule.id).toBe(schedule.id);
      expect(result.value.history).toBeUndefined();
    });

    it('should include history when requested', async () => {
      const schedule = createSchedule({
        taskTemplate: { prompt: 'test' },
        scheduleType: ScheduleType.CRON,
        cronExpression: '0 9 * * *',
      });
      await scheduleRepo.save(schedule);

      // Record an execution so history is non-empty
      const now = Date.now();
      await scheduleRepo.recordExecution({
        scheduleId: schedule.id,
        scheduledFor: now,
        executedAt: now,
        status: 'triggered',
        createdAt: now,
      });

      const result = await service.getSchedule(schedule.id, true);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.history).toBeDefined();
      expect(result.value.history).toHaveLength(1);
    });

    it('should return error for non-existent schedule', async () => {
      const result = await service.getSchedule(ScheduleId('non-existent'));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('not found');
    });
  });

  describe('cancelSchedule()', () => {
    it('should emit ScheduleCancelled event for existing schedule', async () => {
      const schedule = createSchedule({
        taskTemplate: { prompt: 'test' },
        scheduleType: ScheduleType.CRON,
        cronExpression: '0 9 * * *',
      });
      await scheduleRepo.save(schedule);

      const result = await service.cancelSchedule(schedule.id, 'no longer needed');

      expect(result.ok).toBe(true);
      expect(eventBus.hasEmitted('ScheduleCancelled')).toBe(true);

      const events = eventBus.getEmittedEvents('ScheduleCancelled');
      expect(events[0].scheduleId).toBe(schedule.id);
      expect(events[0].reason).toBe('no longer needed');
    });

    it('should emit TaskCancellationRequested for in-flight tasks when cancelTasks=true', async () => {
      const schedule = createSchedule({
        taskTemplate: { prompt: 'pipeline step' },
        scheduleType: ScheduleType.CRON,
        cronExpression: '0 9 * * *',
      });
      await scheduleRepo.save(schedule);

      // Record an execution with pipeline task IDs
      const now = Date.now();
      await scheduleRepo.recordExecution({
        scheduleId: schedule.id,
        scheduledFor: now,
        executedAt: now,
        status: 'triggered',
        pipelineTaskIds: [TaskId('task-aaa'), TaskId('task-bbb'), TaskId('task-ccc')],
        createdAt: now,
      });

      const result = await service.cancelSchedule(schedule.id, 'abort pipeline', true);

      expect(result.ok).toBe(true);
      expect(eventBus.hasEmitted('ScheduleCancelled')).toBe(true);
      expect(eventBus.hasEmitted('TaskCancellationRequested')).toBe(true);
      expect(eventBus.getEventCount('TaskCancellationRequested')).toBe(3);

      const cancelEvents = eventBus.getEmittedEvents('TaskCancellationRequested');
      const cancelledTaskIds = cancelEvents.map((e: { taskId: string }) => e.taskId);
      expect(cancelledTaskIds).toContain('task-aaa');
      expect(cancelledTaskIds).toContain('task-bbb');
      expect(cancelledTaskIds).toContain('task-ccc');
    });

    it('should cancel single taskId when no pipelineTaskIds in execution', async () => {
      const schedule = createSchedule({
        taskTemplate: { prompt: 'single task' },
        scheduleType: ScheduleType.CRON,
        cronExpression: '0 9 * * *',
      });
      await scheduleRepo.save(schedule);

      // Insert a task row to satisfy FK constraint on schedule_executions.task_id
      const taskId = TaskId('task-single');
      const now = Date.now();
      db.getDatabase()
        .prepare(`INSERT INTO tasks (id, prompt, status, priority, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(taskId, 'single task', 'running', 'P2', now);

      // Record an execution with only a single taskId (non-pipeline schedule)
      await scheduleRepo.recordExecution({
        scheduleId: schedule.id,
        scheduledFor: now,
        executedAt: now,
        status: 'triggered',
        taskId,
        createdAt: now,
      });

      const result = await service.cancelSchedule(schedule.id, 'stop it', true);

      expect(result.ok).toBe(true);
      expect(eventBus.getEventCount('TaskCancellationRequested')).toBe(1);

      const cancelEvents = eventBus.getEmittedEvents('TaskCancellationRequested');
      expect(cancelEvents[0].taskId).toBe('task-single');
    });

    it('should not emit TaskCancellationRequested when cancelTasks is false', async () => {
      const schedule = createSchedule({
        taskTemplate: { prompt: 'test' },
        scheduleType: ScheduleType.CRON,
        cronExpression: '0 9 * * *',
      });
      await scheduleRepo.save(schedule);

      const now = Date.now();
      await scheduleRepo.recordExecution({
        scheduleId: schedule.id,
        scheduledFor: now,
        executedAt: now,
        status: 'triggered',
        pipelineTaskIds: [TaskId('task-x')],
        createdAt: now,
      });

      const result = await service.cancelSchedule(schedule.id, 'normal cancel');

      expect(result.ok).toBe(true);
      expect(eventBus.hasEmitted('ScheduleCancelled')).toBe(true);
      expect(eventBus.hasEmitted('TaskCancellationRequested')).toBe(false);
    });

    it('should cancel tasks from ALL active executions, not just the latest', async () => {
      const schedule = createSchedule({
        taskTemplate: { prompt: 'overlapping pipeline' },
        scheduleType: ScheduleType.CRON,
        cronExpression: '*/5 * * * *',
      });
      await scheduleRepo.save(schedule);

      // Record two overlapping triggered executions with different pipelineTaskIds
      const now = Date.now();
      await scheduleRepo.recordExecution({
        scheduleId: schedule.id,
        scheduledFor: now - 300000,
        executedAt: now - 300000,
        status: 'triggered',
        pipelineTaskIds: [TaskId('old-task-1'), TaskId('old-task-2')],
        createdAt: now - 300000,
      });
      await scheduleRepo.recordExecution({
        scheduleId: schedule.id,
        scheduledFor: now,
        executedAt: now,
        status: 'triggered',
        pipelineTaskIds: [TaskId('new-task-1'), TaskId('new-task-2')],
        createdAt: now,
      });

      const result = await service.cancelSchedule(schedule.id, 'stop all', true);

      expect(result.ok).toBe(true);
      expect(eventBus.getEventCount('TaskCancellationRequested')).toBe(4);

      const cancelEvents = eventBus.getEmittedEvents('TaskCancellationRequested');
      const cancelledIds = cancelEvents.map((e: { taskId: string }) => e.taskId);
      expect(cancelledIds).toContain('old-task-1');
      expect(cancelledIds).toContain('old-task-2');
      expect(cancelledIds).toContain('new-task-1');
      expect(cancelledIds).toContain('new-task-2');
    });

    it('should skip completed executions when cancelling tasks', async () => {
      const schedule = createSchedule({
        taskTemplate: { prompt: 'mixed executions' },
        scheduleType: ScheduleType.CRON,
        cronExpression: '*/5 * * * *',
      });
      await scheduleRepo.save(schedule);

      const now = Date.now();
      // One completed execution (should be skipped)
      await scheduleRepo.recordExecution({
        scheduleId: schedule.id,
        scheduledFor: now - 600000,
        executedAt: now - 600000,
        status: 'completed',
        pipelineTaskIds: [TaskId('done-task-1')],
        createdAt: now - 600000,
      });
      // One active triggered execution (should be cancelled)
      await scheduleRepo.recordExecution({
        scheduleId: schedule.id,
        scheduledFor: now,
        executedAt: now,
        status: 'triggered',
        pipelineTaskIds: [TaskId('active-task-1')],
        createdAt: now,
      });

      const result = await service.cancelSchedule(schedule.id, 'stop active only', true);

      expect(result.ok).toBe(true);
      expect(eventBus.getEventCount('TaskCancellationRequested')).toBe(1);

      const cancelEvents = eventBus.getEmittedEvents('TaskCancellationRequested');
      expect(cancelEvents[0].taskId).toBe('active-task-1');
    });

    it('should return error for non-existent schedule', async () => {
      const result = await service.cancelSchedule(ScheduleId('non-existent'));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('not found');
    });
  });

  describe('pauseSchedule()', () => {
    it('should emit SchedulePaused event for active schedule', async () => {
      const schedule = createSchedule({
        taskTemplate: { prompt: 'test' },
        scheduleType: ScheduleType.CRON,
        cronExpression: '0 9 * * *',
      });
      await scheduleRepo.save(schedule);

      const result = await service.pauseSchedule(schedule.id);

      expect(result.ok).toBe(true);
      expect(eventBus.hasEmitted('SchedulePaused')).toBe(true);
    });

    it('should return error when schedule is not active', async () => {
      const schedule = createSchedule({
        taskTemplate: { prompt: 'test' },
        scheduleType: ScheduleType.CRON,
        cronExpression: '0 9 * * *',
      });
      await scheduleRepo.save(schedule);
      await scheduleRepo.update(schedule.id, { status: ScheduleStatus.PAUSED });

      const result = await service.pauseSchedule(schedule.id);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('not active');
    });

    it('should return error for non-existent schedule', async () => {
      const result = await service.pauseSchedule(ScheduleId('non-existent'));

      expect(result.ok).toBe(false);
    });
  });

  describe('resumeSchedule()', () => {
    it('should emit ScheduleResumed event for paused schedule', async () => {
      const schedule = createSchedule({
        taskTemplate: { prompt: 'test' },
        scheduleType: ScheduleType.CRON,
        cronExpression: '0 9 * * *',
      });
      await scheduleRepo.save(schedule);
      await scheduleRepo.update(schedule.id, { status: ScheduleStatus.PAUSED });

      const result = await service.resumeSchedule(schedule.id);

      expect(result.ok).toBe(true);
      expect(eventBus.hasEmitted('ScheduleResumed')).toBe(true);
    });

    it('should return error when schedule is not paused', async () => {
      const schedule = createSchedule({
        taskTemplate: { prompt: 'test' },
        scheduleType: ScheduleType.CRON,
        cronExpression: '0 9 * * *',
      });
      await scheduleRepo.save(schedule);
      // Schedule starts as ACTIVE, not PAUSED

      const result = await service.resumeSchedule(schedule.id);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('not paused');
    });

    it('should return error for non-existent schedule', async () => {
      const result = await service.resumeSchedule(ScheduleId('non-existent'));

      expect(result.ok).toBe(false);
    });
  });

  describe('createPipeline()', () => {
    function pipelineRequest(overrides: Partial<PipelineCreateRequest> = {}): PipelineCreateRequest {
      return {
        steps: [{ prompt: 'Step one' }, { prompt: 'Step two' }, { prompt: 'Step three' }],
        ...overrides,
      };
    }

    it('should reject fewer than 2 steps', async () => {
      const result = await service.createPipeline({ steps: [{ prompt: 'Only one' }] });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('at least 2 steps');
    });

    it('should reject more than 20 steps', async () => {
      const steps = Array.from({ length: 21 }, (_, i) => ({ prompt: `Step ${i + 1}` }));
      const result = await service.createPipeline({ steps });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('exceed 20 steps');
    });

    it('should create chained schedules for 3-step pipeline', async () => {
      const result = await service.createPipeline(pipelineRequest());

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.steps).toHaveLength(3);
      expect(result.value.pipelineId).toBe(result.value.steps[0].scheduleId);
    });

    it('should return all schedule IDs in correct order', async () => {
      const result = await service.createPipeline(pipelineRequest());

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Each step should have a unique schedule ID
      const ids = result.value.steps.map((s) => s.scheduleId);
      expect(new Set(ids).size).toBe(3);

      // Indices should be sequential
      expect(result.value.steps.map((s) => s.index)).toEqual([0, 1, 2]);
    });

    it('should use shared priority as default for all steps', async () => {
      const result = await service.createPipeline(pipelineRequest({ priority: Priority.P0 }));

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Verify all 3 ScheduleCreated events were emitted
      expect(eventBus.getEventCount('ScheduleCreated')).toBe(3);

      // Check each created schedule has P0 priority
      const events = eventBus.getEmittedEvents('ScheduleCreated');
      for (const event of events) {
        expect(event.schedule.taskTemplate.priority).toBe(Priority.P0);
      }
    });

    it('should allow per-step priority override', async () => {
      const result = await service.createPipeline({
        steps: [{ prompt: 'Step one', priority: Priority.P1 }, { prompt: 'Step two' }],
        priority: Priority.P2,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const events = eventBus.getEmittedEvents('ScheduleCreated');
      expect(events[0].schedule.taskTemplate.priority).toBe(Priority.P1);
      expect(events[1].schedule.taskTemplate.priority).toBe(Priority.P2);
    });

    it('should use shared workingDirectory as default', async () => {
      const cwd = process.cwd();
      const result = await service.createPipeline(pipelineRequest({ workingDirectory: cwd }));

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const events = eventBus.getEmittedEvents('ScheduleCreated');
      for (const event of events) {
        expect(event.schedule.taskTemplate.workingDirectory).toBe(cwd);
      }
    });

    it('should allow per-step workingDirectory override', async () => {
      const cwd = process.cwd();
      const overrideDir = `${cwd}/src`;
      const result = await service.createPipeline({
        steps: [{ prompt: 'Step one', workingDirectory: overrideDir }, { prompt: 'Step two' }],
        workingDirectory: cwd,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const events = eventBus.getEmittedEvents('ScheduleCreated');
      expect(events[0].schedule.taskTemplate.workingDirectory).toBe(overrideDir);
      expect(events[1].schedule.taskTemplate.workingDirectory).toBe(cwd);
    });

    it('should truncate long prompts at 50 chars in response', async () => {
      const longPrompt = 'A'.repeat(60);
      const result = await service.createPipeline({
        steps: [{ prompt: longPrompt }, { prompt: 'Short' }],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.steps[0].prompt).toBe('A'.repeat(50) + '...');
      expect(result.value.steps[1].prompt).toBe('Short');
    });

    it('should stop on first failure and report error with step number', async () => {
      // Make ScheduleCreated emission fail — first step will fail
      eventBus.setEmitFailure('ScheduleCreated', true);

      const result = await service.createPipeline(pipelineRequest());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('step 1');
    });

    it('should emit ScheduleCreated for each step', async () => {
      const result = await service.createPipeline(pipelineRequest());

      expect(result.ok).toBe(true);
      expect(eventBus.getEventCount('ScheduleCreated')).toBe(3);
    });

    it('should thread shared model to all steps as default', async () => {
      const result = await service.createPipeline(pipelineRequest({ model: 'claude-opus-4-5' }));

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const events = eventBus.getEmittedEvents('ScheduleCreated');
      for (const event of events) {
        expect(event.schedule.taskTemplate.model).toBe('claude-opus-4-5');
      }
    });

    it('should allow per-step model override', async () => {
      const result = await service.createPipeline({
        steps: [{ prompt: 'Step one', model: 'claude-haiku-3' }, { prompt: 'Step two' }],
        model: 'claude-opus-4-5',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const events = eventBus.getEmittedEvents('ScheduleCreated');
      expect(events[0].schedule.taskTemplate.model).toBe('claude-haiku-3');
      expect(events[1].schedule.taskTemplate.model).toBe('claude-opus-4-5');
    });

    it('should thread shared systemPrompt to all steps as default', async () => {
      const result = await service.createPipeline(pipelineRequest({ systemPrompt: 'Be concise' }));

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const events = eventBus.getEmittedEvents('ScheduleCreated');
      for (const event of events) {
        expect(event.schedule.taskTemplate.systemPrompt).toBe('Be concise');
      }
    });

    it('should allow per-step systemPrompt override', async () => {
      const result = await service.createPipeline({
        steps: [{ prompt: 'Step one', systemPrompt: 'Step-specific' }, { prompt: 'Step two' }],
        systemPrompt: 'Shared default',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const events = eventBus.getEmittedEvents('ScheduleCreated');
      expect(events[0].schedule.taskTemplate.systemPrompt).toBe('Step-specific');
      expect(events[1].schedule.taskTemplate.systemPrompt).toBe('Shared default');
    });
  });

  describe('createScheduledPipeline()', () => {
    function scheduledPipelineRequest(
      overrides: Partial<ScheduledPipelineCreateRequest> = {},
    ): ScheduledPipelineCreateRequest {
      return {
        steps: [{ prompt: 'Step one' }, { prompt: 'Step two' }, { prompt: 'Step three' }],
        scheduleType: ScheduleType.CRON,
        cronExpression: '0 9 * * *',
        timezone: 'UTC',
        ...overrides,
      };
    }

    it('should create a scheduled pipeline with cron', async () => {
      const request = scheduledPipelineRequest();

      const result = await service.createScheduledPipeline(request);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const schedule = result.value;
      expect(schedule.scheduleType).toBe(ScheduleType.CRON);
      expect(schedule.cronExpression).toBe('0 9 * * *');
      expect(schedule.pipelineSteps).toBeDefined();
      expect(schedule.pipelineSteps).toHaveLength(3);
      expect(schedule.taskTemplate.prompt).toContain('Pipeline (3 steps)');
      expect(schedule.taskTemplate.prompt).toContain('Step one');
      expect(schedule.status).toBe(ScheduleStatus.ACTIVE);
    });

    it('should create a scheduled pipeline with one_time', async () => {
      const futureDate = new Date(Date.now() + 3600000); // 1 hour from now
      const request = scheduledPipelineRequest({
        steps: [{ prompt: 'First step' }, { prompt: 'Second step' }],
        scheduleType: ScheduleType.ONE_TIME,
        cronExpression: undefined,
        scheduledAt: futureDate.toISOString(),
      });

      const result = await service.createScheduledPipeline(request);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const schedule = result.value;
      expect(schedule.scheduleType).toBe(ScheduleType.ONE_TIME);
      expect(schedule.scheduledAt).toBeDefined();
      expect(schedule.pipelineSteps).toHaveLength(2);
    });

    it('should reject fewer than 2 steps', async () => {
      const request = scheduledPipelineRequest({
        steps: [{ prompt: 'Only one' }],
      });

      const result = await service.createScheduledPipeline(request);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('at least 2 steps');
    });

    it('should reject more than 20 steps', async () => {
      const steps = Array.from({ length: 21 }, (_, i) => ({ prompt: `Step ${i + 1}` }));
      const request = scheduledPipelineRequest({ steps });

      const result = await service.createScheduledPipeline(request);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('exceed 20 steps');
    });

    it('should store normalized paths for per-step workingDirectory', async () => {
      const cwd = process.cwd();
      // Path with /../ segment that resolves to cwd
      const unnormalizedPath = `${cwd}/src/../src`;
      const normalizedPath = `${cwd}/src`;

      const request = scheduledPipelineRequest({
        steps: [{ prompt: 'Step one', workingDirectory: unnormalizedPath }, { prompt: 'Step two' }],
      });

      const result = await service.createScheduledPipeline(request);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // The schedule's pipelineSteps should contain the NORMALIZED path
      expect(result.value.pipelineSteps).toBeDefined();
      expect(result.value.pipelineSteps![0].workingDirectory).toBe(normalizedPath);
      // Step without workingDirectory should remain undefined
      expect(result.value.pipelineSteps![1].workingDirectory).toBeUndefined();
    });

    it('should emit ScheduleCreated event with pipelineSteps', async () => {
      const request = scheduledPipelineRequest();

      const result = await service.createScheduledPipeline(request);

      expect(result.ok).toBe(true);
      expect(eventBus.hasEmitted('ScheduleCreated')).toBe(true);
      expect(eventBus.getEventCount('ScheduleCreated')).toBe(1);

      const events = eventBus.getEmittedEvents('ScheduleCreated');
      const emittedSchedule = events[0].schedule;
      expect(emittedSchedule.pipelineSteps).toBeDefined();
      expect(emittedSchedule.pipelineSteps).toHaveLength(3);
      expect(emittedSchedule.pipelineSteps![0].prompt).toBe('Step one');
      expect(emittedSchedule.pipelineSteps![1].prompt).toBe('Step two');
      expect(emittedSchedule.pipelineSteps![2].prompt).toBe('Step three');
    });

    it('should thread systemPrompt into taskTemplate when provided', async () => {
      const request = scheduledPipelineRequest({ systemPrompt: 'You are a pipeline expert.' });

      const result = await service.createScheduledPipeline(request);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.taskTemplate.systemPrompt).toBe('You are a pipeline expert.');
    });

    it('should leave systemPrompt undefined in taskTemplate when not provided', async () => {
      const request = scheduledPipelineRequest();

      const result = await service.createScheduledPipeline(request);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.taskTemplate.systemPrompt).toBeUndefined();
    });
  });

  describe('createScheduledLoop()', () => {
    // Helper: create a valid scheduled loop request with cron
    function scheduledLoopRequest(overrides: Partial<ScheduledLoopCreateRequest> = {}): ScheduledLoopCreateRequest {
      return {
        loopConfig: {
          prompt: 'Fix failing tests',
          strategy: LoopStrategy.RETRY,
          exitCondition: 'npm test',
        },
        scheduleType: ScheduleType.CRON,
        cronExpression: '0 9 * * *',
        timezone: 'UTC',
        ...overrides,
      };
    }

    it('should create a cron scheduled loop with loopConfig', async () => {
      const request = scheduledLoopRequest();

      const result = await service.createScheduledLoop(request);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const schedule = result.value;
      expect(schedule.scheduleType).toBe(ScheduleType.CRON);
      expect(schedule.cronExpression).toBe('0 9 * * *');
      expect(schedule.timezone).toBe('UTC');
      expect(schedule.status).toBe(ScheduleStatus.ACTIVE);
      expect(schedule.loopConfig).toBeDefined();
      expect(schedule.loopConfig!.strategy).toBe(LoopStrategy.RETRY);
      expect(schedule.loopConfig!.exitCondition).toBe('npm test');
    });

    it('should create a one-time scheduled loop', async () => {
      const futureDate = new Date(Date.now() + 3600000); // 1 hour from now
      const request = scheduledLoopRequest({
        scheduleType: ScheduleType.ONE_TIME,
        cronExpression: undefined,
        scheduledAt: futureDate.toISOString(),
      });

      const result = await service.createScheduledLoop(request);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const schedule = result.value;
      expect(schedule.scheduleType).toBe(ScheduleType.ONE_TIME);
      expect(schedule.scheduledAt).toBeDefined();
      expect(schedule.loopConfig).toBeDefined();
    });

    it('should reject empty exitCondition', async () => {
      const request = scheduledLoopRequest({
        loopConfig: {
          prompt: 'Fix tests',
          strategy: LoopStrategy.RETRY,
          exitCondition: '',
        },
      });

      const result = await service.createScheduledLoop(request);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('exitCondition is required');
    });

    it('should reject whitespace-only exitCondition', async () => {
      const request = scheduledLoopRequest({
        loopConfig: {
          prompt: 'Fix tests',
          strategy: LoopStrategy.RETRY,
          exitCondition: '   ',
        },
      });

      const result = await service.createScheduledLoop(request);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('exitCondition is required');
    });

    it('should allow empty exitCondition for agent eval mode', async () => {
      const request = scheduledLoopRequest({
        loopConfig: {
          prompt: 'Review code quality',
          strategy: LoopStrategy.RETRY,
          exitCondition: '',
          evalMode: 'agent',
          evalPrompt: 'Did the agent fix all issues?',
        },
      });

      const result = await service.createScheduledLoop(request);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.loopConfig!.evalMode).toBe('agent');
    });

    it('should emit ScheduleCreated event with loopConfig', async () => {
      const request = scheduledLoopRequest();

      const result = await service.createScheduledLoop(request);

      expect(result.ok).toBe(true);
      expect(eventBus.hasEmitted('ScheduleCreated')).toBe(true);
      expect(eventBus.getEventCount('ScheduleCreated')).toBe(1);

      const events = eventBus.getEmittedEvents('ScheduleCreated');
      const emittedSchedule = events[0].schedule;
      expect(emittedSchedule.loopConfig).toBeDefined();
      expect(emittedSchedule.loopConfig!.strategy).toBe(LoopStrategy.RETRY);
      expect(emittedSchedule.loopConfig!.exitCondition).toBe('npm test');
    });

    it('should apply toMissedRunPolicy normalization', async () => {
      const request = scheduledLoopRequest({
        missedRunPolicy: MissedRunPolicy.CATCHUP,
      });

      const result = await service.createScheduledLoop(request);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.missedRunPolicy).toBe(MissedRunPolicy.CATCHUP);
    });

    it('should default missedRunPolicy to SKIP when not provided', async () => {
      const request = scheduledLoopRequest({
        missedRunPolicy: undefined,
      });

      const result = await service.createScheduledLoop(request);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.missedRunPolicy).toBe(MissedRunPolicy.SKIP);
    });

    it('should return error for invalid cron expression', async () => {
      const request = scheduledLoopRequest({
        cronExpression: 'not-a-cron',
      });

      const result = await service.createScheduledLoop(request);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('Invalid cron expression');
    });

    it('should return error for invalid timezone', async () => {
      const request = scheduledLoopRequest({
        timezone: 'Fake/Zone',
      });

      const result = await service.createScheduledLoop(request);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('Invalid timezone');
    });

    it('should return error when event emission fails', async () => {
      eventBus.setEmitFailure('ScheduleCreated', true);
      const request = scheduledLoopRequest();

      const result = await service.createScheduledLoop(request);

      expect(result.ok).toBe(false);
    });

    it('should propagate loopConfig fields to schedule', async () => {
      const request = scheduledLoopRequest({
        loopConfig: {
          prompt: 'Optimize perf',
          strategy: LoopStrategy.OPTIMIZE,
          exitCondition: 'node benchmark.js',
          maxIterations: 20,
          maxConsecutiveFailures: 5,
          cooldownMs: 1000,
          freshContext: false,
          priority: Priority.P0,
        },
      });

      const result = await service.createScheduledLoop(request);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const loopConfig = result.value.loopConfig!;
      expect(loopConfig.strategy).toBe(LoopStrategy.OPTIMIZE);
      expect(loopConfig.exitCondition).toBe('node benchmark.js');
      expect(loopConfig.maxIterations).toBe(20);
      expect(loopConfig.maxConsecutiveFailures).toBe(5);
      expect(loopConfig.cooldownMs).toBe(1000);
      expect(loopConfig.freshContext).toBe(false);
      expect(loopConfig.priority).toBe(Priority.P0);
    });

    it('should respect maxRuns when provided', async () => {
      const request = scheduledLoopRequest({ maxRuns: 3 });

      const result = await service.createScheduledLoop(request);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.maxRuns).toBe(3);
    });

    it('should set nextRunAt on the schedule', async () => {
      const request = scheduledLoopRequest();

      const result = await service.createScheduledLoop(request);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.nextRunAt).toBeDefined();
      expect(typeof result.value.nextRunAt).toBe('number');
    });

    it('should thread model into taskTemplate and loopConfig when provided', async () => {
      const request = scheduledLoopRequest({
        loopConfig: {
          prompt: 'Fix failing tests',
          strategy: LoopStrategy.RETRY,
          exitCondition: 'npm test',
          model: 'claude-opus-4-5',
        },
      });

      const result = await service.createScheduledLoop(request);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.taskTemplate.model).toBe('claude-opus-4-5');
      expect(result.value.loopConfig!.model).toBe('claude-opus-4-5');
    });

    it('should leave model undefined when not provided in loopConfig', async () => {
      const request = scheduledLoopRequest();

      const result = await service.createScheduledLoop(request);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.taskTemplate.model).toBeUndefined();
      expect(result.value.loopConfig!.model).toBeUndefined();
    });

    it('should thread systemPrompt into taskTemplate and loopConfig when provided', async () => {
      const request = scheduledLoopRequest({
        loopConfig: {
          prompt: 'Fix failing tests',
          strategy: LoopStrategy.RETRY,
          exitCondition: 'npm test',
          systemPrompt: 'You are a test-fixing expert.',
        },
      });

      const result = await service.createScheduledLoop(request);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.taskTemplate.systemPrompt).toBe('You are a test-fixing expert.');
      expect(result.value.loopConfig!.systemPrompt).toBe('You are a test-fixing expert.');
    });

    it('should leave systemPrompt undefined when not provided in loopConfig', async () => {
      const request = scheduledLoopRequest();

      const result = await service.createScheduledLoop(request);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.taskTemplate.systemPrompt).toBeUndefined();
      expect(result.value.loopConfig!.systemPrompt).toBeUndefined();
    });
  });
});
