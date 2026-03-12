/**
 * Test data factories for consistent, maintainable test data generation
 */

import { expect, vi } from 'vitest';
import type { Task, TaskRequest } from '../../src/core/domain';
import { createTask, Priority, TaskId, TaskStatus } from '../../src/core/domain';
import type { EventBus } from '../../src/core/events/event-bus';
import type {
  Logger,
  OutputCapture,
  ProcessSpawner,
  ResourceMonitor,
  TaskQueue,
  TaskRepository,
  WorkerPool,
} from '../../src/core/interfaces';
import type { Result } from '../../src/core/result';
import { ok } from '../../src/core/result';

// Test Constants
export const TEST_CONSTANTS = {
  // Time constants
  ONE_SECOND_MS: 1000,
  FIVE_SECONDS_MS: 5000,
  TWO_MINUTES_MS: 120000,
  THIRTY_MINUTES_MS: 1800000,
  ONE_HOUR_MS: 3600000,
  TWENTY_FOUR_HOURS_MS: 86400000,
  TIMEOUT_BUFFER_MS: 100,

  // Buffer size constants
  FIVE_HUNDRED_BYTES: 500,
  ONE_KB: 1024,
  FIVE_KB: 5120,
  TEN_MB: 10485760,
  TWENTY_MB: 20971520,
  FIVE_MB: 5242880,
  ONE_GB: 1073741824,
  TWO_GB: 2147483648,

  // Test data sizes
  SMALL_DATA_SIZE: 100,
  LARGE_DATA_SIZE: 2000,
  ONE_MB: 1048576,

  // Process IDs
  TEST_PID: 1234,

  // Worker IDs
  TEST_WORKER_ID: 'worker-1',

  // Task IDs
  TEST_TASK_ID_123: 'test-task-123',

  // Time offsets
  ONE_SECOND_OFFSET: 1000,
  TWO_SECOND_OFFSET: 2000,

  // Worker names
  WORKER_456: 'worker-456',
};

// Task Factory
export const TaskFactory = {
  basic: (overrides: Partial<TaskRequest> = {}): Task => {
    const request: TaskRequest = {
      prompt: 'test task',
      priority: Priority.P2,
      ...overrides,
    };
    return createTask(request);
  },

  withTimeout: (timeout: number = TEST_CONSTANTS.FIVE_SECONDS_MS): Task => {
    return TaskFactory.basic({ timeout });
  },

  withBuffer: (maxOutputBuffer: number = TEST_CONSTANTS.ONE_KB): Task => {
    return TaskFactory.basic({ maxOutputBuffer });
  },

  withTimeoutAndBuffer: (
    timeout: number = TEST_CONSTANTS.FIVE_SECONDS_MS,
    maxOutputBuffer: number = TEST_CONSTANTS.ONE_KB,
  ): Task => {
    return TaskFactory.basic({ timeout, maxOutputBuffer });
  },

  longRunning: (): Task => {
    return TaskFactory.basic({
      prompt: 'sleep 10',
      timeout: TEST_CONSTANTS.TWO_MINUTES_MS,
    });
  },

  highPriority: (): Task => {
    return TaskFactory.basic({
      prompt: 'urgent task',
      priority: Priority.P0,
    });
  },

  withWorkingDirectory: (workingDirectory: string = '/test/dir'): Task => {
    return TaskFactory.basic({ workingDirectory });
  },

  failed: (): Task => {
    const task = TaskFactory.basic();
    return {
      ...task,
      status: TaskStatus.FAILED,
      completedAt: Date.now(),
      exitCode: 1,
    };
  },

  completed: (): Task => {
    const task = TaskFactory.basic();
    return {
      ...task,
      status: TaskStatus.COMPLETED,
      completedAt: Date.now(),
      exitCode: 0,
    };
  },

  running: (): Task => {
    const task = TaskFactory.basic();
    return {
      ...task,
      status: TaskStatus.RUNNING,
      startedAt: Date.now(),
    };
  },
};

