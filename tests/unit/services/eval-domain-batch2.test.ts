/**
 * Tests for eval domain foundations — Batch 2 (v1.3.0)
 *
 * ARCHITECTURE: Tests for EvalType enum, jsonSchema spawn chain, structured
 * output parsing, evalResponse persistence, feedback accumulation, and
 * EvalResult.decision handling.
 *
 * Pattern: Behavioral testing — verifies observable outcomes, not internals
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Loop } from '../../../src/core/domain.js';
import { createLoop, createTask, EvalMode, EvalType, LoopId, LoopStrategy, TaskId } from '../../../src/core/domain.js';
import type { EvalResult } from '../../../src/core/interfaces.js';
import { ok } from '../../../src/core/result.js';
import { AgentExitConditionEvaluator } from '../../../src/services/agent-exit-condition-evaluator.js';
import { MAX_EVAL_FEEDBACK_LENGTH } from '../../../src/services/eval-prompt-builder.js';
import { createLoopRepo, createOutputRepo, createTestLoop } from '../../fixtures/eval-test-helpers.js';
import { TestEventBus, TestLogger } from '../../fixtures/test-doubles.js';

// ============================================================================
// Section 1: EvalType enum
// ============================================================================

describe('EvalType enum', () => {
  it('should have all expected values', () => {
    expect(EvalType.FEEDFORWARD).toBe('feedforward');
    expect(EvalType.JUDGE).toBe('judge');
    expect(EvalType.SCHEMA).toBe('schema');
  });

  it('should allow type narrowing from const object values', () => {
    const values = Object.values(EvalType) as string[];
    expect(values).toContain('feedforward');
    expect(values).toContain('judge');
    expect(values).toContain('schema');
  });

  it('should be stored on a Loop domain object when set', () => {
    const loop = createLoop(
      {
        prompt: 'test',
        strategy: LoopStrategy.RETRY,
        exitCondition: '',
        evalMode: EvalMode.AGENT,
        evalType: EvalType.SCHEMA,
      },
      '/workspace',
    );
    expect(loop.evalType).toBe(EvalType.SCHEMA);
  });

  it('should be undefined on a Loop when not set', () => {
    const loop = createLoop(
      {
        prompt: 'test',
        strategy: LoopStrategy.RETRY,
        exitCondition: '',
        evalMode: EvalMode.AGENT,
      },
      '/workspace',
    );
    expect(loop.evalType).toBeUndefined();
  });

  it('should persist judgeAgent and judgePrompt on Loop', () => {
    const loop = createLoop(
      {
        prompt: 'test',
        strategy: LoopStrategy.RETRY,
        exitCondition: '',
        evalMode: EvalMode.AGENT,
        evalType: EvalType.JUDGE,
        judgeAgent: 'claude',
        judgePrompt: 'Did the code improve?',
      },
      '/workspace',
    );
    expect(loop.evalType).toBe(EvalType.JUDGE);
    expect(loop.judgeAgent).toBe('claude');
    expect(loop.judgePrompt).toBe('Did the code improve?');
  });
});

// ============================================================================
// Section 2: Structured output parsing + dual prompt directive
// ============================================================================

// createTestLoop, createOutputRepo, createLoopRepo imported from eval-test-helpers.js
// Note: createTestLoop in eval-domain-batch2 originally defaulted agent:'claude'.
// Tests that require a specific agent pass it explicitly in overrides.

/**
 * Evaluate with automatic completion simulation.
 * Spies on eventBus.emit to capture the eval task ID from TaskDelegated,
 * then emits the TaskCompleted event to drive the eval to terminal state.
 */
