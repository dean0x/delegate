/**
 * Test Data Factories
 * Provides builder patterns for creating test data with sensible defaults
 *
 * ARCHITECTURE: These factories ensure consistent test data creation
 * and reduce boilerplate in tests. Use these instead of inline object creation.
 */

import { randomUUID } from 'crypto';
import type { AgentProvider } from '../../src/core/agents';
import type { Configuration } from '../../src/core/configuration';
import type {
  Priority,
  SystemResources,
  Task,
  TaskId,
  TaskRequest,
  TaskStatus,
  Worker,
  WorkerId,
} from '../../src/core/domain';
import {
  TaskId as createTaskId,
  WorkerId as createWorkerId,
  createTask as domainCreateTask,
} from '../../src/core/domain';

/**
 * TaskFactory - Builder pattern for creating test tasks
 *
 * Usage:
 * const task = new TaskFactory()
 *   .withPrompt('echo hello')
 *   .withPriority('P0')
 *   .withStatus('running')
 *   .build();
 */
export class TaskFactory {
  private request: TaskRequest = {
    prompt: 'test task prompt',
    priority: 'P2' as Priority,
    timeout: 30000,
    maxOutputBuffer: 1048576,
    workingDirectory: '/workspace',
  };

  private overrides: Partial<Task> = {};
  private id?: string;
  private createdAt?: number;

  withId(id: string): this {
    this.id = id;
    return this;
  }

  withPrompt(prompt: string): this {
    this.request.prompt = prompt;
    return this;
  }

  withPriority(priority: Priority): this {
    this.request.priority = priority;
    return this;
  }

  withStatus(status: TaskStatus): this {
    this.overrides.status = status;
    return this;
  }

  withWorkerId(workerId: WorkerId | null): this {
    this.overrides.workerId = workerId;
    return this;
  }

  withTimeout(timeout: number): this {
    this.request.timeout = timeout;
    return this;
  }

  withWorkingDirectory(dir: string): this {
    this.request.workingDirectory = dir;
    return this;
  }

  withError(error: unknown): this {
    this.overrides.error = error;
    return this;
  }

  withExitCode(code: number): this {
    this.overrides.exitCode = code;
    return this;
  }

  withCreatedAt(timestamp: number): this {
    this.createdAt = timestamp;
    return this;
  }

  withStartedAt(timestamp: number): this {
    this.overrides.startedAt = timestamp;
    return this;
  }

  completed(exitCode: number = 0): this {
    const now = Date.now();
    this.overrides.status = 'completed' as TaskStatus;
    this.overrides.exitCode = exitCode;
    this.overrides.completedAt = now;
    this.overrides.duration = 5000; // 5 seconds default
    return this;
  }

  failed(error: string = 'Task failed'): this {
    const now = Date.now();
    this.overrides.status = 'failed' as TaskStatus;
    this.overrides.error = { message: error, code: 1 };
    this.overrides.exitCode = 1;
    this.overrides.completedAt = now;
    this.overrides.duration = 3000;
    return this;
  }

  running(workerId: string = 'worker-123'): this {
    this.overrides.status = 'running' as TaskStatus;
    this.overrides.workerId = createWorkerId(workerId);
    this.overrides.startedAt = Date.now();
    return this;
  }

  build(): Task {
    const task = domainCreateTask(this.request);

    // Spread frozen task to create mutable copy, then apply overrides
    return {
      ...task,
      ...(this.id ? { id: createTaskId(this.id) } : {}),
      ...(this.createdAt ? { createdAt: this.createdAt, updatedAt: this.createdAt } : {}),
      ...this.overrides,
    };
  }

  buildMany(count: number, modifier?: (factory: TaskFactory, index: number) => void): Task[] {
    return Array.from({ length: count }, (_, i) => {
      const factory = new TaskFactory().withPrompt(`Task ${i + 1}`).withId(`task-${i + 1}`);

      if (modifier) {
        modifier(factory, i);
      }

      return factory.build();
    });
  }
}

/**
 * WorkerFactory - Builder pattern for creating test workers
 */
export class WorkerFactory {
  private worker: Worker = {
    id: createWorkerId(`worker-${randomUUID()}`),
    pid: Math.floor(Math.random() * 10000) + 1000,
    status: 'idle',
    currentTask: null,
    startedAt: Date.now(),
    lastHeartbeat: Date.now(),
    tasksCompleted: 0,
    tasksFailed: 0,
  };

  withId(id: string): this {
    this.worker.id = createWorkerId(id);
    return this;
  }

