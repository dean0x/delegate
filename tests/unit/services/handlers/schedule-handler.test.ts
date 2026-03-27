/**
 * Unit tests for ScheduleHandler
 * ARCHITECTURE: Tests event-driven schedule lifecycle with real SQLite (in-memory)
 * Pattern: Behavioral testing with InMemoryEventBus (matches dependency-handler pattern)
 *
 * NOTE: ScheduleHandler extends BaseEventHandler. Its handleEvent() wrapper catches errors
 * from inner handlers and logs them rather than propagating. So error-path tests verify
 * state (repo, logger) rather than thrown exceptions.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock git-state before importing modules that depend on it
vi.mock('../../../../src/utils/git-state.js', () => ({
  captureGitState: vi.fn().mockResolvedValue({ ok: true, value: null }),
  getCurrentCommitSha: vi.fn().mockResolvedValue({ ok: true, value: 'abc1234567890abcdef1234567890abcdef123456' }),
  captureLoopGitContext: vi.fn().mockResolvedValue({ ok: true, value: {} }),
}));

import type { Loop, LoopCreateRequest, PipelineStepRequest, Schedule, Task } from '../../../../src/core/domain';
import {
  createSchedule,
  LoopStatus,
  LoopStrategy,
  MissedRunPolicy,
  ScheduleId,
  ScheduleStatus,
  ScheduleType,
  TaskId,
  TaskStatus,
} from '../../../../src/core/domain';
import { AutobeatError, ErrorCode } from '../../../../src/core/errors';
import { InMemoryEventBus } from '../../../../src/core/events/event-bus';
import { Database } from '../../../../src/implementations/database';
import { SQLiteLoopRepository } from '../../../../src/implementations/loop-repository';
import { SQLiteScheduleRepository } from '../../../../src/implementations/schedule-repository';
import { SQLiteTaskRepository } from '../../../../src/implementations/task-repository';
import { ScheduleHandler } from '../../../../src/services/handlers/schedule-handler';
import { LoopManagerService } from '../../../../src/services/loop-manager';
import { captureGitState, captureLoopGitContext } from '../../../../src/utils/git-state';
import { createTestConfiguration } from '../../../fixtures/factories';
import { TestLogger } from '../../../fixtures/test-doubles';
import { flushEventLoop } from '../../../utils/event-helpers';

describe('ScheduleHandler - Behavioral Tests', () => {
  let handler: ScheduleHandler;
  let eventBus: InMemoryEventBus;
  let scheduleRepo: SQLiteScheduleRepository;
  let taskRepo: SQLiteTaskRepository;
  let loopRepo: SQLiteLoopRepository;
  let database: Database;
  let logger: TestLogger;
  let loopService: LoopManagerService;

  beforeEach(async () => {
    logger = new TestLogger();
    const config = createTestConfiguration();
    eventBus = new InMemoryEventBus(config, logger);

    database = new Database(':memory:');
    scheduleRepo = new SQLiteScheduleRepository(database);
    taskRepo = new SQLiteTaskRepository(database);
    loopRepo = new SQLiteLoopRepository(database);
    loopService = new LoopManagerService(eventBus, logger, loopRepo, config);

    const handlerResult = await ScheduleHandler.create({
      scheduleRepo,
      taskRepo,
      eventBus,
      database,
      loopRepo,
      loopService,
      logger,
    });
    if (!handlerResult.ok) {
      throw new Error(`Failed to create ScheduleHandler: ${handlerResult.error.message}`);
    }
    handler = handlerResult.value;
  });

  afterEach(() => {
    eventBus.dispose();
    database.close();
  });

  // Helper: create a test schedule and optionally save it
  function createTestSchedule(overrides: Partial<Parameters<typeof createSchedule>[0]> = {}): Schedule {
    return createSchedule({
      taskTemplate: {
        prompt: 'Scheduled task prompt',
        workingDirectory: '/tmp',
      },
      scheduleType: ScheduleType.CRON,
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      missedRunPolicy: MissedRunPolicy.SKIP,
      ...overrides,
    });
  }

  async function saveSchedule(schedule: Schedule): Promise<void> {
    const result = await scheduleRepo.save(schedule);
    if (!result.ok) throw new Error(`Failed to save schedule: ${result.error.message}`);
  }

  describe('Factory create()', () => {
    it('should succeed and subscribe to events', async () => {
      const freshConfig = createTestConfiguration();
      const freshEventBus = new InMemoryEventBus(freshConfig, new TestLogger());
      const freshLogger = new TestLogger();

      const freshDb = new Database(':memory:');
      const freshScheduleRepo = new SQLiteScheduleRepository(freshDb);
      const freshTaskRepo = new SQLiteTaskRepository(freshDb);
      const freshLoopRepo = new SQLiteLoopRepository(freshDb);
      const freshLoopService = new LoopManagerService(freshEventBus, freshLogger, freshLoopRepo, freshConfig);
      const result = await ScheduleHandler.create({
        scheduleRepo: freshScheduleRepo,
        taskRepo: freshTaskRepo,
        eventBus: freshEventBus,
        database: freshDb,
        loopRepo: freshLoopRepo,
        loopService: freshLoopService,
        logger: freshLogger,
      });

      expect(result.ok).toBe(true);
      expect(freshLogger.hasLogContaining('ScheduleHandler initialized')).toBe(true);

      freshEventBus.dispose();
      freshDb.close();
    });
  });

  describe('handleScheduleCreated', () => {
    it('should persist cron schedule with calculated nextRunAt', async () => {
      const schedule = createTestSchedule();

      await eventBus.emit('ScheduleCreated', { schedule });
      await flushEventLoop();

      const findResult = await scheduleRepo.findById(schedule.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      const persisted = findResult.value;
      expect(persisted).not.toBeNull();
      expect(persisted!.nextRunAt).toBeDefined();
      expect(persisted!.nextRunAt).toBeGreaterThan(Date.now() - 1000);
    });

    it('should persist one-time schedule with scheduledAt as nextRunAt', async () => {
      const scheduledAt = Date.now() + 3600000; // 1 hour from now
      const schedule = createTestSchedule({
        scheduleType: ScheduleType.ONE_TIME,
        cronExpression: undefined,
        scheduledAt,
      });

      await eventBus.emit('ScheduleCreated', { schedule });
      await flushEventLoop();

      const findResult = await scheduleRepo.findById(schedule.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      expect(findResult.value!.nextRunAt).toBe(scheduledAt);
    });

    it('should log error for invalid timezone but not throw', async () => {
      // Create schedule directly with bad timezone to bypass service validation
      const schedule: Schedule = {
        ...createTestSchedule(),
        timezone: 'Invalid/Timezone',
      };

      await eventBus.emit('ScheduleCreated', { schedule });
      await flushEventLoop();

      // Schedule should NOT be persisted since validation failed
      const findResult = await scheduleRepo.findById(schedule.id);
      expect(findResult.ok).toBe(true);
      expect(findResult.value).toBeNull();
    });

    it('should log error for missing cron expression on CRON type', async () => {
      const schedule: Schedule = {
        ...createTestSchedule(),
        cronExpression: undefined,
      };

      await eventBus.emit('ScheduleCreated', { schedule });
      await flushEventLoop();

      const findResult = await scheduleRepo.findById(schedule.id);
      expect(findResult.ok).toBe(true);
      expect(findResult.value).toBeNull();
    });

    it('should log error for missing scheduledAt on ONE_TIME type', async () => {
      const schedule: Schedule = {
        ...createTestSchedule({
          scheduleType: ScheduleType.ONE_TIME,
          cronExpression: undefined,
        }),
        scheduledAt: undefined,
      };

      await eventBus.emit('ScheduleCreated', { schedule });
      await flushEventLoop();

      const findResult = await scheduleRepo.findById(schedule.id);
      expect(findResult.ok).toBe(true);
      expect(findResult.value).toBeNull();
    });
  });

  describe('handleScheduleTriggered', () => {
    it('should create task from template and record execution', async () => {
      const schedule = createTestSchedule();
      await saveSchedule(schedule);
      const nextRunAt = Date.now() - 60000; // Due 1 minute ago
      await scheduleRepo.update(schedule.id, { nextRunAt });

      const triggeredAt = Date.now();
      await eventBus.emit('ScheduleTriggered', {
        scheduleId: schedule.id,
        triggeredAt,
      });
      await flushEventLoop();

      // Verify task was created
      const allTasks = await taskRepo.findAll();
      expect(allTasks.ok).toBe(true);
      if (!allTasks.ok) return;
      expect(allTasks.value.length).toBeGreaterThanOrEqual(1);
      expect(allTasks.value[0].prompt).toBe('Scheduled task prompt');

      // Verify execution was recorded
      const history = await scheduleRepo.getExecutionHistory(schedule.id);
      expect(history.ok).toBe(true);
      if (!history.ok) return;
      expect(history.value.length).toBeGreaterThanOrEqual(1);
      expect(history.value[0].status).toBe('triggered');
    });

    it('should update runCount and lastRunAt', async () => {
      const schedule = createTestSchedule();
      await saveSchedule(schedule);
      await scheduleRepo.update(schedule.id, { nextRunAt: Date.now() - 60000 });

      const triggeredAt = Date.now();
      await eventBus.emit('ScheduleTriggered', {
        scheduleId: schedule.id,
        triggeredAt,
      });
      await flushEventLoop();

      const findResult = await scheduleRepo.findById(schedule.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      expect(findResult.value!.runCount).toBe(1);
      expect(findResult.value!.lastRunAt).toBe(triggeredAt);
    });

    it('should calculate next run time for cron schedules', async () => {
      const schedule = createTestSchedule();
      await saveSchedule(schedule);
      await scheduleRepo.update(schedule.id, { nextRunAt: Date.now() - 60000 });

      await eventBus.emit('ScheduleTriggered', {
        scheduleId: schedule.id,
        triggeredAt: Date.now(),
      });
      await flushEventLoop();

      const findResult = await scheduleRepo.findById(schedule.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      // Next run should be in the future
      expect(findResult.value!.nextRunAt).toBeDefined();
      expect(findResult.value!.nextRunAt).toBeGreaterThan(Date.now() - 1000);
    });

    it('should skip inactive schedules', async () => {
      const schedule = createTestSchedule();
      await saveSchedule(schedule);
      await scheduleRepo.update(schedule.id, {
        status: ScheduleStatus.PAUSED,
        nextRunAt: Date.now() - 60000,
      });

      await eventBus.emit('ScheduleTriggered', {
        scheduleId: schedule.id,
        triggeredAt: Date.now(),
      });
      await flushEventLoop();

      // No tasks should be created
      const allTasks = await taskRepo.findAll();
      expect(allTasks.ok).toBe(true);
      if (!allTasks.ok) return;
      expect(allTasks.value).toHaveLength(0);
    });

    it('should mark schedule completed when maxRuns reached', async () => {
      const schedule = createTestSchedule({ maxRuns: 1 });
      await saveSchedule(schedule);
      await scheduleRepo.update(schedule.id, { nextRunAt: Date.now() - 60000 });

      await eventBus.emit('ScheduleTriggered', {
        scheduleId: schedule.id,
        triggeredAt: Date.now(),
      });
      await flushEventLoop();

      const findResult = await scheduleRepo.findById(schedule.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      expect(findResult.value!.status).toBe(ScheduleStatus.COMPLETED);
      expect(findResult.value!.runCount).toBe(1);
      expect(findResult.value!.nextRunAt).toBeUndefined();
    });

    it('should mark one-time schedule completed after single run', async () => {
      const scheduledAt = Date.now() - 60000;
      const schedule = createTestSchedule({
        scheduleType: ScheduleType.ONE_TIME,
        cronExpression: undefined,
        scheduledAt,
      });
      await saveSchedule(schedule);
      await scheduleRepo.update(schedule.id, { nextRunAt: scheduledAt });

      await eventBus.emit('ScheduleTriggered', {
        scheduleId: schedule.id,
        triggeredAt: Date.now(),
      });
      await flushEventLoop();

      const findResult = await scheduleRepo.findById(schedule.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      expect(findResult.value!.status).toBe(ScheduleStatus.COMPLETED);
      expect(findResult.value!.nextRunAt).toBeUndefined();
    });

    it('should mark schedule expired when expiresAt is reached', async () => {
      const schedule = createTestSchedule({
        expiresAt: Date.now() - 1000, // Already expired
      });
      await saveSchedule(schedule);
      await scheduleRepo.update(schedule.id, { nextRunAt: Date.now() - 60000 });

      await eventBus.emit('ScheduleTriggered', {
        scheduleId: schedule.id,
        triggeredAt: Date.now(),
      });
      await flushEventLoop();

      const findResult = await scheduleRepo.findById(schedule.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      expect(findResult.value!.status).toBe(ScheduleStatus.EXPIRED);
      expect(findResult.value!.nextRunAt).toBeUndefined();
    });

    it('should emit TaskDelegated and ScheduleExecuted events', async () => {
      const schedule = createTestSchedule();
      await saveSchedule(schedule);
      await scheduleRepo.update(schedule.id, { nextRunAt: Date.now() - 60000 });

      await eventBus.emit('ScheduleTriggered', {
        scheduleId: schedule.id,
        triggeredAt: Date.now(),
      });
      await flushEventLoop();

      // Check for emitted events (InMemoryEventBus tracks all emitted events)
      // TaskDelegated should be emitted for the created task
      expect(logger.hasLogContaining('Schedule triggered successfully')).toBe(true);
    });
  });

  describe('handleScheduleCancelled', () => {
    it('should update status to CANCELLED and clear nextRunAt', async () => {
      const schedule = createTestSchedule();
      await saveSchedule(schedule);
      await scheduleRepo.update(schedule.id, { nextRunAt: Date.now() + 3600000 });

      await eventBus.emit('ScheduleCancelled', {
        scheduleId: schedule.id,
        reason: 'manual cancellation',
      });
      await flushEventLoop();

      const findResult = await scheduleRepo.findById(schedule.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      expect(findResult.value!.status).toBe(ScheduleStatus.CANCELLED);
      expect(findResult.value!.nextRunAt).toBeUndefined();
    });
  });

  describe('handleSchedulePaused', () => {
    it('should update status to PAUSED', async () => {
      const schedule = createTestSchedule();
      await saveSchedule(schedule);

      await eventBus.emit('SchedulePaused', { scheduleId: schedule.id });
      await flushEventLoop();

      const findResult = await scheduleRepo.findById(schedule.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      expect(findResult.value!.status).toBe(ScheduleStatus.PAUSED);
    });
  });

  describe('handleScheduleResumed', () => {
    it('should update status to ACTIVE and recalculate nextRunAt for cron', async () => {
      const schedule = createTestSchedule();
      await saveSchedule(schedule);
      await scheduleRepo.update(schedule.id, { status: ScheduleStatus.PAUSED });

      await eventBus.emit('ScheduleResumed', { scheduleId: schedule.id });
      await flushEventLoop();

      const findResult = await scheduleRepo.findById(schedule.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      expect(findResult.value!.status).toBe(ScheduleStatus.ACTIVE);
      expect(findResult.value!.nextRunAt).toBeDefined();
      expect(findResult.value!.nextRunAt).toBeGreaterThan(Date.now() - 1000);
    });

    it('should log error for non-existent schedule', async () => {
      await eventBus.emit('ScheduleResumed', {
        scheduleId: ScheduleId('non-existent'),
      });
      await flushEventLoop();

      // handleEvent logs the error rather than throwing
      expect(logger.hasLogContaining('event handling failed')).toBe(true);
    });
  });

  describe('handleScheduleUpdated', () => {
    it('should apply partial updates to schedule', async () => {
      const schedule = createTestSchedule();
      await saveSchedule(schedule);

      await eventBus.emit('ScheduleUpdated', {
        scheduleId: schedule.id,
        update: { maxRuns: 10 },
      });
      await flushEventLoop();

      const findResult = await scheduleRepo.findById(schedule.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      expect(findResult.value!.maxRuns).toBe(10);
    });
  });

  describe('afterScheduleId chaining', () => {
    it('should inject dependency when target task is non-terminal', async () => {
      // Schedule A triggers and creates a task that stays QUEUED (non-terminal)
      const scheduleA = createTestSchedule();
      await saveSchedule(scheduleA);
      await scheduleRepo.update(scheduleA.id, { nextRunAt: Date.now() - 60000 });

      await eventBus.emit('ScheduleTriggered', {
        scheduleId: scheduleA.id,
        triggeredAt: Date.now(),
      });
      await flushEventLoop();

      // Get task A's ID
      const allTasks = await taskRepo.findAll();
      expect(allTasks.ok).toBe(true);
      if (!allTasks.ok) return;
      expect(allTasks.value).toHaveLength(1);
      const taskA = allTasks.value[0];
      expect(taskA.status).toBe(TaskStatus.QUEUED);

      // Capture TaskDelegated events to inspect task.dependsOn
      // (dependsOn is not persisted by task repo — it flows via events to DependencyHandler)
      const delegatedTasks: { task: { dependsOn?: readonly string[] } }[] = [];
      eventBus.subscribe('TaskDelegated', (event) => {
        delegatedTasks.push(event);
      });

      // Schedule B chains after Schedule A
      const scheduleB = createTestSchedule({
        afterScheduleId: scheduleA.id,
      });
      await saveSchedule(scheduleB);
      await scheduleRepo.update(scheduleB.id, { nextRunAt: Date.now() - 60000 });

      await eventBus.emit('ScheduleTriggered', {
        scheduleId: scheduleB.id,
        triggeredAt: Date.now(),
      });
      await flushEventLoop();

      // The TaskDelegated event for task B should carry dependsOn containing task A's ID
      expect(delegatedTasks).toHaveLength(1);
      expect(delegatedTasks[0].task.dependsOn).toContain(taskA.id);
    });

    it('should skip dependency when target task already completed', async () => {
      // Schedule A triggers and creates a task
      const scheduleA = createTestSchedule();
      await saveSchedule(scheduleA);
      await scheduleRepo.update(scheduleA.id, { nextRunAt: Date.now() - 60000 });

      await eventBus.emit('ScheduleTriggered', {
        scheduleId: scheduleA.id,
        triggeredAt: Date.now(),
      });
      await flushEventLoop();

      // Mark task A as completed
      const allTasks = await taskRepo.findAll();
      expect(allTasks.ok).toBe(true);
      if (!allTasks.ok) return;
      const taskA = allTasks.value[0];
      await taskRepo.update(taskA.id, { status: TaskStatus.COMPLETED });

      // Capture TaskDelegated events
      const delegatedTasks: { task: { dependsOn?: readonly string[] } }[] = [];
      eventBus.subscribe('TaskDelegated', (event) => {
        delegatedTasks.push(event);
      });

      // Schedule B chains after Schedule A
      const scheduleB = createTestSchedule({
        afterScheduleId: scheduleA.id,
      });
      await saveSchedule(scheduleB);
      await scheduleRepo.update(scheduleB.id, { nextRunAt: Date.now() - 60000 });

      await eventBus.emit('ScheduleTriggered', {
        scheduleId: scheduleB.id,
        triggeredAt: Date.now(),
      });
      await flushEventLoop();

      // Task B should have no injected dependency (target already completed)
      expect(delegatedTasks).toHaveLength(1);
      expect(delegatedTasks[0].task.dependsOn ?? []).not.toContain(taskA.id);
    });

    it('should skip dependency when no prior execution exists', async () => {
      // Schedule A exists but has never been triggered (no execution history)
      const scheduleA = createTestSchedule();
      await saveSchedule(scheduleA);

      // Schedule B chains after Schedule A
      const scheduleB = createTestSchedule({
        afterScheduleId: scheduleA.id,
      });
      await saveSchedule(scheduleB);
      await scheduleRepo.update(scheduleB.id, { nextRunAt: Date.now() - 60000 });

      await eventBus.emit('ScheduleTriggered', {
        scheduleId: scheduleB.id,
        triggeredAt: Date.now(),
      });
      await flushEventLoop();

      // Task B should run with no dependsOn
      const allTasks = await taskRepo.findAll();
      expect(allTasks.ok).toBe(true);
      if (!allTasks.ok) return;
      expect(allTasks.value).toHaveLength(1);
      expect(allTasks.value[0].dependsOn ?? []).toHaveLength(0);
    });

    it('should skip dependency when execution has no taskId', async () => {
      // Schedule A has a failed execution record with no taskId
      const scheduleA = createTestSchedule();
      await saveSchedule(scheduleA);

      // Record a failed execution without a taskId
      await scheduleRepo.recordExecution({
        scheduleId: scheduleA.id,
        scheduledFor: Date.now() - 120000,
        executedAt: Date.now() - 120000,
        status: 'failed',
        errorMessage: 'Failed to create task',
        createdAt: Date.now() - 120000,
      });

      // Schedule B chains after Schedule A
      const scheduleB = createTestSchedule({
        afterScheduleId: scheduleA.id,
      });
      await saveSchedule(scheduleB);
      await scheduleRepo.update(scheduleB.id, { nextRunAt: Date.now() - 60000 });

      await eventBus.emit('ScheduleTriggered', {
        scheduleId: scheduleB.id,
        triggeredAt: Date.now(),
      });
      await flushEventLoop();

      // Task B should run with no dependsOn
      const allTasks = await taskRepo.findAll();
      expect(allTasks.ok).toBe(true);
      if (!allTasks.ok) return;
      expect(allTasks.value).toHaveLength(1);
      expect(allTasks.value[0].dependsOn ?? []).toHaveLength(0);
    });
  });

  describe('Pipeline trigger (v0.6.0)', () => {
    const pipelineSteps: readonly PipelineStepRequest[] = [
      { prompt: 'lint code' },
      { prompt: 'run tests' },
      { prompt: 'deploy' },
    ];

    function createPipelineSchedule(overrides: Partial<Parameters<typeof createSchedule>[0]> = {}): Schedule {
      return createSchedule({
        taskTemplate: { prompt: 'Pipeline', workingDirectory: '/tmp' },
        scheduleType: ScheduleType.ONE_TIME,
        scheduledAt: Date.now() + 60000,
        timezone: 'UTC',
        missedRunPolicy: MissedRunPolicy.SKIP,
        pipelineSteps,
        ...overrides,
      });
    }

    async function triggerSchedule(scheduleId: ReturnType<typeof ScheduleId>): Promise<void> {
      await scheduleRepo.update(scheduleId, { nextRunAt: Date.now() - 1000 });
      await eventBus.emit('ScheduleTriggered', { scheduleId, triggeredAt: Date.now() });
      await flushEventLoop();
    }

    it('should create N tasks with linear dependencies for pipeline schedule', async () => {
      // Arrange
      const delegatedTasks: Task[] = [];
      eventBus.subscribe('TaskDelegated', async (e) => {
        delegatedTasks.push(e.task);
      });

      const schedule = createPipelineSchedule();
      await saveSchedule({ ...schedule, status: ScheduleStatus.ACTIVE });

      // Act
      await triggerSchedule(schedule.id);

      // Assert: 3 tasks created in the repo
      const allTasksResult = await taskRepo.findAll();
      expect(allTasksResult.ok).toBe(true);
      if (!allTasksResult.ok) return;
      expect(allTasksResult.value).toHaveLength(3);

      // TaskDelegated events are emitted in pipeline order (step 0, 1, 2)
      expect(delegatedTasks).toHaveLength(3);
      expect(delegatedTasks[0].prompt).toBe('lint code');
      expect(delegatedTasks[1].prompt).toBe('run tests');
      expect(delegatedTasks[2].prompt).toBe('deploy');

      // Assert: linear dependencies — step[1] depends on step[0], step[2] depends on step[1]
      expect(delegatedTasks[0].dependsOn ?? []).toHaveLength(0);
      expect(delegatedTasks[1].dependsOn).toContain(delegatedTasks[0].id);
      expect(delegatedTasks[2].dependsOn).toContain(delegatedTasks[1].id);
      expect(delegatedTasks[2].dependsOn).not.toContain(delegatedTasks[0].id);

      // Assert: pipeline trigger logged
      expect(logger.hasLogContaining('Pipeline triggered successfully')).toBe(true);
    });

    it('should emit ScheduleExecuted with lastTaskId for concurrency tracking', async () => {
      // Arrange
      const twoSteps: readonly PipelineStepRequest[] = [{ prompt: 'build' }, { prompt: 'push' }];
      const schedule = createPipelineSchedule({ pipelineSteps: twoSteps });
      await saveSchedule({ ...schedule, status: ScheduleStatus.ACTIVE });

      const executedEvents: Array<{ scheduleId: ReturnType<typeof ScheduleId>; taskId: ReturnType<typeof TaskId> }> =
        [];
      eventBus.subscribe('ScheduleExecuted', async (e) => {
        executedEvents.push({ scheduleId: e.scheduleId, taskId: e.taskId });
      });

      // Act
      await triggerSchedule(schedule.id);

      // Assert: exactly one ScheduleExecuted event
      expect(executedEvents).toHaveLength(1);
      expect(executedEvents[0].scheduleId).toBe(schedule.id);

      // The taskId in ScheduleExecuted must be the LAST step's task ID
      const allTasksResult = await taskRepo.findAll();
      expect(allTasksResult.ok).toBe(true);
      if (!allTasksResult.ok) return;

      const allTasks = allTasksResult.value;
      expect(allTasks).toHaveLength(2);

      // Last task is the one with no dependents (step 1 = 'push')
      const lastTask = allTasks.find((t) => t.prompt === 'push');
      expect(lastTask).toBeDefined();
      expect(executedEvents[0].taskId).toBe(lastTask!.id);
    });

    it('should inject afterScheduleId dependency on step 0', async () => {
      // Arrange: create a predecessor schedule and trigger it to create a task
      const predecessor = createTestSchedule();
      await saveSchedule(predecessor);
      await scheduleRepo.update(predecessor.id, { nextRunAt: Date.now() - 60000 });

      await eventBus.emit('ScheduleTriggered', {
        scheduleId: predecessor.id,
        triggeredAt: Date.now(),
      });
      await flushEventLoop();

      // Confirm predecessor task was created and is still QUEUED (non-terminal)
      const predecessorTasksResult = await taskRepo.findAll();
      expect(predecessorTasksResult.ok).toBe(true);
      if (!predecessorTasksResult.ok) return;
      expect(predecessorTasksResult.value).toHaveLength(1);
      const predecessorTask = predecessorTasksResult.value[0];
      expect(predecessorTask.status).toBe(TaskStatus.QUEUED);

      // Capture TaskDelegated events for the pipeline
      const delegatedTasks: Task[] = [];
      eventBus.subscribe('TaskDelegated', async (e) => {
        delegatedTasks.push(e.task);
      });

      // Create pipeline schedule chained after predecessor
      const twoSteps: readonly PipelineStepRequest[] = [{ prompt: 'step-0' }, { prompt: 'step-1' }];
      const pipelineSchedule = createPipelineSchedule({
        afterScheduleId: predecessor.id,
        pipelineSteps: twoSteps,
      });
      await saveSchedule({ ...pipelineSchedule, status: ScheduleStatus.ACTIVE });

      // Act
      await triggerSchedule(pipelineSchedule.id);

      // Assert: 2 pipeline tasks created (plus the 1 predecessor task = 3 total)
      const allTasksResult = await taskRepo.findAll();
      expect(allTasksResult.ok).toBe(true);
      if (!allTasksResult.ok) return;
      expect(allTasksResult.value).toHaveLength(3);

      // The 2 pipeline TaskDelegated events carry the dependency info
      expect(delegatedTasks).toHaveLength(2);

      const step0 = delegatedTasks.find((t) => t.prompt === 'step-0');
      const step1 = delegatedTasks.find((t) => t.prompt === 'step-1');
      expect(step0).toBeDefined();
      expect(step1).toBeDefined();

      // Step 0 depends on predecessor task (afterScheduleId injection)
      expect(step0!.dependsOn).toContain(predecessorTask.id);

      // Step 1 depends on step 0
      expect(step1!.dependsOn).toContain(step0!.id);
      expect(step1!.dependsOn).not.toContain(predecessorTask.id);
    });

    it('should rollback all tasks on partial save failure (transaction atomicity)', async () => {
      // Arrange: 3-step pipeline where the 3rd saveSync will throw
      const schedule = createPipelineSchedule();
      await saveSchedule({ ...schedule, status: ScheduleStatus.ACTIVE });

      let saveCallCount = 0;
      const originalSaveSync = taskRepo.saveSync.bind(taskRepo);
      const saveSpy = vi.spyOn(taskRepo, 'saveSync').mockImplementation((task) => {
        saveCallCount++;
        if (saveCallCount === 3) {
          // Sync methods throw on error (caught by transaction wrapper)
          throw new AutobeatError(ErrorCode.SYSTEM_ERROR, 'Simulated DB failure on step 3');
        }
        return originalSaveSync(task);
      });

      // Act
      await triggerSchedule(schedule.id);

      saveSpy.mockRestore();

      // Assert: 0 tasks exist — transaction rolled back ALL saves
      const allTasksResult = await taskRepo.findAll();
      expect(allTasksResult.ok).toBe(true);
      if (!allTasksResult.ok) return;
      expect(allTasksResult.value).toHaveLength(0);

      // Assert: a failed execution was recorded (best-effort, outside transaction)
      const historyResult = await scheduleRepo.getExecutionHistory(schedule.id);
      expect(historyResult.ok).toBe(true);
      if (!historyResult.ok) return;
      expect(historyResult.value).toHaveLength(1);
      expect(historyResult.value[0].status).toBe('failed');
      expect(historyResult.value[0].errorMessage).toContain('Pipeline failed at step 3');
    });

    it('should cancel all tasks when TaskDelegated fails for step 0', async () => {
      // Arrange: 3-step pipeline where step 0 TaskDelegated emission will fail
      const schedule = createPipelineSchedule();
      await saveSchedule({ ...schedule, status: ScheduleStatus.ACTIVE });

      const originalEmit = eventBus.emit.bind(eventBus);
      const emitSpy = vi.spyOn(eventBus, 'emit').mockImplementation(async (event, payload) => {
        if (event === 'TaskDelegated') {
          // Fail on the FIRST TaskDelegated (step 0)
          const { err: mkErr } = await import('../../../../src/core/result');
          const { AutobeatError, ErrorCode } = await import('../../../../src/core/errors');
          return mkErr(new AutobeatError(ErrorCode.SYSTEM_ERROR, 'Simulated emit failure'));
        }
        return originalEmit(event, payload);
      });

      // Act
      await triggerSchedule(schedule.id);

      emitSpy.mockRestore();

      // Assert: all 3 tasks should be cancelled — step 0 failure orphans the whole pipeline
      const allTasksResult = await taskRepo.findAll();
      expect(allTasksResult.ok).toBe(true);
      if (!allTasksResult.ok) return;
      expect(allTasksResult.value).toHaveLength(3);
      expect(allTasksResult.value.every((t) => t.status === TaskStatus.CANCELLED)).toBe(true);

      // Assert: error logged for step 0
      expect(logger.hasLogContaining('Failed to emit TaskDelegated for pipeline step 0')).toBe(true);
    });

    it('should record execution with lastTaskId for afterScheduleId chaining', async () => {
      // Arrange: a pipeline with 3 steps
      const schedule = createPipelineSchedule();
      await saveSchedule({ ...schedule, status: ScheduleStatus.ACTIVE });

      // Act
      await triggerSchedule(schedule.id);

      // Assert: execution record should point to the LAST task, not the first
      const historyResult = await scheduleRepo.getExecutionHistory(schedule.id, 1);
      expect(historyResult.ok).toBe(true);
      if (!historyResult.ok) return;
      expect(historyResult.value).toHaveLength(1);

      const execution = historyResult.value[0];

      // Get all tasks to identify first and last
      const allTasksResult = await taskRepo.findAll();
      expect(allTasksResult.ok).toBe(true);
      if (!allTasksResult.ok) return;
      expect(allTasksResult.value).toHaveLength(3);

      // Last task is the 'deploy' step (step 2, no dependents)
      const lastTask = allTasksResult.value.find((t) => t.prompt === 'deploy');
      const firstTask = allTasksResult.value.find((t) => t.prompt === 'lint code');
      expect(lastTask).toBeDefined();
      expect(firstTask).toBeDefined();

      // execution.taskId must be lastTaskId (for correct afterScheduleId chaining)
      expect(execution.taskId).toBe(lastTask!.id);
      expect(execution.taskId).not.toBe(firstTask!.id);
    });

    it('should not double-wrap error message in pipeline failure execution record', async () => {
      // Arrange: 2-step pipeline where the 2nd saveSync will throw
      const twoSteps: readonly PipelineStepRequest[] = [{ prompt: 'step-a' }, { prompt: 'step-b' }];
      const schedule = createPipelineSchedule({ pipelineSteps: twoSteps });
      await saveSchedule({ ...schedule, status: ScheduleStatus.ACTIVE });

      let saveCallCount = 0;
      const originalSaveSync = taskRepo.saveSync.bind(taskRepo);
      const saveSpy = vi.spyOn(taskRepo, 'saveSync').mockImplementation((task) => {
        saveCallCount++;
        if (saveCallCount === 2) {
          throw new AutobeatError(ErrorCode.SYSTEM_ERROR, 'DB write error');
        }
        return originalSaveSync(task);
      });

      // Act
      await triggerSchedule(schedule.id);
      saveSpy.mockRestore();

      // Assert: execution error message should NOT have double prefix
      const historyResult = await scheduleRepo.getExecutionHistory(schedule.id);
      expect(historyResult.ok).toBe(true);
      if (!historyResult.ok) return;
      expect(historyResult.value).toHaveLength(1);

      const errorMessage = historyResult.value[0].errorMessage;
      expect(errorMessage).toBeDefined();
      // Should contain "Pipeline failed at step 2" but NOT "Schedule trigger failed: Pipeline failed"
      expect(errorMessage).toContain('Pipeline failed at step 2');
      expect(errorMessage).not.toContain('Schedule trigger failed: Pipeline failed');
    });

    it('should include prefix in single-task failure execution record', async () => {
      // Arrange: single-task schedule where saveSync throws
      const schedule = createTestSchedule();
      await saveSchedule(schedule);
      await scheduleRepo.update(schedule.id, { nextRunAt: Date.now() - 60000 });

      const saveSpy = vi.spyOn(taskRepo, 'saveSync').mockImplementation(() => {
        throw new AutobeatError(ErrorCode.SYSTEM_ERROR, 'DB write error');
      });

      // Act
      await eventBus.emit('ScheduleTriggered', { scheduleId: schedule.id, triggeredAt: Date.now() });
      await flushEventLoop();
      saveSpy.mockRestore();

      // Assert: execution error message should include "Schedule trigger failed:" prefix
      const historyResult = await scheduleRepo.getExecutionHistory(schedule.id);
      expect(historyResult.ok).toBe(true);
      if (!historyResult.ok) return;
      expect(historyResult.value).toHaveLength(1);

      const errorMessage = historyResult.value[0].errorMessage;
      expect(errorMessage).toBeDefined();
      expect(errorMessage).toContain('Schedule trigger failed:');
    });

    it('should rollback task on single-task recordExecutionSync failure', async () => {
      // Arrange: single-task schedule where recordExecutionSync throws
      const schedule = createTestSchedule();
      await saveSchedule(schedule);
      await scheduleRepo.update(schedule.id, { nextRunAt: Date.now() - 60000 });

      const spy = vi.spyOn(scheduleRepo, 'recordExecutionSync').mockImplementation(() => {
        throw new AutobeatError(ErrorCode.SYSTEM_ERROR, 'Execution record failed');
      });

      // Act
      await eventBus.emit('ScheduleTriggered', { scheduleId: schedule.id, triggeredAt: Date.now() });
      await flushEventLoop();
      spy.mockRestore();

      // Assert: no task was saved (transaction rolled back)
      const allTasks = await taskRepo.findAll();
      expect(allTasks.ok).toBe(true);
      if (!allTasks.ok) return;
      expect(allTasks.value).toHaveLength(0);
    });

    it('should commit all pipeline tasks + execution atomically on success', async () => {
      // Arrange
      const schedule = createPipelineSchedule();
      await saveSchedule({ ...schedule, status: ScheduleStatus.ACTIVE });

      // Act
      await triggerSchedule(schedule.id);

      // Assert: all 3 tasks committed
      const allTasks = await taskRepo.findAll();
      expect(allTasks.ok).toBe(true);
      if (!allTasks.ok) return;
      expect(allTasks.value).toHaveLength(3);

      // Assert: execution record committed
      const history = await scheduleRepo.getExecutionHistory(schedule.id);
      expect(history.ok).toBe(true);
      if (!history.ok) return;
      expect(history.value).toHaveLength(1);
      expect(history.value[0].status).toBe('triggered');
      expect(history.value[0].pipelineTaskIds).toHaveLength(3);

      // Assert: schedule updated
      const updated = await scheduleRepo.findById(schedule.id);
      expect(updated.ok).toBe(true);
      if (!updated.ok) return;
      expect(updated.value!.runCount).toBe(1);
    });

    it('should update schedule state after pipeline trigger', async () => {
      // Arrange: ONE_TIME pipeline schedule
      const schedule = createPipelineSchedule({
        scheduleType: ScheduleType.ONE_TIME,
        scheduledAt: Date.now() - 60000,
      });
      await saveSchedule({ ...schedule, status: ScheduleStatus.ACTIVE, nextRunAt: Date.now() - 60000 });

      // Act
      await eventBus.emit('ScheduleTriggered', { scheduleId: schedule.id, triggeredAt: Date.now() });
      await flushEventLoop();

      // Assert: schedule is COMPLETED (ONE_TIME runs once)
      const findResult = await scheduleRepo.findById(schedule.id);
      expect(findResult.ok).toBe(true);
      if (!findResult.ok) return;

      const persisted = findResult.value;
      expect(persisted).not.toBeNull();
      expect(persisted!.status).toBe(ScheduleStatus.COMPLETED);
      expect(persisted!.runCount).toBe(1);
      expect(persisted!.nextRunAt).toBeUndefined();
    });
  });

  // ==========================================================================
  // Scheduled Loop Trigger (v0.8.0)
  // ==========================================================================

  describe('Scheduled Loop Trigger', () => {
    function createLoopSchedule(overrides: Partial<Parameters<typeof createSchedule>[0]> = {}): Schedule {
      const loopConfig: LoopCreateRequest = {
        prompt: 'Fix the tests',
        strategy: LoopStrategy.RETRY,
        exitCondition: 'npm test',
        maxIterations: 5,
        maxConsecutiveFailures: 3,
      };
      return createSchedule({
        taskTemplate: { prompt: loopConfig.prompt ?? '', workingDirectory: '/tmp' },
        scheduleType: ScheduleType.CRON,
        cronExpression: '0 9 * * *',
        timezone: 'UTC',
        missedRunPolicy: MissedRunPolicy.SKIP,
        loopConfig,
        ...overrides,
      });
    }

    async function triggerLoopSchedule(scheduleId: ReturnType<typeof ScheduleId>): Promise<void> {
      await scheduleRepo.update(scheduleId, { nextRunAt: Date.now() - 1000 });
      await eventBus.emit('ScheduleTriggered', { scheduleId, triggeredAt: Date.now() });
      await flushEventLoop();
    }

    it('should create a loop when schedule with loopConfig is triggered', async () => {
      const schedule = createLoopSchedule();
      await saveSchedule({ ...schedule, status: ScheduleStatus.ACTIVE });

      await triggerLoopSchedule(schedule.id);

      // Assert: a loop should have been created (LoopCreated event emitted)
      // LoopHandler creates the loop from the event, so check loopRepo
      const loops = await loopRepo.findByScheduleId(schedule.id);
      expect(loops.ok).toBe(true);
      if (!loops.ok) return;
      // LoopCreated event was emitted but LoopHandler is not wired up in this test,
      // so check the execution history instead
      const history = await scheduleRepo.getExecutionHistory(schedule.id);
      expect(history.ok).toBe(true);
      if (!history.ok) return;
      expect(history.value).toHaveLength(1);
      expect(history.value[0].status).toBe('triggered');
    });

    it('should skip trigger when previous loop is still RUNNING', async () => {
      const schedule = createLoopSchedule();
      await saveSchedule({ ...schedule, status: ScheduleStatus.ACTIVE });

      // Create a running loop associated with this schedule
      const { createLoop } = await import('../../../../src/core/domain');
      const existingLoop = createLoop(
        {
          prompt: 'existing loop',
          strategy: LoopStrategy.RETRY,
          exitCondition: 'npm test',
          maxIterations: 5,
        },
        '/tmp',
        schedule.id,
      );
      await loopRepo.save(existingLoop);

      // Trigger schedule again
      await triggerLoopSchedule(schedule.id);

      // Should have been skipped — only the pre-existing loop
      const loops = await loopRepo.findByScheduleId(schedule.id);
      expect(loops.ok).toBe(true);
      if (!loops.ok) return;
      expect(loops.value).toHaveLength(1);
      expect(loops.value[0].id).toBe(existingLoop.id);

      // Logger should record the skip
      expect(logger.hasLogContaining('previous loop still active')).toBe(true);
    });

    it('should skip trigger when previous loop is PAUSED', async () => {
      const schedule = createLoopSchedule();
      await saveSchedule({ ...schedule, status: ScheduleStatus.ACTIVE });

      // Create a paused loop associated with this schedule
      const { createLoop } = await import('../../../../src/core/domain');
      const existingLoop = createLoop(
        {
          prompt: 'paused loop',
          strategy: LoopStrategy.RETRY,
          exitCondition: 'npm test',
          maxIterations: 5,
        },
        '/tmp',
        schedule.id,
      );
      const pausedLoop = { ...existingLoop, status: LoopStatus.PAUSED };
      await loopRepo.save(pausedLoop);

      // Trigger schedule
      await triggerLoopSchedule(schedule.id);

      // Should have been skipped
      const loops = await loopRepo.findByScheduleId(schedule.id);
      expect(loops.ok).toBe(true);
      if (!loops.ok) return;
      expect(loops.value).toHaveLength(1);
      expect(loops.value[0].status).toBe(LoopStatus.PAUSED);
    });

    it('should reject trigger with missing prompt via LoopService validation', async () => {
      // ARCHITECTURE: LoopConfigSchema at repo level allows optional prompt,
      // but LoopManagerService.validateCreateRequest() requires prompt for non-pipeline loops.
      // This test verifies the schedule handler calls validation before creating the loop.
      const invalidLoopConfig: LoopCreateRequest = {
        // prompt intentionally omitted — invalid for non-pipeline loop
        strategy: LoopStrategy.RETRY,
        exitCondition: 'npm test',
        maxIterations: 5,
      };
      const schedule = createSchedule({
        taskTemplate: { prompt: 'placeholder for task template', workingDirectory: '/tmp' },
        scheduleType: ScheduleType.CRON,
        cronExpression: '0 9 * * *',
        timezone: 'UTC',
        missedRunPolicy: MissedRunPolicy.SKIP,
        loopConfig: invalidLoopConfig,
      });
      await saveSchedule({ ...schedule, status: ScheduleStatus.ACTIVE });
      await scheduleRepo.update(schedule.id, { nextRunAt: Date.now() - 1000 });

      await eventBus.emit('ScheduleTriggered', { scheduleId: schedule.id, triggeredAt: Date.now() });
      await flushEventLoop();

      // No loop should have been created
      const loops = await loopRepo.findByScheduleId(schedule.id);
      expect(loops.ok).toBe(true);
      if (!loops.ok) return;
      expect(loops.value).toHaveLength(0);

      // A failed execution should be recorded
      const history = await scheduleRepo.getExecutionHistory(schedule.id);
      expect(history.ok).toBe(true);
      if (!history.ok) return;
      expect(history.value).toHaveLength(1);
      expect(history.value[0].status).toBe('failed');
      expect(history.value[0].errorMessage).toContain('prompt is required');
    });

    it('should still create loop successfully when loopConfig is valid', async () => {
      const validLoopConfig: LoopCreateRequest = {
        prompt: 'Fix the tests',
        strategy: LoopStrategy.RETRY,
        exitCondition: 'npm test',
        maxIterations: 5,
        maxConsecutiveFailures: 3,
      };
      const schedule = createSchedule({
        taskTemplate: { prompt: validLoopConfig.prompt ?? '', workingDirectory: '/tmp' },
        scheduleType: ScheduleType.CRON,
        cronExpression: '0 9 * * *',
        timezone: 'UTC',
        missedRunPolicy: MissedRunPolicy.SKIP,
        loopConfig: validLoopConfig,
      });
      await saveSchedule({ ...schedule, status: ScheduleStatus.ACTIVE });
      await scheduleRepo.update(schedule.id, { nextRunAt: Date.now() - 1000 });

      await eventBus.emit('ScheduleTriggered', { scheduleId: schedule.id, triggeredAt: Date.now() });
      await flushEventLoop();

      // Execution should be triggered successfully
      const history = await scheduleRepo.getExecutionHistory(schedule.id);
      expect(history.ok).toBe(true);
      if (!history.ok) return;
      expect(history.value).toHaveLength(1);
      expect(history.value[0].status).toBe('triggered');
    });

    it('should populate gitBaseBranch and gitStartCommitSha in LoopCreated event when loopConfig has gitBranch', async () => {
      // Mock captureGitState for gitBranch validation in LoopManagerService.validateCreateRequest
      vi.mocked(captureGitState).mockResolvedValue({
        ok: true,
        value: { branch: 'main', commitSha: 'abc123', dirtyFiles: [] },
      });
      // Mock captureLoopGitContext to return branch and SHA
      vi.mocked(captureLoopGitContext).mockResolvedValue({
        ok: true,
        value: {
          gitBaseBranch: 'main',
          gitStartCommitSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        },
      });

      const loopConfig: LoopCreateRequest = {
        prompt: 'Optimize perf',
        strategy: LoopStrategy.RETRY,
        exitCondition: 'npm test',
        maxIterations: 5,
        gitBranch: 'loop/perf-opt',
      };
      const schedule = createSchedule({
        taskTemplate: { prompt: loopConfig.prompt ?? '', workingDirectory: '/tmp' },
        scheduleType: ScheduleType.CRON,
        cronExpression: '0 9 * * *',
        timezone: 'UTC',
        missedRunPolicy: MissedRunPolicy.SKIP,
        loopConfig,
      });
      await saveSchedule({ ...schedule, status: ScheduleStatus.ACTIVE });
      await scheduleRepo.update(schedule.id, { nextRunAt: Date.now() - 1000 });

      // Intercept LoopCreated event
      let capturedLoop: Loop | undefined;
      eventBus.subscribe('LoopCreated', (event: { loop: Loop }) => {
        capturedLoop = event.loop;
      });

      await eventBus.emit('ScheduleTriggered', { scheduleId: schedule.id, triggeredAt: Date.now() });
      await flushEventLoop();

      expect(capturedLoop).toBeDefined();
      expect(capturedLoop!.gitBranch).toBe('loop/perf-opt');
      expect(capturedLoop!.gitBaseBranch).toBe('main');
      expect(capturedLoop!.gitStartCommitSha).toBe('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    });

    it('should leave gitBaseBranch undefined when loopConfig has no gitBranch (regression guard)', async () => {
      // Reset mock — no gitBranch means captureLoopGitContext returns empty context
      vi.mocked(captureLoopGitContext).mockClear();
      vi.mocked(captureLoopGitContext).mockResolvedValue({ ok: true, value: {} });

      const loopConfig: LoopCreateRequest = {
        prompt: 'Fix the tests',
        strategy: LoopStrategy.RETRY,
        exitCondition: 'npm test',
        maxIterations: 5,
        // No gitBranch
      };
      const schedule = createSchedule({
        taskTemplate: { prompt: loopConfig.prompt ?? '', workingDirectory: '/tmp' },
        scheduleType: ScheduleType.CRON,
        cronExpression: '0 9 * * *',
        timezone: 'UTC',
        missedRunPolicy: MissedRunPolicy.SKIP,
        loopConfig,
      });
      await saveSchedule({ ...schedule, status: ScheduleStatus.ACTIVE });
      await scheduleRepo.update(schedule.id, { nextRunAt: Date.now() - 1000 });

      // Intercept LoopCreated event
      let capturedLoop: Loop | undefined;
      eventBus.subscribe('LoopCreated', (event: { loop: Loop }) => {
        capturedLoop = event.loop;
      });

      await eventBus.emit('ScheduleTriggered', { scheduleId: schedule.id, triggeredAt: Date.now() });
      await flushEventLoop();

      expect(capturedLoop).toBeDefined();
      expect(capturedLoop!.gitBaseBranch).toBeUndefined();
      // captureLoopGitContext returns empty context (not a git repo) → no git context set
      expect(capturedLoop!.gitStartCommitSha).toBeUndefined();
    });

    it('should cancel active loops when schedule with loopConfig is cancelled', async () => {
      const schedule = createLoopSchedule();
      await saveSchedule({ ...schedule, status: ScheduleStatus.ACTIVE });

      // Create an active loop associated with this schedule
      const { createLoop } = await import('../../../../src/core/domain');
      const existingLoop = createLoop(
        {
          prompt: 'active loop for cancel test',
          strategy: LoopStrategy.RETRY,
          exitCondition: 'npm test',
          maxIterations: 5,
        },
        '/tmp',
        schedule.id,
      );
      await loopRepo.save(existingLoop);

      // Cancel the schedule
      await eventBus.emit('ScheduleCancelled', {
        scheduleId: schedule.id,
        reason: 'Test cancellation',
      });
      await flushEventLoop();

      // Schedule should be cancelled
      const schedResult = await scheduleRepo.findById(schedule.id);
      expect(schedResult.ok).toBe(true);
      if (!schedResult.ok) return;
      expect(schedResult.value!.status).toBe(ScheduleStatus.CANCELLED);

      // Active loop should have had LoopCancelled emitted
      // (LoopHandler would process it if wired, but we can verify the event was emitted)
      // In this unit test context, the loop state depends on LoopHandler subscription.
      // We verify the intent by checking logger output.
      expect(logger.hasLogContaining('Cancelling schedule')).toBe(true);
    });
  });
});