// Mock Factory
export const MockFactory = {
  processSpawner: (): ProcessSpawner => {
    const mockProcess = {
      pid: TEST_CONSTANTS.TEST_PID,
      on: vi.fn(),
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      kill: vi.fn(),
      killed: false,
    };

    return {
      spawn: vi.fn().mockReturnValue(
        ok({
          process: mockProcess,
          pid: TEST_CONSTANTS.TEST_PID,
        }),
      ),
      kill: vi.fn().mockReturnValue(ok(undefined)),
    } as ProcessSpawner;
  },

  resourceMonitor: (canSpawn: boolean = true): ResourceMonitor => {
    return {
      canSpawnWorker: vi.fn().mockResolvedValue(ok(canSpawn)),
      incrementWorkerCount: vi.fn(),
      decrementWorkerCount: vi.fn(),
      getResources: vi.fn().mockResolvedValue(
        ok({
          cpuUsage: 50,
          availableMemory: 2000000000,
          totalMemory: 8000000000,
          loadAverage: [1.0, 1.0, 1.0],
          workerCount: 0,
        }),
      ),
      getThresholds: vi.fn().mockReturnValue({ maxCpuPercent: 80, minMemoryBytes: 1000000000 }),
      recordSpawn: vi.fn(),
    } as ResourceMonitor;
  },

  logger: (): Logger => {
    const logger: Logger = {
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      child: vi.fn().mockReturnThis(),
    };
    return logger;
  },

  outputCapture: (): OutputCapture => {
    return {
      capture: vi.fn().mockReturnValue(ok(undefined)),
      getOutput: vi.fn().mockReturnValue(
        ok({
          taskId: TaskId('test'),
          stdout: [],
          stderr: [],
          totalSize: 0,
        }),
      ),
      clear: vi.fn().mockReturnValue(ok(undefined)),
    } as OutputCapture;
  },

  taskQueue: (): TaskQueue => {
    return {
      enqueue: vi.fn().mockReturnValue(ok(undefined)),
      dequeue: vi.fn().mockReturnValue(ok(null)),
      remove: vi.fn().mockReturnValue(ok(undefined)),
      peek: vi.fn().mockReturnValue(ok(null)),
      getAll: vi.fn().mockReturnValue(ok([])),
      contains: vi.fn().mockReturnValue(false),
      size: vi.fn().mockReturnValue(0),
      clear: vi.fn().mockReturnValue(ok(undefined)),
    } as TaskQueue;
  },

  workerPool: (): WorkerPool => {
    return {
      spawn: vi.fn().mockResolvedValue(ok({ id: TEST_CONSTANTS.TEST_WORKER_ID } as unknown)),
      kill: vi.fn().mockResolvedValue(ok(undefined)),
      killAll: vi.fn().mockResolvedValue(ok(undefined)),
      getWorker: vi.fn().mockReturnValue(ok(null)),
      getWorkers: vi.fn().mockReturnValue(ok([])),
      getWorkerCount: vi.fn().mockReturnValue(0),
      getWorkerForTask: vi.fn().mockReturnValue(ok(null)),
    } as WorkerPool;
  },

  taskRepository: (): TaskRepository => {
    return {
      save: vi.fn().mockResolvedValue(ok(undefined)),
      findById: vi.fn().mockResolvedValue(ok(null)),
      findByStatus: vi.fn().mockResolvedValue(ok([])),
      update: vi.fn().mockResolvedValue(ok(undefined)),
      delete: vi.fn().mockResolvedValue(ok(undefined)),
      findAll: vi.fn().mockResolvedValue(ok([])),
      cleanupOldTasks: vi.fn().mockResolvedValue(ok(0)),
    } as TaskRepository;
  },

  eventBus: (): EventBus => {
    return {
      emit: vi.fn().mockResolvedValue(ok(undefined)),
      subscribe: vi.fn().mockReturnValue(ok(undefined)),
      unsubscribe: vi.fn().mockReturnValue(ok(undefined)),
      subscribeAll: vi.fn().mockReturnValue(ok(undefined)),
      unsubscribeAll: vi.fn().mockReturnValue(ok(undefined)),
    } as EventBus;
  },
};

// Test Data Factory
export const TestDataFactory = {
  smallData: (size: number = TEST_CONSTANTS.SMALL_DATA_SIZE): string => {
    return 'a'.repeat(size);
  },

  largeData: (size: number = TEST_CONSTANTS.LARGE_DATA_SIZE): string => {
    return 'b'.repeat(size);
  },

  jsonData: (data: Record<string, unknown> = { test: 'data' }): string => {
    return JSON.stringify(data);
  },

  multilineData: (lines: number = 5): string => {
    return Array.from({ length: lines }, (_, i) => `Line ${i + 1}`).join('\n');
  },
};

