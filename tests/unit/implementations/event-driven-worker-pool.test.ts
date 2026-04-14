import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRegistry } from '../../../src/core/agents';
import type { Task } from '../../../src/core/domain';
import { TaskId, WorkerId } from '../../../src/core/domain';
import { AutobeatError, ErrorCode } from '../../../src/core/errors';
import type { EventBus } from '../../../src/core/events/event-bus';
import type { Logger, OutputCapture, ProcessSpawner, ResourceMonitor } from '../../../src/core/interfaces';
import { err, ok } from '../../../src/core/result';
import { InMemoryAgentRegistry } from '../../../src/implementations/agent-registry';
import { EventDrivenWorkerPool } from '../../../src/implementations/event-driven-worker-pool';
import { ProcessSpawnerAdapter } from '../../../src/implementations/process-spawner-adapter';
import { TaskFactory } from '../../fixtures/factories';
import { createMockLogger, createMockOutputRepository, createMockWorkerRepository } from '../../fixtures/mocks';

// --- Mock Factories ---

const createMockProcess = () => {
  const proc = new EventEmitter() as EventEmitter & {
    pid: number;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
    stdin: EventEmitter;
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  proc.pid = 12345;
  proc.killed = false;
  proc.kill = vi.fn((signal?: string) => {
    proc.killed = true;
  });
  proc.stdin = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
};

const createMockSpawner = () => {
  const proc = createMockProcess();
  return {
    spawner: {
      spawn: vi.fn().mockReturnValue(ok({ process: proc, pid: proc.pid })),
      kill: vi.fn().mockReturnValue(ok(undefined)),
    } as unknown as ProcessSpawner,
    process: proc,
  };
};

const createMockMonitor = () =>
  ({
    getResources: vi.fn(),
    canSpawnWorker: vi.fn().mockResolvedValue(ok(true)),
    getThresholds: vi.fn().mockReturnValue({ maxCpuPercent: 80, minMemoryBytes: 1_000_000_000 }),
    incrementWorkerCount: vi.fn(),
    decrementWorkerCount: vi.fn(),
    recordSpawn: vi.fn(),
  }) as unknown as ResourceMonitor;

const createMockOutputCapture = () =>
  ({
    capture: vi.fn().mockReturnValue(ok(undefined)),
    getOutput: vi.fn().mockReturnValue(ok({ stdout: [], stderr: [], taskId: '', totalSize: 0 })),
    clear: vi.fn().mockReturnValue(ok(undefined)),
  }) as unknown as OutputCapture;

const createTestEventBus = () =>
  ({
    emit: vi.fn().mockResolvedValue(ok(undefined)),
    request: vi.fn(),
    subscribe: vi.fn().mockReturnValue(ok('sub-1')),
    unsubscribe: vi.fn().mockReturnValue(ok(undefined)),
    subscribeAll: vi.fn().mockReturnValue(ok('global-1')),
    unsubscribeAll: vi.fn(),
    dispose: vi.fn(),
  }) as unknown as EventBus;

/**
 * Helper to build a Task object without using withId() (which mutates a frozen object).
 * Spreads the frozen task from the factory into a plain mutable object.
 * Sets agent='claude' by default since worker pool requires task.agent to be set.
 */
const buildTask = (configure?: (factory: TaskFactory) => void): Task => {
  const factory = new TaskFactory();
  if (configure) configure(factory);
  return { ...factory.build(), agent: 'claude' as const };
};

describe('EventDrivenWorkerPool', () => {
  let pool: EventDrivenWorkerPool;
  let spawner: ProcessSpawner;
  let agentRegistry: AgentRegistry;
  let mockProcess: ReturnType<typeof createMockProcess>;
  let monitor: ResourceMonitor;
  let logger: Logger;
  let eventBus: EventBus;
  let outputCapture: OutputCapture;
  let workerRepository: ReturnType<typeof createMockWorkerRepository>;
  let outputRepository: ReturnType<typeof createMockOutputRepository>;

  beforeEach(() => {
    vi.useFakeTimers();
    const spawnerMock = createMockSpawner();
    spawner = spawnerMock.spawner;
    mockProcess = spawnerMock.process;
    monitor = createMockMonitor();
    logger = createMockLogger();
    eventBus = createTestEventBus();
    outputCapture = createMockOutputCapture();
    workerRepository = createMockWorkerRepository();
    outputRepository = createMockOutputRepository();

    // Wrap ProcessSpawner in AgentRegistry for backward compatibility
    agentRegistry = new InMemoryAgentRegistry([new ProcessSpawnerAdapter(spawner)]);

    pool = new EventDrivenWorkerPool({
      agentRegistry,
      monitor,
      logger,
      eventBus,
      outputCapture,
      workerRepository,
      outputRepository,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // --- spawn ---

  describe('spawn', () => {
    it('should return WORKER_SPAWN_FAILED when task has no agent assigned', async () => {
      const task = { ...buildTask(), agent: undefined } as unknown as Task;

      const result = await pool.spawn(task);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect((result.error as AutobeatError).code).toBe(ErrorCode.WORKER_SPAWN_FAILED);
      expect(result.error.message).toContain('no agent assigned');
    });

    it('should spawn successfully and return worker with correct fields', async () => {
      const task = buildTask((f) => f.withPrompt('do stuff'));

      const result = await pool.spawn(task);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const worker = result.value;
      expect(worker.id).toBe(WorkerId(`worker-${mockProcess.pid}`));
      expect(worker.taskId).toBe(task.id);
      expect(worker.pid).toBe(mockProcess.pid);
      expect(worker.startedAt).toBeGreaterThan(0);
      expect(worker.cpuUsage).toBe(0);
      expect(worker.memoryUsage).toBe(0);
    });

    it('should return error when resources are insufficient (canSpawnWorker returns false)', async () => {
      (monitor.canSpawnWorker as ReturnType<typeof vi.fn>).mockResolvedValue(ok(false));
      const task = buildTask();

      const result = await pool.spawn(task);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(AutobeatError);
      expect((result.error as AutobeatError).code).toBe(ErrorCode.INSUFFICIENT_RESOURCES);
    });

    it('should return error when canSpawnWorker returns err', async () => {
      const monitorError = new AutobeatError(ErrorCode.RESOURCE_MONITORING_FAILED, 'monitor broken');
      (monitor.canSpawnWorker as ReturnType<typeof vi.fn>).mockResolvedValue(err(monitorError));
      const task = buildTask();

      const result = await pool.spawn(task);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe(monitorError);
    });

    it('should propagate agent registry errors without wrapping', async () => {
      const registryError = new AutobeatError(ErrorCode.AGENT_NOT_FOUND, "Agent 'unknown' not found");
      // Replace registry with one that returns an error
      const failRegistry = {
        get: vi.fn().mockReturnValue(err(registryError)),
        has: vi.fn().mockReturnValue(false),
        list: vi.fn().mockReturnValue([]),
        dispose: vi.fn(),
      } as unknown as AgentRegistry;
      const failPool = new EventDrivenWorkerPool({
        agentRegistry: failRegistry,
        monitor,
        logger,
        eventBus,
        outputCapture,
        workerRepository,
        outputRepository,
      });
      const task = buildTask();

      const result = await failPool.spawn(task);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe(registryError);
      expect((result.error as AutobeatError).code).toBe(ErrorCode.AGENT_NOT_FOUND);
    });

    it('should propagate adapter spawn errors without wrapping', async () => {
      const spawnError = new AutobeatError(
        ErrorCode.AGENT_MISCONFIGURED,
        "Agent 'claude' is misconfigured: CLI not found",
      );
      const failAdapter = {
        provider: 'claude' as const,
        spawn: vi.fn().mockReturnValue(err(spawnError)),
        kill: vi.fn().mockReturnValue(ok(undefined)),
        dispose: vi.fn(),
      };
      const failRegistry = new InMemoryAgentRegistry([failAdapter]);
      const failPool = new EventDrivenWorkerPool({
        agentRegistry: failRegistry,
        monitor,
        logger,
        eventBus,
        outputCapture,
        workerRepository,
        outputRepository,
      });
      const task = buildTask();

      const result = await failPool.spawn(task);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe(spawnError);
      expect((result.error as AutobeatError).code).toBe(ErrorCode.AGENT_MISCONFIGURED);
    });

    it('should use task.workingDirectory when provided', async () => {
      const task = buildTask((f) => f.withWorkingDirectory('/my/project'));

      await pool.spawn(task);

      expect(spawner.spawn as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        task.prompt,
        '/my/project',
        task.id,
        task.model,
      );
    });

    it('should fall back to process.cwd() when no workingDirectory provided', async () => {
      const task = { ...buildTask(), workingDirectory: undefined } as Task;

      await pool.spawn(task);

      expect(spawner.spawn as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        task.prompt,
        process.cwd(),
        task.id,
        task.model,
      );
    });

    it('should increase worker count after successful spawn', async () => {
      expect(pool.getWorkerCount()).toBe(0);

      const task = buildTask();
      await pool.spawn(task);

      expect(pool.getWorkerCount()).toBe(1);
    });

    it('should map task to worker via getWorkerForTask', async () => {
      const task = buildTask();
      const result = await pool.spawn(task);
      if (!result.ok) return;

      const lookup = pool.getWorkerForTask(task.id);
      expect(lookup.ok).toBe(true);
      if (!lookup.ok) return;
      expect(lookup.value).not.toBeNull();
      expect(lookup.value!.id).toBe(result.value.id);
    });
  });

  // --- kill ---

  describe('kill', () => {
    it('should skip process.kill but still clean up state when process is already killed', async () => {
      const task = buildTask();
      const spawnResult = await pool.spawn(task);
      expect(spawnResult.ok).toBe(true);
      if (!spawnResult.ok) return;

      // Simulate process already killed externally
      mockProcess.killed = true;
      mockProcess.kill.mockClear();

      await pool.kill(spawnResult.value.id);

      // process.kill should NOT have been called (process.killed was true)
      expect(mockProcess.kill).not.toHaveBeenCalled();
      // But state should still be cleaned up
      expect(pool.getWorkerCount()).toBe(0);
      expect(monitor.decrementWorkerCount as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    });

    it('should return error for unknown worker', async () => {
      const unknownId = WorkerId('worker-nonexistent');

      const result = await pool.kill(unknownId);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect((result.error as AutobeatError).code).toBe(ErrorCode.WORKER_NOT_FOUND);
    });

    it('should kill process with SIGTERM', async () => {
      const task = buildTask();
      const spawnResult = await pool.spawn(task);
      if (!spawnResult.ok) return;

      await pool.kill(spawnResult.value.id);

      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('should clean up worker state (removed from getWorker and getWorkerForTask)', async () => {
      const task = buildTask();
      const spawnResult = await pool.spawn(task);
      if (!spawnResult.ok) return;
      const workerId = spawnResult.value.id;

      await pool.kill(workerId);

      const workerResult = pool.getWorker(workerId);
      expect(workerResult.ok).toBe(true);
      if (workerResult.ok) {
        expect(workerResult.value).toBeNull();
      }

      const taskWorkerResult = pool.getWorkerForTask(task.id);
      expect(taskWorkerResult.ok).toBe(true);
      if (taskWorkerResult.ok) {
        expect(taskWorkerResult.value).toBeNull();
      }
    });

    it('should decrement monitor worker count', async () => {
      const task = buildTask();
      const spawnResult = await pool.spawn(task);
      if (!spawnResult.ok) return;

      await pool.kill(spawnResult.value.id);

      expect(monitor.decrementWorkerCount as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
    });
  });

  // --- killAll ---

  describe('killAll', () => {
    it('should return ok immediately when pool is empty', async () => {
      expect(pool.getWorkerCount()).toBe(0);

      const result = await pool.killAll();

      expect(result.ok).toBe(true);
      expect(pool.getWorkerCount()).toBe(0);
    });

    it('should kill all workers', async () => {
      const task1 = buildTask();
      await pool.spawn(task1);

      // Create a second mock process for the second spawn
      const proc2 = createMockProcess();
      proc2.pid = 99999;
      (spawner.spawn as ReturnType<typeof vi.fn>).mockReturnValue(ok({ process: proc2, pid: proc2.pid }));
      const task2 = buildTask();
      await pool.spawn(task2);

      expect(pool.getWorkerCount()).toBe(2);

      const result = await pool.killAll();

      expect(result.ok).toBe(true);
      expect(pool.getWorkerCount()).toBe(0);
    });

    it('should return ok even if some kills fail', async () => {
      const task = buildTask();
      await pool.spawn(task);

      // Make the process.kill throw to simulate kill failure
      mockProcess.kill = vi.fn(() => {
        throw new Error('kill failed');
      });

      const result = await pool.killAll();

      // killAll always returns ok (logs failures)
      expect(result.ok).toBe(true);
    });
  });

  // --- Getter methods ---

  describe('getWorker', () => {
    it('should return null for unknown worker ID', () => {
      const result = pool.getWorker(WorkerId('worker-unknown'));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });

    it('should return the worker after spawn', async () => {
      const task = buildTask();
      const spawnResult = await pool.spawn(task);
      if (!spawnResult.ok) return;

      const result = pool.getWorker(spawnResult.value.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).not.toBeNull();
        expect(result.value!.taskId).toBe(task.id);
      }
    });
  });

  describe('getWorkers', () => {
    it('should return frozen array', async () => {
      const task = buildTask();
      await pool.spawn(task);

      const result = pool.getWorkers();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(Object.isFrozen(result.value)).toBe(true);
        expect(result.value.length).toBe(1);
      }
    });

    it('should return empty frozen array when no workers', () => {
      const result = pool.getWorkers();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(Object.isFrozen(result.value)).toBe(true);
        expect(result.value.length).toBe(0);
      }
    });
  });

  describe('getWorkerCount', () => {
    it('should return 0 initially', () => {
      expect(pool.getWorkerCount()).toBe(0);
    });

    it('should reflect spawned workers', async () => {
      const task = buildTask();
      await pool.spawn(task);
      expect(pool.getWorkerCount()).toBe(1);
    });
  });

  describe('getWorkerForTask', () => {
    it('should return null for unknown task', () => {
      const result = pool.getWorkerForTask(TaskId('task-ghost'));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });
  });

  // --- Timeout behavior ---

  describe('timeout behavior', () => {
    it('should not trigger timeout for tasks with undefined timeout', async () => {
      const task = { ...buildTask(), timeout: undefined } as Task;

      await pool.spawn(task);

      // Advance time well past any reasonable timeout
      vi.advanceTimersByTime(120_000);

      // Worker should still exist (not killed by timeout)
      expect(pool.getWorkerCount()).toBe(1);
    });

    it('should not trigger timeout for tasks with timeout=0', async () => {
      const task = buildTask((f) => f.withTimeout(0));

      await pool.spawn(task);

      // Advance time significantly
      vi.advanceTimersByTime(120_000);

      // Worker should still exist
      expect(pool.getWorkerCount()).toBe(1);
    });

    it('should trigger timeout and kill worker when timeout expires', async () => {
      const task = buildTask((f) => f.withTimeout(5000));

      await pool.spawn(task);
      expect(pool.getWorkerCount()).toBe(1);

      // Advance time past the timeout
      await vi.advanceTimersByTimeAsync(5001);

      // Worker should be killed
      expect(pool.getWorkerCount()).toBe(0);
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('should not crash or double-emit when timeout fires after worker already completed', async () => {
      const task = buildTask((f) => f.withTimeout(5000));

      const spawnResult = await pool.spawn(task);
      expect(spawnResult.ok).toBe(true);

      // Process exits before timeout fires
      mockProcess.emit('exit', 0);
      await vi.advanceTimersByTimeAsync(0);

      expect(pool.getWorkerCount()).toBe(0);

      // Clear emit calls to track only what happens after
      (eventBus.emit as ReturnType<typeof vi.fn>).mockClear();

      // Advance past the timeout — should be no-op since timeout was cleared on completion
      await vi.advanceTimersByTimeAsync(5001);

      // Should NOT emit TaskTimeout (timeout was cleared during completion)
      expect(eventBus.emit as ReturnType<typeof vi.fn>).not.toHaveBeenCalledWith('TaskTimeout', expect.anything());
    });

    it('should emit TaskTimeout event when timeout triggers', async () => {
      const task = buildTask((f) => f.withTimeout(3000));

      await pool.spawn(task);

      await vi.advanceTimersByTimeAsync(3001);

      expect(eventBus.emit as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        'TaskTimeout',
        expect.objectContaining({
          taskId: task.id,
        }),
      );
    });
  });

  // --- Worker completion (tested via process exit event) ---

  describe('worker completion', () => {
    it('should log warning and not crash when completion fires for already-removed worker', async () => {
      const task = buildTask();
      const spawnResult = await pool.spawn(task);
      expect(spawnResult.ok).toBe(true);
      if (!spawnResult.ok) return;

      // Kill the worker first (removes from maps)
      await pool.kill(spawnResult.value.id);

      // Now simulate process exit (worker already removed from maps by kill)
      mockProcess.emit('exit', 0);
      await vi.advanceTimersByTimeAsync(0);

      // Should log warning, not crash
      expect(logger.warn).toHaveBeenCalledWith(
        'Worker completion for unknown task',
        expect.objectContaining({ taskId: task.id }),
      );
    });

    it('should emit TaskCompleted event on exit code 0', async () => {
      const task = buildTask();
      await pool.spawn(task);

      // Simulate process exit with code 0
      mockProcess.emit('exit', 0);

      // Allow async handlers to run
      await vi.advanceTimersByTimeAsync(0);

      expect(eventBus.emit as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        'TaskCompleted',
        expect.objectContaining({
          taskId: task.id,
          exitCode: 0,
        }),
      );
    });

    it('should emit TaskFailed event on non-zero exit code', async () => {
      const task = buildTask();
      await pool.spawn(task);

      // Simulate process exit with non-zero code
      mockProcess.emit('exit', 1);

      await vi.advanceTimersByTimeAsync(0);

      expect(eventBus.emit as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        'TaskFailed',
        expect.objectContaining({
          taskId: task.id,
          exitCode: 1,
        }),
      );
    });

    it('should clean up worker state on completion', async () => {
      const task = buildTask();
      const spawnResult = await pool.spawn(task);
      if (!spawnResult.ok) return;

      mockProcess.emit('exit', 0);
      await vi.advanceTimersByTimeAsync(0);

      expect(pool.getWorkerCount()).toBe(0);
      const workerResult = pool.getWorker(spawnResult.value.id);
      expect(workerResult.ok).toBe(true);
      if (workerResult.ok) {
        expect(workerResult.value).toBeNull();
      }
    });

    it('should decrement monitor worker count on completion', async () => {
      const task = buildTask();
      await pool.spawn(task);

      mockProcess.emit('exit', 0);
      await vi.advanceTimersByTimeAsync(0);

      expect(monitor.decrementWorkerCount as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    });
  });

  // --- WorkerRepository integration ---

  describe('workerRepository integration', () => {
    it('should register worker in workerRepository on spawn', async () => {
      const task = buildTask();

      const result = await pool.spawn(task);

      expect(result.ok).toBe(true);
      expect(workerRepository.register).toHaveBeenCalledOnce();
      expect(workerRepository.register).toHaveBeenCalledWith(
        expect.objectContaining({
          workerId: WorkerId(`worker-${mockProcess.pid}`),
          taskId: task.id,
          pid: mockProcess.pid,
          ownerPid: process.pid,
          agent: 'claude',
        }),
      );
    });

    it('should unregister worker from workerRepository on kill', async () => {
      const task = buildTask();
      const spawnResult = await pool.spawn(task);
      if (!spawnResult.ok) return;

      await pool.kill(spawnResult.value.id);

      expect(workerRepository.unregister).toHaveBeenCalledOnce();
      expect(workerRepository.unregister).toHaveBeenCalledWith(spawnResult.value.id);
    });

    it('should unregister worker from workerRepository on process exit', async () => {
      const task = buildTask();
      const spawnResult = await pool.spawn(task);
      if (!spawnResult.ok) return;

      mockProcess.emit('exit', 0);
      // Flush the async onExit chain (flushOutput -> clear -> finally -> handleWorkerCompletion)
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      expect(workerRepository.unregister).toHaveBeenCalledOnce();
      expect(workerRepository.unregister).toHaveBeenCalledWith(spawnResult.value.id);
    });

    it('should return error when workerRepository.register fails (UNIQUE constraint)', async () => {
      const registrationError = new AutobeatError(ErrorCode.SYSTEM_ERROR, 'UNIQUE constraint failed: workers.task_id');
      workerRepository.register.mockReturnValue(err(registrationError));

      const task = buildTask();

      const result = await pool.spawn(task);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe(registrationError);
      // Worker should NOT remain in pool after registration failure
      expect(pool.getWorkerCount()).toBe(0);
      // Process should have been killed
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
    });
  });

  // --- Heartbeat behavior ---

  describe('heartbeat behavior', () => {
    it('should start calling updateHeartbeat every 30 seconds after spawn', async () => {
      // Capture the setInterval callback for the heartbeat timer (30s interval)
      const setIntervalCalls: { fn: Function; delay: number }[] = [];
      const origSetInterval = global.setInterval;
      const setIntervalSpy = vi
        .spyOn(global, 'setInterval')
        .mockImplementation((fn: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
          setIntervalCalls.push({ fn, delay: delay ?? 0 });
          return origSetInterval(fn, delay, ...args);
        });

      const task = buildTask();
      await pool.spawn(task);

      setIntervalSpy.mockRestore();

      // Find the 30s heartbeat callback
      const heartbeatCall = setIntervalCalls.find((c) => c.delay === 30_000);
      expect(heartbeatCall).toBeDefined();

      // No heartbeat yet
      expect(workerRepository.updateHeartbeat).not.toHaveBeenCalled();

      // Manually trigger the callback (simulates 30s passing)
      heartbeatCall!.fn();
      expect(workerRepository.updateHeartbeat).toHaveBeenCalledTimes(1);

      // Trigger again
      heartbeatCall!.fn();
      expect(workerRepository.updateHeartbeat).toHaveBeenCalledTimes(2);
    });

    it('should set heartbeatTimer on worker and clear it on kill', async () => {
      const task = buildTask();
      const spawnResult = await pool.spawn(task);
      if (!spawnResult.ok) return;
      const workerId = spawnResult.value.id;

      // Worker should have a heartbeat timer after spawn
      const workerState = (
        pool as unknown as { workers: Map<string, { heartbeatTimer?: NodeJS.Timeout }> }
      ).workers.get(workerId);
      expect(workerState?.heartbeatTimer).toBeDefined();

      // Kill the worker
      await pool.kill(workerId);

      // Worker is removed from map — verify updateHeartbeat is not called after kill
      // (We've already verified it was set and then cleared)
      expect(workerRepository.unregister).toHaveBeenCalledWith(workerId);
    });

    it('should stop calling updateHeartbeat after worker is killed (via captured callback)', async () => {
      // Capture the heartbeat callback
      const setIntervalCalls: { fn: Function; delay: number }[] = [];
      const origSetInterval = global.setInterval;
      const setIntervalSpy = vi
        .spyOn(global, 'setInterval')
        .mockImplementation((fn: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
          setIntervalCalls.push({ fn, delay: delay ?? 0 });
          return origSetInterval(fn, delay, ...args);
        });

      const task = buildTask();
      const spawnResult = await pool.spawn(task);
      if (!spawnResult.ok) return;
      setIntervalSpy.mockRestore();

      const heartbeatCall = setIntervalCalls.find((c) => c.delay === 30_000);
      expect(heartbeatCall).toBeDefined();

      // Call heartbeat once (simulates 30s)
      heartbeatCall!.fn();
      expect(workerRepository.updateHeartbeat).toHaveBeenCalledTimes(1);

      // Kill the worker
      await pool.kill(spawnResult.value.id);

      // After kill, clear mock and advance — the real interval timer should be cleared
      (workerRepository.updateHeartbeat as ReturnType<typeof vi.fn>).mockClear();

      // Advance time — the real interval (captured via origSetInterval) is still running
      // but the clearInterval in cleanupWorkerState should have stopped it
      await vi.advanceTimersByTimeAsync(30_000);

      // updateHeartbeat should NOT be called — timer was cleared on kill
      expect(workerRepository.updateHeartbeat).not.toHaveBeenCalled();
    });
  });
});
