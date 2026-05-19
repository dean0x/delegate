# TypeScript Review Report

**Branch**: feat/v1.4.0-reliability-eval-redesign -> main
**PR**: #136
**Base**: 33abbb78c6c566480ef474d5b98d20087051a929
**Date**: 2026-04-15 10:23

## Issues in Your Changes (BLOCKING)

### CRITICAL
_None._

### HIGH

**Unchecked type assertion `event as TaskFailedEvent` on a discriminated union (2 occurrences)** — Confidence: 92%
- `src/services/handlers/loop-handler.ts:261`, `src/services/handlers/loop-handler.ts:1591`
- Problem: `TaskCompletedEvent | TaskFailedEvent` is a textbook discriminated union (the `type` literal `'TaskCompleted'` / `'TaskFailed'` is the discriminant). Both call sites cast with `event as TaskFailedEvent` instead of letting the compiler narrow. The TypeScript skill's Iron Law table flags `data as User` as a violation: the correct pattern is a runtime check that narrows. The cast is needed today only because the code stores the discriminant in a local boolean (`const isTaskFailed = event.type === 'TaskFailed'`), which strips narrowing — assigning a `===` test to a variable does NOT preserve narrowing on the original. If the event payload shape ever drifts (e.g. an optional `error` becomes required), the unchecked cast will compile but crash at runtime.
- Fix: branch directly on the discriminant instead of caching it, so the compiler narrows automatically and the cast disappears:
  ```typescript
  // Before (loop-handler.ts:257-261)
  const isTaskFailed = event.type === 'TaskFailed';
  if (isTaskFailed) {
    const failedEvent = event as TaskFailedEvent; // unchecked
    ...failedEvent.exitCode
  }

  // After
  if (event.type === 'TaskFailed') {
    // event is narrowed to TaskFailedEvent — no cast
    ...event.exitCode
    ...event.error?.message
  } else {
    // event is narrowed to TaskCompletedEvent
  }
  ```
  Apply the same pattern at line 1591 in `handlePipelineIntermediateTask` — `event.type` is already known to be `'TaskFailed'` by that code path, so just check it inline at the top of the failure branch.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`EvalPromptBase.gitDiffInstructions` is dead public surface** — Confidence: 90%
- `src/services/eval-prompt-builder.ts:30`
- Problem: The `EvalPromptBase` interface exports three readonly fields, but a grep across the three callers (`agent-exit-condition-evaluator.ts:181-183`, `feedforward-evaluator.ts:134-136`, `judge-exit-condition-evaluator.ts:271-273`) shows only `contextHeader` and `toolInstructions` are read. `gitDiffInstructions` is computed inside `buildEvalPromptBase` purely as a substring of `toolInstructions` (line 60: `${gitDiffInstructions} Use \`beat logs ${taskId}\`...`) and exposed as a separate field that nothing consumes. This widens the public type contract without value: any future caller will see `gitDiffInstructions` and assume it's load-bearing.
- Fix: drop the field from the interface and the return object, keeping the local variable in the function body:
  ```typescript
  export interface EvalPromptBase {
    readonly contextHeader: string;
    readonly toolInstructions: string;
  }
  // ...
  return { contextHeader, toolInstructions };
  ```
  If a caller later needs the raw git-diff instruction without the `beat logs` suffix, re-introduce it then.

**`IterationResultFields` fields are not `readonly` — inconsistent with adjacent types** — Confidence: 84%
- `src/services/handlers/loop-handler.ts:68-74`
- Problem: The new exported `IterationResultFields` type uses mutable optional fields, while the new `SpawnOptions` interface in the same diff (`src/core/agents.ts:233-246`) commits to fully `readonly` fields, as does most of the rest of the domain layer (`Loop`, `LoopIteration`, all event interfaces). Inconsistent immutability is a TypeScript anti-pattern flagged by the consistency dimension and weakens the "Immutable by default" engineering principle in CLAUDE.md.
- Fix:
  ```typescript
  export type IterationResultFields = {
    readonly score?: number;
    readonly exitCode?: number;
    readonly errorMessage?: string;
    readonly evalFeedback?: string;
    readonly evalResponse?: string;
  };
  ```

**`acquirePidFile` returns `Result<'acquired' | 'already-running', Error>` but callers don't exhaustively check** — Confidence: 82%
- `src/cli/commands/schedule-executor.ts:77`, callsite `src/cli/commands/schedule-executor.ts:218-226`
- Problem: The return type is a discriminated union with two distinct success values that have very different semantics (acquired = continue startup; already-running = exit cleanly). The current call site checks `acquireResult.value === 'already-running'` then falls through, implicitly treating any other value as 'acquired'. If a third sentinel (e.g. `'stale-recovered'`) is added to the union, the `else` branch silently mishandles it. The pattern skill's "Exhaustive Checks" idiom (`const _: never = status`) applies here.
- Fix: switch on the literal and use `never` for exhaustiveness:
  ```typescript
  switch (acquireResult.value) {
    case 'acquired':
      break; // continue startup
    case 'already-running':
      process.exit(0);
    default: {
      const _exhaustive: never = acquireResult.value;
      throw new Error(`Unhandled acquire result: ${String(_exhaustive)}`);
    }
  }
  ```
  This mirrors the (now-correct) `default: throw new Error` pattern you adopted in `composite-exit-condition-evaluator.ts:53-57`.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Unsafe `as unknown as ScheduleRepository` / `as unknown as LoopRepository` / `as unknown as OutputRepository` in shared test fixture** — Confidence: 86%