async function evaluateWithCompletion(
  evaluator: AgentExitConditionEvaluator,
  loop: Loop,
  taskId: ReturnType<typeof TaskId>,
  eventBus: TestEventBus,
  simulateFn?: (evalTaskId: string) => Promise<void>,
): Promise<EvalResult> {
  let capturedEvalTaskId: string | undefined;
  const origEmit = eventBus.emit.bind(eventBus);
  vi.spyOn(eventBus, 'emit').mockImplementation(async (type: string, payload: unknown) => {
    if (type === 'TaskDelegated') {
      capturedEvalTaskId = (payload as { task: { id: string } }).task.id;
    }
    return origEmit(type as never, payload as never);
  });

  const evalPromise = evaluator.evaluate(loop, taskId);
  // Give async operations a tick to set up subscription
  await new Promise((r) => setImmediate(r));
  if (capturedEvalTaskId) {
    if (simulateFn) {
      await simulateFn(capturedEvalTaskId);
    } else {
      // Default: complete successfully
      await eventBus.emit('TaskCompleted', {
        taskId: capturedEvalTaskId as unknown as ReturnType<typeof TaskId>,
        workerId: 'w1' as unknown as never,
      });
    }
  }

  return evalPromise;
}

/**
 * Helper to capture the eval task from a TaskDelegated event.
 * Returns { evalTaskId, taskPayload, evalPromise } — call after setting up the spy.
 */
async function captureEvalTask(
  evaluator: AgentExitConditionEvaluator,
  loop: Loop,
  taskId: ReturnType<typeof TaskId>,
  eventBus: TestEventBus,
) {
  let capturedTask: Record<string, unknown> | undefined;
  const origEmit = eventBus.emit.bind(eventBus);
  vi.spyOn(eventBus, 'emit').mockImplementation(async (type: string, payload: unknown) => {
    if (type === 'TaskDelegated') {
      capturedTask = (payload as { task: Record<string, unknown> }).task;
    }
    return origEmit(type as never, payload as never);
  });

  const evalPromise = evaluator.evaluate(loop, taskId);
  await new Promise((r) => setImmediate(r));

  if (capturedTask?.id) {
    // Complete the eval task so promise resolves
    await eventBus.emit('TaskCompleted', {
      taskId: capturedTask.id as unknown as ReturnType<typeof TaskId>,
      workerId: 'w1' as unknown as never,
    });
  }

  const result = await evalPromise;
  return { capturedTask, result };
}

