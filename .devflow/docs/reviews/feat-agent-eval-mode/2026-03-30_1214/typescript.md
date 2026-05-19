# TypeScript Review Report

**Branch**: feat-agent-eval-mode -> main
**Date**: 2026-03-30T12:14

## Issues in Your Changes (BLOCKING)

### HIGH

**Unsafe `as` casts on `eval_mode` from DB row bypass Zod validation** - `src/implementations/loop-repository.ts:609`, `src/adapters/mcp-adapter.ts:2181`, `src/adapters/mcp-adapter.ts:2512`
**Confidence**: 85%
- Problem: The `LoopRowSchema` validates `eval_mode` as `z.string().default('shell')` -- a bare `string`, not `z.enum(['shell', 'agent'])`. The repository then casts the raw string to `'shell' | 'agent'` with `as`, bypassing the type system. If a future migration introduces a new eval mode value, or if data corruption produces an unexpected string, this cast silently lies about the type. The MCP adapter similarly casts `data.evalMode as 'shell' | 'agent' | undefined` even though the Zod schema already narrows the type to exactly `'shell' | 'agent'` via `z.enum(['shell', 'agent'])`, making the cast redundant there.
- Fix: In `loop-repository.ts`, change the Zod schema for `eval_mode` from `z.string().default('shell')` to `z.enum(['shell', 'agent']).default('shell')`. This validates at the boundary and removes the need for the `as` cast. In the MCP adapter, the `z.enum(['shell', 'agent'])` schema already produces the correct type, so the `as` cast is unnecessary and can be removed (Zod infers the union type correctly).

```typescript
// loop-repository.ts LoopRowSchema — change:
eval_mode: z.string().default('shell'),
// to:
eval_mode: z.enum(['shell', 'agent']).default('shell'),

// loop-repository.ts toDomain — remove cast:
evalMode: data.eval_mode, // z.enum already narrows the type

// mcp-adapter.ts — remove redundant casts:
evalMode: data.evalMode,  // z.enum already narrows the type
```

### MEDIUM

**Cleanup code duplicated in stale-state guard early returns** - `src/services/handlers/loop-handler.ts:294-296`, `src/services/handlers/loop-handler.ts:313-315`
**Confidence**: 82%
- Problem: The three cleanup lines (`cleanupPipelineTaskTracking`, `taskToLoop.delete`, `cleanupPipelineTasks`) are copy-pasted identically in both stale-state guard branches AND again after the normal flow at lines 324-326. If cleanup logic changes, three locations must be updated in sync. This is a maintenance hazard within newly added code.
- Fix: Extract the cleanup into a local helper or use a `try/finally` pattern so the cleanup at lines 324-326 always runs, even on early return. Alternatively, restructure the early returns to `break` or set a flag, letting the single cleanup block at the end run.

```typescript
// Option: restructure to avoid duplicating cleanup
let skipResult = false;
if (!freshLoopResult.ok || ...) {
  this.logger.info('Loop no longer running after eval...');
  skipResult = true;
}
if (!skipResult) {
  const freshIterationResult = await this.loopRepo.findIterationByTaskId(taskId);
  if (!freshIterationResult.ok || ...) {
    this.logger.info('Iteration no longer running after eval...');
    skipResult = true;
  }
  if (!skipResult) {
    await this.handleIterationResult(freshLoop, freshIteration, evalResult);
  }
}
// Single cleanup block (already exists at lines 324-326)
this.cleanupPipelineTaskTracking(iteration);
this.taskToLoop.delete(taskId);
this.cleanupPipelineTasks(loopId, iteration.iterationNumber);
```

**No validation of `evalMode` value in `LoopManagerService.createLoop`** - `src/services/loop-manager.ts:57`
**Confidence**: 80%
- Problem: The `evalMode` is defaulted to `'shell'` and then used in conditional branches, but there is no explicit check that rejects invalid values. The `LoopCreateRequest` interface constrains the type to `'shell' | 'agent' | undefined`, but at runtime the MCP adapter passes validated Zod output while the CLI constructs the value manually. If a future caller passes a string that does not match either variant, no error is raised -- the code silently falls through to shell behavior. This is the "validate at boundaries" principle from the project guidelines.
- Fix: Add an explicit guard for invalid `evalMode` values at the top of the validation block:

