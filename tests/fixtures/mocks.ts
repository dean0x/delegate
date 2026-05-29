import type { EventEmitter } from 'events';
import { vi } from 'vitest';
import type { Task, TaskId, Worker, WorkerOptions } from '../../src/core/domain';
import type {
  EventBus,
  Logger,
  OutputCapture,
  OutputRepository,
  ResourceMonitor,
  TaskQueue,
  TaskRepository,
  WorkerRepository,
} from '../../src/core/interfaces';
import type { Result } from '../../src/core/result';
import { ok } from '../../src/core/result';
import type {
  OutputMessage,
  SpawnCallbacks,
  TmuxConnectorPort,
  TmuxHandle,
  TmuxSessionManagerCorePort,
} from '../../src/core/tmux-types';
import { createMockTask, createMockWorker } from './mock-data.js';

export const createMockLogger = (): Logger => ({
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
});

export const createMockEventBus = (): EventBus => {
  const listeners = new Map<string, Set<Function>>();
  return {
    emit: vi.fn((event: string, data?: unknown) => {
      const handlers = listeners.get(event);
      if (handlers) {
        handlers.forEach((handler) => handler(data));
      }
    }),
    on: vi.fn((event: string, handler: Function) => {
      if (!listeners.has(event)) {
        listeners.set(event, new Set());
      }
      listeners.get(event)!.add(handler);
    }),
    off: vi.fn((event: string, handler: Function) => {
      listeners.get(event)?.delete(handler);
    }),
    once: vi.fn((event: string, handler: Function) => {
      const wrapper = (data: unknown) => {
        handler(data);
        listeners.get(event)?.delete(wrapper);
      };
      if (!listeners.has(event)) {
        listeners.set(event, new Set());
      }
      listeners.get(event)!.add(wrapper);
    }),
  };
};

export const createMockTaskRepository = (): TaskRepository => ({
  save: vi.fn(async (task: Task): Promise<Result<Task>> => ({ ok: true, value: task })),
  findById: vi.fn(async (id: string): Promise<Result<Task | null>> => ({ ok: true, value: createMockTask({ id }) })),
  findAll: vi.fn(async (): Promise<Result<Task[]>> => ({ ok: true, value: [] })),
  update: vi.fn(
    async (id: string, updates: Partial<Task>): Promise<Result<Task>> => ({
      ok: true,
      value: { ...createMockTask({ id }), ...updates },
    }),
  ),
  delete: vi.fn(async (id: string): Promise<Result<void>> => ({ ok: true, value: undefined })),
  findByStatus: vi.fn(async (status: Task['status']): Promise<Result<Task[]>> => ({ ok: true, value: [] })),
});

export const createMockOutputCapture = (): OutputCapture => ({
  capture: vi.fn(async (workerId: string, data: string): Promise<Result<void>> => ({ ok: true, value: undefined })),
  getOutput: vi.fn(async (workerId: string): Promise<Result<string>> => ({ ok: true, value: '' })),
  clear: vi.fn(async (workerId: string): Promise<Result<void>> => ({ ok: true, value: undefined })),
});

export const createMockResourceMonitor = (): ResourceMonitor => ({
  getAvailableResources: vi.fn(async () => ({
    ok: true as const,
    value: { cpuAvailable: 4, memoryAvailable: 8 * 1024 * 1024 * 1024 },
  })),
  getSystemLoad: vi.fn(async () => ({ ok: true as const, value: { cpuUsage: 0.5, memoryUsage: 0.6 } })),
  canSpawnWorker: vi.fn(async () => ({ ok: true as const, value: true })),
  trackWorker: vi.fn(async (worker: Worker) => ({ ok: true as const, value: undefined })),
  releaseWorker: vi.fn(async (workerId: string) => ({ ok: true as const, value: undefined })),
});

export const createMockTaskQueue = (): TaskQueue => ({
  enqueue: vi.fn(async (task: Task): Promise<Result<void>> => ({ ok: true, value: undefined })),
  dequeue: vi.fn(async (): Promise<Result<Task | null>> => ({ ok: true, value: null })),
  peek: vi.fn(async (): Promise<Result<Task | null>> => ({ ok: true, value: null })),
  size: vi.fn(async (): Promise<Result<number>> => ({ ok: true, value: 0 })),
  isEmpty: vi.fn(async (): Promise<Result<boolean>> => ({ ok: true, value: true })),
  clear: vi.fn(async (): Promise<Result<void>> => ({ ok: true, value: undefined })),
});