describe('AgentExitConditionEvaluator — structured output parsing', () => {
  let eventBus: TestEventBus;
  let logger: TestLogger;

  beforeEach(() => {
    eventBus = new TestEventBus();
    logger = new TestLogger();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should parse structured output with pass decision for retry strategy', async () => {
    const structuredResult = {
      type: 'result',
      structured_output: {
        decision: 'pass',
        reasoning: 'The code looks great.',
      },
    };
    const outputLines = [`some output\n${JSON.stringify(structuredResult)}`];
    const outputRepo = createOutputRepo(outputLines);
    const loopRepo = createLoopRepo();
    const evaluator = new AgentExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger);

    const loop = createTestLoop({ agent: 'claude', strategy: LoopStrategy.RETRY });
    const result = await evaluateWithCompletion(evaluator, loop, TaskId('task-work-1'), eventBus);

    expect(result.passed).toBe(true);
    expect(result.feedback).toBe('The code looks great.');
    expect(result.evalResponse).toBeDefined();
  });

  it('should parse structured output with fail decision for retry strategy', async () => {
    const structuredResult = {
      type: 'result',
      structured_output: {
        decision: 'fail',
        reasoning: 'Tests still failing.',
      },
    };
    const outputLines = [`some output\n${JSON.stringify(structuredResult)}`];
    const outputRepo = createOutputRepo(outputLines);
    const loopRepo = createLoopRepo();
    const evaluator = new AgentExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger);

    const loop = createTestLoop({ agent: 'claude', strategy: LoopStrategy.RETRY });
    const result = await evaluateWithCompletion(evaluator, loop, TaskId('task-work-2'), eventBus);

    expect(result.passed).toBe(false);
    expect(result.feedback).toBe('Tests still failing.');
  });

  it('should parse structured output with score for optimize strategy', async () => {
    const structuredResult = {
      type: 'result',
      structured_output: {
        decision: 'pass',
        score: 78.5,
        reasoning: 'Good improvement in performance.',
      },
    };
    const outputLines = [`analysis\n${JSON.stringify(structuredResult)}`];
    const outputRepo = createOutputRepo(outputLines);
    const loopRepo = createLoopRepo();
    const evaluator = new AgentExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger);

    const loop = createTestLoop({ agent: 'claude', strategy: LoopStrategy.OPTIMIZE });
    const result = await evaluateWithCompletion(evaluator, loop, TaskId('task-work-3'), eventBus);

    expect(result.passed).toBe(true);
    expect(result.score).toBe(78.5);
    expect(result.feedback).toBe('Good improvement in performance.');
  });

  it('should fallback to text parsing when structured JSON is absent', async () => {
    // Plain text output — no structured_output — falls back to PASS/FAIL last-line parsing
    const outputLines = ['Some analysis text', 'PASS'];
    const outputRepo = createOutputRepo(outputLines);
    const loopRepo = createLoopRepo();
    const evaluator = new AgentExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger);

    const loop = createTestLoop({ agent: 'claude', strategy: LoopStrategy.RETRY });
    const result = await evaluateWithCompletion(evaluator, loop, TaskId('task-work-4'), eventBus);

    // Falls back to text parsing — last line is 'PASS'
    expect(result.passed).toBe(true);
  });

  it('should fallback to text parsing when structured output has invalid decision', async () => {
    // Structured output missing 'decision' field — fallback to text parsing
    const badStructured = {
      type: 'result',
      structured_output: {
        reasoning: 'Something happened',
        // Missing decision
      },
    };
    // After the bad structured JSON, last line is FAIL
    const outputLines = [`prefix\n${JSON.stringify(badStructured)}\nFAIL`];
    const outputRepo = createOutputRepo(outputLines);
    const loopRepo = createLoopRepo();
    const evaluator = new AgentExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger);

    const loop = createTestLoop({ agent: 'claude', strategy: LoopStrategy.RETRY });
    const result = await evaluateWithCompletion(evaluator, loop, TaskId('task-work-5'), eventBus);

    // Falls back to text parsing — last non-empty line is 'FAIL'
    expect(result.passed).toBe(false);
  });

  it('should set evalResponse to raw JSON envelope when structured output found', async () => {
    const structuredResult = {
      type: 'result',
      structured_output: {
        decision: 'pass',
        reasoning: 'Good.',
      },
    };
    const outputLines = [`prefix\n${JSON.stringify(structuredResult)}`];
    const outputRepo = createOutputRepo(outputLines);
    const loopRepo = createLoopRepo();
    const evaluator = new AgentExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger);

    const loop = createTestLoop({ agent: 'claude', strategy: LoopStrategy.RETRY });
    const result = await evaluateWithCompletion(evaluator, loop, TaskId('task-work-6'), eventBus);

    expect(result.evalResponse).toBe(JSON.stringify(structuredResult));
  });

  it('should not crash on optimize strategy when score is missing in structured output', async () => {
    // Valid decision but missing score — should return null and fall back to text parsing
    const badOptimize = {
      type: 'result',
      structured_output: {
        decision: 'pass',
        reasoning: 'Looks good',
        // Missing score — invalid for optimize strategy structured output
      },
    };
    // Output is two separate lines: the JSON (which will fail structured parse) and then '75'
    // Since structured parse returns null, falls back to text parsing of all lines
    const outputLines = [JSON.stringify(badOptimize), '75'];
    const outputRepo = createOutputRepo(outputLines);
    const loopRepo = createLoopRepo();
    const evaluator = new AgentExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger);

    const loop = createTestLoop({ agent: 'claude', strategy: LoopStrategy.OPTIMIZE });
    const result = await evaluateWithCompletion(evaluator, loop, TaskId('task-work-7'), eventBus);

    // Falls back to text parsing — last non-empty line '75' should parse as score
    expect(result.passed).toBe(true);
    expect(result.score).toBe(75);
  });
});