- `tests/fixtures/eval-test-helpers.ts:54, 91`
- Problem: The double-cast `as unknown as T` is the TypeScript escape hatch that disables structural typing — the helper builds an object with only some interface methods then forces it into the full interface type. If a new method is added to `LoopRepository` and a production code path begins calling it during eval, every test using `createLoopRepo()` will compile cleanly but throw "not a function" at runtime. The pattern skill's anti-pattern table calls out unchecked assertions as a violation.
- Fix: replace the double cast with `Partial<T>` plus a `satisfies` check, or build a typed Proxy that throws on unimplemented methods:
  ```typescript
  function createLoopRepo(...): LoopRepository {
    const stub: Partial<LoopRepository> = { /* ... */ };
    return new Proxy(stub, {
      get(target, prop) {
        if (prop in target) return Reflect.get(target, prop);
        throw new Error(`LoopRepository.${String(prop)} not stubbed`);
      },
    }) as LoopRepository;
  }
  ```

**`ProcessSpawnerAdapter.spawn` silently drops `orchestratorId` and `jsonSchema` from `SpawnOptions`** — Confidence: 78%
- `src/implementations/process-spawner-adapter.ts:26-28`
- Problem: Destructures only `{ prompt, workingDirectory, taskId, model }` from `SpawnOptions` and silently discards the v1.3.0 `orchestratorId` and v1.4.0 `jsonSchema` fields. Tests using `MockProcessSpawner` via this adapter cannot exercise orchestration attribution or structured-output flows. The TypeScript discriminator-style fix would be to either widen `ProcessSpawner.spawn` to accept the new fields, or have this adapter explicitly note the limitation in a logger warning when the dropped fields are non-undefined. The file comment ("This adapter will be removed once all tests migrate to mock AgentAdapters") acknowledges the technical debt, but as long as it lives, the silent drop is a typing pitfall.
- Fix: log a structured warning when dropped fields are present, or document the omission in the type signature:
  ```typescript
  spawn(opts: SpawnOptions): Result<{ process: ChildProcess; pid: number }> {
    if (opts.orchestratorId || opts.jsonSchema) {
      console.error(JSON.stringify({
        level: 'warn',
        msg: 'ProcessSpawnerAdapter dropping unsupported SpawnOptions fields',
        dropped: { orchestratorId: !!opts.orchestratorId, jsonSchema: !!opts.jsonSchema },
      }));
    }
    return this.spawner.spawn(opts.prompt, opts.workingDirectory, opts.taskId, opts.model);
  }
  ```

## Suggestions (Lower Confidence)

- **`refetchAfterAgentEval` returns `null` to signal stale state instead of using a Result/discriminated union** - `src/services/handlers/loop-handler.ts:324-365` (Confidence: 65%) — Three distinct null-return reasons (loop missing, loop not running, iteration not running) collapse to a single `null` at the call site. A typed `Result<{loop, iteration}, 'loop-missing' | 'loop-not-running' | 'iteration-not-running'>` would let the caller log/branch precisely and would catch any future "fourth reason" via exhaustive narrowing.
- **`event as TaskFailedEvent` cast pattern is a codebase-wide consistency issue** - `src/services/handlers/loop-handler.ts` (Confidence: 70%) — Both occurrences in this PR mirror the same anti-pattern; a one-line lint rule (`@typescript-eslint/consistent-type-assertions` with `assertionStyle: 'never'` for known discriminated unions, or a custom rule via `no-restricted-syntax`) would prevent the pattern from spreading.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | - |
| Should Fix | - | 0 | 3 | - |
| Pre-existing | - | - | 2 | 0 |

**TypeScript Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The diff is overwhelmingly an improvement to the type system: the `SpawnOptions` interface (fully `readonly`, optional fields with clear JSDoc, replaces 6 positional params), the new `Result<'acquired' | 'already-running', Error>` discriminated union, the `Pick<NodeJS.Process, 'on'>` DI typing for testability, the `EvalPromptBase` extraction, and the `LoopRowSchema` enum tightening that eliminated `data.eval_type as EvalType` casts in the loop repository all demonstrate strong TypeScript fluency. The exhaustiveness `never` guard in `composite-exit-condition-evaluator.ts` (now throwing on unhandled `evalType` rather than silently falling back) is exactly the pattern the typescript skill recommends.

The one HIGH finding (`event as TaskFailedEvent` casts on a discriminated union) is a small, mechanical fix that should land before merge — it's the only direct violation of the "Unknown over Any" / unchecked-assertion principles in this PR, and the same anti-pattern appears twice in the same file, indicating it would be worth a one-time correction now.
