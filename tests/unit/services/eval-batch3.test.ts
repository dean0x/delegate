/**
 * Tests for eval batch 3 (v1.4.0)
 *
 * ARCHITECTURE: Covers FeedforwardEvaluator, CompositeExitConditionEvaluator routing
 * by evalType, and LoopManagerService evalType validation constraints.
 *
 * Note: JudgeExitConditionEvaluator tests are in a separate file
 * (judge-exit-condition-evaluator.test.ts) because vi.mock('node:fs/promises')
 * must be isolated to prevent cross-file mock contamination in combined test runs.
 *
 * Pattern: Behavioral testing — verifies observable outcomes, not internals.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Loop } from '../../../src/core/domain.js';
import { createLoop, EvalMode, EvalType, LoopStrategy, OptimizeDirection, TaskId } from '../../../src/core/domain.js';
import type {
  EvalResult,
  ExitConditionEvaluator,
  LoopRepository,
  OutputRepository,
} from '../../../src/core/interfaces.js';
import { ok } from '../../../src/core/result.js';
import { CompositeExitConditionEvaluator } from '../../../src/services/composite-exit-condition-evaluator.js';
import { FeedforwardEvaluator } from '../../../src/services/feedforward-evaluator.js';
import { TestEventBus, TestLogger } from '../../fixtures/test-doubles.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

function createOutputRepo(lines: string[]): OutputRepository {
  return {
    get: vi.fn().mockResolvedValue(
      ok({
        stdout: lines,
        stderr: [],
        truncated: false,
        byteSize: lines.join('\n').length,
      }),
    ),
    save: vi.fn().mockResolvedValue(ok(undefined)),
    delete: vi.fn().mockResolvedValue(ok(undefined)),
    getByteSize: vi.fn().mockResolvedValue(ok(0)),
  } as unknown as OutputRepository;
}

function createLoopRepo(preIterationCommitSha?: string): LoopRepository {
  return {
    findIterationByTaskId: vi
      .fn()
      .mockResolvedValue(
        ok(preIterationCommitSha ? { iterationNumber: 1, preIterationCommitSha, status: 'running' } : null),
      ),
    findById: vi.fn().mockResolvedValue(ok(null)),
    findAll: vi.fn().mockResolvedValue(ok([])),
    findByStatus: vi.fn().mockResolvedValue(ok([])),
    save: vi.fn().mockResolvedValue(ok(undefined)),
    updateStatus: vi.fn().mockResolvedValue(ok(undefined)),
    recordIteration: vi.fn().mockResolvedValue(ok(undefined)),
    updateIteration: vi.fn().mockResolvedValue(ok(undefined)),
    getIterations: vi.fn().mockResolvedValue(ok([])),
    saveSync: vi.fn().mockReturnValue(ok(undefined)),
    updateStatusSync: vi.fn().mockReturnValue(ok(undefined)),
    recordIterationSync: vi.fn().mockReturnValue(ok(undefined)),
    updateIterationSync: vi.fn().mockReturnValue(ok(undefined)),
  } as unknown as LoopRepository;
}

function createMockEvaluator(result: EvalResult): ExitConditionEvaluator {
  return { evaluate: vi.fn().mockResolvedValue(result) };
}

function createTestLoop(overrides: Partial<Parameters<typeof createLoop>[0]> = {}): Loop {
  return createLoop(
    {
      prompt: 'Improve the code quality',
      strategy: LoopStrategy.RETRY,
      exitCondition: '',
      evalMode: EvalMode.AGENT,
      maxIterations: 5,
      evalTimeout: 10000,
      ...overrides,
    },
    '/workspace',
  );
}

/**
 * Evaluate with automatic task completion simulation.
 * Captures the eval task ID from TaskDelegated, then drives it to completion.
 * Can handle multiple sequential task delegations (e.g., judge phase 1 + phase 2).
 */
async function evaluateWithCompletions<
  T extends { evaluate: (loop: Loop, taskId: ReturnType<typeof TaskId>) => Promise<EvalResult> },
>(
  evaluator: T,
  loop: Loop,
  taskId: ReturnType<typeof TaskId>,
  eventBus: TestEventBus,
  simulateFns: Array<(evalTaskId: string) => Promise<void>>,
): Promise<EvalResult> {
  const capturedTaskIds: string[] = [];
  const origEmit = eventBus.emit.bind(eventBus);
  vi.spyOn(eventBus, 'emit').mockImplementation(async (type: string, payload: unknown) => {
    if (type === 'TaskDelegated') {
      capturedTaskIds.push((payload as { task: { id: string } }).task.id);
    }
    return origEmit(type as never, payload as never);
  });

  const evalPromise = evaluator.evaluate(loop, taskId);

  for (let i = 0; i < simulateFns.length; i++) {
    // Give subscriptions a tick to register
    await new Promise((r) => setImmediate(r));
    const taskIdForPhase = capturedTaskIds[i];
    if (taskIdForPhase) {
      await simulateFns[i](taskIdForPhase);
    }
    // Give the evaluator a tick to process the event
    await new Promise((r) => setImmediate(r));
  }

  return evalPromise;
}