describe('AgentExitConditionEvaluator — dual prompt directive', () => {
  let eventBus: TestEventBus;
  let logger: TestLogger;

  beforeEach(() => {
    eventBus = new TestEventBus();
    logger = new TestLogger();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should use "structured automatically" directive for Claude agent', async () => {
    const outputLines = ['PASS'];
    const outputRepo = createOutputRepo(outputLines);
    const loopRepo = createLoopRepo();
    const evaluator = new AgentExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger);

    const loop = createTestLoop({ agent: 'claude', strategy: LoopStrategy.RETRY });
    const { capturedTask } = await captureEvalTask(evaluator, loop, TaskId('task-p1'), eventBus);

    expect(capturedTask?.prompt).toContain('structured automatically');
    expect(capturedTask?.prompt).not.toContain('LAST LINE');
  });

  it('should use LAST LINE directive for non-Claude agent (codex)', async () => {
    const outputLines = ['PASS'];
    const outputRepo = createOutputRepo(outputLines);
    const loopRepo = createLoopRepo();
    const evaluator = new AgentExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger);

    const loop = createTestLoop({ agent: 'codex', strategy: LoopStrategy.RETRY });
    const { capturedTask } = await captureEvalTask(evaluator, loop, TaskId('task-p2'), eventBus);

    expect(capturedTask?.prompt).toContain('LAST LINE');
    expect(capturedTask?.prompt).not.toContain('structured automatically');
  });

  it('should use numeric score directive for non-Claude optimize', async () => {
    const outputLines = ['75'];
    const outputRepo = createOutputRepo(outputLines);
    const loopRepo = createLoopRepo();
    const evaluator = new AgentExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger);

    const loop = createTestLoop({ agent: 'codex', strategy: LoopStrategy.OPTIMIZE });
    const { capturedTask } = await captureEvalTask(evaluator, loop, TaskId('task-p3'), eventBus);

    expect(capturedTask?.prompt).toContain('LAST LINE');
    expect(capturedTask?.prompt).toContain('numeric score');
  });

  it('should include jsonSchema on eval task for Claude retry strategy', async () => {
    const outputLines = ['PASS'];
    const outputRepo = createOutputRepo(outputLines);
    const loopRepo = createLoopRepo();
    const evaluator = new AgentExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger);

    const loop = createTestLoop({ agent: 'claude', strategy: LoopStrategy.RETRY });
    const { capturedTask } = await captureEvalTask(evaluator, loop, TaskId('task-p4'), eventBus);

    expect(capturedTask?.jsonSchema).toBeDefined();
    const schema = JSON.parse(capturedTask?.jsonSchema as string);
    expect(schema).toHaveProperty('properties.decision');
    expect(schema).toHaveProperty('properties.reasoning');
  });

  it('should include jsonSchema on eval task for Claude optimize strategy', async () => {
    const outputLines = ['75'];
    const outputRepo = createOutputRepo(outputLines);
    const loopRepo = createLoopRepo();
    const evaluator = new AgentExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger);

    const loop = createTestLoop({ agent: 'claude', strategy: LoopStrategy.OPTIMIZE });
    const { capturedTask } = await captureEvalTask(evaluator, loop, TaskId('task-p5'), eventBus);

    expect(capturedTask?.jsonSchema).toBeDefined();
    const schema = JSON.parse(capturedTask?.jsonSchema as string);
    expect(schema).toHaveProperty('properties.score');
  });

  it('should NOT include jsonSchema for non-Claude agent', async () => {
    const outputLines = ['PASS'];
    const outputRepo = createOutputRepo(outputLines);
    const loopRepo = createLoopRepo();
    const evaluator = new AgentExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger);

    const loop = createTestLoop({ agent: 'codex', strategy: LoopStrategy.RETRY });
    const { capturedTask } = await captureEvalTask(evaluator, loop, TaskId('task-p6'), eventBus);

    expect(capturedTask?.jsonSchema).toBeUndefined();
  });
});

