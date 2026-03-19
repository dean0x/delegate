/**
 * Integration test: Task Scheduling - End-to-End Flow
 *
 * Verifies the complete scheduling lifecycle through the real bootstrap system:
 * create schedule -> persist -> trigger via executor -> TaskDelegated emitted -> execution recorded
 *
 * ARCHITECTURE: Uses real bootstrap, real EventBus, real SQLite (temp file-based DB)
 * Pattern: Matches task-dependencies.test.ts integration test conventions
 */

import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { Container } from '../../src/core/container.js';
import type { Schedule, TaskId } from '../../src/core/domain.js';
import { MissedRunPolicy, Priority, ScheduleId, ScheduleStatus, ScheduleType } from '../../src/core/domain.js';
import { EventBus } from '../../src/core/events/event-bus.js';
import type { ScheduleExecutedEvent, TaskDelegatedEvent } from '../../src/core/events/events.js';
import { ScheduleRepository, ScheduleService } from '../../src/core/interfaces.js';
import { Database } from '../../src/implementations/database.js';
import { TestResourceMonitor } from '../../src/implementations/resource-monitor.js';
import { ScheduleExecutor } from '../../src/services/schedule-executor.js';
import { NoOpProcessSpawner } from '../fixtures/no-op-spawner.js';
import { flushEventLoop, waitForEvent } from '../utils/event-helpers.js';

