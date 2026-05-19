# Tests Review Report

**Branch**: feat-agent-eval-mode -> main
**Date**: 2026-03-30T12:14

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

**Repetitive test boilerplate in `agent-exit-condition-evaluator.test.ts` (12 occurrences)** -- Confidence: 90%
- `tests/unit/services/agent-exit-condition-evaluator.test.ts:317-323`, `tests/unit/services/agent-exit-condition-evaluator.test.ts:345-351`, and 10 more occurrences
- Problem: Nearly every test in this file repeats the same 8-line `vi.spyOn(eventBus, 'emit').mockImplementation(...)` block to capture the eval task ID, followed by the same `await new Promise((r) => setImmediate(r))` tick-flush and `if (capturedEvalTaskId) { await simulateEvalTaskComplete(...) }` pattern. This pattern appears in 12 of 15 tests, constituting ~40% of the test file. Per test-patterns, the same pattern repeated >3 times indicates the API under test (or test helpers) need improvement.
- Fix: Extract a shared helper that encapsulates the spy-capture-simulate cycle:
  ```typescript
  async function evaluateWithCompletion(
    evaluator: AgentExitConditionEvaluator,
    loop: Loop,
    taskId: TaskId,
    eventBus: TestEventBus,
    simulate: (evalTaskId: string, eventBus: TestEventBus) => Promise<void> = simulateEvalTaskComplete,
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
    await new Promise((r) => setImmediate(r));
    if (capturedEvalTaskId) {
      await simulate(capturedEvalTaskId, eventBus);
    }
    return evalPromise;
  }
  ```
  This would reduce each test to 3-5 lines of meaningful assertions.

**Repeated `new MCPAdapter({...})` construction in MCP adapter tests (3 occurrences)** -- Confidence: 82%
- `tests/unit/adapters/mcp-adapter.test.ts:2400-2407`, `tests/unit/adapters/mcp-adapter.test.ts:2430-2437`, `tests/unit/adapters/mcp-adapter.test.ts:2454-2461`
- Problem: Three new tests each construct a `new MCPAdapter(...)` with the exact same 6-property configuration object. The surrounding test suite (`describe('MCPAdapter - Loop Tools')`) likely already has a shared adapter fixture that could be reused.
- Fix: Verify if a shared adapter exists in the parent `describe` scope's `beforeEach`; if so, use it instead of constructing a new one in each test. If not, introduce a `beforeEach` for the `describe('CreateLoop with evalMode via callTool()')` block.

### MEDIUM

**Variable reference before declaration in stale state guard test** -- Confidence: 85%
- `tests/unit/services/handlers/loop-handler.test.ts:786-795`
- Problem: The `mockEvaluator.evaluate.mockImplementation` callback on line 788 references `loop.id`, but `loop` is declared with `const` on line 795 (7 lines later). This works at runtime because the closure captures by reference and the mock only executes after `loop` is assigned during the event emission on line 800. However, this is misleading and fragile -- if the code is reordered or the mock is called synchronously in the future, it will throw a `ReferenceError` (TDZ violation).
- Fix: Move the `const loop = await createAndEmitLoop(...)` line above the `mockEvaluator.evaluate.mockImplementation(...)` setup:
  ```typescript
  const loop = await createAndEmitLoop({ maxIterations: 5 });
  mockEvaluator.evaluate.mockImplementation(async () => {
    const loopResult = await loopRepo.findById(loop.id);
    // ...
  });
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Missing test for stale iteration guard path** -- Confidence: 82%
- `src/services/handlers/loop-handler.ts:301-317`
- Problem: The loop-handler's stale state guard has two branches: (1) loop no longer running after eval, and (2) iteration no longer running after eval. The first branch is tested (`'should skip result processing when loop is no longer running after eval'`), but the second branch (iteration status changed to non-running while eval ran) has no test. This leaves one of two defensive code paths uncovered.
- Fix: Add a test where the evaluator mock modifies the iteration status to a terminal state (e.g., via `loopRepo.updateIteration(...)`) before returning, and verify the loop does not process the stale result.

**Missing test for `evalTimeout` boundary validation for shell mode (300s max)** -- Confidence: 80%
- `src/services/loop-manager.ts:130`
- Problem: The loop-manager tests cover agent mode `evalTimeout` rejection at 600001ms, and agent mode acceptance at 600000ms. However, there is no test verifying that shell mode rejects `evalTimeout > 300000ms`. The old test for this may exist elsewhere (pre-existing), but the new validation logic changed the boundary conditionally, and the new tests only cover the agent path.
- Fix: Add a test in the `createLoop() - agent eval mode` describe block (or a sibling block) that verifies shell mode rejects `evalTimeout: 300001`.

## Pre-existing Issues (Not Blocking)

(none -- no critical pre-existing test issues found in the reviewed files)

## Suggestions (Lower Confidence)

- **No negative test for `evalMode: 'agent'` with `evalDirection`** - `tests/unit/services/loop-manager.test.ts` (Confidence: 65%) -- The source code does not appear to reject `evalDirection` when `evalMode` is `agent`, but it is unclear whether this combination is meaningful for optimize strategy. Consider whether this is intentional or a missing validation.

- **Fallback timer test missing** - `tests/unit/services/agent-exit-condition-evaluator.test.ts` (Confidence: 70%) -- The `waitForTaskCompletion` method has a fallback timer at `evalTimeout + 5000ms`. No test exercises this path (where neither TaskCompleted/Failed/Cancelled/Timeout is emitted and the timer fires). This is a defensive path and testing it would require controlling real timers or injecting a timer abstraction.

- **`byteSize` calculated with `.length` instead of `Buffer.byteLength` in test helper** - `tests/unit/services/agent-exit-condition-evaluator.test.ts:226` (Confidence: 62%) -- The `createOutputRepo` helper uses `lines.join('\n').length` for byteSize, which counts characters, not bytes. Per pitfalls, the codebase standardized on `Buffer.byteLength`. This is a test helper and the value is not asserted, so it has no behavioral impact.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 1 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Tests Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The new test suite provides strong behavioral coverage for the agent eval feature. The `AgentExitConditionEvaluator` tests cover retry PASS/FAIL parsing, optimize score parsing, feedback capture, empty output, task failure/cancellation/timeout, emit failure, prompt construction (with custom evalPrompt, with git diff SHA), and output repository failures. The `CompositeExitConditionEvaluator` tests properly verify routing and passthrough. CLI tests cover 8 new argument parsing scenarios with both positive and negative cases. The loop-handler tests cover evalFeedback propagation across retry pass/fail and optimize paths, plus the stale state guard. The loop-manager tests cover agent mode creation, evalPrompt storage, validation rules, and timeout boundaries.

Key conditions:
1. Extract the repeated spy-capture-simulate boilerplate in the agent evaluator tests (HIGH -- 12 repetitions exceeds the >3 threshold)
2. Fix the variable-before-declaration ordering in the stale state guard test (MEDIUM -- fragile to refactoring)
3. Consider adding the missing stale iteration guard test (MEDIUM -- one of two defensive branches uncovered)