// ============================================================================
// Section 3: Loop repository — new fields persist and round-trip
// ============================================================================

describe('SQLiteLoopRepository — eval redesign fields', () => {
  let db: import('../../../src/implementations/database.js').Database;
  let repo: import('../../../src/implementations/loop-repository.js').SQLiteLoopRepository;

  beforeEach(async () => {
    const { Database } = await import('../../../src/implementations/database.js');
    const { SQLiteLoopRepository } = await import('../../../src/implementations/loop-repository.js');
    db = new Database(':memory:');
    repo = new SQLiteLoopRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should persist evalType and retrieve it', async () => {
    const loop = createLoop(
      {
        prompt: 'test',
        strategy: LoopStrategy.RETRY,
        exitCondition: '',
        evalMode: EvalMode.AGENT,
        evalType: EvalType.SCHEMA,
      },
      '/workspace',
    );
    await repo.save(loop);
    const result = await repo.findById(loop.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.evalType).toBe(EvalType.SCHEMA);
  });

  it('should persist judgeAgent and judgePrompt and retrieve them', async () => {
    const loop = createLoop(
      {
        prompt: 'test',
        strategy: LoopStrategy.RETRY,
        exitCondition: '',
        evalMode: EvalMode.AGENT,
        evalType: EvalType.JUDGE,
        judgeAgent: 'claude',
        judgePrompt: 'Was this improvement sufficient?',
      },
      '/workspace',
    );
    await repo.save(loop);
    const result = await repo.findById(loop.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.judgeAgent).toBe('claude');
    expect(result.value?.judgePrompt).toBe('Was this improvement sufficient?');
  });

  it('should have undefined evalType when not set (backward compat)', async () => {
    const loop = createLoop(
      {
        prompt: 'test',
        strategy: LoopStrategy.RETRY,
        exitCondition: 'npm test',
      },
      '/workspace',
    );
    await repo.save(loop);
    const result = await repo.findById(loop.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Old loops without evalType stored as NULL → undefined in domain
    expect(result.value?.evalType).toBeUndefined();
  });

  it('should update evalType via update()', async () => {
    const loop = createLoop(
      {
        prompt: 'test',
        strategy: LoopStrategy.RETRY,
        exitCondition: '',
        evalMode: EvalMode.AGENT,
        evalType: EvalType.FEEDFORWARD,
      },
      '/workspace',
    );
    await repo.save(loop);

    // Update evalType to SCHEMA
    const updated = { ...loop, evalType: EvalType.SCHEMA as import('../../../src/core/domain.js').EvalType };
    await repo.update(updated);

    const result = await repo.findById(loop.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.evalType).toBe(EvalType.SCHEMA);
  });

  it('should persist evalResponse on iteration record', async () => {
    const { SQLiteTaskRepository } = await import('../../../src/implementations/task-repository.js');
    const taskRepo = new SQLiteTaskRepository(db);

    const loop = createLoop({ prompt: 'test', strategy: LoopStrategy.RETRY, exitCondition: '' }, '/workspace');
    await repo.save(loop);

    const task = createTask({ prompt: 'iteration task', workingDirectory: '/workspace' });
    await taskRepo.save(task);

    const evalResponseValue = '{"type":"result","structured_output":{"decision":"pass","reasoning":"good"}}';
    const iteration = {
      id: 0,
      loopId: loop.id,
      iterationNumber: 1,
      taskId: task.id,
      status: 'running' as const,
      evalResponse: evalResponseValue,
      startedAt: Date.now(),
    };
    await repo.recordIteration(iteration);

    const itersResult = await repo.getIterations(loop.id, 10, 0);
    expect(itersResult.ok).toBe(true);
    if (!itersResult.ok) return;
    expect(itersResult.value[0].evalResponse).toBe(evalResponseValue);
  });

  it('should persist evalResponse via updateIteration()', async () => {
    const { SQLiteTaskRepository } = await import('../../../src/implementations/task-repository.js');
    const taskRepo = new SQLiteTaskRepository(db);

    const loop = createLoop({ prompt: 'test', strategy: LoopStrategy.RETRY, exitCondition: '' }, '/workspace');
    await repo.save(loop);

    const task = createTask({ prompt: 'iteration task', workingDirectory: '/workspace' });
    await taskRepo.save(task);

    // Create without evalResponse
    const iteration = {
      id: 0,
      loopId: loop.id,
      iterationNumber: 1,
      taskId: task.id,
      status: 'running' as const,
      startedAt: Date.now(),
    };
    await repo.recordIteration(iteration);

    // Retrieve to get real auto-incremented ID
    const itersResult = await repo.getIterations(loop.id, 10, 0);
    expect(itersResult.ok).toBe(true);
    if (!itersResult.ok) return;
    const saved = itersResult.value[0];

    // Update with evalResponse
    const evalResponseValue = 'structured eval output';
    const updated = { ...saved, status: 'pass' as const, evalResponse: evalResponseValue, completedAt: Date.now() };
    const updateResult = await repo.updateIteration(updated);
    expect(updateResult.ok).toBe(true);

    const itersResult2 = await repo.getIterations(loop.id, 10, 0);
    if (!itersResult2.ok) return;
    expect(itersResult2.value[0].evalResponse).toBe(evalResponseValue);
  });

  it('should have undefined evalResponse when not set on iteration', async () => {
    const { SQLiteTaskRepository } = await import('../../../src/implementations/task-repository.js');
    const taskRepo = new SQLiteTaskRepository(db);

    const loop = createLoop({ prompt: 'test', strategy: LoopStrategy.RETRY, exitCondition: '' }, '/workspace');
    await repo.save(loop);

    const task = createTask({ prompt: 'iter task', workingDirectory: '/workspace' });
    await taskRepo.save(task);

    const iteration = {
      id: 0,
      loopId: loop.id,
      iterationNumber: 1,
      taskId: task.id,
      status: 'running' as const,
      startedAt: Date.now(),
    };
    await repo.recordIteration(iteration);

    const itersResult = await repo.getIterations(loop.id, 10, 0);
    if (!itersResult.ok) return;
    expect(itersResult.value[0].evalResponse).toBeUndefined();
  });
});

// ============================================================================
// Section 4: EvalResult.decision interface contract
// ============================================================================

describe('EvalResult.decision field', () => {
  it('should support continue decision', () => {
    const result: EvalResult = {
      passed: false,
      decision: 'continue',
    };
    expect(result.decision).toBe('continue');
  });

  it('should support stop decision', () => {
    const result: EvalResult = {
      passed: true,
      decision: 'stop',
    };
    expect(result.decision).toBe('stop');
  });

  it('should be optional for backward compatibility', () => {
    const result: EvalResult = {
      passed: true,
    };
    expect(result.decision).toBeUndefined();
  });

  it('should coexist with evalResponse field', () => {
    const result: EvalResult = {
      passed: false,
      decision: 'continue',
      evalResponse: '{"type":"result","structured_output":{"decision":"fail"}}',
    };
    expect(result.decision).toBe('continue');
    expect(result.evalResponse).toContain('"type":"result"');
  });
});

// ============================================================================
// Section 5: jsonSchema in Task/TaskRequest domain types
// ============================================================================

describe('jsonSchema in Task domain', () => {
  it('should be set on created task when provided in request', () => {
    const schema = JSON.stringify({ type: 'object', properties: { decision: { type: 'string' } } });
    const task = createTask({
      prompt: 'test prompt',
      workingDirectory: '/workspace',
      jsonSchema: schema,
    });
    expect(task.jsonSchema).toBe(schema);
  });

  it('should be undefined when not provided in request', () => {
    const task = createTask({
      prompt: 'test prompt',
      workingDirectory: '/workspace',
    });
    expect(task.jsonSchema).toBeUndefined();
  });
});

// ============================================================================
// Section 6: Feedback accumulation cap — real evaluator behavioral invariant
// ============================================================================

/**
 * These tests invoke the REAL AgentExitConditionEvaluator with output lines that
 * exceed MAX_EVAL_FEEDBACK_LENGTH and assert observable properties of the returned
 * EvalResult. The previous implementation re-implemented the cap loop locally
 * and never called the evaluator (tautological — #136).
 */
describe('Feedback accumulation cap', () => {
  let eventBus: TestEventBus;
  let logger: TestLogger;

  beforeEach(() => {
    eventBus = new TestEventBus();
    logger = new TestLogger();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('truncates feedback to MAX_EVAL_FEEDBACK_LENGTH when eval output exceeds the cap', async () => {
    // Build output lines whose joined length well exceeds MAX_EVAL_FEEDBACK_LENGTH (16_000).
    // Each feedback line is ~500 chars; 40 of them = 20_000 chars > 16_000 cap.
    // The last line must be 'FAIL' (text-parse path, no jsonSchema since agent is not claude).
    const feedbackLine = 'x'.repeat(500);
    const lines: string[] = [];
    for (let i = 0; i < 40; i++) {
      lines.push(feedbackLine);
    }
    lines.push('FAIL');

    const outputRepo = createOutputRepo(lines);
    const loopRepo = createLoopRepo();
    const evaluator = new AgentExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger);

    // Use a non-claude agent so structured output is NOT attempted (forces text-parse path)
    const loop = createTestLoop({ agent: 'codex', strategy: LoopStrategy.RETRY });
    const result = await evaluateWithCompletion(evaluator, loop, TaskId('task-cap-1'), eventBus);

    // Evaluator must return a result (FAIL path, passed: false)
    expect(result.passed).toBe(false);

    // feedback must be present and capped at MAX_EVAL_FEEDBACK_LENGTH
    expect(result.feedback).toBeDefined();
    expect(result.feedback!.length).toBeLessThanOrEqual(MAX_EVAL_FEEDBACK_LENGTH);
  });

  it('preserves the start of feedback when truncating (slice(0, cap) semantics)', async () => {
    // First feedback line is distinctive — it must survive the cap even after truncation.
    const distinctFirst = 'FIRST_LINE_DISTINCTIVE_MARKER: iteration notes here.';
    const bulkLine = 'y'.repeat(500);
    const lines: string[] = [distinctFirst];
    // Add enough bulk lines to push total well past the cap
    for (let i = 0; i < 40; i++) {
      lines.push(bulkLine);
    }
    lines.push('FAIL');

    const outputRepo = createOutputRepo(lines);
    const loopRepo = createLoopRepo();
    const evaluator = new AgentExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger);

    const loop = createTestLoop({ agent: 'codex', strategy: LoopStrategy.RETRY });
    const result = await evaluateWithCompletion(evaluator, loop, TaskId('task-cap-2'), eventBus);

    expect(result.feedback).toBeDefined();
    // The first line must be present (truncation cuts from the end, not the start)
    expect(result.feedback).toContain(distinctFirst);
    // Total must still be within cap
    expect(result.feedback!.length).toBeLessThanOrEqual(MAX_EVAL_FEEDBACK_LENGTH);
  });

  it('does NOT truncate feedback when output is within the cap', async () => {
    // 5 short lines totalling well under 16_000 chars
    const lines = ['Line one.', 'Line two.', 'Line three.', 'FAIL'];

    const outputRepo = createOutputRepo(lines);
    const loopRepo = createLoopRepo();
    const evaluator = new AgentExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger);

    const loop = createTestLoop({ agent: 'codex', strategy: LoopStrategy.RETRY });
    const result = await evaluateWithCompletion(evaluator, loop, TaskId('task-cap-3'), eventBus);

    expect(result.passed).toBe(false);
    // All feedback lines must be present (no truncation)
    expect(result.feedback).toContain('Line one.');
    expect(result.feedback).toContain('Line two.');
    expect(result.feedback).toContain('Line three.');
  });
});
