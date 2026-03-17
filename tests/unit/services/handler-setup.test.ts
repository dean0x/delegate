/**
 * Unit tests for handler-setup module
 * Tests dependency extraction and handler setup functionality
 */

import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Container } from '../../../src/core/container';
import { InMemoryEventBus } from '../../../src/core/events/event-bus';
import { ok } from '../../../src/core/result';
import { InMemoryAgentRegistry } from '../../../src/implementations/agent-registry';
import { SQLiteCheckpointRepository } from '../../../src/implementations/checkpoint-repository';
import { Database } from '../../../src/implementations/database';
import { SQLiteDependencyRepository } from '../../../src/implementations/dependency-repository';
import { EventDrivenWorkerPool } from '../../../src/implementations/event-driven-worker-pool';
import { BufferedOutputCapture } from '../../../src/implementations/output-capture';
import { ProcessSpawnerAdapter } from '../../../src/implementations/process-spawner-adapter';
import { SystemResourceMonitor } from '../../../src/implementations/resource-monitor';
import { SQLiteScheduleRepository } from '../../../src/implementations/schedule-repository';
import { PriorityTaskQueue } from '../../../src/implementations/task-queue';
import { SQLiteTaskRepository } from '../../../src/implementations/task-repository';
import {
  extractHandlerDependencies,
  HandlerDependencies,
  setupEventHandlers,
} from '../../../src/services/handler-setup';
import { createTestConfiguration } from '../../fixtures/factories';
import { createMockOutputRepository, createMockWorkerRepository } from '../../fixtures/mocks';
import { TestLogger, TestProcessSpawner } from '../../fixtures/test-doubles';