/**
 * Create a mock WorkerRepository with vi.fn() stubs.
 * All methods return successful defaults (ok with empty/zero values).
 */
export const createMockWorkerRepository = (): WorkerRepository => ({
  register: vi.fn().mockReturnValue(ok(undefined)),
  unregister: vi.fn().mockReturnValue(ok(undefined)),
  updateTaskId: vi.fn().mockReturnValue(ok(undefined)),
  findByTaskId: vi.fn().mockReturnValue(ok(null)),
  findBySessionName: vi.fn().mockReturnValue(ok(null)),
  findAll: vi.fn().mockReturnValue(ok([])),
  getGlobalCount: vi.fn().mockReturnValue(ok(0)),
  updateHeartbeat: vi.fn().mockReturnValue(ok(undefined)),
});

/**
 * Create a mock OutputRepository with vi.fn() stubs.
 * All methods return successful defaults (ok with empty/null values).
 */
export const createMockOutputRepository = (): OutputRepository => ({
  save: vi.fn().mockResolvedValue(ok(undefined)),
  append: vi.fn().mockResolvedValue(ok(undefined)),
  get: vi.fn().mockResolvedValue(ok(null)),
  delete: vi.fn().mockResolvedValue(ok(undefined)),
  getSize: vi.fn().mockResolvedValue(ok(0)),
});

/**
 * MockTmuxConnector for integration tests.
 *
 * Stores SpawnCallbacks per taskId so tests can drive completion/output:
 *   _simulateExit(taskId, code) — triggers onExit callback
 *   _simulateOutput(taskId, msg) — triggers onOutput callback
 */
export type MockTmuxConnector = TmuxConnectorPort & {
  _simulateExit(taskId: string, code: number | null): void;
  _simulateOutput(taskId: string, msg: OutputMessage): void;
  _getCallbacks(): Map<string, SpawnCallbacks>;
};

export const createMockTmuxConnector = (opts?: { autoComplete?: boolean }): MockTmuxConnector => {
  const callbacksMap = new Map<string, SpawnCallbacks>();
  const autoComplete = opts?.autoComplete ?? false;

  return {
    spawn: vi
      .fn()
      .mockImplementation(
        (config: { taskId: string; sessionsDir: string; name: string }, callbacks: SpawnCallbacks) => {
          const sessionName = config.name;
          callbacksMap.set(config.taskId, callbacks);
          if (autoComplete) {
            setImmediate(() => callbacks.onExit(0));
          }
          const handle: TmuxHandle = {
            sessionName,
            taskId: config.taskId as TaskId,
            sessionsDir: config.sessionsDir ?? '/tmp/sessions',
          };
          return ok(handle);
        },
      ),
    destroy: vi.fn().mockReturnValue(ok(undefined)),
    sendKeys: vi.fn().mockReturnValue(ok(undefined)),
    sendControlKeys: vi.fn().mockReturnValue(ok(undefined)),
    isAlive: vi.fn().mockReturnValue(ok(true)),
    setEnvironment: vi.fn().mockReturnValue(ok(undefined)),
    pasteContent: vi.fn().mockReturnValue(ok(undefined)),
    getActiveHandles: vi.fn().mockReturnValue([]),
    dispose: vi.fn(),

    _simulateExit(taskId: string, code: number | null): void {
      const callbacks = callbacksMap.get(taskId);
      if (!callbacks) throw new Error(`No callbacks registered for taskId: ${taskId}`);
      callbacks.onExit(code);
    },

    _simulateOutput(taskId: string, msg: OutputMessage): void {
      const callbacks = callbacksMap.get(taskId);
      if (!callbacks) throw new Error(`No callbacks registered for taskId: ${taskId}`);
      callbacks.onOutput(msg);
    },

    _getCallbacks(): Map<string, SpawnCallbacks> {
      return callbacksMap;
    },
  };
};

/**
 * Create a mock TmuxSessionManagerCorePort for use in RecoveryManager tests.
 * All sessions default to alive (isAlive returns ok(true), listSessions returns ok([])).
 * Tests override listSessions to control which sessions are "live".
 */
export const createMockTmuxSessionManagerCore = (): TmuxSessionManagerCorePort => ({
  isAlive: vi.fn().mockReturnValue(ok(true)),
  sendControlKeys: vi.fn().mockReturnValue(ok(undefined)),
  listSessions: vi.fn().mockReturnValue(ok([])),
  destroySession: vi.fn().mockReturnValue(ok(undefined)),
});