async function simulateTaskComplete(eventBus: TestEventBus, taskId: string): Promise<void> {
  await eventBus.emit('TaskCompleted', {
    taskId: taskId as ReturnType<typeof TaskId>,
    workerId: 'w1' as unknown as never,
  });
}

async function simulateTaskFailed(eventBus: TestEventBus, taskId: string): Promise<void> {
  await eventBus.emit('TaskFailed', {
    taskId: taskId as ReturnType<typeof TaskId>,
    error: new Error('task failed'),
    workerId: 'w1' as unknown as never,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 1: FeedforwardEvaluator
// ─────────────────────────────────────────────────────────────────────────────

describe('FeedforwardEvaluator', () => {
  let eventBus: TestEventBus;
  let logger: TestLogger;
  const workTaskId = TaskId('task-work-abc123');

  beforeEach(() => {
    eventBus = new TestEventBus();
    logger = new TestLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    eventBus.dispose();
  });

  it('returns decision: continue without spawning agent when no evalPrompt', async () => {
    const loop = createTestLoop({ evalPrompt: undefined });
    const outputRepo = createOutputRepo([]);
    const loopRepo = createLoopRepo();
    const evaluator = new FeedforwardEvaluator(eventBus, outputRepo, loopRepo, logger);

    const result = await evaluator.evaluate(loop, workTaskId);

    expect(result.decision).toBe('continue');
    expect(result.feedback).toBeUndefined();
    // No task should be delegated
    expect(eventBus.hasEmitted('TaskDelegated')).toBe(false);
  });

  it('returns decision: continue with findings when evalPrompt is set', async () => {
    const loop = createTestLoop({ evalPrompt: 'Review code quality' });
    const outputRepo = createOutputRepo(['Code looks good.', 'Tests pass.']);
    const loopRepo = createLoopRepo();
    const evaluator = new FeedforwardEvaluator(eventBus, outputRepo, loopRepo, logger);

    const result = await evaluateWithCompletions(evaluator, loop, workTaskId, eventBus, [
      (id) => simulateTaskComplete(eventBus, id),
    ]);

    expect(result.decision).toBe('continue');
    expect(result.feedback).toBeTruthy();
    expect(result.feedback).toContain('Code looks good.');
    // An eval task WAS delegated
    expect(eventBus.hasEmitted('TaskDelegated')).toBe(true);
  });

  it('returns decision: continue even when eval agent fails', async () => {
    const loop = createTestLoop({ evalPrompt: 'Review changes' });
    const outputRepo = createOutputRepo([]);
    const loopRepo = createLoopRepo();
    const evaluator = new FeedforwardEvaluator(eventBus, outputRepo, loopRepo, logger);

    const result = await evaluateWithCompletions(evaluator, loop, workTaskId, eventBus, [
      (id) => simulateTaskFailed(eventBus, id),
    ]);

    // Even on eval failure, feedforward always continues
    expect(result.decision).toBe('continue');
  });

  it('always returns passed: false (feedforward is not a quality gate)', async () => {
    const loop = createTestLoop({ evalPrompt: undefined });
    const outputRepo = createOutputRepo([]);
    const loopRepo = createLoopRepo();
    const evaluator = new FeedforwardEvaluator(eventBus, outputRepo, loopRepo, logger);

    const result = await evaluator.evaluate(loop, workTaskId);

    // passed: false because feedforward doesn't evaluate quality — decision overrides this
    expect(result.passed).toBe(false);
    expect(result.decision).toBe('continue');
  });

  it('emits eval task prompt with [EVAL-FEEDFORWARD] prefix', async () => {
    const loop = createTestLoop({ evalPrompt: 'Check test coverage' });
    const outputRepo = createOutputRepo(['All good.']);
    const loopRepo = createLoopRepo();
    const evaluator = new FeedforwardEvaluator(eventBus, outputRepo, loopRepo, logger);

    await evaluateWithCompletions(evaluator, loop, workTaskId, eventBus, [(id) => simulateTaskComplete(eventBus, id)]);

    const delegatedEvents = eventBus.getEmittedEvents('TaskDelegated') as Array<{ task: { prompt: string } }>;
    expect(delegatedEvents[0].task.prompt).toMatch(/^\[EVAL-FEEDFORWARD\]/);
  });

  it('does not inject jsonSchema on the eval task', async () => {
    const loop = createTestLoop({ evalPrompt: 'Evaluate changes' });
    const outputRepo = createOutputRepo(['Nice work.']);
    const loopRepo = createLoopRepo();
    const evaluator = new FeedforwardEvaluator(eventBus, outputRepo, loopRepo, logger);

    await evaluateWithCompletions(evaluator, loop, workTaskId, eventBus, [(id) => simulateTaskComplete(eventBus, id)]);

    const delegatedEvents = eventBus.getEmittedEvents('TaskDelegated') as Array<{ task: { jsonSchema?: string } }>;
    expect(delegatedEvents[0].task.jsonSchema).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 2: CompositeExitConditionEvaluator — evalType routing
// ─────────────────────────────────────────────────────────────────────────────

describe('CompositeExitConditionEvaluator — evalType routing', () => {
  const taskId = TaskId('task-routing-test');

  const shellResult: EvalResult = { passed: true, exitCode: 0 };
  const agentResult: EvalResult = { passed: true, feedback: 'agent says pass' };
  const judgeResult: EvalResult = { passed: false, decision: 'stop', feedback: 'judge says stop' };
  const feedforwardResult: EvalResult = { passed: false, decision: 'continue', feedback: 'findings' };

  function makeComposite() {
    const shellEval = createMockEvaluator(shellResult);
    const agentEval = createMockEvaluator(agentResult);
    const judgeEval = createMockEvaluator(judgeResult);
    const feedforwardEval = createMockEvaluator(feedforwardResult);
    const composite = new CompositeExitConditionEvaluator(shellEval, agentEval, judgeEval, feedforwardEval);
    return { composite, shellEval, agentEval, judgeEval, feedforwardEval };
  }

  it('routes evalMode=shell to shellEvaluator regardless of evalType', async () => {
    const { composite, shellEval, agentEval, judgeEval, feedforwardEval } = makeComposite();
    const loop = createTestLoop({ evalMode: EvalMode.SHELL, exitCondition: 'npm test' });

    const result = await composite.evaluate(loop, taskId);

    expect(result).toEqual(shellResult);
    expect(shellEval.evaluate).toHaveBeenCalledOnce();
    expect(agentEval.evaluate).not.toHaveBeenCalled();
    expect(judgeEval.evaluate).not.toHaveBeenCalled();
    expect(feedforwardEval.evaluate).not.toHaveBeenCalled();
  });

  it('routes evalMode=agent + evalType=schema to agentEvaluator', async () => {
    const { composite, shellEval, agentEval, judgeEval, feedforwardEval } = makeComposite();
    const loop = createTestLoop({ evalMode: EvalMode.AGENT, evalType: EvalType.SCHEMA });

    const result = await composite.evaluate(loop, taskId);

    expect(result).toEqual(agentResult);
    expect(agentEval.evaluate).toHaveBeenCalledOnce();
    expect(shellEval.evaluate).not.toHaveBeenCalled();
    expect(judgeEval.evaluate).not.toHaveBeenCalled();
    expect(feedforwardEval.evaluate).not.toHaveBeenCalled();
  });

  it('routes evalMode=agent + evalType=judge to judgeEvaluator', async () => {
    const { composite, shellEval, agentEval, judgeEval, feedforwardEval } = makeComposite();
    const loop = createTestLoop({ evalMode: EvalMode.AGENT, evalType: EvalType.JUDGE });

    const result = await composite.evaluate(loop, taskId);

    expect(result).toEqual(judgeResult);
    expect(judgeEval.evaluate).toHaveBeenCalledOnce();
    expect(shellEval.evaluate).not.toHaveBeenCalled();
    expect(agentEval.evaluate).not.toHaveBeenCalled();
    expect(feedforwardEval.evaluate).not.toHaveBeenCalled();
  });

  it('routes evalMode=agent + evalType=feedforward to feedforwardEvaluator', async () => {
    const { composite, shellEval, agentEval, judgeEval, feedforwardEval } = makeComposite();
    const loop = createTestLoop({ evalMode: EvalMode.AGENT, evalType: EvalType.FEEDFORWARD });

    const result = await composite.evaluate(loop, taskId);

    expect(result).toEqual(feedforwardResult);
    expect(feedforwardEval.evaluate).toHaveBeenCalledOnce();
    expect(shellEval.evaluate).not.toHaveBeenCalled();
    expect(agentEval.evaluate).not.toHaveBeenCalled();
    expect(judgeEval.evaluate).not.toHaveBeenCalled();
  });

  it('defaults to feedforwardEvaluator when evalMode=agent and evalType is undefined', async () => {
    const { composite, shellEval, agentEval, judgeEval, feedforwardEval } = makeComposite();
    // evalType not specified — should default to feedforward
    const loop = createTestLoop({ evalMode: EvalMode.AGENT, evalType: undefined });

    const result = await composite.evaluate(loop, taskId);

    expect(result).toEqual(feedforwardResult);
    expect(feedforwardEval.evaluate).toHaveBeenCalledOnce();
    expect(agentEval.evaluate).not.toHaveBeenCalled();
    expect(judgeEval.evaluate).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 4: LoopManagerService — evalType validation
// ─────────────────────────────────────────────────────────────────────────────

// Mock git-state before importing LoopManagerService
vi.mock('../../../src/utils/git-state.js', () => ({
  captureGitState: vi.fn().mockResolvedValue({ ok: true, value: null }),
  getCurrentCommitSha: vi.fn().mockResolvedValue({ ok: true, value: 'abc1234567890abcdef1234567890abcdef123456' }),
  captureLoopGitContext: vi.fn().mockResolvedValue({ ok: true, value: {} }),
  validateGitRefName: vi.fn().mockReturnValue({ ok: true, value: undefined }),
}));

import { Database } from '../../../src/implementations/database.js';
import { SQLiteLoopRepository } from '../../../src/implementations/loop-repository.js';
import { LoopManagerService } from '../../../src/services/loop-manager.js';
import { createTestConfiguration } from '../../fixtures/factories.js';

describe('LoopManagerService — evalType validation', () => {
  let db: Database;
  let loopRepo: SQLiteLoopRepository;
  let service: LoopManagerService;
  let testEventBus: TestEventBus;
  let testLogger: TestLogger;

  beforeEach(() => {
    db = new Database(':memory:');
    loopRepo = new SQLiteLoopRepository(db);
    testEventBus = new TestEventBus();
    testLogger = new TestLogger();
    service = new LoopManagerService(testEventBus, testLogger, loopRepo, createTestConfiguration());
  });

  afterEach(() => {
    testEventBus.dispose();
    db.close();
  });

  it('rejects schema evalType with non-Claude agent', async () => {
    const result = await service.validateCreateRequest({
      prompt: 'Fix bugs',
      strategy: LoopStrategy.RETRY,
      evalMode: EvalMode.AGENT,
      evalType: EvalType.SCHEMA,
      agent: 'gemini',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Claude agent');
      expect(result.error.message).toContain('schema');
    }
  });

  it('allows schema evalType with Claude agent', async () => {
    const result = await service.validateCreateRequest({
      prompt: 'Fix bugs',
      strategy: LoopStrategy.RETRY,
      evalMode: EvalMode.AGENT,
      evalType: EvalType.SCHEMA,
      agent: 'claude',
    });

    expect(result.ok).toBe(true);
  });

  it('rejects judge evalType without evalPrompt in agent mode', async () => {
    const result = await service.validateCreateRequest({
      prompt: 'Fix bugs',
      strategy: LoopStrategy.RETRY,
      evalMode: EvalMode.AGENT,
      evalType: EvalType.JUDGE,
      // No evalPrompt
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('evalPrompt');
      expect(result.error.message).toContain('judge');
    }
  });

  it('allows judge evalType with evalPrompt', async () => {
    const result = await service.validateCreateRequest({
      prompt: 'Fix bugs',
      strategy: LoopStrategy.RETRY,
      evalMode: EvalMode.AGENT,
      evalType: EvalType.JUDGE,
      evalPrompt: 'Is the code better than before?',
    });

    expect(result.ok).toBe(true);
  });

  it('rejects feedforward evalType with optimize strategy', async () => {
    const result = await service.validateCreateRequest({
      prompt: 'Optimize performance',
      strategy: LoopStrategy.OPTIMIZE,
      evalMode: EvalMode.AGENT,
      evalType: EvalType.FEEDFORWARD,
      exitCondition: 'echo 42',
      evalDirection: OptimizeDirection.MINIMIZE,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('feedforward');
      expect(result.error.message).toContain('optimize');
    }
  });

  it('allows judge evalType with optimize strategy', async () => {
    const result = await service.validateCreateRequest({
      prompt: 'Optimize performance',
      strategy: LoopStrategy.OPTIMIZE,
      evalMode: EvalMode.AGENT,
      evalType: EvalType.JUDGE,
      evalPrompt: 'Score the performance improvement',
      evalDirection: OptimizeDirection.MAXIMIZE,
    });

    expect(result.ok).toBe(true);
  });

  it('schema evalType without explicit agent passes (agent will be resolved later)', async () => {
    // When no agent is specified at validation time, we can't reject yet
    // (default agent resolution happens in createLoop)
    const result = await service.validateCreateRequest({
      prompt: 'Fix bugs',
      strategy: LoopStrategy.RETRY,
      evalMode: EvalMode.AGENT,
      evalType: EvalType.SCHEMA,
      // agent not specified — should pass validation
    });

    expect(result.ok).toBe(true);
  });
});
