/**
 * Unit tests for EventDrivenWorkerPool (Phase 3: tmux-backed workers)
 *
 * Uses MockTmuxConnector with helpers:
 *   _simulateExit(taskId, code) — triggers onExit callback
 *   _simulateOutput(taskId, msg) — triggers onOutput callback
 *
 * All TmuxConnectorPort methods are vi.fn() returning ok()
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRegistry } from '../../../src/core/agents';
import type { Task } from '../../../src/core/domain';
import { TaskId, WorkerId } from '../../../src/core/domain';
import { AutobeatError, ErrorCode } from '../../../src/core/errors';
import type { EventBus } from '../../../src/core/events/event-bus';
import type { Logger, OutputCapture, ResourceMonitor } from '../../../src/core/interfaces';
import { err, ok } from '../../../src/core/result';
import type { OutputMessage } from '../../../src/core/tmux-types';
import {
  EventDrivenWorkerPool,
  type EventDrivenWorkerPoolDeps,
} from '../../../src/implementations/event-driven-worker-pool';
import { TaskFactory } from '../../fixtures/factories';
import {
  createMockLogger,
  createMockOutputRepository,
  createMockTmuxConnector,
  createMockWorkerRepository,
} from '../../fixtures/mocks';

// ─── Mock agent adapter ───────────────────────────────────────────────────────

function createMockAgentRegistry(
  opts: {
    buildTmuxCommandOverride?: (options: { taskId?: string; prompt?: string; sessionsDir?: string }) => unknown;
  } = {},
): AgentRegistry {
  const buildTmuxCommandFn = opts.buildTmuxCommandOverride
    ? vi.fn().mockImplementation(opts.buildTmuxCommandOverride)
    : vi.fn().mockImplementation((options: { taskId?: string; prompt?: string; sessionsDir?: string }) =>
        ok({
          config: {
            name: `beat-${options.taskId ?? 'task-unknown'}`,
            command: 'claude',
            cwd: '/tmp',
            taskId: options.taskId ?? 'task-unknown',
            sessionsDir: options.sessionsDir ?? '/tmp/sessions',
            agent: 'claude' as const,
            agentArgs: [],
          },
          prompt: options.prompt ?? 'do stuff',
        }),
      );

  return {
    get: vi.fn().mockReturnValue(
      ok({
        provider: 'claude',
        dispose: vi.fn(),
        cleanup: vi.fn(),
        buildTmuxCommand: buildTmuxCommandFn,
      }),
    ),
    has: vi.fn().mockReturnValue(true),
    list: vi.fn().mockReturnValue(['claude']),
    dispose: vi.fn(),
  } as unknown as AgentRegistry;
}

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

const buildTask = (configure?: (factory: TaskFactory) => void): Task => {
  const factory = new TaskFactory();
  if (configure) configure(factory);
  return { ...factory.build(), agent: 'claude' as const };
};

const buildPersistentTask = (sessionKey: string, configure?: (factory: TaskFactory) => void): Task => {
  const factory = new TaskFactory();
  if (configure) configure(factory);
  return { ...factory.build(), agent: 'claude' as const, persistentSessionKey: sessionKey };
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EventDrivenWorkerPool (Phase 3: tmux)', () => {
  let pool: EventDrivenWorkerPool;
  let tmuxConnector: ReturnType<typeof createMockTmuxConnector>;
  let agentRegistry: AgentRegistry;
  let monitor: ResourceMonitor;
  let logger: Logger;
  let eventBus: EventBus;
  let outputCapture: OutputCapture;
  let workerRepository: ReturnType<typeof createMockWorkerRepository>;
  let outputRepository: ReturnType<typeof createMockOutputRepository>;

  const SESSIONS_DIR = '/tmp/autobeat/sessions';

  function buildPool(deps?: Partial<EventDrivenWorkerPoolDeps>): EventDrivenWorkerPool {
    return new EventDrivenWorkerPool({
      agentRegistry,
      monitor,
      logger,
      eventBus,
      outputCapture,
      workerRepository,
      outputRepository,
      tmuxConnector,
      sessionsDir: SESSIONS_DIR,
      ...deps,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    tmuxConnector = createMockTmuxConnector();
    agentRegistry = createMockAgentRegistry();
    monitor = createMockMonitor();
    logger = createMockLogger();
    eventBus = createTestEventBus();
    outputCapture = createMockOutputCapture();
    workerRepository = createMockWorkerRepository();
    outputRepository = createMockOutputRepository();
    pool = buildPool();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ─── AC-1: Uses TmuxConnectorPort ─────

  describe('AC-1: TmuxConnectorPort usage', () => {
    it('calls tmuxConnector.spawn on successful spawn', async () => {
      const task = buildTask((f) => f.withPrompt('do stuff'));
      await pool.spawn(task);
      expect(tmuxConnector.spawn).toHaveBeenCalled();
    });

    it('calls tmuxConnector.sendKeys to deliver prompt after spawn', async () => {
      const task = buildTask((f) => f.withPrompt('run tests'));
      await pool.spawn(task);
      expect(tmuxConnector.sendKeys).toHaveBeenCalledWith(
        expect.objectContaining({ sessionName: expect.stringContaining('beat-') }),
        expect.stringContaining('run tests'),
      );
    });
  });

  // ─── AC-2: WorkerState has handle: TmuxHandle ────────────────────────────

  describe('AC-2: Worker fields', () => {
    it('returns worker with pid=0 (tmux sentinel)', async () => {
      const task = buildTask();
      const result = await pool.spawn(task);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.pid).toBe(0);
    });

    it('returns worker with valid startedAt and taskId', async () => {
      const task = buildTask();
      const result = await pool.spawn(task);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.taskId).toBe(task.id);
      expect(result.value.startedAt).toBeGreaterThan(0);
    });
  });

  // ─── AC-3: Worker ID format ───────────────────────────────────────────────

  describe('AC-3: Worker ID format', () => {
    it('uses worker-beat-{taskId} format', async () => {
      const task = buildTask();
      const result = await pool.spawn(task);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.id).toBe(WorkerId(`worker-beat-${task.id}`));
    });
  });

  // ─── AC-4: Kill sequence ──────────────────────────────────────────────────

  describe('AC-4: kill() sends C-c then destroy', () => {
    it('sends C-c via sendControlKeys', async () => {
      const task = buildTask();
      const spawnResult = await pool.spawn(task);
      expect(spawnResult.ok).toBe(true);
      if (!spawnResult.ok) return;

      // isAlive: true on first call (before C-c), false on subsequent poll checks
      (tmuxConnector.isAlive as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(ok(true)) // initial alive check → enters kill flow
        .mockReturnValue(ok(false)); // poll check → session died, exit loop

      const killPromise = pool.kill(spawnResult.value.id);
      // Advance timers past the 3s single grace-period wait
      await vi.advanceTimersByTimeAsync(3500);
      await killPromise;

      expect(tmuxConnector.sendControlKeys).toHaveBeenCalledWith(
        expect.objectContaining({ sessionName: expect.any(String) }),
        'C-c',
      );
    });

    it('calls destroy after grace period when isAlive stays true', async () => {
      const task = buildTask();
      const spawnResult = await pool.spawn(task);
      expect(spawnResult.ok).toBe(true);
      if (!spawnResult.ok) return;

      // isAlive always returns true — force-destroy should be called
      (tmuxConnector.isAlive as ReturnType<typeof vi.fn>).mockReturnValue(ok(true));

      const killPromise = pool.kill(spawnResult.value.id);
      // Advance fake timers past the 5s grace period
      await vi.advanceTimersByTimeAsync(6000);
      await killPromise;

      expect(tmuxConnector.destroy).toHaveBeenCalled();
    });

    it('skips destroy when session is already dead', async () => {
      const task = buildTask();
      const spawnResult = await pool.spawn(task);
      expect(spawnResult.ok).toBe(true);
      if (!spawnResult.ok) return;

      // isAlive returns false immediately
      (tmuxConnector.isAlive as ReturnType<typeof vi.fn>).mockReturnValue(ok(false));

      await pool.kill(spawnResult.value.id);

      expect(tmuxConnector.destroy).not.toHaveBeenCalled();
    });

    it('returns error for unknown worker ID', async () => {
      const result = await pool.kill(WorkerId('nonexistent-worker'));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect((result.error as AutobeatError).code).toBe(ErrorCode.WORKER_NOT_FOUND);
    });
  });

  // ─── AC-5: Heartbeat ─────────────────────────────────────────────────────

  describe('AC-5: Heartbeat calls isAlive every 30s', () => {
    it('triggers cleanupWorkerState when isAlive returns false', async () => {
      (tmuxConnector.isAlive as ReturnType<typeof vi.fn>).mockReturnValue(ok(false));

      const task = buildTask();
      await pool.spawn(task);

      // Advance 30s to trigger heartbeat
      await vi.advanceTimersByTimeAsync(30_000);

      // Worker should have been cleaned up — getWorkerForTask returns null
      const workerResult = pool.getWorkerForTask(task.id);
      expect(workerResult.ok).toBe(true);
      if (!workerResult.ok) return;
      expect(workerResult.value).toBeNull();
    });
  });

  // ─── AC-6: Spawn flow ────────────────────────────────────────────────────

  describe('AC-6: Spawn flow', () => {
    it('returns error when task has no agent assigned', async () => {
      const task = { ...buildTask(), agent: undefined } as unknown as Task;
      const result = await pool.spawn(task);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect((result.error as AutobeatError).code).toBe(ErrorCode.WORKER_SPAWN_FAILED);
    });

    it('returns error when resources are insufficient', async () => {
      (monitor.canSpawnWorker as ReturnType<typeof vi.fn>).mockResolvedValue(ok(false));
      const result = await pool.spawn(buildTask());
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect((result.error as AutobeatError).code).toBe(ErrorCode.INSUFFICIENT_RESOURCES);
    });

    it('returns error when canSpawnWorker returns err', async () => {
      const monitorError = new AutobeatError(ErrorCode.RESOURCE_MONITORING_FAILED, 'monitor broken');
      (monitor.canSpawnWorker as ReturnType<typeof vi.fn>).mockResolvedValue(err(monitorError));
      const result = await pool.spawn(buildTask());
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe(monitorError);
    });

    it('propagates agent registry errors', async () => {
      const registryError = new AutobeatError(ErrorCode.AGENT_NOT_FOUND, "Agent 'unknown' not found");
      const failRegistry = {
        get: vi.fn().mockReturnValue(err(registryError)),
        has: vi.fn().mockReturnValue(false),
        list: vi.fn().mockReturnValue([]),
        dispose: vi.fn(),
      } as unknown as AgentRegistry;

      const failPool = buildPool({ agentRegistry: failRegistry });
      const result = await failPool.spawn(buildTask());
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe(registryError);
    });

    it('returns error when buildTmuxCommand fails', async () => {
      const buildError = new AutobeatError(ErrorCode.AGENT_MISCONFIGURED, 'No sessionsDir');
      const badRegistry = {
        get: vi.fn().mockReturnValue(
          ok({
            provider: 'claude',
            dispose: vi.fn(),
            cleanup: vi.fn(),
            buildTmuxCommand: vi.fn().mockReturnValue(err(buildError)),
          }),
        ),
        has: vi.fn().mockReturnValue(true),
        list: vi.fn().mockReturnValue(['claude']),
        dispose: vi.fn(),
      } as unknown as AgentRegistry;

      const failPool = buildPool({ agentRegistry: badRegistry });
      const result = await failPool.spawn(buildTask());
      expect(result.ok).toBe(false);
    });

    it('cleans up when sendKeys fails after spawn (step 10 failure)', async () => {
      (tmuxConnector.sendKeys as ReturnType<typeof vi.fn>).mockReturnValueOnce(
        err(new AutobeatError(ErrorCode.TMUX_SEND_KEYS_FAILED, 'send failed')),
      );

      const task = buildTask();
      const result = await pool.spawn(task);

      expect(result.ok).toBe(false);
      // Session should be destroyed on sendKeys failure
      expect(tmuxConnector.destroy).toHaveBeenCalled();
      // Worker should not be registered
      expect(pool.getWorkerCount()).toBe(0);
    });
  });

  // ─── AC-7: Output routing ────────────────────────────────────────────────

  describe('AC-7: Output flows via onOutput → OutputCapture', () => {
    it('routes stdout messages to outputCapture.capture', async () => {
      const task = buildTask();
      await pool.spawn(task);

      tmuxConnector._simulateOutput(task.id, {
        sequence: 1,
        timestamp: new Date().toISOString(),
        type: 'stdout',
        content: 'hello world',
      });

      expect(outputCapture.capture).toHaveBeenCalledWith(task.id, 'stdout', 'hello world');
    });

    it('routes stderr messages to outputCapture.capture', async () => {
      const task = buildTask();
      await pool.spawn(task);

      tmuxConnector._simulateOutput(task.id, {
        sequence: 2,
        timestamp: new Date().toISOString(),
        type: 'stderr',
        content: 'error output',
      });

      expect(outputCapture.capture).toHaveBeenCalledWith(task.id, 'stderr', 'error output');
    });

    it('routes result messages to stdout (EC-7)', async () => {
      const task = buildTask();
      await pool.spawn(task);

      tmuxConnector._simulateOutput(task.id, {
        sequence: 3,
        timestamp: new Date().toISOString(),
        type: 'result',
        content: '{"ok": true}',
      });

      expect(outputCapture.capture).toHaveBeenCalledWith(task.id, 'stdout', '{"ok": true}');
    });
  });

  // ─── AC-8: onExit callback ───────────────────────────────────────────────

  describe('AC-8: onExit fires → flush → clear → handleWorkerCompletion', () => {
    it('emits TaskCompleted on exit code 0', async () => {
      const task = buildTask();
      await pool.spawn(task);

      tmuxConnector._simulateExit(task.id, 0);

      // Allow async operations to settle
      await vi.runAllTimersAsync();

      expect(eventBus.emit).toHaveBeenCalledWith('TaskCompleted', expect.objectContaining({ taskId: task.id }));
    });

    it('emits TaskFailed on non-zero exit code', async () => {
      const task = buildTask();
      await pool.spawn(task);

      tmuxConnector._simulateExit(task.id, 1);
      await vi.runAllTimersAsync();

      expect(eventBus.emit).toHaveBeenCalledWith('TaskFailed', expect.objectContaining({ taskId: task.id }));
    });

    it('maps null exit code to 0 (EC-8)', async () => {
      const task = buildTask();
      await pool.spawn(task);

      tmuxConnector._simulateExit(task.id, null);
      await vi.runAllTimersAsync();

      expect(eventBus.emit).toHaveBeenCalledWith('TaskCompleted', expect.objectContaining({ taskId: task.id }));
    });

    it('clears outputCapture after completion', async () => {
      const task = buildTask();
      await pool.spawn(task);

      // Simulate non-empty output so flush is triggered
      (outputCapture.getOutput as ReturnType<typeof vi.fn>).mockReturnValue(
        ok({ stdout: ['line'], stderr: [], taskId: task.id, totalSize: 10 }),
      );

      tmuxConnector._simulateExit(task.id, 0);
      await vi.runAllTimersAsync();

      expect(outputCapture.clear).toHaveBeenCalledWith(task.id);
    });
  });

  // ─── EC-1: Double completion guard ──────────────────────────────────────

  describe('EC-1: Double completion guard', () => {
    it('does not emit TaskCompleted twice if onExit fires twice', async () => {
      const task = buildTask();
      await pool.spawn(task);

      tmuxConnector._simulateExit(task.id, 0);
      tmuxConnector._simulateExit(task.id, 0);
      await vi.runAllTimersAsync();

      const completedCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([event]) => event === 'TaskCompleted',
      );
      expect(completedCalls).toHaveLength(1);
    });
  });

  // ─── AC-9: killAll ───────────────────────────────────────────────────────

  describe('AC-9: killAll destroys all sessions + dispose', () => {
    it('kills all workers and calls connector.dispose()', async () => {
      const task1 = buildTask();
      const task2 = buildTask();
      await pool.spawn(task1);
      await pool.spawn(task2);

      (tmuxConnector.isAlive as ReturnType<typeof vi.fn>).mockReturnValue(ok(false));

      const result = await pool.killAll();
      expect(result.ok).toBe(true);
      expect(tmuxConnector.dispose).toHaveBeenCalled();
    });

    it('returns ok when no workers exist', async () => {
      const result = await pool.killAll();
      expect(result.ok).toBe(true);
    });

    it('returns err(WORKER_KILL_FAILED) when at least one worker fails to kill', async () => {
      const task = buildTask();
      await pool.spawn(task);

      // isAlive returns false so gracefulShutdownSession returns immediately (no timer).
      // Make unregister throw so kill()'s try/catch catches it and returns err(WORKER_KILL_FAILED).
      (tmuxConnector.isAlive as ReturnType<typeof vi.fn>).mockReturnValue(ok(false));
      (workerRepository.unregister as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('DB connection lost');
      });

      const result = await pool.killAll();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.WORKER_KILL_FAILED);
        expect(result.error.message).toMatch(/orphaned/);
      }
      // dispose() is still called even on partial failure
      expect(tmuxConnector.dispose).toHaveBeenCalled();
    });
  });

  // ─── EC-3: UNIQUE violation rollback ────────────────────────────────────

  describe('EC-3: UNIQUE violation on registerWorker', () => {
    it('returns error and destroys session on UNIQUE violation', async () => {
      // Make workerRepository.register fail with WORKER_SPAWN_FAILED (UNIQUE violation)
      (workerRepository.register as ReturnType<typeof vi.fn>).mockReturnValue(
        err(new AutobeatError(ErrorCode.WORKER_SPAWN_FAILED, 'UNIQUE constraint failed')),
      );

      const task = buildTask();
      const result = await pool.spawn(task);

      expect(result.ok).toBe(false);
      // Session should be destroyed on registration failure
      expect(tmuxConnector.destroy).toHaveBeenCalled();
    });
  });

  // ─── EC-4: Kill on already-dead session ─────────────────────────────────

  describe('EC-4: Kill on already-dead session', () => {
    it('succeeds without error when session is already dead', async () => {
      (tmuxConnector.isAlive as ReturnType<typeof vi.fn>).mockReturnValue(ok(false));

      const task = buildTask();
      const spawnResult = await pool.spawn(task);
      expect(spawnResult.ok).toBe(true);
      if (!spawnResult.ok) return;

      const result = await pool.kill(spawnResult.value.id);
      expect(result.ok).toBe(true);
    });
  });

  // ─── EC-5: Periodic flush backpressure ───────────────────────────────────

  describe('EC-5: Periodic flush backpressure guard', () => {
    it('starts periodic flushing after spawn', async () => {
      (outputCapture.getOutput as ReturnType<typeof vi.fn>).mockReturnValue(
        ok({ stdout: ['line1'], stderr: [], taskId: '', totalSize: 10 }),
      );

      const task = buildTask();
      await pool.spawn(task);

      // Advance 1 flush interval
      await vi.advanceTimersByTimeAsync(1001);

      expect(outputRepository.save).toHaveBeenCalled();
    });
  });

  // ─── EC-6: Graceful shutdown with no workers ─────────────────────────────

  describe('EC-6: Graceful shutdown with no workers', () => {
    it('killAll returns ok when pool has no workers', async () => {
      const result = await pool.killAll();
      expect(result.ok).toBe(true);
    });
  });

  // ─── EC-9: Heartbeat detects dead session ────────────────────────────────

  describe('EC-9: Heartbeat detects dead session', () => {
    it('removes worker from pool when heartbeat detects dead session', async () => {
      // Set isAlive to return false (dead session)
      (tmuxConnector.isAlive as ReturnType<typeof vi.fn>).mockReturnValue(ok(false));

      const task = buildTask();
      await pool.spawn(task);
      expect(pool.getWorkerCount()).toBe(1);

      // Advance 30s to trigger heartbeat
      await vi.advanceTimersByTimeAsync(30_000);

      expect(pool.getWorkerCount()).toBe(0);
    });
  });

  // ─── AC-10: Worker timeout ───────────────────────────────────────────────

  describe('AC-10: handleWorkerTimeout emits TaskTimeout and kills session', () => {
    it('emits TaskTimeout when task timeout elapses', async () => {
      const TIMEOUT_MS = 5_000;
      const task = buildTask((f) => f.withTimeout(TIMEOUT_MS));

      // isAlive returns false so kill's grace-period resolves without destroy
      (tmuxConnector.isAlive as ReturnType<typeof vi.fn>).mockReturnValue(ok(false));

      await pool.spawn(task);

      // Advance past the task timeout to trigger handleWorkerTimeout
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 100);
      // Advance past kill()'s internal 3s grace-period setTimeout
      await vi.advanceTimersByTimeAsync(3_500);
      // Flush remaining microtasks / async continuations
      await vi.runAllTimersAsync();

      expect(eventBus.emit).toHaveBeenCalledWith('TaskTimeout', expect.objectContaining({ taskId: task.id }));
    });

    it('calls kill (sendControlKeys + destroy) when timeout fires', async () => {
      const TIMEOUT_MS = 3_000;
      const task = buildTask((f) => f.withTimeout(TIMEOUT_MS));

      // isAlive always true so destroy is invoked after grace period
      (tmuxConnector.isAlive as ReturnType<typeof vi.fn>).mockReturnValue(ok(true));

      await pool.spawn(task);

      // Advance past timeout, then past kill grace period
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 6_000);

      expect(tmuxConnector.sendControlKeys).toHaveBeenCalledWith(
        expect.objectContaining({ sessionName: expect.stringContaining('beat-') }),
        'C-c',
      );
      expect(tmuxConnector.destroy).toHaveBeenCalled();
    });

    it('does not emit TaskTimeout when task has no timeout set', async () => {
      // buildTask() by default uses TaskFactory which sets timeout: 30000
      // Use a task with explicit timeout: undefined to test the guard
      const task = { ...buildTask(), timeout: undefined };

      await pool.spawn(task);

      // Advance a long time — no timeout should fire
      await vi.advanceTimersByTimeAsync(120_000);

      const timeoutCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([event]) => event === 'TaskTimeout',
      );
      expect(timeoutCalls).toHaveLength(0);
    });

    it('does not emit TaskFailed after timeout (completionHandled guard)', async () => {
      const TIMEOUT_MS = 2_000;
      const task = buildTask((f) => f.withTimeout(TIMEOUT_MS));

      // isAlive returns false so kill completes quickly without destroy
      (tmuxConnector.isAlive as ReturnType<typeof vi.fn>).mockReturnValue(ok(false));

      await pool.spawn(task);

      // Advance past timeout
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 500);

      // Now simulate the onExit callback firing (as if tmux session ended)
      tmuxConnector._simulateExit(task.id, 1);
      await vi.runAllTimersAsync();

      const failedCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([event]) => event === 'TaskFailed',
      );
      expect(failedCalls).toHaveLength(0);
    });
  });

  // ─── AC-11: Adapter cleanup delegation ──────────────────────────────────

  describe('AC-11: adapter.cleanup() delegation', () => {
    /** Build a pool whose adapter uses the given cleanup function. */
    function buildPoolWithCleanup(cleanupFn: ReturnType<typeof vi.fn>): EventDrivenWorkerPool {
      const registry = createMockAgentRegistry();
      (registry.get as ReturnType<typeof vi.fn>).mockReturnValue(
        ok({
          provider: 'claude',
          dispose: vi.fn(),
          cleanup: cleanupFn,
          buildTmuxCommand: vi
            .fn()
            .mockImplementation((options: { taskId?: string; prompt?: string; sessionsDir?: string }) =>
              ok({
                config: {
                  name: `beat-${options.taskId ?? 'task-unknown'}`,
                  command: 'claude',
                  cwd: '/tmp',
                  taskId: options.taskId ?? 'task-unknown',
                  sessionsDir: options.sessionsDir ?? '/tmp/sessions',
                  agent: 'claude' as const,
                  agentArgs: [],
                },
                prompt: options.prompt ?? 'do stuff',
              }),
            ),
        }),
      );
      return buildPool({ agentRegistry: registry });
    }

    it('calls adapter.cleanup(taskId) when task with systemPrompt completes', async () => {
      const cleanupFn = vi.fn();
      const poolWithCleanup = buildPoolWithCleanup(cleanupFn);

      // Task with systemPrompt — triggers cleanupFn capture at spawn time
      const task = { ...buildTask(), systemPrompt: 'You are a coding assistant.' };
      await poolWithCleanup.spawn(task);

      // Simulate successful exit — cleanupWorkerState is called which invokes cleanupFn
      tmuxConnector._simulateExit(task.id, 0);
      await vi.runAllTimersAsync();

      expect(cleanupFn).toHaveBeenCalledWith(task.id);
    });

    it('continues worker cleanup even when adapter.cleanup() throws', async () => {
      const throwingCleanup = vi.fn().mockImplementation(() => {
        throw new Error('temp file deletion failed');
      });
      const poolWithThrowingCleanup = buildPoolWithCleanup(throwingCleanup);

      const task = { ...buildTask(), systemPrompt: 'You are a coding assistant.' };
      await poolWithThrowingCleanup.spawn(task);

      // Simulate exit — cleanupWorkerState must survive adapter.cleanup() throwing
      tmuxConnector._simulateExit(task.id, 0);
      await vi.runAllTimersAsync();

      // Worker is removed from pool despite cleanup() throwing
      expect(poolWithThrowingCleanup.getWorkerCount()).toBe(0);
      // Warning is logged for the failure
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Adapter cleanup() threw'),
        expect.objectContaining({ taskId: task.id }),
      );
    });
  });

  // ─── EC-10: Completion after kill (unknown worker guard) ─────────────────

  describe('EC-10: handleWorkerCompletion for already-removed worker', () => {
    it('logs a warning (not a crash) when onExit fires after worker has been removed', async () => {
      const task = buildTask();
      const spawnResult = await pool.spawn(task);
      expect(spawnResult.ok).toBe(true);
      if (!spawnResult.ok) return;

      // Kill the worker — removes it from internal maps
      (tmuxConnector.isAlive as ReturnType<typeof vi.fn>).mockReturnValue(ok(false));
      await pool.kill(spawnResult.value.id);

      // Now simulate onExit for the already-removed worker
      // The callbacks are still stored in the connector — calling _simulateExit
      // exercises the handleWorkerCompletion guard paths (lines 649-658)
      tmuxConnector._simulateExit(task.id, 0);
      await vi.runAllTimersAsync();

      // Must log a warning, not throw
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Worker completion for unknown'),
        expect.objectContaining({ taskId: task.id }),
      );
      // And must NOT emit TaskCompleted / TaskFailed for the already-handled task
      const completionCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([event]) => event === 'TaskCompleted' || event === 'TaskFailed',
      );
      expect(completionCalls).toHaveLength(0);
    });
  });

  // ─── EC-11: Worker registration contract ─────────────────────────────────

  describe('EC-11: workerRepository.register call shape', () => {
    it('registers worker with pid: 0 sentinel and sessionName from tmux handle', async () => {
      const task = buildTask();
      await pool.spawn(task);

      expect(workerRepository.register).toHaveBeenCalledWith(
        expect.objectContaining({
          pid: 0,
          taskId: task.id,
          sessionName: `beat-${task.id}`,
        }),
      );
    });
  });

  // ─── API-1: WorkerPool interface unchanged ───────────────────────────────

  describe('API-1: WorkerPool interface', () => {
    it('getWorkers returns empty array initially', () => {
      const result = pool.getWorkers();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(0);
    });

    it('getWorkerCount returns 0 initially', () => {
      expect(pool.getWorkerCount()).toBe(0);
    });

    it('getWorkerForTask returns null for unknown task', () => {
      const result = pool.getWorkerForTask(TaskId('nonexistent'));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeNull();
    });

    it('getWorker returns null for unknown worker', () => {
      const result = pool.getWorker(WorkerId('nonexistent'));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeNull();
    });

    it('spawn returns worker accessible via getWorkerForTask', async () => {
      const task = buildTask();
      await pool.spawn(task);

      const result = pool.getWorkerForTask(task.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).not.toBeNull();
      expect(result.value!.taskId).toBe(task.id);
    });

    it('getWorkerCount increments after spawn', async () => {
      await pool.spawn(buildTask());
      await pool.spawn(buildTask());
      expect(pool.getWorkerCount()).toBe(2);
    });
  });

  // ─── Phase 5: Persistent session reuse ───────────────────────────────────

  describe('Phase 5: persistent session reuse', () => {
    it('first spawn with persistentSessionKey creates a fresh session', async () => {
      const task = buildPersistentTask('loop-abc');
      const result = await pool.spawn(task);
      expect(result.ok).toBe(true);
      expect(tmuxConnector.spawn).toHaveBeenCalledOnce();
    });

    it('second spawn with same key reuses session (sends /clear then prompt)', async () => {
      const task1 = buildPersistentTask('loop-abc', (f) => f.withPrompt('iteration 1'));
      const task2 = buildPersistentTask('loop-abc', (f) => f.withPrompt('iteration 2'));

      await pool.spawn(task1);
      // Session is alive by default in the mock.
      // reuseSession() awaits a 300ms settle timer — advance fake timers concurrently.
      await Promise.all([pool.spawn(task2), vi.advanceTimersByTimeAsync(400)]);

      // spawn was only called once (for the first iteration)
      expect(tmuxConnector.spawn).toHaveBeenCalledOnce();
      // setEnvironment should have been called to update AUTOBEAT_TASK_ID
      expect(tmuxConnector.setEnvironment).toHaveBeenCalledWith(
        expect.objectContaining({ sessionName: expect.stringContaining('beat-') }),
        'AUTOBEAT_TASK_ID',
        task2.id,
      );
      // sendKeys called for /clear and for the prompt
      const sendKeysCalls = (tmuxConnector.sendKeys as ReturnType<typeof vi.fn>).mock.calls;
      expect(sendKeysCalls.some(([, keys]: [unknown, string]) => keys === '/clear\n')).toBe(true);
      expect(sendKeysCalls.some(([, keys]: [unknown, string]) => keys.includes('iteration 2'))).toBe(true);

      // Behavioral outcome: the worker must be reachable via the new task ID, not the old one.
      const workerForTask2 = pool.getWorkerForTask(task2.id);
      expect(workerForTask2.ok).toBe(true);
      if (!workerForTask2.ok) return;
      expect(workerForTask2.value).not.toBeNull();
      const workerForTask1 = pool.getWorkerForTask(task1.id);
      expect(workerForTask1.ok).toBe(true);
      if (!workerForTask1.ok) return;
      expect(workerForTask1.value).toBeNull();
    });

    it('concurrent spawns with same persistentSessionKey: second falls through to fresh spawn while first reuse is in-progress', async () => {
      // Tests the reuseInProgress guard. When reuseSession() is executing for a key,
      // a second concurrent spawn() for the same key must NOT wait for reuse — it falls
      // through to launchAndRegister (fresh spawn) immediately.
      const task1 = buildPersistentTask('loop-concurrent', (f) => f.withPrompt('first'));
      const task2 = buildPersistentTask('loop-concurrent', (f) => f.withPrompt('second'));
      const task3 = buildPersistentTask('loop-concurrent', (f) => f.withPrompt('concurrent'));

      // Establish the persistent session entry
      await pool.spawn(task1);
      expect(tmuxConnector.spawn).toHaveBeenCalledTimes(1);

      // Now reuse task2 and concurrently spawn task3 (same key) while reuse is in-progress.
      // task3 should see reuseInProgress and fall through to a fresh spawn.
      await Promise.all([
        pool.spawn(task2), // triggers reuseSession — acquires reuseInProgress lock for duration of settle timer
        pool.spawn(task3), // arrives while lock held — must fall through to fresh spawn
        vi.advanceTimersByTimeAsync(400), // advance past the 300ms settle timer so reuseSession can complete
      ]);

      // task2 reused the session (no new tmux spawn for it)
      // task3 fell through to a fresh spawn → total spawn count = 2 (task1 + task3)
      expect(tmuxConnector.spawn).toHaveBeenCalledTimes(2);
    });

    it('second spawn with dead persistent session creates a new fresh session', async () => {
      const task1 = buildPersistentTask('loop-dead');
      const task2 = buildPersistentTask('loop-dead');

      await pool.spawn(task1);

      // Simulate session dying
      (tmuxConnector.isAlive as ReturnType<typeof vi.fn>).mockReturnValue(ok(false));

      await pool.spawn(task2);

      // spawn called twice — once for each task
      expect(tmuxConnector.spawn).toHaveBeenCalledTimes(2);
      // /clear NOT sent because the session was dead and a fresh spawn happened
      const sendKeysCalls = (tmuxConnector.sendKeys as ReturnType<typeof vi.fn>).mock.calls;
      expect(sendKeysCalls.some(([, keys]: [unknown, string]) => keys === '/clear\n')).toBe(false);
    });

    it('cleanupPersistentSession destroys the session and removes it from the map', async () => {
      const task = buildPersistentTask('loop-cleanup');
      await pool.spawn(task);

      pool.cleanupPersistentSession('loop-cleanup');

      expect(tmuxConnector.destroy).toHaveBeenCalledOnce();

      // Subsequent spawn for same key should create a new session (not reuse destroyed one)
      const task2 = buildPersistentTask('loop-cleanup');
      (tmuxConnector.isAlive as ReturnType<typeof vi.fn>).mockReturnValue(ok(true));
      await pool.spawn(task2);
      expect(tmuxConnector.spawn).toHaveBeenCalledTimes(2);
    });

    it('cleanupPersistentSession is a no-op when no session is registered for the key', () => {
      expect(() => pool.cleanupPersistentSession('nonexistent-key')).not.toThrow();
      expect(tmuxConnector.destroy).not.toHaveBeenCalled();
    });

    it('killAll destroys all persistent sessions', async () => {
      const task1 = buildPersistentTask('loop-x');
      const task2 = buildPersistentTask('loop-y');

      await pool.spawn(task1);
      await pool.spawn(task2);

      // isAlive: false so kill() skips graceful shutdown
      (tmuxConnector.isAlive as ReturnType<typeof vi.fn>).mockReturnValue(ok(false));

      await pool.killAll();

      // destroy should have been called for both persistent sessions
      expect(tmuxConnector.destroy).toHaveBeenCalledTimes(2);
    });

    it('tasks without persistentSessionKey never reuse a session', async () => {
      const regular1 = buildTask((f) => f.withPrompt('regular 1'));
      const regular2 = buildTask((f) => f.withPrompt('regular 2'));

      await pool.spawn(regular1);
      await pool.spawn(regular2);

      // Both tasks spawn fresh sessions
      expect(tmuxConnector.spawn).toHaveBeenCalledTimes(2);
      // setEnvironment never called for non-persistent tasks
      expect(tmuxConnector.setEnvironment).not.toHaveBeenCalled();
    });

    it('onOutput callback routes output to the current iteration task, not the original', async () => {
      // Regression test for stale-closure bug: after reuseSession, output must be
      // attributed to the new task ID, not the one captured at createCallbacks time.
      const task1 = buildPersistentTask('loop-output', (f) => f.withPrompt('iter 1'));
      const task2 = buildPersistentTask('loop-output', (f) => f.withPrompt('iter 2'));

      await pool.spawn(task1);
      await Promise.all([pool.spawn(task2), vi.advanceTimersByTimeAsync(400)]);

      // Simulate output arriving after the session is reused for task2.
      // task1.id is used here because the mock stores callbacks keyed by the original
      // spawn task ID — firing on task1.id triggers the session's output handler.
      tmuxConnector._simulateOutput(task1.id, {
        sequence: 1,
        timestamp: '',
        type: 'stdout',
        content: 'hello from iter 2',
      });

      // Output must be captured under task2's ID
      expect(outputCapture.capture).toHaveBeenCalledWith(task2.id, 'stdout', 'hello from iter 2');
      // Must NOT have been captured under task1's stale ID for this specific message
      const calls = (outputCapture.capture as ReturnType<typeof vi.fn>).mock.calls;
      const capturedUnderTask1 = calls.filter(
        ([id, , content]: [string, string, string]) => id === task1.id && content === 'hello from iter 2',
      );
      expect(capturedUnderTask1).toHaveLength(0);
    });

    it('onExit callback emits TaskCompleted for the current iteration task after reuse', async () => {
      // Regression test for stale-closure + stale WorkerState bugs: after reuseSession,
      // onExit must look up the new taskId (not the original) so TaskCompleted is emitted.
      const task1 = buildPersistentTask('loop-exit', (f) => f.withPrompt('iter 1'));
      const task2 = buildPersistentTask('loop-exit', (f) => f.withPrompt('iter 2'));

      await pool.spawn(task1);
      await Promise.all([pool.spawn(task2), vi.advanceTimersByTimeAsync(400)]);

      // Simulate exit for the session (originally registered under task1's ID).
      // task1.id is used because the mock stores callbacks keyed by the original
      // spawn task ID — firing on task1.id triggers the session's exit handler.
      tmuxConnector._simulateExit(task1.id, 0);
      // Let the async flush + completion chain resolve
      await vi.advanceTimersByTimeAsync(100);

      // TaskCompleted must be emitted for task2 (the active iteration), not task1
      const emitCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
      const completedForTask2 = emitCalls.filter(
        ([event, payload]: [string, { taskId: string }]) => event === 'TaskCompleted' && payload.taskId === task2.id,
      );
      expect(completedForTask2).toHaveLength(1);

      // TaskCompleted must NOT be emitted for the stale task1 ID
      const completedForTask1 = emitCalls.filter(
        ([event, payload]: [string, { taskId: string }]) => event === 'TaskCompleted' && payload.taskId === task1.id,
      );
      expect(completedForTask1).toHaveLength(0);
    });

    it('completionHandled is reset to false after session reuse so the new iteration can complete', async () => {
      // Regression test for stale WorkerState: completionHandled from a previous iteration
      // must be false after reuse so the new iteration's completion is not silently dropped.
      const task1 = buildPersistentTask('loop-reset', (f) => f.withPrompt('iter 1'));
      const task2 = buildPersistentTask('loop-reset', (f) => f.withPrompt('iter 2'));

      await pool.spawn(task1);
      await Promise.all([pool.spawn(task2), vi.advanceTimersByTimeAsync(400)]);

      // Simulate exit twice for the reused session — only the first should emit.
      // task1.id is used because the mock stores callbacks keyed by the original
      // spawn task ID — both firings target the same session's exit handler.
      tmuxConnector._simulateExit(task1.id, 0);
      await vi.advanceTimersByTimeAsync(100);
      tmuxConnector._simulateExit(task1.id, 0);
      await vi.advanceTimersByTimeAsync(100);

      const emitCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
      const completedEvents = emitCalls.filter(([event]: [string]) => event === 'TaskCompleted');
      // Exactly one completion event despite two exit signals
      expect(completedEvents).toHaveLength(1);
    });

    it('reuseSession failure (setEnvironment error) falls through to fresh spawn rather than propagating error', async () => {
      // Regression test for design-mismatch bug: setEnvironment failure must cause a fresh
      // spawn rather than returning an error to the caller.
      const task1 = buildPersistentTask('loop-fallback', (f) => f.withPrompt('iter 1'));
      const task2 = buildPersistentTask('loop-fallback', (f) => f.withPrompt('iter 2'));

      await pool.spawn(task1);

      // Make setEnvironment fail on the next call (simulates a broken session)
      (tmuxConnector.setEnvironment as ReturnType<typeof vi.fn>).mockReturnValueOnce(
        err(new Error('env update failed')),
      );

      const result = await pool.spawn(task2);

      // Must succeed — fall through to fresh spawn, not propagate the error
      expect(result.ok).toBe(true);
      // A second tmux spawn was created for the fresh iteration
      expect(tmuxConnector.spawn).toHaveBeenCalledTimes(2);
    });

    // ── B1-1 regression: real-world loop lifecycle ─────────────────────────

    it('B1-1: reuses session after previous iteration completed (WorkerState removed by cleanupWorkerState)', async () => {
      // Real-world loop lifecycle: task1 completes, onExit → cleanupWorkerState removes
      // the WorkerState from this.workers. When task2 spawns, reuseSession must re-register
      // a new WorkerState rather than falling through to a fresh spawn.
      const task1 = buildPersistentTask('loop-lifecycle', (f) => f.withPrompt('iter 1'));
      const task2 = buildPersistentTask('loop-lifecycle', (f) => f.withPrompt('iter 2'));

      await pool.spawn(task1);

      // Simulate iteration 1 completing: onExit → handleWorkerCompletion → cleanupWorkerState
      tmuxConnector._simulateExit(task1.id, 0);
      // Let the async flush chain (flushOutput, outputCapture.clear) settle
      await vi.advanceTimersByTimeAsync(50);

      // Now spawn iteration 2 — this is where B1-1 manifests.
      // After cleanupWorkerState, this.workers.get(workerId) === undefined.
      // The fix re-registers a new WorkerState using the stored taskIdRef + handle.
      const [spawnResult] = await Promise.all([pool.spawn(task2), vi.advanceTimersByTimeAsync(400)]);

      // Must succeed and reuse the existing session (not spawn a new tmux session)
      expect(spawnResult.ok).toBe(true);
      expect(tmuxConnector.spawn).toHaveBeenCalledOnce(); // only the original spawn for task1

      // The worker must be accessible via the new task ID
      const workerForTask2 = pool.getWorkerForTask(task2.id);
      expect(workerForTask2.ok).toBe(true);
      if (!workerForTask2.ok) return;
      expect(workerForTask2.value).not.toBeNull();

      // Task1's mapping must be gone (cleaned up by handleWorkerCompletion)
      const workerForTask1 = pool.getWorkerForTask(task1.id);
      expect(workerForTask1.ok).toBe(true);
      if (!workerForTask1.ok) return;
      expect(workerForTask1.value).toBeNull();
    });

    it('B1-1: after completion-then-reuse, onExit emits TaskCompleted for iteration 2', async () => {
      // After B1-1 fix: when task2 reuses a session whose previous WorkerState was cleaned up,
      // the new WorkerState's onExit callback must emit TaskCompleted for task2.
      const task1 = buildPersistentTask('loop-lc-exit', (f) => f.withPrompt('iter 1'));
      const task2 = buildPersistentTask('loop-lc-exit', (f) => f.withPrompt('iter 2'));

      await pool.spawn(task1);
      // Iteration 1 completes — cleans up WorkerState
      tmuxConnector._simulateExit(task1.id, 0);
      await vi.advanceTimersByTimeAsync(50);

      // Iteration 2 spawns and reuses session
      await Promise.all([pool.spawn(task2), vi.advanceTimersByTimeAsync(400)]);

      // Clear emit calls from task1's completion before simulating task2's exit
      (eventBus.emit as ReturnType<typeof vi.fn>).mockClear();

      // Simulate iteration 2 completing (callbacks still keyed by original taskId in mock)
      tmuxConnector._simulateExit(task1.id, 0);
      await vi.advanceTimersByTimeAsync(100);

      const emitCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
      const completedForTask2 = emitCalls.filter(
        ([event, payload]: [string, { taskId: string }]) => event === 'TaskCompleted' && payload.taskId === task2.id,
      );
      expect(completedForTask2).toHaveLength(1);
    });

    it('B1-3: heartbeat timer is restarted after session reuse following completion', async () => {
      // After B1-1 fix, the re-registered WorkerState must have timers set up.
      // onExit stops flushing + heartbeat before handleWorkerCompletion; without
      // restarting them, the reused session has no heartbeat updates.
      const task1 = buildPersistentTask('loop-timers', (f) => f.withPrompt('iter 1'));
      const task2 = buildPersistentTask('loop-timers', (f) => f.withPrompt('iter 2'));

      await pool.spawn(task1);
      // Iteration 1 completes — stops timers
      tmuxConnector._simulateExit(task1.id, 0);
      await vi.advanceTimersByTimeAsync(50);

      // Iteration 2 spawns and reuses session
      const [spawnResult] = await Promise.all([pool.spawn(task2), vi.advanceTimersByTimeAsync(400)]);
      expect(spawnResult.ok).toBe(true);

      // Advance past heartbeat interval (30s) — heartbeat write should fire for reused worker
      (workerRepository.updateHeartbeat as ReturnType<typeof vi.fn>).mockClear();
      await vi.advanceTimersByTimeAsync(31_000);
      // The heartbeat timer must have fired for task2's session
      expect(workerRepository.updateHeartbeat).toHaveBeenCalled();
    });

    it('B1-timer-leak: existing timers are cleared before setup calls in in-place remap branch', async () => {
      // Regression: the else branch (WorkerState still present) called setupTimeoutForWorker,
      // setupHeartbeatForWorker, and startFlushing without first clearing existing timers.
      // If the previous task's timeout or heartbeat was still running, those handles were
      // silently overwritten — leaking setInterval/setTimeout.
      //
      // This test verifies that after in-place remap, there is exactly one heartbeat timer
      // (not two). We use updateHeartbeat call frequency as a proxy: if a leaked timer ran
      // alongside the new one, it would fire extra calls.
      //
      // The else branch runs when WorkerState is still in this.workers at reuse time —
      // i.e. reuseSession() is called before onExit/cleanupWorkerState has removed it.
      // We simulate this by NOT simulating task1's exit before spawning task2.
      const task1 = buildPersistentTask('loop-timer-leak', (f) => f.withPrompt('iter 1'));
      const task2 = buildPersistentTask('loop-timer-leak', (f) => f.withPrompt('iter 2'));

      await pool.spawn(task1);
      // Do NOT simulate task1 exit — WorkerState remains in this.workers map,
      // so reuseSession() hits the else (in-place remap) branch.
      const [spawnResult] = await Promise.all([pool.spawn(task2), vi.advanceTimersByTimeAsync(400)]);
      expect(spawnResult.ok).toBe(true);

      // Advance past one full heartbeat interval (30s).
      // With the fix: exactly one heartbeat fires.
      // Without the fix: two leaked timers fire simultaneously → two calls.
      (workerRepository.updateHeartbeat as ReturnType<typeof vi.fn>).mockClear();
      await vi.advanceTimersByTimeAsync(31_000);
      // Exactly one heartbeat per interval — no leaked timer running in parallel
      expect(workerRepository.updateHeartbeat).toHaveBeenCalledTimes(1);
    });

    it('B1-4: in-place remap clears flushingInProgress for old task so first new-task flush is not skipped', async () => {
      // B1-4 regression: remapExistingWorkerForReuse must delete the old task's flushingInProgress
      // entry before updating worker.taskId. Without the delete, an in-flight flush from the
      // previous iteration could leave a stale entry that blocks the new task's first flush tick.
      //
      // This test triggers the in-place remap branch (WorkerState still present — no exit before reuse).
      // It then verifies that the flush interval fires and calls getOutput for task2's ID on the
      // first tick, proving the flush was NOT skipped due to a stale flushingInProgress entry.
      //
      // Strategy: Mock getOutput to track which taskId was flushed. Advance past one flush interval
      // and confirm getOutput was called for task2 (not task1, not suppressed).
      const task1 = buildPersistentTask('loop-b14', (f) => f.withPrompt('iter 1'));
      const task2 = buildPersistentTask('loop-b14', (f) => f.withPrompt('iter 2'));

      await pool.spawn(task1);
      // Do NOT simulate task1 exit — WorkerState stays in this.workers, hitting the in-place
      // remap branch (remapExistingWorkerForReuse) rather than the re-registration branch.
      const [spawnResult] = await Promise.all([pool.spawn(task2), vi.advanceTimersByTimeAsync(400)]);
      expect(spawnResult.ok).toBe(true);

      // Arrange: clear getOutput call history from task1 setup, then advance past one flush interval.
      (outputCapture.getOutput as ReturnType<typeof vi.fn>).mockClear();
      await vi.advanceTimersByTimeAsync(1_100); // past the 1s flush interval

      // The first flush tick for task2 must NOT be skipped — getOutput must be called for task2.
      const getOutputCalls = (outputCapture.getOutput as ReturnType<typeof vi.fn>).mock.calls;
      const flushedForTask2 = getOutputCalls.some(([id]: [string]) => id === task2.id);
      expect(flushedForTask2).toBe(true);
    });

    it('B1-5: in-place remap calls updateTaskId with the new task ID (DB re-registration)', async () => {
      // B1-5 regression: remapExistingWorkerForReuse must call workerRepository.updateTaskId()
      // to atomically update the DB worker registration from the old task ID to the new task ID.
      // Without this, the worker row in the DB still references the old task — crash recovery
      // would try to resume a stale task ID, leading to a ghost worker entry.
      //
      // This test triggers the in-place remap branch (WorkerState still present — no exit before reuse).
      const task1 = buildPersistentTask('loop-b15', (f) => f.withPrompt('iter 1'));
      const task2 = buildPersistentTask('loop-b15', (f) => f.withPrompt('iter 2'));

      await pool.spawn(task1);
      // Do NOT simulate task1 exit — keeps WorkerState in this.workers, hitting in-place remap.
      const [spawnResult] = await Promise.all([pool.spawn(task2), vi.advanceTimersByTimeAsync(400)]);
      expect(spawnResult.ok).toBe(true);

      // updateTaskId must have been called with task2's ID (the new DB registration).
      expect(workerRepository.updateTaskId).toHaveBeenCalledWith(expect.objectContaining({ taskId: task2.id }));
    });

    it('B1-2: sendKeys failure on reuse cleans up WorkerState (falls through to fresh spawn)', async () => {
      // B1-2: if sendKeys fails after worker state is remapped, cleanupWorkerState must be
      // called to clear timers and remove the worker from maps — preventing orphaned callbacks.
      // The call falls through to a fresh spawn.
      const task1 = buildPersistentTask('loop-sendkeys-fail', (f) => f.withPrompt('iter 1'));
      const task2 = buildPersistentTask('loop-sendkeys-fail', (f) => f.withPrompt('iter 2'));

      await pool.spawn(task1);

      // Make sendKeys fail on the prompt send inside reuseSession.
      // The mock is installed AFTER task1's spawn, so call counts restart from 0.
      // sendKeys call order from this point: (1) /clear in reuseSession,
      // (2) task2 prompt in reuseSession — fail on call 2.
      // Subsequent calls (fresh spawn prompt) must succeed so the fallback completes.
      (tmuxConnector.sendKeys as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(ok(undefined)) // call 1: /clear succeeds
        .mockReturnValueOnce(err(new Error('pipe broken'))); // call 2: prompt fails → fallthrough

      const [spawnResult] = await Promise.all([pool.spawn(task2), vi.advanceTimersByTimeAsync(400)]);

      // Must fall through to fresh spawn (ok result, 2 total spawns)
      expect(spawnResult.ok).toBe(true);
      expect(tmuxConnector.spawn).toHaveBeenCalledTimes(2);

      // The persistent session must be destroyed (cleanupPersistentSession called after cleanupWorkerState)
      expect(tmuxConnector.destroy).toHaveBeenCalled();
    });

    // ─── Phase B: prepareForReuse ordering ────────────────────────────────────

    it('Phase B: prepareForReuse called after setEnvironment and /clear settle, before sendKeys(prompt)', async () => {
      // Verify the call ordering: setEnvironment → sendKeys(/clear) → [settle] →
      // prepareForReuse → sendKeys(prompt). The connector must have watchers ready
      // before the agent starts processing the new prompt.
      const task1 = buildPersistentTask('loop-ordering', (f) => f.withPrompt('iter 1'));
      const task2 = buildPersistentTask('loop-ordering', (f) => f.withPrompt('iter 2'));

      await pool.spawn(task1);

      const callOrder: string[] = [];
      vi.mocked(tmuxConnector.setEnvironment).mockImplementation((...args) => {
        callOrder.push(`setEnvironment(${args[1]})`);
        return ok(undefined);
      });
      vi.mocked(tmuxConnector.sendKeys).mockImplementation((...args) => {
        const keys = args[1] as string;
        callOrder.push(keys.includes('/clear') ? 'sendKeys(/clear)' : 'sendKeys(prompt)');
        return ok(undefined);
      });
      vi.mocked(tmuxConnector.prepareForReuse).mockImplementation(() => {
        callOrder.push('prepareForReuse');
        return ok(undefined);
      });

      await Promise.all([pool.spawn(task2), vi.advanceTimersByTimeAsync(400)]);

      const envIdx = callOrder.indexOf('setEnvironment(AUTOBEAT_TASK_ID)');
      const clearIdx = callOrder.indexOf('sendKeys(/clear)');
      const prepareIdx = callOrder.indexOf('prepareForReuse');
      const promptIdx = callOrder.indexOf('sendKeys(prompt)');

      expect(envIdx).toBeGreaterThanOrEqual(0);
      expect(clearIdx).toBeGreaterThan(envIdx);
      expect(prepareIdx).toBeGreaterThan(clearIdx);
      expect(promptIdx).toBeGreaterThan(prepareIdx);
    });

    it('Phase B: prepareForReuse failure falls through to fresh spawn', async () => {
      const task1 = buildPersistentTask('loop-prepare-fail', (f) => f.withPrompt('iter 1'));
      const task2 = buildPersistentTask('loop-prepare-fail', (f) => f.withPrompt('iter 2'));

      await pool.spawn(task1);

      // Make prepareForReuse fail
      vi.mocked(tmuxConnector.prepareForReuse).mockReturnValueOnce(
        err(
          new (await import('../../../src/core/errors')).AutobeatError(
            (await import('../../../src/core/errors')).ErrorCode.TMUX_HOOK_FAILED,
            'dir creation failed',
          ),
        ),
      );

      const [spawnResult] = await Promise.all([pool.spawn(task2), vi.advanceTimersByTimeAsync(400)]);

      // Must fall through to fresh spawn
      expect(spawnResult.ok).toBe(true);
      expect(tmuxConnector.spawn).toHaveBeenCalledTimes(2);
    });

    it('Phase B: prepareForReuse called with the new task ID', async () => {
      const task1 = buildPersistentTask('loop-taskid', (f) => f.withPrompt('iter 1'));
      const task2 = buildPersistentTask('loop-taskid', (f) => f.withPrompt('iter 2'));

      await pool.spawn(task1);

      await Promise.all([pool.spawn(task2), vi.advanceTimersByTimeAsync(400)]);

      // prepareForReuse must have been called with task2's ID
      expect(tmuxConnector.prepareForReuse).toHaveBeenCalledWith(
        expect.objectContaining({ sessionName: expect.stringContaining('beat-') }),
        task2.id,
        expect.any(Object), // callbacks
      );
    });
  });
});
