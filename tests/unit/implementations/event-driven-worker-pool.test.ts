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
        spawn: vi.fn(),
        spawnInteractive: vi.fn(),
        kill: vi.fn(),
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

  // ─── AC-1: Uses TmuxConnectorPort (not ChildProcess/ProcessConnector) ─────

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
            spawn: vi.fn(),
            spawnInteractive: vi.fn(),
            kill: vi.fn(),
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
          spawn: vi.fn(),
          spawnInteractive: vi.fn(),
          kill: vi.fn(),
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
  });
});