  withPid(pid: number): this {
    this.worker.pid = pid;
    return this;
  }

  withStatus(status: Worker['status']): this {
    this.worker.status = status;
    return this;
  }

  withCurrentTask(taskId: TaskId | null): this {
    this.worker.currentTask = taskId;
    if (taskId) {
      this.worker.status = 'busy';
    }
    return this;
  }

  withTaskId(taskId: string): this {
    this.worker.currentTask = createTaskId(taskId);
    this.worker.status = 'busy';
    return this;
  }

  withTasksCompleted(count: number): this {
    this.worker.tasksCompleted = count;
    return this;
  }

  withTasksFailed(count: number): this {
    this.worker.tasksFailed = count;
    return this;
  }

  idle(): this {
    this.worker.status = 'idle';
    this.worker.currentTask = null;
    return this;
  }

  busy(taskId: string): this {
    this.worker.status = 'busy';
    this.worker.currentTask = createTaskId(taskId);
    return this;
  }

  error(message: string = 'Worker error'): this {
    this.worker.status = 'error';
    this.worker.error = message;
    return this;
  }

  build(): Worker {
    return { ...this.worker };
  }

  buildMany(count: number, modifier?: (factory: WorkerFactory, index: number) => void): Worker[] {
    return Array.from({ length: count }, (_, i) => {
      const factory = new WorkerFactory().withId(`worker-${i + 1}`).withPid(1000 + i);

      if (modifier) {
        modifier(factory, i);
      }

      return factory.build();
    });
  }
}

/**
 * ConfigFactory - Builder pattern for creating test configurations
 */
export class ConfigFactory {
  private config: Configuration = {
    timeout: 30000,
    maxOutputBuffer: 10485760,
    cpuCoresReserved: 2,
    memoryReserve: 1073741824,
    logLevel: 'info',
    maxListenersPerEvent: 100,
    maxTotalSubscriptions: 1000,
    // Process management defaults
    killGracePeriodMs: 5000,
    resourceMonitorIntervalMs: 100, // Fast for tests
    minSpawnDelayMs: 10, // Fast for tests
    settlingWindowMs: 15000, // 15 second settling window
    // Event system defaults
    eventRequestTimeoutMs: 5000,
    eventCleanupIntervalMs: 60000,
    // Storage defaults
    fileStorageThresholdBytes: 102400,
    // Retry defaults
    retryInitialDelayMs: 100, // Fast for tests
    retryMaxDelayMs: 1000, // Fast for tests
    // Recovery defaults
    taskRetentionDays: 7,
    // Agent defaults — set to 'claude' so existing tests don't break
    defaultAgent: 'claude' as AgentProvider,
  };

  withTimeout(timeout: number): this {
    this.config.timeout = timeout;
    return this;
  }

  withMaxOutputBuffer(size: number): this {
    this.config.maxOutputBuffer = size;
    return this;
  }

  withCpuCoresReserved(cores: number): this {
    this.config.cpuCoresReserved = cores;
    return this;
  }

  withMemoryReserve(bytes: number): this {
    this.config.memoryReserve = bytes;
    return this;
  }

  withLogLevel(level: Configuration['logLevel']): this {
    this.config.logLevel = level;
    return this;
  }

  withDefaultAgent(agent: AgentProvider | undefined): this {
    this.config.defaultAgent = agent;
    return this;
  }

  development(): this {
    this.config.timeout = 5000;
    this.config.maxOutputBuffer = 1048576; // 1MB
    this.config.cpuCoresReserved = 1;
    this.config.memoryReserve = 100000000; // 100MB
    this.config.logLevel = 'debug';
    return this;
  }

  production(): this {
    this.config.timeout = 3600000; // 1 hour
    this.config.maxOutputBuffer = 52428800; // 50MB
    this.config.cpuCoresReserved = 2;
    this.config.memoryReserve = 2147483648; // 2GB
    this.config.logLevel = 'error';
    return this;
  }

  ci(): this {
    this.config.timeout = 600000; // 10 minutes
    this.config.maxOutputBuffer = 10485760; // 10MB
    this.config.cpuCoresReserved = 2;
    this.config.memoryReserve = 500000000; // 500MB
    this.config.logLevel = 'info';
    return this;
  }

  build(): Configuration {
    return { ...this.config };
  }
}

/**
 * EventFactory - Builder pattern for creating test events
 */
export class EventFactory {
  private eventType: string = 'TestEvent';
  private payload: Record<string, unknown> = {};
  private timestamp: number = Date.now();