// Error Factory
export const ErrorFactory = {
  systemError: (message: string = 'Test system error'): Error => {
    return new Error(message);
  },

  networkError: (): Error => {
    const error = new Error('Network request failed');
    (error as unknown as Record<string, unknown>).code = 'ENOTFOUND';
    return error;
  },

  timeoutError: (): Error => {
    const error = new Error('Operation timed out');
    (error as unknown as Record<string, unknown>).code = 'ETIMEDOUT';
    return error;
  },
};

// Assertion Helpers
export const AssertionHelpers = {
  expectSuccessResult: <T>(result: Result<T, Error>): T => {
    expect(result.ok).toBe(true);
    return (result as { ok: true; value: T }).value;
  },

  expectErrorResult: (result: Result<unknown, Error>, expectedMessage?: string): Error => {
    expect(result.ok).toBe(false);
    const error = (result as { ok: false; error: Error }).error;
    if (expectedMessage) {
      expect(error.message).toContain(expectedMessage);
    }
    return error;
  },

  expectTaskWithStatus: (task: Task, status: TaskStatus): void => {
    expect(task.status).toBe(status);
    switch (status) {
      case TaskStatus.RUNNING:
        expect(task.startedAt).toBeDefined();
        break;
      case TaskStatus.COMPLETED:
      case TaskStatus.FAILED:
        expect(task.completedAt).toBeDefined();
        break;
    }
  },

  expectMockCalledWithTask: (mockFn: ReturnType<typeof vi.fn>, expectedTask: Partial<Task>): void => {
    expect(mockFn).toHaveBeenCalledWith(expect.objectContaining(expectedTask));
  },
};

// Enhanced Mock Verification Helpers
export const MockVerification = {
  expectCalledOnce: (mockFn: ReturnType<typeof vi.fn>): void => {
    expect(mockFn).toHaveBeenCalledTimes(1);
  },

  expectCalledWith: (mockFn: ReturnType<typeof vi.fn>, ...expectedArgs: unknown[]): void => {
    expect(mockFn).toHaveBeenCalledWith(...expectedArgs);
  },

  expectCalledOnceWith: (mockFn: ReturnType<typeof vi.fn>, ...expectedArgs: unknown[]): void => {
    expect(mockFn).toHaveBeenCalledTimes(1);
    expect(mockFn).toHaveBeenCalledWith(...expectedArgs);
  },

  expectLastCalledWith: (mockFn: ReturnType<typeof vi.fn>, ...expectedArgs: unknown[]): void => {
    expect(mockFn).toHaveBeenLastCalledWith(...expectedArgs);
  },

  expectNthCalledWith: (mockFn: ReturnType<typeof vi.fn>, nthCall: number, ...expectedArgs: unknown[]): void => {
    expect(mockFn).toHaveBeenNthCalledWith(nthCall, ...expectedArgs);
  },

  expectCallOrder: (mockFn1: ReturnType<typeof vi.fn>, mockFn2: ReturnType<typeof vi.fn>): void => {
    const fn1CallTime = mockFn1.mock.invocationCallOrder?.[0];
    const fn2CallTime = mockFn2.mock.invocationCallOrder?.[0];

    expect(fn1CallTime).toBeDefined();
    expect(fn2CallTime).toBeDefined();
    expect(fn1CallTime).toBeLessThan(fn2CallTime);
  },

  expectRepositorySave: (mockRepository: TaskRepository, expectedTask: Partial<Task>): void => {
    expect(mockRepository.save).toHaveBeenCalledWith(expect.objectContaining(expectedTask));
  },

  expectLoggerError: (mockLogger: Logger, expectedMessage: string): void => {
    expect(mockLogger.error).toHaveBeenCalledWith(expectedMessage);
  },

  expectLoggerInfo: (mockLogger: Logger, expectedMessage: string): void => {
    expect(mockLogger.info).toHaveBeenCalledWith(expectedMessage);
  },

  expectWorkerPoolSpawn: (mockWorkerPool: WorkerPool, expectedTask: Task): void => {
    expect(mockWorkerPool.spawn).toHaveBeenCalledWith(expectedTask);
  },

  expectWorkerPoolKill: (mockWorkerPool: WorkerPool, workerId: string): void => {
    expect(mockWorkerPool.kill).toHaveBeenCalledWith(workerId);
  },

  expectOutputCaptureConfigured: (mockOutput: OutputCapture, taskId: TaskId, config: Record<string, unknown>): void => {
    expect(mockOutput.configureTask).toHaveBeenCalledWith(taskId, config);
  },

  expectResourceMonitorChecked: (mockMonitor: ResourceMonitor): void => {
    expect(mockMonitor.canSpawnWorker).toHaveBeenCalled();
  },
};
