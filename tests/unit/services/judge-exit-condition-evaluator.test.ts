/**
 * Unit tests for JudgeExitConditionEvaluator
 *
 * ARCHITECTURE: Uses injected FsAdapter mock rather than vi.mock('node:fs/promises').
 *
 * DECISION: Inject fs dependency rather than vi.mock at file scope.
 * Why: vi.mock('node:fs/promises') leaks through vitest's shared module registry in
 * --no-file-parallelism runs. When handler-setup.test.ts runs, it imports handler-setup.ts
 * which instantiates JudgeExitConditionEvaluator, loading the real node:fs/promises into
 * the module cache. This clobbers the vi.mock regardless of file run order.
 * DI injection (optional 5th constructor param) is the clean solution — no module-level
 * mocking required, and the production code defaults to the real fs when no mock is passed.
 *
 * Pattern: Behavioral testing — verifies file-based judge decision mechanism,
 * two-phase eval+judge flow, safe fallbacks, and schema injection for Claude.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EvalMode, LoopStrategy, TaskId } from '../../../src/core/domain.js';
import type { OutputRepository } from '../../../src/core/interfaces.js';
import { ok } from '../../../src/core/result.js';
import type { FsAdapter } from '../../../src/services/judge-exit-condition-evaluator.js';
import { JudgeExitConditionEvaluator } from '../../../src/services/judge-exit-condition-evaluator.js';
import {
  createLoopRepo,
  createOutputRepo,
  createTestLoop,
  evaluateWithCompletions,
  simulateTaskComplete,
  simulateTaskFailed,
} from '../../fixtures/eval-test-helpers.js';
import { TestEventBus, TestLogger } from '../../fixtures/test-doubles.js';

// ─────────────────────────────────────────────────────────────────────────────
// File-specific helpers
// ─────────────────────────────────────────────────────────────────────────────

function createMockFs(): { readFile: ReturnType<typeof vi.fn>; unlink: ReturnType<typeof vi.fn> } & FsAdapter {
  return {
    readFile: vi.fn().mockResolvedValue(''),
    unlink: vi.fn().mockResolvedValue(undefined),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('JudgeExitConditionEvaluator', () => {
  let eventBus: TestEventBus;
  let logger: TestLogger;
  const workTaskId = TaskId('task-work-xyz789');

  beforeEach(() => {
    eventBus = new TestEventBus();
    logger = new TestLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    eventBus.dispose();
  });

  it('returns decision: stop when judge file contains continue: false', async () => {
    const loop = createTestLoop({ evalPrompt: 'Review changes', judgePrompt: 'Should we stop?' });
    const outputRepo = createOutputRepo(['Analysis: tests are passing.']);
    const loopRepo = createLoopRepo();
    const mockFs = createMockFs();
    mockFs.readFile.mockResolvedValueOnce(JSON.stringify({ continue: false, reasoning: 'All criteria met.' }));
    const evaluator = new JudgeExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger, mockFs);

    const result = await evaluateWithCompletions(evaluator, loop, workTaskId, eventBus, [
      (id) => simulateTaskComplete(eventBus, id),
      (id) => simulateTaskComplete(eventBus, id),
    ]);

    expect(result.decision).toBe('stop');
    expect(result.feedback).toBeTruthy();
  });

  it('returns decision: continue when judge file contains continue: true', async () => {
    const loop = createTestLoop({ evalPrompt: 'Review changes' });
    const outputRepo = createOutputRepo(['Tests still failing.']);
    const loopRepo = createLoopRepo();
    const mockFs = createMockFs();
    mockFs.readFile.mockResolvedValueOnce(JSON.stringify({ continue: true, reasoning: 'More work needed.' }));
    const evaluator = new JudgeExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger, mockFs);

    const result = await evaluateWithCompletions(evaluator, loop, workTaskId, eventBus, [
      (id) => simulateTaskComplete(eventBus, id),
      (id) => simulateTaskComplete(eventBus, id),
    ]);

    expect(result.decision).toBe('continue');
  });

  it('defaults to continue when judge file is missing (ENOENT)', async () => {
    const loop = createTestLoop({ evalPrompt: 'Review changes' });
    const outputRepo = createOutputRepo(['No verdict.']);
    const loopRepo = createLoopRepo();
    const mockFs = createMockFs();
    const enoentErr = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockFs.readFile.mockRejectedValue(enoentErr);
    const evaluator = new JudgeExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger, mockFs);

    const result = await evaluateWithCompletions(evaluator, loop, workTaskId, eventBus, [
      (id) => simulateTaskComplete(eventBus, id),
      (id) => simulateTaskComplete(eventBus, id),
    ]);

    expect(result.decision).toBe('continue');
  });

  it('defaults to continue when judge file contains invalid JSON', async () => {
    const loop = createTestLoop({ evalPrompt: 'Review changes' });
    const outputRepo = createOutputRepo(['Some output.']);
    const loopRepo = createLoopRepo();
    const mockFs = createMockFs();
    mockFs.readFile.mockResolvedValueOnce('not valid json at all!!!!');
    const evaluator = new JudgeExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger, mockFs);

    const result = await evaluateWithCompletions(evaluator, loop, workTaskId, eventBus, [
      (id) => simulateTaskComplete(eventBus, id),
      (id) => simulateTaskComplete(eventBus, id),
    ]);

    expect(result.decision).toBe('continue');
  });

  it('defaults to continue when judge phase 2 task fails', async () => {
    const loop = createTestLoop({ evalPrompt: 'Review changes' });
    const outputRepo = createOutputRepo(['Output here.']);
    const loopRepo = createLoopRepo();
    const mockFs = createMockFs();
    const evaluator = new JudgeExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger, mockFs);

    const result = await evaluateWithCompletions(evaluator, loop, workTaskId, eventBus, [
      (id) => simulateTaskComplete(eventBus, id),
      (id) => simulateTaskFailed(eventBus, id),
    ]);

    expect(result.decision).toBe('continue');
  });

  it('includes findings (phase 1 output) in feedback', async () => {
    const loop = createTestLoop({ evalPrompt: 'Evaluate test quality' });
    const outputRepo = createOutputRepo(['Coverage is at 80%.', 'Three tests still failing.']);
    const loopRepo = createLoopRepo();
    const mockFs = createMockFs();
    mockFs.readFile.mockResolvedValueOnce(JSON.stringify({ continue: true, reasoning: 'Keep going.' }));
    const evaluator = new JudgeExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger, mockFs);

    const result = await evaluateWithCompletions(evaluator, loop, workTaskId, eventBus, [
      (id) => simulateTaskComplete(eventBus, id),
      (id) => simulateTaskComplete(eventBus, id),
    ]);

    expect(result.feedback).toContain('Coverage is at 80%.');
    expect(result.feedback).toContain('Three tests still failing.');
  });

  it('injects jsonSchema for Claude judge agent (belt-and-suspenders)', async () => {
    const loop = createTestLoop({
      evalPrompt: 'Review',
      judgeAgent: 'claude',
    });
    const outputRepo = createOutputRepo(['Findings.']);
    const loopRepo = createLoopRepo();
    const mockFs = createMockFs();
    const enoentErr = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockFs.readFile.mockRejectedValue(enoentErr);
    const evaluator = new JudgeExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger, mockFs);

    await evaluateWithCompletions(evaluator, loop, workTaskId, eventBus, [
      (id) => simulateTaskComplete(eventBus, id),
      (id) => simulateTaskComplete(eventBus, id),
    ]);

    const delegatedEvents = eventBus.getEmittedEvents('TaskDelegated') as Array<{
      task: { prompt: string; jsonSchema?: string; agent: string };
    }>;
    const judgeEvent = delegatedEvents.find((e) => e.task.prompt.startsWith('[JUDGE]'));
    expect(judgeEvent).toBeDefined();
    expect(judgeEvent?.task.jsonSchema).toBeTruthy();
  });

  it('does not inject jsonSchema for non-Claude judge agent', async () => {
    const loop = createTestLoop({
      evalPrompt: 'Review',
      judgeAgent: 'gemini',
    });
    const outputRepo = createOutputRepo(['Findings.']);
    const loopRepo = createLoopRepo();
    const mockFs = createMockFs();
    const enoentErr = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockFs.readFile.mockRejectedValue(enoentErr);
    const evaluator = new JudgeExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger, mockFs);

    await evaluateWithCompletions(evaluator, loop, workTaskId, eventBus, [
      (id) => simulateTaskComplete(eventBus, id),
      (id) => simulateTaskComplete(eventBus, id),
    ]);

    const delegatedEvents = eventBus.getEmittedEvents('TaskDelegated') as Array<{
      task: { prompt: string; jsonSchema?: string };
    }>;
    const judgeEvent = delegatedEvents.find((e) => e.task.prompt.startsWith('[JUDGE]'));
    expect(judgeEvent?.task.jsonSchema).toBeUndefined();
  });

  it('stores evalResponse with judgeDecision and evalFindings', async () => {
    const loop = createTestLoop({ evalPrompt: 'Review' });
    const outputRepo = createOutputRepo(['Good progress.']);
    const loopRepo = createLoopRepo();
    const mockFs = createMockFs();
    mockFs.readFile.mockResolvedValueOnce(JSON.stringify({ continue: false, reasoning: 'Done.' }));
    const evaluator = new JudgeExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger, mockFs);

    const result = await evaluateWithCompletions(evaluator, loop, workTaskId, eventBus, [
      (id) => simulateTaskComplete(eventBus, id),
      (id) => simulateTaskComplete(eventBus, id),
    ]);

    expect(result.evalResponse).toBeTruthy();
    const parsed = JSON.parse(result.evalResponse!);
    expect(parsed.judgeDecision).toBeDefined();
    expect(parsed.judgeDecision.continue).toBe(false);
    expect(parsed.evalFindings).toBeTruthy();
  });

  it('uses structured output from Claude judge when available (bypasses file read)', async () => {
    const loop = createTestLoop({ evalPrompt: 'Review', judgeAgent: 'claude' });
    const structuredOutput = JSON.stringify({
      type: 'result',
      structured_output: { continue: false, reasoning: 'Structured: complete.' },
    });
    const outputRepoPhase1 = createOutputRepo(['Findings.']);
    const outputRepoPhase2 = createOutputRepo([structuredOutput]);
    let callCount = 0;
    const combinedOutputRepo: OutputRepository = {
      get: vi.fn().mockImplementation(() => {
        callCount++;
        return callCount === 1
          ? outputRepoPhase1.get(undefined as unknown as ReturnType<typeof TaskId>)
          : outputRepoPhase2.get(undefined as unknown as ReturnType<typeof TaskId>);
      }),
      save: vi.fn().mockResolvedValue(ok(undefined)),
      delete: vi.fn().mockResolvedValue(ok(undefined)),
      getSize: vi.fn().mockResolvedValue(ok(0)),
    } as unknown as OutputRepository;
    const loopRepo = createLoopRepo();
    const mockFs = createMockFs();
    const evaluator = new JudgeExitConditionEvaluator(eventBus, combinedOutputRepo, loopRepo, logger, mockFs);

    const result = await evaluateWithCompletions(evaluator, loop, workTaskId, eventBus, [
      (id) => simulateTaskComplete(eventBus, id),
      (id) => simulateTaskComplete(eventBus, id),
    ]);

    expect(result.decision).toBe('stop');
  });

  it('uses a unique per-task decision filename (TOCTOU fix)', async () => {
    // The judge prompt must instruct the agent to write to a file whose name includes
    // the judgeTaskId — not the fixed ".autobeat-judge" name.
    const loop = createTestLoop({ evalPrompt: 'Review', workingDirectory: '/workspace' });
    const outputRepo = createOutputRepo(['Findings.']);
    const loopRepo = createLoopRepo();
    const mockFs = createMockFs();
    const enoentErr = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockFs.readFile.mockRejectedValue(enoentErr);
    const evaluator = new JudgeExitConditionEvaluator(eventBus, outputRepo, loopRepo, logger, mockFs);

    await evaluateWithCompletions(evaluator, loop, workTaskId, eventBus, [
      (id) => simulateTaskComplete(eventBus, id),
      (id) => simulateTaskComplete(eventBus, id),
    ]);

    const delegatedEvents = eventBus.getEmittedEvents('TaskDelegated') as Array<{
      task: { prompt: string; id: string };
    }>;
    const judgeEvent = delegatedEvents.find((e) => e.task.prompt.startsWith('[JUDGE]'));
    expect(judgeEvent).toBeDefined();

    // The judge task ID must appear in the prompt's decision filename
    const judgeTaskId = judgeEvent!.task.id;
    expect(judgeEvent!.task.prompt).toContain(`.autobeat-judge-${judgeTaskId}`);

    // The fixed .autobeat-judge name must NOT appear in the prompt
    expect(judgeEvent!.task.prompt).not.toMatch(/\.autobeat-judge[^-]/);

    // readFile must also be called with the unique filename
    expect(mockFs.readFile).toHaveBeenCalledWith(expect.stringContaining(`.autobeat-judge-${judgeTaskId}`), 'utf-8');
  });
});
