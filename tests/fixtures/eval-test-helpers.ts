/**
 * Shared eval test helpers — extracted from eval-batch3, eval-domain-batch2,
 * and judge-exit-condition-evaluator tests (#143).
 *
 * ARCHITECTURE: No vi.mock() calls here — pure helper functions and factory stubs.
 * Using vi.mock() in a shared fixture causes module registry contamination across
 * test files in --no-file-parallelism runs (see judge evaluator test for details).
 *
 * RECONCILIATION NOTES (PF-2):
 * - createOutputRepo: eval-domain-batch2 used lines.join('') (byte count without
 *   separators); reconciled to lines.join('\n') (most correct — matches actual
 *   line-separated output).
 * - createLoopRepo: eval-domain-batch2 had the most complete stub (includes update,
 *   count, countByStatus, delete, cleanupOldLoops, findByScheduleId, findRunningIterations,
 *   findUpdatedSince). eval-batch3 and judge files had minimal stubs — reconciled to
 *   most complete version.
 * - createTestLoop: eval-domain-batch2 used Record<string, unknown> with agent:'claude';
 *   reconciled to typed Partial<Parameters<typeof createLoop>[0]> without default agent
 *   (callers set agent explicitly when needed).
 * - evaluateWithCompletions: eval-domain-batch2 had a single-completion variant
 *   (evaluateWithCompletion, not exported here — callers use evaluateWithCompletions
 *   with a single simulateFn array element). Generic typed version from eval-batch3
 *   is the most complete.
 */

import { vi } from 'vitest';
import type { Loop } from '../../src/core/domain.js';
import { createLoop, EvalMode, LoopStrategy, TaskId } from '../../src/core/domain.js';
import type { EvalResult, LoopRepository, OutputRepository } from '../../src/core/interfaces.js';
import { ok } from '../../src/core/result.js';
import type { TestEventBus } from './test-doubles.js';

// ─────────────────────────────────────────────────────────────────────────────
// Repository stubs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a minimal OutputRepository stub that returns the provided lines as stdout.
 * totalSize is measured with '\n' as separator via Buffer.byteLength — matches actual output.
 */
export function createOutputRepo(lines: string[]): OutputRepository {
  return {
    get: vi.fn().mockResolvedValue(
      ok({
        taskId: 'stub-task' as TaskId,
        stdout: lines,
        stderr: [],
        totalSize: Buffer.byteLength(lines.join('\n'), 'utf-8'),
      }),
    ),
    save: vi.fn().mockResolvedValue(ok(undefined)),
    delete: vi.fn().mockResolvedValue(ok(undefined)),
    append: vi.fn().mockResolvedValue(ok(undefined)),
    getSize: vi.fn().mockResolvedValue(ok(0)),
  } as unknown as OutputRepository;
}

/**
 * Create a LoopRepository stub. When preIterationCommitSha is provided, the stub
 * returns a running iteration with that SHA from findIterationByTaskId.
 *
 * This is the most complete stub across all eval test files — includes all interface
 * methods so tests don't fail with "not a function" on unexpected calls.
 */
