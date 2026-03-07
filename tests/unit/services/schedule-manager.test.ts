/**
 * Unit tests for ScheduleManagerService
 * ARCHITECTURE: Tests service layer with real SQLite (in-memory) and TestEventBus
 * Pattern: Behavior-driven testing with Result pattern validation
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PipelineCreateRequest, ScheduleCreateRequest } from '../../../src/core/domain';
import {
  createSchedule,
  MissedRunPolicy,
  Priority,
  ScheduleId,
  ScheduleStatus,
  ScheduleType,
} from '../../../src/core/domain';
import { Database } from '../../../src/implementations/database';
import { SQLiteScheduleRepository } from '../../../src/implementations/schedule-repository';
import { ScheduleManagerService, toMissedRunPolicy } from '../../../src/services/schedule-manager';
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
  });
});
