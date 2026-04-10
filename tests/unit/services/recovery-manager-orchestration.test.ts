/**
 * Unit tests for RecoveryManager zombie orchestration detection
 * ARCHITECTURE: Tests the failZombieRunningOrchestrations method
 * Pattern: Behavioral testing with mock repositories
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Loop,
  type LoopIteration,
  LoopId,
  LoopStatus,
  LoopStrategy,
  OrchestratorId,
  OrchestratorStatus,
  TaskId,
  WorkerId,
  updateOrchestration,
  type Orchestration,
} from '../../../src/core/domain.js';
import { ok, err } from '../../../src/core/result.js';
import { RecoveryManager } from '../../../src/services/recovery-manager.js';
import { checkOrchestrationLiveness } from '../../../src/services/orchestration-liveness.js';

// ============================================================================
// Mock factories
// ============================================================================

const createMockOrchestration = (overrides: Partial<Orchestration> = {}): Orchestration => ({
  id: OrchestratorId('orch-test-1'),
  goal: 'Test goal',
  loopId: undefined,
  stateFilePath: '/tmp/test-state.json',
  workingDirectory: '/tmp',
  agent: 'claude',
  maxDepth: 2,
  maxWorkers: 3,
  maxIterations: 10,
  status: OrchestratorStatus.RUNNING,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...overrides,
});

const createMockIteration = (overrides: Partial<LoopIteration> = {}): LoopIteration => ({
  id: 'iter-1',
  loopId: LoopId('loop-test-1'),
  iterationNumber: 1,
  taskId: TaskId('task-test-1'),
  status: 'running',
  startedAt: new Date(),
  ...overrides,
});

const makeRecoveryManager = (deps: {
  orchestrationRepo?: Record<string, unknown>;
  loopRepo?: Record<string, unknown>;
  taskRepo?: Record<string, unknown>;
  workerRepo?: Record<string, unknown>;
} = {}) => {
  const defaultTaskRepo = {
    findByStatus: vi.fn().mockResolvedValue(ok([])),
    findById: vi.fn().mockResolvedValue(ok(null)),
    update: vi.fn().mockResolvedValue(ok(undefined)),
    cleanupOldTasks: vi.fn().mockResolvedValue(ok(0)),
    countByStatus: vi.fn().mockResolvedValue(ok({})),
  };

  const defaultLoopRepo = {
    findAll: vi.fn().mockResolvedValue(ok([])),
    getIterations: vi.fn().mockResolvedValue(ok([])),
    cleanupOldLoops: vi.fn().mockResolvedValue(ok(0)),
  };

  const defaultOrchRepo = {
    findByStatus: vi.fn().mockResolvedValue(ok([])),
    update: vi.fn().mockResolvedValue(ok(undefined)),
    cleanupOldOrchestrations: vi.fn().mockResolvedValue(ok(0)),
  };

  const defaultWorkerRepo = {
    findAll: vi.fn().mockReturnValue(ok([])),
    findByTaskId: vi.fn().mockReturnValue(ok(null)),
    unregister: vi.fn().mockReturnValue(ok(undefined)),
  };

  const defaultDependencyRepo = {
    isBlocked: vi.fn().mockResolvedValue(ok(false)),
  };

  const defaultEventBus = {
    emit: vi.fn().mockResolvedValue(ok(undefined)),
  };

  const defaultQueue = {
    enqueue: vi.fn().mockReturnValue(ok(undefined)),
    contains: vi.fn().mockReturnValue(false),
  };

  const defaultLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };

  return {
    recovery: new RecoveryManager({
      taskRepo: { ...defaultTaskRepo, ...deps.taskRepo } as never,
      queue: defaultQueue as never,
      eventBus: defaultEventBus as never,
      logger: defaultLogger as never,
      workerRepo: { ...defaultWorkerRepo, ...deps.workerRepo } as never,
      dependencyRepo: defaultDependencyRepo as never,
      loopRepo: { ...defaultLoopRepo, ...deps.loopRepo } as never,
      orchestrationRepo: { ...defaultOrchRepo, ...deps.orchestrationRepo } as never,
    }),
    mocks: {
      taskRepo: { ...defaultTaskRepo, ...deps.taskRepo },
      loopRepo: { ...defaultLoopRepo, ...deps.loopRepo },
      orchRepo: { ...defaultOrchRepo, ...deps.orchestrationRepo },
      workerRepo: { ...defaultWorkerRepo, ...deps.workerRepo },
    },
  };
};

// ============================================================================
// checkOrchestrationLiveness unit tests
// ============================================================================

describe('checkOrchestrationLiveness', () => {
  it('returns unknown when orchestration has no loopId', async () => {
    const orch = createMockOrchestration({ loopId: undefined });
    const loopRepo = { getIterations: vi.fn() };
    const taskRepo = { findById: vi.fn() };
    const workerRepo = { findByTaskId: vi.fn() };

    const result = await checkOrchestrationLiveness(orch, {
      loopRepo: loopRepo as never,
      taskRepo: taskRepo as never,
      workerRepo: workerRepo as never,
      isProcessAlive: vi.fn(),
    });

    expect(result).toBe('unknown');
    expect(loopRepo.getIterations).not.toHaveBeenCalled();
  });

  it('returns unknown when no iterations exist', async () => {
    const orch = createMockOrchestration({ loopId: LoopId('loop-1') });
    const loopRepo = { getIterations: vi.fn().mockResolvedValue(ok([])) };

    const result = await checkOrchestrationLiveness(orch, {
      loopRepo: loopRepo as never,
      taskRepo: { findById: vi.fn() } as never,
      workerRepo: { findByTaskId: vi.fn() } as never,
      isProcessAlive: vi.fn(),
    });

    expect(result).toBe('unknown');
  });

  it('returns unknown when iteration is not running', async () => {
    const orch = createMockOrchestration({ loopId: LoopId('loop-1') });
    const iter = createMockIteration({ status: 'completed', taskId: TaskId('task-1') });
    const loopRepo = { getIterations: vi.fn().mockResolvedValue(ok([iter])) };

    const result = await checkOrchestrationLiveness(orch, {
      loopRepo: loopRepo as never,
      taskRepo: { findById: vi.fn() } as never,
      workerRepo: { findByTaskId: vi.fn() } as never,
      isProcessAlive: vi.fn(),
    });

    expect(result).toBe('unknown');
  });

  it('returns live when worker PID is alive', async () => {
    const orch = createMockOrchestration({ loopId: LoopId('loop-1') });
    const iter = createMockIteration({ status: 'running', taskId: TaskId('task-1') });
    const loopRepo = { getIterations: vi.fn().mockResolvedValue(ok([iter])) };
    const task = { id: TaskId('task-1'), workerId: WorkerId('worker-1'), status: 'running' };
    const taskRepo = { findById: vi.fn().mockResolvedValue(ok(task)) };
    const workerReg = { workerId: WorkerId('worker-1'), ownerPid: 12345, taskId: TaskId('task-1') };
    const workerRepo = { findByTaskId: vi.fn().mockReturnValue(ok(workerReg)) };
    const isProcessAlive = vi.fn().mockReturnValue(true);

    const result = await checkOrchestrationLiveness(orch, {
      loopRepo: loopRepo as never,
      taskRepo: taskRepo as never,
      workerRepo: workerRepo as never,
      isProcessAlive,
    });

    expect(result).toBe('live');
    expect(isProcessAlive).toHaveBeenCalledWith(12345);
  });

  it('returns dead when worker PID is not alive', async () => {
    const orch = createMockOrchestration({ loopId: LoopId('loop-1') });
    const iter = createMockIteration({ status: 'running', taskId: TaskId('task-1') });
    const loopRepo = { getIterations: vi.fn().mockResolvedValue(ok([iter])) };
    const task = { id: TaskId('task-1'), workerId: WorkerId('worker-1'), status: 'running' };
    const taskRepo = { findById: vi.fn().mockResolvedValue(ok(task)) };
    const workerReg = { workerId: WorkerId('worker-1'), ownerPid: 99999, taskId: TaskId('task-1') };
    const workerRepo = { findByTaskId: vi.fn().mockReturnValue(ok(workerReg)) };
    const isProcessAlive = vi.fn().mockReturnValue(false);

    const result = await checkOrchestrationLiveness(orch, {
      loopRepo: loopRepo as never,
      taskRepo: taskRepo as never,
      workerRepo: workerRepo as never,
      isProcessAlive,
    });

    expect(result).toBe('dead');
  });
});

// ============================================================================
// RecoveryManager.failZombieRunningOrchestrations (via recover())
// ============================================================================

describe('RecoveryManager — zombie RUNNING orchestration detection', () => {
  it('leaves orchestration with no loopId alone (unknown liveness)', async () => {
    const orch = createMockOrchestration({ loopId: undefined });
    const orchRepo = {
      findByStatus: vi.fn().mockResolvedValue(ok([orch])),
      update: vi.fn().mockResolvedValue(ok(undefined)),
      cleanupOldOrchestrations: vi.fn().mockResolvedValue(ok(0)),
    };
    const loopRepo = {
      getIterations: vi.fn().mockResolvedValue(ok([])),
      cleanupOldLoops: vi.fn().mockResolvedValue(ok(0)),
    };

    const { recovery, mocks } = makeRecoveryManager({ orchestrationRepo: orchRepo, loopRepo });
    await recovery.recover();

    expect(orchRepo.update).not.toHaveBeenCalled();
  });

  it('leaves orchestration with live worker PID alone', async () => {
    const orch = createMockOrchestration({ loopId: LoopId('loop-1') });
    const iter = createMockIteration({ status: 'running', taskId: TaskId('task-1') });
    const task = { id: TaskId('task-1'), workerId: WorkerId('worker-1'), status: 'running' };
    const workerReg = { workerId: WorkerId('worker-1'), ownerPid: process.pid, taskId: TaskId('task-1') };

    const orchRepo = {
      findByStatus: vi.fn((status: string) =>
        status === OrchestratorStatus.RUNNING ? ok([orch]) : ok([]),
      ),
      update: vi.fn().mockResolvedValue(ok(undefined)),
      cleanupOldOrchestrations: vi.fn().mockResolvedValue(ok(0)),
    };
    const loopRepo = {
      getIterations: vi.fn().mockResolvedValue(ok([iter])),
      cleanupOldLoops: vi.fn().mockResolvedValue(ok(0)),
    };
    const taskRepo = {
      findByStatus: vi.fn().mockResolvedValue(ok([])),
      findById: vi.fn().mockResolvedValue(ok(task)),
      update: vi.fn().mockResolvedValue(ok(undefined)),
      cleanupOldTasks: vi.fn().mockResolvedValue(ok(0)),
    };
    const workerRepo = {
      findAll: vi.fn().mockReturnValue(ok([])),
      findByTaskId: vi.fn().mockReturnValue(ok(workerReg)),
      unregister: vi.fn().mockReturnValue(ok(undefined)),
    };

    const { recovery } = makeRecoveryManager({ orchestrationRepo: orchRepo, loopRepo, taskRepo, workerRepo });
    await recovery.recover();

    // update should not be called for the orchestration (only for tasks potentially)
    const orchUpdateCalls = orchRepo.update.mock.calls;
    expect(orchUpdateCalls.length).toBe(0);
  });

  it('marks orchestration FAILED when worker PID is dead', async () => {
    const orch = createMockOrchestration({ loopId: LoopId('loop-1') });
    const iter = createMockIteration({ status: 'running', taskId: TaskId('task-1') });
    const task = { id: TaskId('task-1'), workerId: WorkerId('worker-1'), status: 'running' };
    // Use a PID guaranteed to be dead (PID 1 exists but we can force isProcessAlive to return false
    // by using a PID that cannot be signalled — we'll use 999999)
    const workerReg = { workerId: WorkerId('worker-1'), ownerPid: 999999, taskId: TaskId('task-1') };

    const orchRepo = {
      findByStatus: vi.fn((status: string) =>
        status === OrchestratorStatus.RUNNING ? ok([orch]) : ok([]),
      ),
      update: vi.fn().mockResolvedValue(ok(undefined)),
      cleanupOldOrchestrations: vi.fn().mockResolvedValue(ok(0)),
    };
    const loopRepo = {
      getIterations: vi.fn().mockResolvedValue(ok([iter])),
      cleanupOldLoops: vi.fn().mockResolvedValue(ok(0)),
    };
    const taskRepo = {
      findByStatus: vi.fn().mockResolvedValue(ok([])),
      findById: vi.fn().mockResolvedValue(ok(task)),
      update: vi.fn().mockResolvedValue(ok(undefined)),
      cleanupOldTasks: vi.fn().mockResolvedValue(ok(0)),
    };
    const workerRepo = {
      findAll: vi.fn().mockReturnValue(ok([])),
      findByTaskId: vi.fn().mockReturnValue(ok(workerReg)),
      unregister: vi.fn().mockReturnValue(ok(undefined)),
    };

    const { recovery } = makeRecoveryManager({ orchestrationRepo: orchRepo, loopRepo, taskRepo, workerRepo });
    await recovery.recover();

    expect(orchRepo.update).toHaveBeenCalledOnce();
    const updatedOrch = orchRepo.update.mock.calls[0][0] as Orchestration;
    expect(updatedOrch.status).toBe(OrchestratorStatus.FAILED);
    expect(updatedOrch.completedAt).toBeDefined();
  });

  it('leaves orchestration alone when chain is broken (no iteration)', async () => {
    const orch = createMockOrchestration({ loopId: LoopId('loop-1') });

    const orchRepo = {
      findByStatus: vi.fn((status: string) =>
        status === OrchestratorStatus.RUNNING ? ok([orch]) : ok([]),
      ),
      update: vi.fn().mockResolvedValue(ok(undefined)),
      cleanupOldOrchestrations: vi.fn().mockResolvedValue(ok(0)),
    };
    const loopRepo = {
      getIterations: vi.fn().mockResolvedValue(ok([])), // No iterations
      cleanupOldLoops: vi.fn().mockResolvedValue(ok(0)),
    };

    const { recovery } = makeRecoveryManager({ orchestrationRepo: orchRepo, loopRepo });
    await recovery.recover();

    expect(orchRepo.update).not.toHaveBeenCalled();
  });
});