export function createLoopRepo(preIterationCommitSha?: string): LoopRepository {
  return {
    findIterationByTaskId: vi
      .fn()
      .mockResolvedValue(
        ok(preIterationCommitSha ? { iterationNumber: 1, preIterationCommitSha, status: 'running' } : null),
      ),
    findById: vi.fn().mockResolvedValue(ok(null)),
    findAll: vi.fn().mockResolvedValue(ok([])),
    findByStatus: vi.fn().mockResolvedValue(ok([])),
    findByScheduleId: vi.fn().mockResolvedValue(ok([])),
    save: vi.fn().mockResolvedValue(ok(undefined)),
    update: vi.fn().mockResolvedValue(ok(undefined)),
    count: vi.fn().mockResolvedValue(ok(0)),
    countByStatus: vi.fn().mockResolvedValue(ok({})),
    delete: vi.fn().mockResolvedValue(ok(undefined)),
    cleanupOldLoops: vi.fn().mockResolvedValue(ok(0)),
    recordIteration: vi.fn().mockResolvedValue(ok(undefined)),
    getIterations: vi.fn().mockResolvedValue(ok([])),
    findRunningIterations: vi.fn().mockResolvedValue(ok([])),
    updateIteration: vi.fn().mockResolvedValue(ok(undefined)),
    findUpdatedSince: vi.fn().mockResolvedValue(ok([])),
    // Sync methods (used inside runInTransaction)
    updateSync: vi.fn(),
    recordIterationSync: vi.fn(),
    findByIdSync: vi.fn().mockReturnValue(null),
    updateIterationSync: vi.fn(),
  } as unknown as LoopRepository;
}

// ─────────────────────────────────────────────────────────────────────────────
// Domain factories
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a test Loop with sensible eval defaults. Pass overrides to customise
 * strategy, evalMode, agent, evalPrompt, etc.
 *
 * Note: no default agent — tests that need a specific agent (e.g. 'claude') should
 * pass it explicitly in overrides. This matches eval-batch3 and judge-evaluator behaviour.
 */
export function createTestLoop(overrides: Partial<Parameters<typeof createLoop>[0]> = {}): Loop {
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

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Drive an evaluator through one or more task-completion cycles.
 *
 * Captures the eval task IDs from TaskDelegated events, then calls each simulateFn
 * with the corresponding captured task ID — enabling multi-phase evaluators (e.g.
 * JudgeExitConditionEvaluator: phase 1 eval + phase 2 judge) to be driven sequentially.
 *
 * ARCHITECTURE: Generic over any evaluator that exposes evaluate(). This avoids
 * coupling the helper to a specific evaluator type (e.g. JudgeExitConditionEvaluator)
 * — callers need only satisfy the structural constraint.
 */
export async function evaluateWithCompletions<
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
    // WHY setImmediate (not Promise.resolve / await tick):
    // evaluate() calls await buildEvalPrompt() before setting up its TaskCompleted
    // subscription via waitForEvalTaskCompletion. buildEvalPrompt() is an async
    // function that may itself await, queuing work on the microtask queue. A single
    // microtask yield (Promise.resolve) is insufficient to drain the entire async
    // setup chain. setImmediate defers to the next I/O event loop iteration,
    // ensuring evaluate()'s subscription setup code has fully executed before we
    // fire the simulated TaskCompleted. Replacing with Promise.resolve causes
    // intermittent "no subscription registered" failures in CI.
    await new Promise((r) => setImmediate(r));
    const taskIdForPhase = capturedTaskIds[i];
    if (taskIdForPhase) {
      await simulateFns[i](taskIdForPhase);
    }
    // Second setImmediate: give the evaluator's completion handler a full event-loop
    // tick to process the event and resolve its internal promise before we return.
    await new Promise((r) => setImmediate(r));
  }

  return evalPromise;
}

// ─────────────────────────────────────────────────────────────────────────────
// Event simulation helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Emit TaskCompleted for the given taskId to simulate a successful eval task.
 */
export async function simulateTaskComplete(eventBus: TestEventBus, taskId: string): Promise<void> {
  await eventBus.emit('TaskCompleted', {
    taskId: taskId as ReturnType<typeof TaskId>,
    workerId: 'w1' as unknown as never,
  });
}

/**
 * Emit TaskFailed for the given taskId to simulate a failed eval task.
 */
export async function simulateTaskFailed(
  eventBus: TestEventBus,
  taskId: string,
  message = 'task failed',
): Promise<void> {
  await eventBus.emit('TaskFailed', {
    taskId: taskId as ReturnType<typeof TaskId>,
    error: new Error(message),
    workerId: 'w1' as unknown as never,
  });
}
