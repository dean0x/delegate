import { randomUUID } from 'crypto';
import { Priority, type Task, TaskId, type TaskRequest, TaskStatus } from '../../src/core/domain';

export const createTestTask = (overrides?: Partial<Task>): Task => ({
  id: overrides?.id || TaskId(`test-task-${randomUUID()}`),
  prompt: 'Test prompt',
  priority: Priority.P1,
  status: TaskStatus.QUEUED,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  workingDirectory: '/workspace',
  timeout: 300000,
  maxOutputBuffer: 10485760,
  agent: 'claude',
  model: undefined,
  ...overrides,
});

export const createTestTaskSpec = (overrides?: Partial<TaskRequest>): TaskRequest => ({
  prompt: 'Test task specification',
  priority: Priority.P1,
  workingDirectory: '/workspace',
  timeout: 300000,
  maxOutputBuffer: 10485760,
  ...overrides,
});

export const mockWorker = {
  id: 'worker-123',
  status: 'idle' as const,
  pid: 12345,
  createdAt: Date.now(),
  taskId: null,
};

export const mockProcessOutput = {
  stdout: 'Task completed successfully\n',
  stderr: '',
  exitCode: 0,
};

export const mockDatabaseConfig = {
  path: ':memory:',
  walMode: false,
  busyTimeout: 5000,
  maxConnections: 1,
};

export const mockLoggerFactory = () => ({
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
});

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const createMockEventBus = () => {
  const handlers = new Map<string, Set<Function>>();

  return {
    on: (event: string, handler: Function) => {
      if (!handlers.has(event)) {
        handlers.set(event, new Set());
      }
      handlers.get(event)!.add(handler);
      return () => handlers.get(event)?.delete(handler);
    },
    emit: (event: string, payload: unknown) => {
      const eventHandlers = handlers.get(event) || [];
      const wildcardHandlers = handlers.get('*') || [];

      [...eventHandlers, ...wildcardHandlers].forEach((handler) => {
        try {
          handler({ type: event, payload, timestamp: Date.now() });
        } catch (error) {
          // Silently ignore handler errors in test fixture
        }
      });
    },
    once: (event: string, handler: Function) => {
      const wrapper = (data: unknown) => {
        handler(data);
        handlers.get(event)?.delete(wrapper);
      };
      handlers.get(event)?.add(wrapper);
      return () => handlers.get(event)?.delete(wrapper);
    },
    removeAllListeners: (event?: string) => {
      if (event) {
        handlers.delete(event);
      } else {
        handlers.clear();
      }
    },
  };
};

export const createMockRepository = () => ({
  save: () => Promise.resolve({ ok: true, value: undefined }),
  update: () => Promise.resolve({ ok: true, value: undefined }),
  get: () => Promise.resolve({ ok: true, value: null }),
  getAll: () => Promise.resolve({ ok: true, value: [] }),
  delete: () => Promise.resolve({ ok: true, value: undefined }),
  getByStatus: () => Promise.resolve({ ok: true, value: [] }),
});

export const createMockQueue = () => ({
  enqueue: () => ({ ok: true, value: undefined }),
  dequeue: () => ({ ok: true, value: null }),
  peek: () => ({ ok: true, value: null }),
  size: () => 0,
  isEmpty: () => true,
  clear: () => {},
});

export const createMockWorkerPool = () => ({
  addWorker: () => ({ ok: true, value: undefined }),
  removeWorker: () => ({ ok: true, value: undefined }),
  getWorker: () => ({ ok: true, value: null }),
  updateWorker: () => ({ ok: true, value: undefined }),
  getActiveWorkers: () => [],
  getIdleWorkers: () => [],
  size: () => 0,
});

export const createMockProcessSpawner = () => ({
  spawn: () =>
    Promise.resolve({
      ok: true,
      value: {
        id: 'worker-123',
        process: { pid: 12345 },
      },
    }),
  kill: () => Promise.resolve({ ok: true, value: undefined }),
  sendInput: () => Promise.resolve({ ok: true, value: undefined }),
});

export const createMockResourceMonitor = () => ({
  getResources: () =>
    Promise.resolve({
      ok: true,
      value: {
        cpu: { usage: 50, available: 50 },
        memory: { used: 4000, free: 4000, total: 8000 },
        canSpawnWorker: true,
      },
    }),
  startMonitoring: () => {},
  stopMonitoring: () => {},
});
