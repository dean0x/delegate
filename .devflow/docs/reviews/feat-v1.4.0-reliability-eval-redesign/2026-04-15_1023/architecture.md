# Architecture Review Report

**Branch**: feat/v1.4.0-reliability-eval-redesign -> main
**Base SHA**: 33abbb78c6c566480ef474d5b98d20087051a929
**PR**: #136
**Date**: 2026-04-15

## Scope

7-commit tech debt cleanup focused on:
- `refetchAfterAgentEval` and `handleStopDecision` extraction in `LoopHandler`
- `buildEvalPromptBase` shared utility for 3 evaluator implementations
- Pure-function refactor of `schedule-executor` with DI (`acquirePidFile`, `checkActiveSchedules`, `registerSignalHandlers`, `startIdleCheckLoop`)
- `SpawnOptions` object replaces 6 positional `spawn()` params on `AgentAdapter`

Pattern skill `devflow:architecture` loaded; pitfalls cross-checked against `.memory/knowledge/pitfalls.md` (PF-001 through PF-005).

---

## Issues in Your Changes (BLOCKING)

### CRITICAL

None.

### HIGH

**Leaky `ProcessSpawnerAdapter` silently drops `orchestratorId` and `jsonSchema`** — `src/implementations/process-spawner-adapter.ts:26-28`
**Confidence**: 92%
- Problem: The new `SpawnOptions` interface defines six fields (`prompt`, `workingDirectory`, `taskId`, `model`, `orchestratorId`, `jsonSchema`). `ProcessSpawnerAdapter.spawn()` destructures only four and forwards them to `ProcessSpawner.spawn(prompt, workingDirectory, taskId, model)` — the underlying `ProcessSpawner` interface in `src/core/interfaces.ts:60-66` was NOT updated to accept `orchestratorId` or `jsonSchema`. Any production code path (or test) that injects a `ProcessSpawner` will silently lose orchestrator attribution (v1.3.0) and structured-output JSON schemas (v1.4.0). The previous positional-args API had the same drop, but it was visible at the type level (the parameters didn't exist on the function). The new options-object API hides the loss because the destructure statement is the only place the dropped fields are visible.
- Architectural impact: This violates the Liskov Substitution Principle [3] — `ProcessSpawnerAdapter` claims to implement `AgentAdapter` but cannot honour the full contract. It is a "subtype that strengthens preconditions" by silently ignoring valid options. The pattern skill iron law: "subtype cannot strengthen preconditions. Throwing where parent doesn't throw is a violation" — silently dropping is arguably worse than throwing because the failure is invisible.
- Fix:
  ```typescript
  // Option A (preferred): widen ProcessSpawner interface to accept SpawnOptions
  export interface ProcessSpawner {
    spawn(options: SpawnOptions): Result<{ process: ChildProcess; pid: number }>;
    kill(pid: number): Result<void>;
  }
  // Then ProcessSpawnerAdapter is trivially: spawn(o) { return this.spawner.spawn(o); }

  // Option B: at minimum, log a warn and document the limitation
  spawn(options: SpawnOptions): Result<{ process: ChildProcess; pid: number }> {
    if (options.orchestratorId || options.jsonSchema) {
      this.logger.warn('ProcessSpawnerAdapter: dropping unsupported options', {
        orchestratorId: !!options.orchestratorId,
        jsonSchema: !!options.jsonSchema,
      });
    }
    return this.spawner.spawn(options.prompt, options.workingDirectory, options.taskId, options.model);
  }
  ```
  Note that the file's docstring already calls itself "compatibility adapter… will be removed once all tests migrate to mock AgentAdapters." Until removed, it should faithfully implement the interface or fail loudly. Option A is the right long-term fix.

### MEDIUM

**`finishLoop` is called with stale `loop` reference after transactional status update** — `src/services/handlers/loop-handler.ts:1281`
**Confidence**: 80%
- Problem: Inside `handleStopDecision`, the transaction at lines 1261-1274 calls `updateLoop(loop, { status: COMPLETED, completedAt: ... })` and persists it via `updateSync`, but the local `loop` variable is never reassigned. The next line passes the original `loop` (still has `status: RUNNING` and the pre-update `completedAt`) to `finishLoop`. `finishLoop` reads `loop.id` and `loop.currentIteration` and `loop.bestScore` for logging — none of these are mutated by the transaction, so the `Loop completed` log is correct. However the pattern silently relies on "the fields finishLoop reads happen to be unchanged." A future change to `finishLoop` that reads `loop.status` or `loop.completedAt` would observe stale values.
- Architectural impact: Mild Tell-Don't-Ask violation [17]. Caller has the source-of-truth `updatedLoop` after the transaction but discards it. Readers must mentally trace through the transaction body to confirm `loop` is safe to pass forward.
- Fix: Capture the updated loop and pass the post-transaction value:
  ```typescript
  const updatedLoop = updateLoop(loop, { status: LoopStatus.COMPLETED, completedAt: Date.now() });
  const txResult = this.database.runInTransaction(() => {
    this.loopRepo.updateIterationSync({ ...iteration, status: iterationStatus, ... });
    this.loopRepo.updateSync(updatedLoop);
  });
  if (!txResult.ok) { ... }
  await this.finishLoop(updatedLoop, LoopStatus.COMPLETED, 'Eval decision: stop');
  ```
  This mirrors the pattern already used in `handleRetryResult` line 882-913 (`updatedLoop` captured before the tx). Consistency bonus: same pattern should apply across all `finishLoop` callers.

**`registerSignalHandlers` injects `process` but `exitCleanly` still calls global `process.exit()` and `process.stderr`** — `src/cli/commands/schedule-executor.ts:171-179`
**Confidence**: 88%
- Problem: The function takes `proc: Pick<NodeJS.Process, 'on'>` for testability — but the closure inside `exitCleanly` calls `process.stderr.write(...)` and `process.exit(0)` against the real global `process`, not the injected one. The injected fake captures handler registration only; the side-effects of triggering a handler still hit the real process. Tests in `schedule-executor-pure-fns.test.ts:185-200` work around this by checking call order on a separate `process.exit` spy, but the asymmetry is a leaky abstraction [9] — half the dependency is injected, half is global.
- Architectural impact: Inconsistent DI [18]. The pattern violates the global engineering principle in CLAUDE.md: "Inject dependencies — Makes testing trivial" / "If dependency injection is used, apply it consistently throughout."
- Fix: Take both `on` and `exit`/`stderr` (or take the entire `process`) and use them throughout:
  ```typescript
  export function registerSignalHandlers(
    cleanup: () => void,
    proc: Pick<NodeJS.Process, 'on' | 'exit' | 'stderr'> = process,
  ): void {
    const exitCleanly = (signal: string): void => {
      proc.stderr.write(`Schedule executor: received ${signal}, shutting down\n`);
      cleanup();
      proc.exit(0);
    };
    proc.on('SIGTERM', () => exitCleanly('SIGTERM'));
    proc.on('SIGINT', () => exitCleanly('SIGINT'));
  }
  ```

**`startIdleCheckLoop` swallows repo errors silently** — `src/cli/commands/schedule-executor.ts:195-203`
**Confidence**: 82%
- Problem: When `checkActiveSchedules` returns `err`, the comment says "On error: stay alive (conservative) — do nothing", but "do nothing" includes "do not log." Operators get no signal that the executor is wedged on repo errors. The injected `warn` callback is right there.
- Architectural impact: Violates the global engineering principle "Structured logging — JSON logs with context" — silent error paths defeat observability. Also inconsistent with the surrounding code which logs every other failure mode through `process.stderr.write`.
- Fix:
  ```typescript
  return setInterval(async () => {
    const hasActiveResult = await checkActiveSchedules(scheduleRepo);
    if (!hasActiveResult.ok) {
      warn(`Schedule executor: idle check failed (staying alive): ${hasActiveResult.error.message}`);
      return;
    }
    if (!hasActiveResult.value) {
      warn('Schedule executor: no active schedules — exiting');
      onIdle();
    }
  }, intervalMs);
  ```

---

## Issues in Code You Touched (Should Fix)

**`buildEvalPromptBase` couples evaluators to `LoopRepository` for a single field** — `src/services/eval-prompt-builder.ts:45-69`
**Confidence**: 78% → reported as Suggestion (below threshold for Should-Fix; see Suggestions)

**`ProcessSpawner` interface drift from `AgentAdapter`** — `src/core/interfaces.ts:60-66`
**Confidence**: 85%
- Problem: After the `SpawnOptions` refactor, the `AgentAdapter.spawn()` and `ProcessSpawner.spawn()` interfaces have diverged in shape. `AgentAdapter` is the strategy [2] used in production; `ProcessSpawner` is the test-injection seam (per `process-spawner-adapter.ts` docstring). Two parallel "spawn a thing" abstractions with different signatures is a smell — `ProcessSpawner` is now a strict subset of `AgentAdapter`, so the question is why both exist.
- Architectural impact: Same as the HIGH finding above — this is the root cause of the leaky `ProcessSpawnerAdapter`. Unifying them removes the adapter entirely.
- Fix: Either widen `ProcessSpawner.spawn()` to accept `SpawnOptions`, or delete `ProcessSpawner` and have tests inject `AgentAdapter` directly (the file docstring already says this is the planned trajectory).

**`refetchAfterAgentEval` re-emits identical "loop no longer running" log message four times with different `staleStatus` values** — `src/services/handlers/loop-handler.ts:331-364`
**Confidence**: 81%
- Problem: The helper has four return-null branches, all of which emit a `logger.info` with one of two message strings ("Loop no longer running after eval, skipping result processing" twice, "Iteration no longer running after eval, skipping result processing" twice). Splitting on whether the result was `!ok` vs `value === null` vs `status not in (RUNNING, PAUSED)` means the same message has different semantics depending on context. Operators searching logs see "Loop no longer running" and can't tell whether it's a DB error, a missing row, or a normal cancelled state.
- Architectural impact: Information hiding violation [9] — the log message hides a meaningful distinction that the helper has full visibility into.
- Fix: Use distinct messages per branch:
  ```typescript
  // Branch 1: repo error
  this.logger.warn('Failed to fetch loop after eval', { loopId: loop.id, error: ... });
  // Branch 2: loop deleted
  this.logger.info('Loop deleted during eval, dropping result', { loopId: loop.id });
  // Branch 3: loop not running
  this.logger.info('Loop transitioned out of RUNNING/PAUSED during eval', { loopId, status });
  // Branches 4/5: iteration variants — same pattern
  ```

---

## Pre-existing Issues (Not Blocking)

**`LoopHandler` is approaching God-class territory (~1700 lines, 30+ private methods)** — `src/services/handlers/loop-handler.ts`
**Confidence**: 90%
- Already covered by extensive `ARCHITECTURE:` and `DECISION:` JSDoc throughout. The recent extractions (`refetchAfterAgentEval`, `handleStopDecision`, `finishLoop`, `recordAndContinue`, `commitAndCaptureDiff`) are correctly heading the opposite direction — pulling shared concerns into named helpers. Continuing the trend, the next natural splits would be `LoopGitStateManager` (setupGitForIteration, handleIterationGitOutcome, commitAndCaptureDiff, getResetTargetSha, resetIterationGitState) and `LoopRecoveryService` (rebuildMaps, recoverStuckLoops, recoverSingleLoop). Not a regression — current PR improves the situation.

**Database migration list growing unbounded inside `getMigrations()`** — `src/implementations/database.ts:262-...`
**Confidence**: 75%
- The single function returns 21+ migration objects in one literal. Each migration is a closure over raw SQL. Pre-existing pattern, not introduced or worsened by this PR.

---

## Suggestions (Lower Confidence)

- **`buildEvalPromptBase` couples evaluators to `LoopRepository` for one field** - `src/services/eval-prompt-builder.ts:45-54` (Confidence: 78%) — The function takes the full repo just to call `findIterationByTaskId(taskId)`. A narrower port (`interface PreIterationShaSource { findPreIterationCommitSha(taskId): Promise<string | null> }`) would let evaluators be tested without a full mock repo and would document the dependency at the type level. Today, three evaluators each take `LoopRepository` solely to feed it into this helper.

- **`acquirePidFile` retry loop hides a second TOCTOU window** - `src/cli/commands/schedule-executor.ts:101-109` (Confidence: 70%) — The docstring already acknowledges this ("Residual TOCTOU: After unlinking a stale PID and before re-opening, a concurrent racing process could create the file. Accepted"). A flock-based primitive would close the window, but the pragmatic decision to accept it is reasonable for the stated scenario (3+ racing executors). Worth revisiting only if multi-host scheduler is on the roadmap.

- **`SpawnOptions.taskId` typed as `string` rather than `TaskId` brand** - `src/core/agents.ts:255` (Confidence: 65%) — The codebase uses branded `TaskId` for type-safe identifier handling, but `SpawnOptions.taskId?: string` opts out. `EventDrivenWorkerPool.spawn` passes `task.id` (a `TaskId` brand) which structurally widens to string. The convention would be `taskId?: TaskId`. Same applies to `orchestratorId`. Low-impact but inconsistent with the rest of the type system.

---

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 3 | - |
| Should Fix | - | 2 | 0 | - |
| Pre-existing | - | - | 2 | 0 |

**Architecture Score**: 8/10

This is a high-quality refactor PR. Every extraction has a clear single responsibility, helpers are named and JSDoc'd with explicit `DECISION:` tags explaining trade-offs, the factory pattern in `LoopHandler.create()` is properly preserved, and the new pure functions in `schedule-executor` are straightforward to test. The `IterationResultFields` type extraction (loop-handler.ts:64-74) is exemplary information hiding. The `handleStopDecision` extraction correctly identifies the 25-line duplication and consolidates it without altering semantics.

The main architectural concerns are concentrated around the `SpawnOptions` migration: the new options object is a real improvement for `AgentAdapter`, but the parallel `ProcessSpawner` interface was left behind, creating a leaky compatibility adapter that silently drops `orchestratorId` and `jsonSchema`. This is the only finding that has user-visible impact (lost orchestrator attribution under any test path that injects a `ProcessSpawner`), and it should be fixed before merge — preferably by deleting `ProcessSpawner` outright per the `process-spawner-adapter.ts` docstring, otherwise by widening it to accept `SpawnOptions`.

The `LoopHandler` extractions are well-aimed but a couple of them have minor consistency follow-ups (`finishLoop` called with stale loop reference; `refetchAfterAgentEval` log noise). These are MEDIUM and won't break anything in practice.

Pitfalls cross-check: the new `LoopRowSchema` correctly tightens `eval_type` and `judge_agent` to Zod enums (consistent with PF-005 resolution). No prepared statements added per-call (PF-004 clean). Nothing in the diff touches the dashboard polling path (PF-001/PF-003 N/A). No multi-byte string slicing (PF-002 N/A).

**Recommendation**: CHANGES_REQUESTED

Block on the HIGH `ProcessSpawnerAdapter` finding — silently dropping `orchestratorId` is a real behavioural regression for v1.3.0 attribution under the test injection path. The other findings are MEDIUM and can be addressed in a follow-up if the `ProcessSpawner` deletion is staged.
