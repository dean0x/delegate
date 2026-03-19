/**
 * Unit tests for ScheduleExecutor
 * ARCHITECTURE: Tests timer-based scheduler with real SQLite (in-memory)
 * Pattern: Behavioral testing - focuses on triggerTick(), missed run handling,
 *          concurrent execution prevention
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Schedule } from '../../../src/core/domain';
import { createSchedule, MissedRunPolicy, ScheduleId, ScheduleStatus, ScheduleType } from '../../../src/core/domain';
import { InMemoryEventBus } from '../../../src/core/events/event-bus';
import { Database } from '../../../src/implementations/database';
import { SQLiteScheduleRepository } from '../../../src/implementations/schedule-repository';
import { ScheduleExecutor } from '../../../src/services/schedule-executor';
import { createTestConfiguration } from '../../fixtures/factories';
import { TestLogger } from '../../fixtures/test-doubles';
import { flushEventLoop } from '../../utils/event-helpers';

describe('ScheduleExecutor - Unit Tests', () => {
  let executor: ScheduleExecutor;
  let eventBus: InMemoryEventBus;
  let scheduleRepo: SQLiteScheduleRepository;
  let database: Database;
  let logger: TestLogger;

  /** Grace period used in tests (1 second) */
  const GRACE_PERIOD_MS = 1000;

  beforeEach(() => {
    logger = new TestLogger();
    const config = createTestConfiguration();
    eventBus = new InMemoryEventBus(config, logger);

    database = new Database(':memory:');
    scheduleRepo = new SQLiteScheduleRepository(database);

    const result = ScheduleExecutor.create(scheduleRepo, eventBus, database, logger, {
      checkIntervalMs: 100,
      missedRunGracePeriodMs: GRACE_PERIOD_MS,
    });
    if (!result.ok) {
      throw new Error(`Failed to create ScheduleExecutor: ${result.error.message}`);
    }
    executor = result.value;
  });

  afterEach(() => {
    // Always stop executor to clean up timers
    executor.stop();
    eventBus.dispose();
    database.close();
  });

  // Helper: create and persist a schedule that is due for execution
  async function createDueSchedule(
    overrides: Partial<Parameters<typeof createSchedule>[0]> & {
      nextRunAt?: number;
      status?: ScheduleStatus;
    } = {},
  ): Promise<Schedule> {
    const { nextRunAt, status, ...scheduleOverrides } = overrides;
    const schedule = createSchedule({
      taskTemplate: {
        prompt: 'Scheduled task',
        workingDirectory: '/tmp',
      },
      scheduleType: ScheduleType.CRON,
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      missedRunPolicy: MissedRunPolicy.SKIP,
      ...scheduleOverrides,
    });
    await scheduleRepo.save(schedule);

    // Set nextRunAt to a past time (within grace period) so findDue() returns it
    // Default: 500ms ago, within 1000ms grace period → treated as "on-time" not "missed"
    const effectiveNextRunAt = nextRunAt ?? Date.now() - 500;
    const effectiveStatus = status ?? ScheduleStatus.ACTIVE;
    await scheduleRepo.update(schedule.id, {
      nextRunAt: effectiveNextRunAt,
      status: effectiveStatus,
    });

    return schedule;
  }

  describe('Factory create()', () => {
    it('should succeed and return executor', () => {
      const result = ScheduleExecutor.create(scheduleRepo, eventBus, database, logger, {
        checkIntervalMs: 100,
        missedRunGracePeriodMs: 1000,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeInstanceOf(ScheduleExecutor);
    });
  });

  describe('start() and stop()', () => {
    it('should start and become active', () => {
      expect(executor.isActive()).toBe(false);

      const result = executor.start();

      expect(result.ok).toBe(true);
      expect(executor.isActive()).toBe(true);
    });

    it('should return error if already running', () => {
      executor.start();

      const result = executor.start();

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('already running');
    });

    it('should stop and become inactive', () => {
      executor.start();

      const result = executor.stop();

      expect(result.ok).toBe(true);
      expect(executor.isActive()).toBe(false);
    });

    it('should clear running schedules on stop', () => {
      executor.markScheduleRunning('sched-1', 'task-1');
      expect(executor.isScheduleRunning('sched-1')).toBe(true);

      executor.stop();

      expect(executor.isScheduleRunning('sched-1')).toBe(false);
    });
  });

  describe('isActive()', () => {
    it('should reflect running state accurately', () => {
      expect(executor.isActive()).toBe(false);
      executor.start();
      expect(executor.isActive()).toBe(true);
      executor.stop();
      expect(executor.isActive()).toBe(false);
    });
  });

  describe('triggerTick()', () => {
    it('should find due schedules and emit ScheduleTriggered events', async () => {
      const schedule = await createDueSchedule();

      // Track emitted events
      const triggeredEvents: Array<{ scheduleId: string; triggeredAt: number }> = [];
      eventBus.subscribe('ScheduleTriggered', async (event: { scheduleId: string; triggeredAt: number }) => {
        triggeredEvents.push(event);
      });

      await executor.triggerTick();
      await flushEventLoop();

      expect(triggeredEvents).toHaveLength(1);
      expect(triggeredEvents[0].scheduleId).toBe(schedule.id);
      expect(triggeredEvents[0].triggeredAt).toBeGreaterThan(0);
    });

    it('should not trigger schedules with nextRunAt in the future', async () => {
      await createDueSchedule({ nextRunAt: Date.now() + 3600000 }); // 1 hour from now

      const triggeredEvents: unknown[] = [];
      eventBus.subscribe('ScheduleTriggered', async (event: unknown) => {
        triggeredEvents.push(event);
      });

      await executor.triggerTick();
      await flushEventLoop();

      expect(triggeredEvents).toHaveLength(0);
    });

    it('should not trigger paused schedules', async () => {
      await createDueSchedule({ status: ScheduleStatus.PAUSED });

      const triggeredEvents: unknown[] = [];
      eventBus.subscribe('ScheduleTriggered', async (event: unknown) => {
        triggeredEvents.push(event);
      });

      await executor.triggerTick();
      await flushEventLoop();

      expect(triggeredEvents).toHaveLength(0);
    });

    it('should handle empty due list gracefully', async () => {
      // No schedules at all
      await executor.triggerTick();
      await flushEventLoop();

      // Should not throw, should log debug message
      expect(logger.hasLogContaining('No due schedules found')).toBe(true);
    });
  });

  describe('Concurrent execution prevention', () => {
    it('should skip schedule if previous task is still running', async () => {
      const schedule = await createDueSchedule();

      // Mark schedule as having a running task
      executor.markScheduleRunning(schedule.id, 'running-task-1');

      const triggeredEvents: unknown[] = [];
      eventBus.subscribe('ScheduleTriggered', async (event: unknown) => {
        triggeredEvents.push(event);
      });

      await executor.triggerTick();
      await flushEventLoop();

      expect(triggeredEvents).toHaveLength(0);
      expect(logger.hasLogContaining('previous task still running')).toBe(true);
    });

    it('should track running state via markScheduleRunning', () => {
      executor.markScheduleRunning('sched-1', 'task-1');

      expect(executor.isScheduleRunning('sched-1')).toBe(true);
      expect(executor.getRunningTaskId('sched-1')).toBe('task-1');
    });

    it('should clear running state on TaskCompleted event', async () => {
      const scheduleId = 'sched-clear-1';
      const taskId = 'task-clear-1';

      // Mark as running
      executor.markScheduleRunning(scheduleId, taskId);
      expect(executor.isScheduleRunning(scheduleId)).toBe(true);

      // Emit ScheduleExecuted first (which the executor subscribes to)
      // The executor already auto-subscribes, so just emit TaskCompleted
      await eventBus.emit('TaskCompleted', {
        taskId,
        exitCode: 0,
        duration: 1000,
      });
      await flushEventLoop();

      expect(executor.isScheduleRunning(scheduleId)).toBe(false);
    });

    it('should clear running state on TaskFailed event', async () => {
      const scheduleId = 'sched-fail-1';
      const taskId = 'task-fail-1';

      executor.markScheduleRunning(scheduleId, taskId);

      await eventBus.emit('TaskFailed', {
        taskId,
        error: { code: 'SYSTEM_ERROR', message: 'test error', name: 'BackbeatError' },
        exitCode: 1,
      });
      await flushEventLoop();

      expect(executor.isScheduleRunning(scheduleId)).toBe(false);
    });

    it('should clear running state on TaskCancelled event', async () => {
      const scheduleId = 'sched-cancel-1';
      const taskId = 'task-cancel-1';

      executor.markScheduleRunning(scheduleId, taskId);

      await eventBus.emit('TaskCancelled', {
        taskId,
        reason: 'cancelled by user',
      });
      await flushEventLoop();

      expect(executor.isScheduleRunning(scheduleId)).toBe(false);
    });
  });

  describe('Missed run handling', () => {
    it('should apply SKIP policy: skip execution and emit ScheduleMissed', async () => {
      // Create schedule with nextRunAt far in the past (beyond grace period)
      const schedule = await createDueSchedule({
        missedRunPolicy: MissedRunPolicy.SKIP,
        nextRunAt: Date.now() - GRACE_PERIOD_MS - 60000, // Well beyond grace
      });

      const missedEvents: Array<{ scheduleId: string; policy: string }> = [];
      eventBus.subscribe('ScheduleMissed', async (event: { scheduleId: string; policy: string }) => {
        missedEvents.push(event);
      });

      const triggeredEvents: unknown[] = [];
      eventBus.subscribe('ScheduleTriggered', async (event: unknown) => {
        triggeredEvents.push(event);
      });

      await executor.triggerTick();
      await flushEventLoop();

      // SKIP policy should emit ScheduleMissed, NOT ScheduleTriggered
      expect(missedEvents).toHaveLength(1);
      expect(missedEvents[0].scheduleId).toBe(schedule.id);
      expect(triggeredEvents).toHaveLength(0);

      expect(logger.hasLogContaining('Skipped missed schedule run')).toBe(true);
    });

    it('should apply CATCHUP policy: execute immediately', async () => {
      const schedule = await createDueSchedule({
        missedRunPolicy: MissedRunPolicy.CATCHUP,
        nextRunAt: Date.now() - GRACE_PERIOD_MS - 60000,
      });

      const triggeredEvents: Array<{ scheduleId: string }> = [];
      eventBus.subscribe('ScheduleTriggered', async (event: { scheduleId: string }) => {
        triggeredEvents.push(event);
      });

      await executor.triggerTick();
      await flushEventLoop();

      // CATCHUP policy should emit ScheduleTriggered
      expect(triggeredEvents).toHaveLength(1);
      expect(triggeredEvents[0].scheduleId).toBe(schedule.id);
      expect(logger.hasLogContaining('Catching up missed schedule run')).toBe(true);
    });

    it('should apply FAIL policy: cancel schedule and record failed execution', async () => {
      const schedule = await createDueSchedule({
        missedRunPolicy: MissedRunPolicy.FAIL,
        nextRunAt: Date.now() - GRACE_PERIOD_MS - 60000,
      });

      const missedEvents: Array<{ scheduleId: string; policy: string }> = [];
      eventBus.subscribe('ScheduleMissed', async (event: { scheduleId: string; policy: string }) => {
        missedEvents.push(event);
      });

      await executor.triggerTick();
      await flushEventLoop();

      // Should cancel the schedule
      const findResult = await scheduleRepo.findById(schedule.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;
      expect(findResult.value!.status).toBe(ScheduleStatus.CANCELLED);
      expect(findResult.value!.nextRunAt).toBeUndefined();

      // Should record a 'missed' execution
      const history = await scheduleRepo.getExecutionHistory(schedule.id);
      expect(history.ok).toBe(true);
      if (!history.ok) return;
      expect(history.value.length).toBeGreaterThanOrEqual(1);
      expect(history.value[0].status).toBe('missed');

      // Should emit ScheduleMissed
      expect(missedEvents).toHaveLength(1);
      expect(missedEvents[0].policy).toBe(MissedRunPolicy.FAIL);

      expect(logger.hasLogContaining('Schedule failed due to missed run')).toBe(true);
    });

    it('should roll back schedule cancellation if execution recording fails', async () => {
      const schedule = await createDueSchedule({
        missedRunPolicy: MissedRunPolicy.FAIL,
        nextRunAt: Date.now() - GRACE_PERIOD_MS - 60000,
      });

      // Sabotage recordExecutionSync to throw mid-transaction
      const original = scheduleRepo.recordExecutionSync.bind(scheduleRepo);
      scheduleRepo.recordExecutionSync = () => {
        throw new Error('Simulated DB failure');
      };

      await executor.triggerTick();
      await flushEventLoop();
      scheduleRepo.recordExecutionSync = original;

      // Schedule NOT cancelled — transaction rolled back
      const found = await scheduleRepo.findById(schedule.id);
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      expect(found.value!.status).toBe(ScheduleStatus.ACTIVE);

      // No execution history — transaction rolled back
      const history = await scheduleRepo.getExecutionHistory(schedule.id);
      expect(history.ok).toBe(true);
      if (!history.ok) return;
      expect(history.value).toHaveLength(0);
    });

    it('should trigger normally when within grace period', async () => {
      // Create schedule that is late but within grace period
      const schedule = await createDueSchedule({
        nextRunAt: Date.now() - 500, // 500ms ago, within 1s grace period
      });

      const triggeredEvents: Array<{ scheduleId: string }> = [];
      eventBus.subscribe('ScheduleTriggered', async (event: { scheduleId: string }) => {
        triggeredEvents.push(event);
      });

      const missedEvents: unknown[] = [];
      eventBus.subscribe('ScheduleMissed', async (event: unknown) => {
        missedEvents.push(event);
      });

      await executor.triggerTick();
      await flushEventLoop();

      // Should trigger normally, not treat as missed
      expect(triggeredEvents).toHaveLength(1);
      expect(missedEvents).toHaveLength(0);
    });
  });

  describe('ScheduleExecuted event subscription', () => {
    it('should mark schedule running when ScheduleExecuted is emitted', async () => {
      const scheduleId = ScheduleId('sched-exec-1');
      const taskId = 'task-exec-1';

      await eventBus.emit('ScheduleExecuted', {
        scheduleId,
        taskId,
        executedAt: Date.now(),
      });
      await flushEventLoop();

      expect(executor.isScheduleRunning(scheduleId)).toBe(true);
      expect(executor.getRunningTaskId(scheduleId)).toBe(taskId);
    });
  });

  describe('Multiple due schedules', () => {
    it('should process all due schedules in a single tick', async () => {
      const s1 = await createDueSchedule();
      const s2 = await createDueSchedule();

      const triggeredIds: string[] = [];
      eventBus.subscribe('ScheduleTriggered', async (event: { scheduleId: string }) => {
        triggeredIds.push(event.scheduleId);
      });

      await executor.triggerTick();
      await flushEventLoop();

      expect(triggeredIds).toHaveLength(2);
      expect(triggeredIds).toContain(s1.id);
      expect(triggeredIds).toContain(s2.id);
    });
  });
});
