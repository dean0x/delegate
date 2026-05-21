/**
 * Unit tests for RecoveryManager zombie orchestration detection
 * ARCHITECTURE: Tests the failZombieRunningOrchestrations method
 * Pattern: Behavioral testing with mock repositories
 *
 * Phase 4: isProcessAlive renamed to isOrchestratorProcessAlive.
 * isTmuxSessionAlive is required (not optional).
 * All worker liveness is tmux-session-based; PID check is for interactive orchestrators only.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Loop,
  LoopId,
  type LoopIteration,
  LoopStatus,
  LoopStrategy,
  type Orchestration,
  OrchestratorId,
  OrchestratorStatus,
  TaskId,
  updateOrchestration,
  WorkerId,
} from '../../../src/core/domain.js';
import { err, ok } from '../../../src/core/result.js';
import { checkOrchestrationLiveness } from '../../../src/services/orchestration-liveness.js';
import { RecoveryManager } from '../../../src/services/recovery-manager.js';

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

const makeRecoveryManager = (
  deps: {
    orchestrationRepo?: Record<string, unknown>;
    loopRepo?: Record<string, unknown>;
    taskRepo?: Record<string, unknown>;
    workerRepo?: Record<string, unknown>;
  } = {},
) => {
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

  // Default tmux session manager — no live sessions
  const defaultTmuxSessionManager = {
    isAlive: vi.fn().mockReturnValue(ok(false)),
    sendControlKeys: vi.fn().mockReturnValue(ok(undefined)),
    listSessions: vi.fn().mockReturnValue(ok([])),
    destroySession: vi.fn().mockReturnValue(ok(undefined)),
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
      tmuxSessionManager: defaultTmuxSessionManager as never,
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
      isOrchestratorProcessAlive: vi.fn(),
      isTmuxSessionAlive: vi.fn().mockReturnValue(false),
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
      isOrchestratorProcessAlive: vi.fn(),
      isTmuxSessionAlive: vi.fn().mockReturnValue(false),
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
      isOrchestratorProcessAlive: vi.fn(),
      isTmuxSessionAlive: vi.fn().mockReturnValue(false),
    });

    expect(result).toBe('unknown');
  });

  it('returns live when tmux worker session is alive', async () => {
    const orch = createMockOrchestration({ loopId: LoopId('loop-1') });
    const iter = createMockIteration({ status: 'running', taskId: TaskId('task-1') });
    const loopRepo = { getIterations: vi.fn().mockResolvedValue(ok([iter])) };
    const task = { id: TaskId('task-1'), workerId: WorkerId('worker-1'), status: 'running' };
    const taskRepo = { findById: vi.fn().mockResolvedValue(ok(task)) };
    // pid=0 is the tmux sentinel; sessionName identifies the session
    const workerReg = {
      workerId: WorkerId('worker-1'),
      pid: 0,
      ownerPid: 0,
      sessionName: 'beat-task-1',
      taskId: TaskId('task-1'),
    };
    const workerRepo = { findByTaskId: vi.fn().mockReturnValue(ok(workerReg)) };
    const isOrchestratorProcessAlive = vi.fn().mockReturnValue(false); // Should NOT be called for tmux workers
    const isTmuxSessionAlive = vi.fn().mockReturnValue(true);

    const result = await checkOrchestrationLiveness(orch, {
      loopRepo: loopRepo as never,
      taskRepo: taskRepo as never,
      workerRepo: workerRepo as never,
      isOrchestratorProcessAlive,
      isTmuxSessionAlive,
    });

    expect(result).toBe('live');
    expect(isTmuxSessionAlive).toHaveBeenCalledWith('beat-task-1');
    expect(isOrchestratorProcessAlive).not.toHaveBeenCalled();
  });

  it('returns dead when tmux worker session has ended', async () => {
    const orch = createMockOrchestration({ loopId: LoopId('loop-1') });
    const iter = createMockIteration({ status: 'running', taskId: TaskId('task-1') });
    const loopRepo = { getIterations: vi.fn().mockResolvedValue(ok([iter])) };
    const task = { id: TaskId('task-1'), workerId: WorkerId('worker-1'), status: 'running' };
    const taskRepo = { findById: vi.fn().mockResolvedValue(ok(task)) };
    const workerReg = {
      workerId: WorkerId('worker-1'),
      pid: 0,
      ownerPid: 0,
      sessionName: 'beat-task-1',
      taskId: TaskId('task-1'),
    };
    const workerRepo = { findByTaskId: vi.fn().mockReturnValue(ok(workerReg)) };
    const isOrchestratorProcessAlive = vi.fn().mockReturnValue(false);
    const isTmuxSessionAlive = vi.fn().mockReturnValue(false);

    const result = await checkOrchestrationLiveness(orch, {
      loopRepo: loopRepo as never,
      taskRepo: taskRepo as never,
      workerRepo: workerRepo as never,
      isOrchestratorProcessAlive,
      isTmuxSessionAlive,
    });

    expect(result).toBe('dead');
    expect(isTmuxSessionAlive).toHaveBeenCalledWith('beat-task-1');
  });

  it('returns unknown for worker with no sessionName (legacy/corrupted row)', async () => {
    const orch = createMockOrchestration({ loopId: LoopId('loop-1') });
    const iter = createMockIteration({ status: 'running', taskId: TaskId('task-1') });
    const loopRepo = { getIterations: vi.fn().mockResolvedValue(ok([iter])) };
    const task = { id: TaskId('task-1'), workerId: WorkerId('worker-1'), status: 'running' };
    const taskRepo = { findById: vi.fn().mockResolvedValue(ok(task)) };
    const workerReg = {
      workerId: WorkerId('worker-1'),
      pid: 0,
      ownerPid: 0,
      // sessionName intentionally absent (legacy row)
      taskId: TaskId('task-1'),
    };
    const workerRepo = { findByTaskId: vi.fn().mockReturnValue(ok(workerReg)) };
    const isOrchestratorProcessAlive = vi.fn().mockReturnValue(false);
    const isTmuxSessionAlive = vi.fn().mockReturnValue(false);

    const result = await checkOrchestrationLiveness(orch, {
      loopRepo: loopRepo as never,
      taskRepo: taskRepo as never,
      workerRepo: workerRepo as never,
      isOrchestratorProcessAlive,
      // Conservative: no sessionName → 'unknown' (leave row alone)
      isTmuxSessionAlive,
    });

    expect(result).toBe('unknown');
    expect(isTmuxSessionAlive).not.toHaveBeenCalled();
    expect(isOrchestratorProcessAlive).not.toHaveBeenCalled();
  });

  it('returns live when interactive mode orchestrator PID is alive', async () => {
    // Interactive orchestrators use real PIDs
    const orch = createMockOrchestration({ mode: 'interactive', pid: process.pid });
    const isOrchestratorProcessAlive = vi.fn().mockReturnValue(true);

    const result = await checkOrchestrationLiveness(orch, {
      loopRepo: { getIterations: vi.fn() } as never,
      taskRepo: { findById: vi.fn() } as never,
      workerRepo: { findByTaskId: vi.fn() } as never,
      isOrchestratorProcessAlive,
      isTmuxSessionAlive: vi.fn().mockReturnValue(false),
    });

    expect(result).toBe('live');
    expect(isOrchestratorProcessAlive).toHaveBeenCalledWith(process.pid);
  });

  it('returns dead when interactive mode orchestrator PID is dead', async () => {
    const orch = createMockOrchestration({ mode: 'interactive', pid: 999999 });
    const isOrchestratorProcessAlive = vi.fn().mockReturnValue(false);

    const result = await checkOrchestrationLiveness(orch, {
      loopRepo: { getIterations: vi.fn() } as never,
      taskRepo: { findById: vi.fn() } as never,
      workerRepo: { findByTaskId: vi.fn() } as never,
      isOrchestratorProcessAlive,
      isTmuxSessionAlive: vi.fn().mockReturnValue(false),
    });

    expect(result).toBe('dead');
  });

  it('returns unknown when interactive mode orchestrator has no PID', async () => {
    const orch = createMockOrchestration({ mode: 'interactive', pid: undefined });

    const result = await checkOrchestrationLiveness(orch, {
      loopRepo: { getIterations: vi.fn() } as never,
      taskRepo: { findById: vi.fn() } as never,
      workerRepo: { findByTaskId: vi.fn() } as never,
      isOrchestratorProcessAlive: vi.fn(),
      isTmuxSessionAlive: vi.fn().mockReturnValue(false),
    });

    expect(result).toBe('unknown');
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

    const { recovery } = makeRecoveryManager({ orchestrationRepo: orchRepo, loopRepo });
    await recovery.recover();

    expect(orchRepo.update).not.toHaveBeenCalled();
  });

  it('leaves orchestration with live tmux session alone', async () => {
    const orch = createMockOrchestration({ loopId: LoopId('loop-1') });
    const iter = createMockIteration({ status: 'running', taskId: TaskId('task-1') });
    const task = { id: TaskId('task-1'), workerId: WorkerId('worker-1'), status: 'running' };
    // Worker with tmux session name
    const workerReg = {
      workerId: WorkerId('worker-1'),
      pid: 0,
      ownerPid: 0,
      sessionName: 'beat-task-1',
      taskId: TaskId('task-1'),
    };

    const orchRepo = {
      findByStatus: vi.fn((status: string) => (status === OrchestratorStatus.RUNNING ? ok([orch]) : ok([]))),
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

    // Provide a tmux session manager that reports the session as alive
    const tmuxSessionManager = {
      isAlive: vi.fn().mockReturnValue(ok(true)),
      sendControlKeys: vi.fn().mockReturnValue(ok(undefined)),
      listSessions: vi.fn().mockReturnValue(ok([{ name: 'beat-task-1' }])),
      destroySession: vi.fn().mockReturnValue(ok(undefined)),
    };

    const recovery = new RecoveryManager({
      taskRepo: taskRepo as never,
      queue: { enqueue: vi.fn().mockReturnValue(ok(undefined)), contains: vi.fn().mockReturnValue(false) } as never,
      eventBus: { emit: vi.fn().mockResolvedValue(ok(undefined)) } as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      workerRepo: workerRepo as never,
      dependencyRepo: { isBlocked: vi.fn().mockResolvedValue(ok(false)) } as never,
      loopRepo: loopRepo as never,
      orchestrationRepo: orchRepo as never,
      tmuxSessionManager: tmuxSessionManager as never,
    });

    await recovery.recover();

    const orchUpdateCalls = orchRepo.update.mock.calls;
    expect(orchUpdateCalls.length).toBe(0);
  });

  it('marks orchestration FAILED when tmux session is dead', async () => {
    const orch = createMockOrchestration({ loopId: LoopId('loop-1') });
    const iter = createMockIteration({ status: 'running', taskId: TaskId('task-1') });
    const task = { id: TaskId('task-1'), workerId: WorkerId('worker-1'), status: 'running' };
    const workerReg = {
      workerId: WorkerId('worker-1'),
      pid: 0,
      ownerPid: 0,
      sessionName: 'beat-task-dead',
      taskId: TaskId('task-1'),
    };

    const orchRepo = {
      findByStatus: vi.fn((status: string) => (status === OrchestratorStatus.RUNNING ? ok([orch]) : ok([]))),
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

    // tmuxSessionManager reports session as dead (isAlive = false)
    const tmuxSessionManager = {
      isAlive: vi.fn().mockReturnValue(ok(false)),
      sendControlKeys: vi.fn().mockReturnValue(ok(undefined)),
      listSessions: vi.fn().mockReturnValue(ok([])),
      destroySession: vi.fn().mockReturnValue(ok(undefined)),
    };

    const recovery = new RecoveryManager({
      taskRepo: taskRepo as never,
      queue: { enqueue: vi.fn().mockReturnValue(ok(undefined)), contains: vi.fn().mockReturnValue(false) } as never,
      eventBus: { emit: vi.fn().mockResolvedValue(ok(undefined)) } as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      workerRepo: workerRepo as never,
      dependencyRepo: { isBlocked: vi.fn().mockResolvedValue(ok(false)) } as never,
      loopRepo: loopRepo as never,
      orchestrationRepo: orchRepo as never,
      tmuxSessionManager: tmuxSessionManager as never,
    });

    await recovery.recover();

    expect(orchRepo.update).toHaveBeenCalledOnce();
    const updatedOrch = orchRepo.update.mock.calls[0][0] as Orchestration;
    expect(updatedOrch.status).toBe(OrchestratorStatus.FAILED);
    expect(updatedOrch.completedAt).toBeDefined();
  });

  it('leaves orchestration alone when chain is broken (no iteration)', async () => {
    const orch = createMockOrchestration({ loopId: LoopId('loop-1') });

    const orchRepo = {
      findByStatus: vi.fn((status: string) => (status === OrchestratorStatus.RUNNING ? ok([orch]) : ok([]))),
      update: vi.fn().mockResolvedValue(ok(undefined)),
      cleanupOldOrchestrations: vi.fn().mockResolvedValue(ok(0)),
    };
    const loopRepo = {
      getIterations: vi.fn().mockResolvedValue(ok([])),
      cleanupOldLoops: vi.fn().mockResolvedValue(ok(0)),
    };

    const { recovery } = makeRecoveryManager({ orchestrationRepo: orchRepo, loopRepo });
    await recovery.recover();

    expect(orchRepo.update).not.toHaveBeenCalled();
  });
});