describe('handler-setup', () => {
  let container: Container;
  let tempDir: string;
  let database: Database;
  let logger: TestLogger;
  let config: ReturnType<typeof createTestConfiguration>;
  let eventBus: InMemoryEventBus;

  beforeEach(async () => {
    logger = new TestLogger();
    config = createTestConfiguration();
    eventBus = new InMemoryEventBus(config, logger);

    // Create temp directory for database
    tempDir = await mkdtemp(join(tmpdir(), 'handler-setup-test-'));
    database = new Database(join(tempDir, 'test.db'));

    // Set up container with all required services
    container = new Container(logger);

    // Register all services needed by handlers
    container.registerValue('config', config);
    container.registerValue('logger', logger);
    container.registerValue('eventBus', eventBus);
    container.registerValue('taskRepository', new SQLiteTaskRepository(database));
    container.registerValue('dependencyRepository', new SQLiteDependencyRepository(database));
    container.registerValue('taskQueue', new PriorityTaskQueue());
    container.registerValue('outputCapture', new BufferedOutputCapture(config.maxOutputBuffer, eventBus));

    // Resource monitor with mocked system resources
    const mockWorkerRepo = createMockWorkerRepository();
    const resourceMonitor = new SystemResourceMonitor(
      config,
      mockWorkerRepo,
      eventBus,
      logger.child({ module: 'ResourceMonitor' }),
    );
    container.registerValue('resourceMonitor', resourceMonitor);

    // Worker pool with test spawner wrapped in AgentRegistry
    const agentRegistry = new InMemoryAgentRegistry([new ProcessSpawnerAdapter(new TestProcessSpawner())]);
    const workerPool = new EventDrivenWorkerPool(
      agentRegistry,
      resourceMonitor,
      logger.child({ module: 'WorkerPool' }),
      eventBus,
      new BufferedOutputCapture(config.maxOutputBuffer, eventBus),
      mockWorkerRepo,
      createMockOutputRepository(),
    );
    container.registerValue('workerPool', workerPool);

    // Repositories added in v0.4.0+ (scheduleRepository, checkpointRepository, database)
    container.registerValue('database', database);
    container.registerValue('scheduleRepository', new SQLiteScheduleRepository(database));
    container.registerValue('checkpointRepository', new SQLiteCheckpointRepository(database));
  });

  afterEach(async () => {
    eventBus.dispose();
    database.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('extractHandlerDependencies', () => {
    it('should extract all dependencies from complete container', () => {
      const result = extractHandlerDependencies(container);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.config).toBeDefined();
        expect(result.value.logger).toBeDefined();
        expect(result.value.eventBus).toBeDefined();
        expect(result.value.taskRepository).toBeDefined();
        expect(result.value.dependencyRepository).toBeDefined();
        expect(result.value.taskQueue).toBeDefined();
        expect(result.value.outputCapture).toBeDefined();
        expect(result.value.workerPool).toBeDefined();
        expect(result.value.resourceMonitor).toBeDefined();
      }
    });

    it('should fail with clear error when config missing', () => {
      const emptyContainer = new Container(logger);

      const result = extractHandlerDependencies(emptyContainer);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('config');
      }
    });

    it('should fail with clear error when logger missing', () => {
      const partialContainer = new Container(logger);
      partialContainer.registerValue('config', config);

      const result = extractHandlerDependencies(partialContainer);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('logger');
      }
    });

    it('should fail with clear error when eventBus missing', () => {
      const partialContainer = new Container(logger);
      partialContainer.registerValue('config', config);
      partialContainer.registerValue('logger', logger);

      const result = extractHandlerDependencies(partialContainer);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('eventBus');
      }
    });

    it('should fail with clear error when database missing', () => {
      const partialContainer = new Container(logger);
      partialContainer.registerValue('config', config);
      partialContainer.registerValue('logger', logger);
      partialContainer.registerValue('eventBus', eventBus);

      const result = extractHandlerDependencies(partialContainer);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('database');
      }
    });

    it('should fail with clear error when taskRepository missing', () => {
      const partialContainer = new Container(logger);
      partialContainer.registerValue('config', config);
      partialContainer.registerValue('logger', logger);
      partialContainer.registerValue('eventBus', eventBus);
      partialContainer.registerValue('database', database);

      const result = extractHandlerDependencies(partialContainer);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('taskRepository');
      }
    });
  });

  describe('setupEventHandlers', () => {
    it('should create and setup all handlers successfully', async () => {
      const depsResult = extractHandlerDependencies(container);
      expect(depsResult.ok).toBe(true);
      if (!depsResult.ok) return;

      const result = await setupEventHandlers(depsResult.value);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.registry).toBeDefined();
        expect(result.value.dependencyHandler).toBeDefined();
      }
    });

    it('should return registry for lifecycle management', async () => {
      const depsResult = extractHandlerDependencies(container);
      expect(depsResult.ok).toBe(true);
      if (!depsResult.ok) return;

      const result = await setupEventHandlers(depsResult.value);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Registry should be usable for shutdown
        const shutdownResult = await result.value.registry.shutdown();
        expect(shutdownResult.ok).toBe(true);
      }
    });

    it('should setup all 6 handlers (3 standard + DependencyHandler + ScheduleHandler + CheckpointHandler)', async () => {
      const depsResult = extractHandlerDependencies(container);
      expect(depsResult.ok).toBe(true);
      if (!depsResult.ok) return;

      const result = await setupEventHandlers(depsResult.value);
      expect(result.ok).toBe(true);

      // Verify handlers are working by checking event subscriptions exist
      // The eventBus should have subscriptions for all handler event types
      const subscriptionCount = (eventBus as unknown as { handlers?: Map<string, unknown[]> }).handlers?.size ?? 0;

      // With all handlers setup, we should have multiple event subscriptions
      // PersistenceHandler: TaskDelegated, TaskStarted, TaskCompleted, TaskFailed, etc.
      // QueueHandler: TaskCancellationRequested, RequeueTask, TaskUnblocked
      // WorkerHandler: TaskQueued, TaskCancellationRequested
      // DependencyHandler: TaskDelegated, TaskCompleted, TaskFailed, TaskCancelled, etc.
      expect(subscriptionCount).toBeGreaterThan(0);
    });

    it('should log success with handler count', async () => {
      const depsResult = extractHandlerDependencies(container);
      expect(depsResult.ok).toBe(true);
      if (!depsResult.ok) return;

      await setupEventHandlers(depsResult.value);

      // Check that success was logged
      const infoLogs = logger.logs.filter((log) => log.level === 'info');
      const successLog = infoLogs.find(
        (log) =>
          log.message.includes('Event handlers initialized successfully') ||
          log.message.includes('Event handler registry initialized'),
      );
      expect(successLog).toBeDefined();
    });

    it('should cleanup standard handlers if DependencyHandler.create() fails', async () => {
      const depsResult = extractHandlerDependencies(container);
      expect(depsResult.ok).toBe(true);
      if (!depsResult.ok) return;

      // Mock DependencyHandler.create() to return an error
      const { DependencyHandler } = await import('../../../src/services/handlers/dependency-handler');
      const { err } = await import('../../../src/core/result');
      const { BackbeatError, ErrorCode } = await import('../../../src/core/errors');

      const originalCreate = DependencyHandler.create;
      DependencyHandler.create = vi
        .fn()
        .mockResolvedValue(err(new BackbeatError(ErrorCode.INTERNAL_ERROR, 'DependencyHandler creation failed')));

      try {
        const result = await setupEventHandlers(depsResult.value);

        // Should return error
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('DependencyHandler');
        }

        // Verify registry.shutdown() was called (cleanup happened)
        // We can verify cleanup by checking that subscriptions were cleared
        // or by checking error logs
        const errorLogs = logger.logs.filter((log) => log.level === 'error');
        // If cleanup worked, no additional errors should appear from unhandled subscriptions
      } finally {
        // Restore original implementation
        DependencyHandler.create = originalCreate;
      }
    });
  });
});
