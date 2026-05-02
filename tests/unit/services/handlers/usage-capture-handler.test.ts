/**
 * Unit tests for UsageCaptureHandler
 * ARCHITECTURE: Real in-memory SQLite + InMemoryEventBus — no process spawning.
 * Pattern: Behavior-driven, testing observable side-effects (usage row saved / not saved).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTask, TaskId } from '../../../../src/core/domain.js';
import { InMemoryEventBus } from '../../../../src/core/events/event-bus.js';
import { Database } from '../../../../src/implementations/database.js';
import { SQLiteOutputRepository } from '../../../../src/implementations/output-repository.js';
import { SQLiteTaskRepository } from '../../../../src/implementations/task-repository.js';
import { SQLiteUsageRepository } from '../../../../src/implementations/usage-repository.js';
import { UsageCaptureHandler } from '../../../../src/services/handlers/usage-capture-handler.js';
import { createTestConfiguration } from '../../../fixtures/factories.js';
import { TestLogger } from '../../../fixtures/test-doubles.js';
import { flushEventLoop } from '../../../utils/event-helpers.js';

// Minimal valid Claude JSON result appended to stdout
const makeClaudeResultJson = (inputTokens = 100, outputTokens = 50, cost = 0.001234): string =>
  JSON.stringify({
    type: 'result',
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    total_cost_usd: cost,
    model: 'claude-3-5-sonnet-20241022',
  });

describe('UsageCaptureHandler', () => {
  let handler: UsageCaptureHandler;
  let eventBus: InMemoryEventBus;
  let db: Database;
  let taskRepo: SQLiteTaskRepository;
  let outputRepo: SQLiteOutputRepository;
  let usageRepo: SQLiteUsageRepository;
  let logger: TestLogger;

  beforeEach(async () => {
    logger = new TestLogger();
    const config = createTestConfiguration();
    eventBus = new InMemoryEventBus(config, logger);
    db = new Database(':memory:');
    taskRepo = new SQLiteTaskRepository(db);
    outputRepo = new SQLiteOutputRepository(config, db);
    usageRepo = new SQLiteUsageRepository(db);

    const createResult = await UsageCaptureHandler.create({
      usageRepository: usageRepo,
      outputRepository: outputRepo,
      taskRepository: taskRepo,
      eventBus,
      logger,
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) throw new Error('Handler creation failed');
    handler = createResult.value;
  });

  afterEach(() => {
    eventBus.dispose();
    db.close();
  });

  describe('TaskCompleted — claude agent', () => {
    it('saves usage when task has claude agent and valid JSON output', async () => {
      const task = createTask({ prompt: 'build feature', agent: 'claude' });
      await taskRepo.save(task);
      await outputRepo.save(task.id, {
        stdout: [makeClaudeResultJson(200, 100, 0.005)],
        stderr: [],
        totalSize: 100,
      });

      await eventBus.emit('TaskCompleted', { taskId: task.id, exitCode: 0, duration: 1000 });
      await flushEventLoop();

      const usageResult = await usageRepo.get(task.id);
      expect(usageResult.ok).toBe(true);
      if (!usageResult.ok) return;
      expect(usageResult.value).not.toBeNull();

      const usage = usageResult.value!;
      expect(usage.taskId).toBe(task.id);
      expect(usage.inputTokens).toBe(200);
      expect(usage.outputTokens).toBe(100);
      expect(usage.totalCostUsd).toBeCloseTo(0.005);
      expect(usage.model).toBe('claude-3-5-sonnet-20241022');
    });

    it('does not save usage when output has no Claude JSON result', async () => {
      const task = createTask({ prompt: 'plain text', agent: 'claude' });
      await taskRepo.save(task);
      await outputRepo.save(task.id, {
        stdout: ['plain text output, no JSON'],
        stderr: [],
        totalSize: 30,
      });

      await eventBus.emit('TaskCompleted', { taskId: task.id, exitCode: 0, duration: 500 });
      await flushEventLoop();

      const usageResult = await usageRepo.get(task.id);
      expect(usageResult.ok).toBe(true);
      if (!usageResult.ok) return;
      expect(usageResult.value).toBeNull();
    });

    it('does not save usage when task has no output', async () => {
      const task = createTask({ prompt: 'no output', agent: 'claude' });
      await taskRepo.save(task);
      // No output saved for this task

      await eventBus.emit('TaskCompleted', { taskId: task.id, exitCode: 0, duration: 100 });
      await flushEventLoop();

      const usageResult = await usageRepo.get(task.id);
      expect(usageResult.ok).toBe(true);
      if (!usageResult.ok) return;
      expect(usageResult.value).toBeNull();
    });
  });

  describe('TaskCompleted — non-claude agent', () => {
    it('skips capture for codex agent', async () => {
      const task = createTask({ prompt: 'codex task', agent: 'codex' });
      await taskRepo.save(task);
      await outputRepo.save(task.id, {
        stdout: [makeClaudeResultJson()],
        stderr: [],
        totalSize: 100,
      });

      await eventBus.emit('TaskCompleted', { taskId: task.id, exitCode: 0, duration: 500 });
      await flushEventLoop();

      const usageResult = await usageRepo.get(task.id);
      expect(usageResult.ok).toBe(true);
      if (!usageResult.ok) return;
      expect(usageResult.value).toBeNull();
    });

  });

  describe('resilience — best-effort capture', () => {
    it('does not propagate error when task is not found in DB', async () => {
      // Emit event for non-existent task — handler should not throw
      const missingId = TaskId('task-does-not-exist');
      await expect(
        eventBus.emit('TaskCompleted', { taskId: missingId, exitCode: 0, duration: 0 }),
      ).resolves.toBeDefined();
      await flushEventLoop();

      // No usage saved and no crash
      const usageResult = await usageRepo.get(missingId);
      expect(usageResult.ok).toBe(true);
      expect(usageResult.value).toBeNull();
    });

    it('does not log error for missing task (task was deleted before capture)', async () => {
      const missingId = TaskId('task-deleted-early');
      await eventBus.emit('TaskCompleted', { taskId: missingId, exitCode: 0, duration: 0 });
      await flushEventLoop();

      // Should warn at most but not error
      const errorLogs = logger.getLogsByLevel('error');
      expect(errorLogs.length).toBe(0);
    });
  });

  describe('factory create()', () => {
    it('creates handler and subscribes to TaskCompleted', async () => {
      // Verify handler is properly subscribed by confirming a usage is captured
      const task = createTask({ prompt: 'verify subscription', agent: 'claude' });
      await taskRepo.save(task);
      await outputRepo.save(task.id, {
        stdout: [makeClaudeResultJson()],
        stderr: [],
        totalSize: 100,
      });

      await eventBus.emit('TaskCompleted', { taskId: task.id, exitCode: 0, duration: 100 });
      await flushEventLoop();

      const result = await usageRepo.get(task.id);
      expect(result.ok).toBe(true);
      expect(result.value).not.toBeNull();
    });
  });
});