```typescript
const evalMode = request.evalMode ?? 'shell';
if (evalMode !== 'shell' && evalMode !== 'agent') {
  return err(
    new AutobeatError(ErrorCode.INVALID_INPUT, `evalMode must be "shell" or "agent"`, {
      field: 'evalMode',
      value: evalMode,
    }),
  );
}
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`recordAndContinue` parameter type uses inline object instead of extending `EvalResult`** - `src/services/handlers/loop-handler.ts:1121`
**Confidence**: 80%
- Problem: The `evalResult` parameter type `{ score?: number; exitCode?: number; errorMessage?: string; evalFeedback?: string }` is an ad-hoc inline type that duplicates a subset of `EvalResult` fields plus `evalFeedback`. This was extended in this PR by adding `evalFeedback`. As `EvalResult` evolves, this inline type must be manually kept in sync. The parameter is used identically in 6 call sites within this PR.
- Fix: Define a named type (e.g., `IterationEvalFields`) or use `Pick<EvalResult, 'score' | 'exitCode'> & { errorMessage?: string; evalFeedback?: string }` to create a single source of truth.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Test helper pattern uses `as unknown as` double-cast for branded types** - `tests/unit/services/agent-exit-condition-evaluator.test.ts:267`, `tests/unit/services/agent-exit-condition-evaluator.test.ts:274`
**Confidence**: 80%
- Problem: The test helpers (`simulateEvalTaskFailed`, `simulateEvalTaskComplete`, etc.) use `as unknown as never` to bypass the `WorkerId` branded type, and `as ReturnType<typeof TaskId>` for task IDs. While this is a common test pattern, the `as unknown as never` is particularly opaque -- it intentionally lies about the type being `never` which suppresses all type checking on that field.
- Fix: Consider creating a `WorkerId('test-worker')` call instead, or a test helper `testWorkerId()` that produces a properly branded value, consistent with the `TaskId('task-work-abc123')` pattern already used in the same file.

## Suggestions (Lower Confidence)

- **Score range not validated in `parseEvalOutput`** - `src/services/agent-exit-condition-evaluator.ts:252` (Confidence: 70%) -- The optimize strategy parses any finite float as a valid score, including negatives or values above 100. The prompt instructs 0-100 but the parser does not enforce it. This may be intentional for flexibility, but could lead to surprising `bestScore` values.

- **`buildEvalPrompt` discards git diff instruction when custom `evalPrompt` is provided** - `src/services/agent-exit-condition-evaluator.ts:142` (Confidence: 65%) -- When `loop.evalPrompt` is set, it replaces the entire `defaultInstructions` block including the `gitDiffInstruction`. A custom eval prompt author must know to include their own git diff command, which is not documented in the MCP tool description.

- **`exitCondition: ''` sentinel for agent mode** - `src/core/domain.ts:621`, `src/cli/commands/loop.ts:183` (Confidence: 62%) -- Using an empty string as a sentinel for "no exit condition" in agent mode works but is fragile. The `Loop` interface still types `exitCondition` as `string` (not `string | undefined`), so it is impossible to distinguish "no exit condition" from "empty exit condition" without also checking `evalMode`. A discriminated union or making `exitCondition` optional on the domain type would be more type-safe.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**TypeScript Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The core architecture (strategy pattern, composite evaluator, event-driven eval task lifecycle) is well-typed and follows established project patterns. The main TypeScript concern is the unsafe `as` casts on `eval_mode` in the repository layer, where the Zod schema validates as bare `z.string()` but the code asserts a narrower union type. Tightening the Zod schema to `z.enum()` is a one-line fix that provides real runtime safety. The stale-state guard cleanup duplication and missing boundary validation for `evalMode` are smaller but worth addressing.