  withType(type: string): this {
    this.eventType = type;
    return this;
  }

  withPayload(payload: Record<string, unknown>): this {
    this.payload = payload;
    return this;
  }

  withTimestamp(timestamp: number): this {
    this.timestamp = timestamp;
    return this;
  }

  taskDelegated(task: Task): this {
    this.eventType = 'TaskDelegated';
    this.payload = { task };
    return this;
  }

  taskCompleted(taskId: TaskId, exitCode: number = 0): this {
    this.eventType = 'TaskCompleted';
    this.payload = { taskId, exitCode };
    return this;
  }

  taskFailed(taskId: TaskId, error: unknown): this {
    this.eventType = 'TaskFailed';
    this.payload = { taskId, error };
    return this;
  }

  workerSpawned(workerId: WorkerId, taskId: TaskId): this {
    this.eventType = 'WorkerSpawned';
    this.payload = { workerId, taskId };
    return this;
  }

  build(): { type: string; payload: Record<string, unknown>; timestamp: number } {
    return {
      type: this.eventType,
      payload: this.payload,
      timestamp: this.timestamp,
    };
  }
}

/**
 * ResourceFactory - Builder pattern for creating test system resources
 */
export class ResourceFactory {
  private resources: SystemResources = {
    cpuUsage: 50,
    cpuAvailable: 50,
    memoryUsed: 4000000000,
    memoryFree: 4000000000,
    memoryTotal: 8000000000,
    loadAverage: [1.5, 1.2, 1.0],
    canSpawnWorker: true,
  };

  withCpuUsage(percent: number): this {
    this.resources.cpuUsage = percent;
    this.resources.cpuAvailable = 100 - percent;
    return this;
  }

  withMemory(used: number, total: number): this {
    this.resources.memoryUsed = used;
    this.resources.memoryTotal = total;
    this.resources.memoryFree = total - used;
    return this;
  }

  withLoadAverage(one: number, five: number, fifteen: number): this {
    this.resources.loadAverage = [one, five, fifteen];
    return this;
  }

  withCanSpawnWorker(can: boolean): this {
    this.resources.canSpawnWorker = can;
    return this;
  }

  highLoad(): this {
    this.resources.cpuUsage = 95;
    this.resources.cpuAvailable = 5;
    this.resources.memoryUsed = 7500000000;
    this.resources.memoryFree = 500000000;
    this.resources.memoryTotal = 8000000000;
    this.resources.loadAverage = [8.5, 7.2, 6.8];
    this.resources.canSpawnWorker = false;
    return this;
  }

  lowLoad(): this {
    this.resources.cpuUsage = 20;
    this.resources.cpuAvailable = 80;
    this.resources.memoryUsed = 2000000000;
    this.resources.memoryFree = 6000000000;
    this.resources.memoryTotal = 8000000000;
    this.resources.loadAverage = [0.5, 0.3, 0.2];
    this.resources.canSpawnWorker = true;
    return this;
  }

  build(): SystemResources {
    return { ...this.resources };
  }
}

/**
 * Create multiple tasks with different statuses for testing
 */
export function createTaskSet(): {
  pending: Task[];
  running: Task[];
  completed: Task[];
  failed: Task[];
  cancelled: Task[];
} {
  const factory = new TaskFactory();

  return {
    pending: factory.buildMany(3, (f, i) => f.withStatus('pending' as TaskStatus)),
    running: factory.buildMany(2, (f, i) => f.running(`worker-${i}`)),
    completed: factory.buildMany(2, (f, i) => f.completed(0)),
    failed: factory.buildMany(2, (f, i) => f.failed(`Error in task ${i}`)),
    cancelled: factory.buildMany(1, (f, i) => f.withStatus('cancelled' as TaskStatus)),
  };
}

/**
 * Create a worker pool with various states
 */
export function createWorkerPool(): Worker[] {
  const factory = new WorkerFactory();

  return [
    factory.withId('worker-1').idle().build(),
    factory.withId('worker-2').busy('task-1').build(),
    factory.withId('worker-3').busy('task-2').build(),
    factory.withId('worker-4').error('Connection lost').build(),
    factory.withId('worker-5').idle().withTasksCompleted(10).build(),
  ];
}

/**
 * Create a test configuration with safe defaults
 * Used in tests to ensure consistent configuration
 */
export function createTestConfiguration(overrides?: Partial<Configuration>): Configuration {
  const factory = new ConfigFactory().development();
  return { ...factory.build(), ...overrides };
}