describe('Integration: Task Scheduling - End-to-End Flow', () => {
  let container: Container;
  let scheduleService: ScheduleService;
  let scheduleRepo: ScheduleRepository;
  let eventBus: EventBus;
  let database: Database;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'backbeat-schedule-test-'));
    process.env.BACKBEAT_DATABASE_PATH = join(tempDir, 'test.db');
    process.env.BACKBEAT_DEFAULT_AGENT = 'claude';
    process.env.WORKER_MIN_SPAWN_DELAY_MS = '10'; // Fast spawn for tests

    const result = await bootstrap({
      processSpawner: new NoOpProcessSpawner(),
      resourceMonitor: new TestResourceMonitor(),
    });
    if (!result.ok) throw new Error(`Bootstrap failed: ${result.error.message}`);
    container = result.value;

    // Resolve scheduleService (async factory in bootstrap registers it)
    const ssResult = container.get<ScheduleService>('scheduleService');
    if (!ssResult.ok) throw new Error(`Failed to get ScheduleService: ${ssResult.error.message}`);
    scheduleService = ssResult.value;

    const srResult = container.get<ScheduleRepository>('scheduleRepository');
    if (!srResult.ok) throw new Error(`Failed to get ScheduleRepository: ${srResult.error.message}`);
    scheduleRepo = srResult.value;

    const ebResult = container.get<EventBus>('eventBus');
    if (!ebResult.ok) throw new Error(`Failed to get EventBus: ${ebResult.error.message}`);
    eventBus = ebResult.value;

    const dbResult = container.get<Database>('database');
    if (!dbResult.ok) throw new Error(`Failed to get Database: ${dbResult.error.message}`);
    database = dbResult.value;

    // Stop the default executor started by bootstrap to prevent interference
    // We create our own executor in tests that need it for controlled triggering
    const executorResult = container.get<ScheduleExecutor>('scheduleExecutor');
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

  describe('Schedule Creation', () => {
    it('should create a cron schedule and persist it with correct nextRunAt', async () => {
      // Resolve taskManager first so event handlers are wired up
      const tmResult = await container.resolve('taskManager');
      if (!tmResult.ok) throw new Error(`Failed to resolve taskManager: ${tmResult.error.message}`);

      const beforeCreate = Date.now();

      const result = await scheduleService.createSchedule({
        prompt: 'Run daily cleanup',
        scheduleType: ScheduleType.CRON,
        cronExpression: '0 0 * * *', // Every day at midnight
        timezone: 'UTC',
        priority: Priority.P2,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const schedule = result.value;
      expect(schedule.scheduleType).toBe(ScheduleType.CRON);
      expect(schedule.cronExpression).toBe('0 0 * * *');
      expect(schedule.status).toBe(ScheduleStatus.ACTIVE);
      expect(schedule.timezone).toBe('UTC');
      expect(schedule.runCount).toBe(0);

      await flushEventLoop();

      // Verify persistence - schedule handler should have persisted with nextRunAt calculated
      const persisted = await scheduleRepo.findById(schedule.id);
      expect(persisted.ok).toBe(true);
      if (!persisted.ok) return;

      expect(persisted.value).not.toBeNull();
      const saved = persisted.value!;
      expect(saved.id).toBe(schedule.id);
      expect(saved.scheduleType).toBe(ScheduleType.CRON);
      expect(saved.status).toBe(ScheduleStatus.ACTIVE);
      // nextRunAt should be in the future (next midnight UTC)
      expect(saved.nextRunAt).toBeDefined();
      expect(saved.nextRunAt!).toBeGreaterThan(beforeCreate);
    });

    it('should create a one-time schedule with future scheduledAt', async () => {
      const tmResult = await container.resolve('taskManager');
      if (!tmResult.ok) throw new Error(`Failed to resolve taskManager: ${tmResult.error.message}`);

      // Schedule 1 hour in the future
      const futureTime = new Date(Date.now() + 3600_000);

      const result = await scheduleService.createSchedule({
        prompt: 'Run one-time migration',
        scheduleType: ScheduleType.ONE_TIME,
        scheduledAt: futureTime.toISOString(),
        timezone: 'UTC',
        priority: Priority.P1,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const schedule = result.value;
      expect(schedule.scheduleType).toBe(ScheduleType.ONE_TIME);
      expect(schedule.status).toBe(ScheduleStatus.ACTIVE);
      expect(schedule.scheduledAt).toBeDefined();

      await flushEventLoop();

      // Verify persistence
      const persisted = await scheduleRepo.findById(schedule.id);
      expect(persisted.ok).toBe(true);
      if (!persisted.ok) return;

      const saved = persisted.value!;
      expect(saved.scheduleType).toBe(ScheduleType.ONE_TIME);
      expect(saved.nextRunAt).toBeDefined();
      // nextRunAt should match scheduledAt for one-time schedules
      expect(saved.nextRunAt).toBe(saved.scheduledAt);
    });

    it('should reject cron schedule without cron expression', async () => {
      const result = await scheduleService.createSchedule({
        prompt: 'Missing cron expression',
        scheduleType: ScheduleType.CRON,
        timezone: 'UTC',
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.message).toMatch(/cronExpression/i);
    });

    it('should reject one-time schedule without scheduledAt', async () => {
      const result = await scheduleService.createSchedule({
        prompt: 'Missing scheduledAt',
        scheduleType: ScheduleType.ONE_TIME,
        timezone: 'UTC',
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.message).toMatch(/scheduledAt/i);
    });

    it('should reject one-time schedule with past scheduledAt', async () => {
      const pastTime = new Date(Date.now() - 3600_000);

      const result = await scheduleService.createSchedule({
        prompt: 'Past schedule',
        scheduleType: ScheduleType.ONE_TIME,
        scheduledAt: pastTime.toISOString(),
        timezone: 'UTC',
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.message).toMatch(/future/i);
    });
  });

  describe('Schedule Trigger via Executor', () => {
    it('should emit TaskDelegated when executor triggers a due schedule', async () => {
      // Resolve taskManager to wire up event handlers
      const tmResult = await container.resolve('taskManager');
      if (!tmResult.ok) throw new Error(`Failed to resolve taskManager: ${tmResult.error.message}`);

      // Create a cron schedule
      const createResult = await scheduleService.createSchedule({
        prompt: 'Executor trigger test task',
        scheduleType: ScheduleType.CRON,
        cronExpression: '* * * * *', // Every minute
        timezone: 'UTC',
        priority: Priority.P2,
      });

      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const schedule = createResult.value;
      await flushEventLoop();

      // Manually set nextRunAt to the past so executor considers it due
      const pastTime = Date.now() - 5000;
      const updateResult = await scheduleRepo.update(schedule.id, { nextRunAt: pastTime });
      expect(updateResult.ok).toBe(true);

      // Track TaskDelegated events
      const delegatedEvents: TaskDelegatedEvent[] = [];
      eventBus.on!('TaskDelegated', (event: TaskDelegatedEvent) => {
        delegatedEvents.push(event);
      });

      // Create a test executor with short interval and trigger manually
      const loggerResult = container.get('logger');
      if (!loggerResult.ok) throw new Error('Failed to get logger');

      const executorCreateResult = ScheduleExecutor.create(
        scheduleRepo,
        eventBus,
        database,
        (loggerResult.value as import('../../src/core/interfaces.js').Logger).child({ module: 'TestExecutor' }),
        {
          checkIntervalMs: 50,
          missedRunGracePeriodMs: 60_000, // Large grace period so this is not "missed"
        },
      );

      expect(executorCreateResult.ok).toBe(true);
      if (!executorCreateResult.ok) return;

      const executor = executorCreateResult.value;

      try {
        // Set up event listener before triggering to capture the async chain
        const executedPromise = waitForEvent(eventBus, 'ScheduleExecuted');

        // Trigger a tick manually
        await executor.triggerTick();
        await executedPromise;
        await flushEventLoop();

        // Verify TaskDelegated was emitted
        expect(delegatedEvents.length).toBeGreaterThanOrEqual(1);

        // The delegated task should contain the schedule's prompt
        const delegatedTask = delegatedEvents[0].task;
        expect(delegatedTask.prompt).toBe('Executor trigger test task');
        expect(delegatedTask.priority).toBe(Priority.P2);
      } finally {
        executor.stop();
      }
    });

    it('should record execution after trigger', async () => {
      // Resolve taskManager to wire up event handlers
      const tmResult = await container.resolve('taskManager');
      if (!tmResult.ok) throw new Error(`Failed to resolve taskManager: ${tmResult.error.message}`);

      // Create schedule
      const createResult = await scheduleService.createSchedule({
        prompt: 'Execution recording test',
        scheduleType: ScheduleType.CRON,
        cronExpression: '* * * * *',
        timezone: 'UTC',
      });

      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const schedule = createResult.value;
      await flushEventLoop();

      // Set nextRunAt to the past
      await scheduleRepo.update(schedule.id, { nextRunAt: Date.now() - 5000 });

      // Create and trigger executor
      const loggerResult = container.get('logger');
      if (!loggerResult.ok) throw new Error('Failed to get logger');

      const executorCreateResult = ScheduleExecutor.create(
        scheduleRepo,
        eventBus,
        database,
        (loggerResult.value as import('../../src/core/interfaces.js').Logger).child({ module: 'TestExecutor' }),
        { checkIntervalMs: 50, missedRunGracePeriodMs: 60_000 },
      );

      expect(executorCreateResult.ok).toBe(true);
      if (!executorCreateResult.ok) return;

      const executor = executorCreateResult.value;

      try {
        const executedPromise = waitForEvent(eventBus, 'ScheduleExecuted');
        await executor.triggerTick();
        await executedPromise;
        await flushEventLoop();

        // Verify execution was recorded
        const historyResult = await scheduleRepo.getExecutionHistory(schedule.id);
        expect(historyResult.ok).toBe(true);
        if (!historyResult.ok) return;

        expect(historyResult.value.length).toBeGreaterThanOrEqual(1);

        const execution = historyResult.value[0];
        expect(execution.scheduleId).toBe(schedule.id);
        expect(execution.status).toBe('triggered');
        expect(execution.taskId).toBeDefined();
      } finally {
        executor.stop();
      }
    });
  });

  describe('Schedule Lifecycle', () => {
    it('should transition through active -> paused -> resumed -> cancelled', async () => {
      // Resolve taskManager to wire up event handlers
      const tmResult = await container.resolve('taskManager');
      if (!tmResult.ok) throw new Error(`Failed to resolve taskManager: ${tmResult.error.message}`);

      // Create active schedule
      const createResult = await scheduleService.createSchedule({
        prompt: 'Lifecycle test schedule',
        scheduleType: ScheduleType.CRON,
        cronExpression: '0 */6 * * *', // Every 6 hours
        timezone: 'UTC',
      });

      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const schedule = createResult.value;
      await flushEventLoop();

      // Verify active
      const activeResult = await scheduleRepo.findById(schedule.id);
      expect(activeResult.ok).toBe(true);
      expect(activeResult.value?.status).toBe(ScheduleStatus.ACTIVE);

      // Pause
      const pauseResult = await scheduleService.pauseSchedule(schedule.id);
      expect(pauseResult.ok).toBe(true);
      await flushEventLoop();

      const pausedResult = await scheduleRepo.findById(schedule.id);
      expect(pausedResult.ok).toBe(true);
      expect(pausedResult.value?.status).toBe(ScheduleStatus.PAUSED);

      // Resume
      const resumeResult = await scheduleService.resumeSchedule(schedule.id);
      expect(resumeResult.ok).toBe(true);
      await flushEventLoop();

      const resumedResult = await scheduleRepo.findById(schedule.id);
      expect(resumedResult.ok).toBe(true);
      expect(resumedResult.value?.status).toBe(ScheduleStatus.ACTIVE);
      // After resume, nextRunAt should be recalculated (still future)
      expect(resumedResult.value?.nextRunAt).toBeDefined();
      expect(resumedResult.value!.nextRunAt!).toBeGreaterThan(Date.now() - 1000);

      // Cancel
      const cancelResult = await scheduleService.cancelSchedule(schedule.id, 'Test cancellation');
      expect(cancelResult.ok).toBe(true);
      await flushEventLoop();

      const cancelledResult = await scheduleRepo.findById(schedule.id);
      expect(cancelledResult.ok).toBe(true);
      expect(cancelledResult.value?.status).toBe(ScheduleStatus.CANCELLED);
      // Cancelled schedules should have nextRunAt cleared
      expect(cancelledResult.value?.nextRunAt).toBeUndefined();
    });

    it('should reject pausing a non-active schedule', async () => {
      const tmResult = await container.resolve('taskManager');
      if (!tmResult.ok) throw new Error(`Failed to resolve taskManager: ${tmResult.error.message}`);

      // Create and cancel a schedule
      const createResult = await scheduleService.createSchedule({
        prompt: 'Will be cancelled first',
        scheduleType: ScheduleType.CRON,
        cronExpression: '0 0 * * *',
        timezone: 'UTC',
      });

      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      await flushEventLoop();

      await scheduleService.cancelSchedule(createResult.value.id);
      await flushEventLoop();

      // Trying to pause a cancelled schedule should fail
      const pauseResult = await scheduleService.pauseSchedule(createResult.value.id);
      expect(pauseResult.ok).toBe(false);
    });

    it('should reject resuming a non-paused schedule', async () => {
      const tmResult = await container.resolve('taskManager');
      if (!tmResult.ok) throw new Error(`Failed to resolve taskManager: ${tmResult.error.message}`);

      // Create an active schedule
      const createResult = await scheduleService.createSchedule({
        prompt: 'Active schedule',
        scheduleType: ScheduleType.CRON,
        cronExpression: '0 0 * * *',
        timezone: 'UTC',
      });

      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      await flushEventLoop();

      // Trying to resume an active schedule should fail
      const resumeResult = await scheduleService.resumeSchedule(createResult.value.id);
      expect(resumeResult.ok).toBe(false);
    });
  });

  describe('Schedule Queries', () => {
    it('should list schedules by status', async () => {
      const tmResult = await container.resolve('taskManager');
      if (!tmResult.ok) throw new Error(`Failed to resolve taskManager: ${tmResult.error.message}`);

      // Create two schedules, pause one
      const create1 = await scheduleService.createSchedule({
        prompt: 'Active schedule 1',
        scheduleType: ScheduleType.CRON,
        cronExpression: '0 0 * * *',
        timezone: 'UTC',
      });

      const create2 = await scheduleService.createSchedule({
        prompt: 'Will be paused',
        scheduleType: ScheduleType.CRON,
        cronExpression: '0 12 * * *',
        timezone: 'UTC',
      });

      expect(create1.ok && create2.ok).toBe(true);
      if (!create1.ok || !create2.ok) return;

      await flushEventLoop();

      // Pause the second schedule
      await scheduleService.pauseSchedule(create2.value.id);
      await flushEventLoop();

      // List active schedules
      const activeListResult = await scheduleService.listSchedules(ScheduleStatus.ACTIVE);
      expect(activeListResult.ok).toBe(true);
      if (!activeListResult.ok) return;

      const activeIds = activeListResult.value.map((s) => s.id);
      expect(activeIds).toContain(create1.value.id);
      expect(activeIds).not.toContain(create2.value.id);

      // List paused schedules
      const pausedListResult = await scheduleService.listSchedules(ScheduleStatus.PAUSED);
      expect(pausedListResult.ok).toBe(true);
      if (!pausedListResult.ok) return;

      const pausedIds = pausedListResult.value.map((s) => s.id);
      expect(pausedIds).toContain(create2.value.id);
      expect(pausedIds).not.toContain(create1.value.id);
    });

    it('should get schedule with execution history', async () => {
      const tmResult = await container.resolve('taskManager');
      if (!tmResult.ok) throw new Error(`Failed to resolve taskManager: ${tmResult.error.message}`);

      // Create schedule
      const createResult = await scheduleService.createSchedule({
        prompt: 'History test schedule',
        scheduleType: ScheduleType.CRON,
        cronExpression: '* * * * *',
        timezone: 'UTC',
      });

      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const schedule = createResult.value;
      await flushEventLoop();

      // Trigger execution by setting nextRunAt to past and running tick
      await scheduleRepo.update(schedule.id, { nextRunAt: Date.now() - 5000 });

      const loggerResult = container.get('logger');
      if (!loggerResult.ok) throw new Error('Failed to get logger');

      const executorCreateResult = ScheduleExecutor.create(
        scheduleRepo,
        eventBus,
        database,
        (loggerResult.value as import('../../src/core/interfaces.js').Logger).child({ module: 'TestExecutor' }),
        { checkIntervalMs: 50, missedRunGracePeriodMs: 60_000 },
      );

      expect(executorCreateResult.ok).toBe(true);
      if (!executorCreateResult.ok) return;

      const executor = executorCreateResult.value;

      try {
        const executedPromise = waitForEvent(eventBus, 'ScheduleExecuted');
        await executor.triggerTick();
        await executedPromise;
        await flushEventLoop();

        // Get schedule with history
        const getResult = await scheduleService.getSchedule(schedule.id, true, 10);
        expect(getResult.ok).toBe(true);
        if (!getResult.ok) return;

        expect(getResult.value.schedule.id).toBe(schedule.id);
        expect(getResult.value.history).toBeDefined();
        expect(getResult.value.history!.length).toBeGreaterThanOrEqual(1);
      } finally {
        executor.stop();
      }
    });
  });

  describe('One-Time Schedule Completion', () => {
    it('should mark one-time schedule as completed after trigger', async () => {
      const tmResult = await container.resolve('taskManager');
      if (!tmResult.ok) throw new Error(`Failed to resolve taskManager: ${tmResult.error.message}`);

      // Create a one-time schedule with a future time
      const futureTime = new Date(Date.now() + 3600_000);

      const createResult = await scheduleService.createSchedule({
        prompt: 'One-time completion test',
        scheduleType: ScheduleType.ONE_TIME,
        scheduledAt: futureTime.toISOString(),
        timezone: 'UTC',
      });

      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const schedule = createResult.value;
      await flushEventLoop();

      // Set nextRunAt to past to make it due
      await scheduleRepo.update(schedule.id, { nextRunAt: Date.now() - 5000 });

      const loggerResult = container.get('logger');
      if (!loggerResult.ok) throw new Error('Failed to get logger');

      const executorCreateResult = ScheduleExecutor.create(
        scheduleRepo,
        eventBus,
        database,
        (loggerResult.value as import('../../src/core/interfaces.js').Logger).child({ module: 'TestExecutor' }),
        { checkIntervalMs: 50, missedRunGracePeriodMs: 60_000 },
      );

      expect(executorCreateResult.ok).toBe(true);
      if (!executorCreateResult.ok) return;

      const executor = executorCreateResult.value;

      try {
        const executedPromise = waitForEvent(eventBus, 'ScheduleExecuted');
        await executor.triggerTick();
        await executedPromise;
        await flushEventLoop();

        // Verify schedule is marked as completed
        const afterTrigger = await scheduleRepo.findById(schedule.id);
        expect(afterTrigger.ok).toBe(true);
        if (!afterTrigger.ok) return;

        expect(afterTrigger.value?.status).toBe(ScheduleStatus.COMPLETED);
        expect(afterTrigger.value?.runCount).toBe(1);
        // nextRunAt should be cleared for completed schedules
        expect(afterTrigger.value?.nextRunAt).toBeUndefined();
      } finally {
        executor.stop();
      }
    });
  });
});
