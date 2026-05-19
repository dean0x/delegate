# Complexity Review Report

**Branch**: feat/178-worker-pool-rewiring -> main
**Date**: 2026-05-19

## Issues in Your Changes (BLOCKING)

### HIGH

**`launchAndRegister()` has 6 parameters** - `event-driven-worker-pool.ts:157-163`
**Confidence**: 85%
- Problem: The extracted helper `launchAndRegister(task, config, prompt, callbacks, agentProvider, cleanupFn)` takes 6 parameters, exceeding the 5-parameter threshold. The `config: unknown` type further erodes readability since the reader cannot infer what shape the config takes.
- Fix: Bundle the parameters into a single options object. This also gives each field a name at the call site, which aids comprehension:
  ```typescript
  interface LaunchParams {
    task: Task;
    config: unknown;
    prompt: string;
    callbacks: SpawnCallbacks;
    agentProvider: string;
    cleanupFn: ((taskId: string) => void) | undefined;
  }
  private launchAndRegister(params: LaunchParams): Result<Worker> { ... }
  ```

**`launchAndRegister()` is 66 lines with rollback duplication** - `event-driven-worker-pool.ts:157-222`
**Confidence**: 82%
- Problem: The method handles session spawn, worker registration, timer setup, flushing, prompt delivery, and two rollback paths (post-registration failure and post-sendKeys failure). Each rollback path repeats the `tmuxConnector.destroy()` + warning log pattern (lines 176-182 and 199-205). At 66 lines the function exceeds the 50-line warning threshold.
- Fix: Extract a small `destroySessionWithWarning(handle, context)` helper to deduplicate the rollback pattern:
  ```typescript
  private destroySessionWithWarning(handle: TmuxHandle, context: string): void {
    const destroyResult = this.tmuxConnector.destroy(handle);
    if (!destroyResult.ok) {
      this.logger.warn(`Failed to destroy session after ${context}`, {
        sessionName: handle.sessionName,
        destroyError: destroyResult.error.message,
      });
    }
  }
  ```
  This would reduce `launchAndRegister` by roughly 10 lines and remove the duplicated destroy-and-warn blocks.

### MEDIUM

**`onExit` callback has 3 levels of nesting** - `event-driven-worker-pool.ts:379-405`
**Confidence**: 82%
- Problem: The `onExit` callback in `createCallbacks()` contains nested `if (workerId) { if (worker) { if (worker.heartbeatTimer) { ... } } }` at 3 levels of nesting (lines 388-396). While each guard is individually simple, the combined nesting makes the pre-flush cleanup harder to trace visually.
- Fix: Use early return pattern. Since the timer cleanup is defense-in-depth (completionHandled is the canonical gate), extract it into a named private method:
  ```typescript
  private stopTimersForTaskId(taskId: TaskId): void {
    const workerId = this.taskToWorker.get(taskId);
    if (!workerId) return;
    const worker = this.workers.get(workerId);
    if (!worker) return;
    this.stopFlushing(worker);
    if (worker.heartbeatTimer) {
      clearInterval(worker.heartbeatTimer);
      worker.heartbeatTimer = undefined;
    }
  }
  ```

**`spawn()` is 59 lines with sequential early returns** - `event-driven-worker-pool.ts:93-151`
**Confidence**: 80%
- Problem: `spawn()` at 59 lines exceeds the 50-line threshold. It performs 5 sequential validation/setup steps before delegating to `launchAndRegister()`. Each step is individually clear, but the combined length pushes beyond the "explain in 5 minutes" threshold when combined with the delegation to `launchAndRegister()`. The total spawn flow (spawn + launchAndRegister) is 125 lines.
- Fix: This is partially addressed by the extraction of `launchAndRegister()`. The remaining 59 lines are primarily guard clauses with early returns, which is a clean pattern. Consider whether the `buildTmuxCommand` step (lines 127-141) could be inlined into `launchAndRegister()` to move all tmux-specific logic into one place, reducing `spawn()` to a pure validation method.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`bootstrap()` function is 540 lines** - `bootstrap.ts:183-722`
**Confidence**: 85%
- Problem: The `bootstrap()` function is already the longest function in the codebase at ~540 lines. This PR adds 55 more lines (the tmux wiring block at lines 504-559). While each individual block is well-commented and the function is procedural setup code (low cyclomatic complexity), the sheer length makes it hard to navigate and understand as a whole.
- Fix: This is a pre-existing issue amplified by the PR. The tmux wiring block is well-sectioned with comments and could be extracted into a helper like `registerTmuxConnector(container, options, logger)` if bootstrap length becomes a maintainability concern. Not blocking since bootstrap is procedural and each section is independent.

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **`handleWorkerCompletion()` is 54 lines** - `event-driven-worker-pool.ts:620-673` (Confidence: 70%) -- The method handles guard checks, double-completion guard, duration calculation, cleanup, and fire-and-forget event emission. Most of the length comes from well-documented DECISION comments (lines 648-652) which aid maintainability. The cyclomatic complexity is low (2 branches: exitCode 0 vs non-0). Borderline on the 50-line threshold but justified by the documentation density.

- **`recovery-manager.ts` `handleDeadWorker()` duplicates log context patterns** - `recovery-manager.ts:217-281` (Confidence: 65%) -- The extracted `handleDeadWorker()` method is clean (65 lines), but the log context objects (`{ workerId, taskId, ownerPid, sessionName }`) are repeated across multiple log calls. A shared context variable would reduce repetition, but the current form is readable.

- **`cleanupWorkerState()` clears timers that may already be cleared by callers** - `event-driven-worker-pool.ts:519-528` (Confidence: 62%) -- The method clears heartbeatTimer, timeoutTimer, and flushInterval, but callers like `kill()` already clear timeout and flushing before calling cleanup, and `onExit` clears heartbeat and flushing. The idempotency guard at line 517 makes this safe, and the redundant clearing is intentional defense-in-depth, but it does mean readers must mentally track which timers are already cleared by each caller.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Complexity Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The extraction of `launchAndRegister()` and `gracefulShutdownSession()` from `spawn()` and `kill()` respectively is a clear improvement over the pre-existing monolithic methods. The `createCallbacks()`, `startFlushing()`, `stopFlushing()`, and `flushOutput()` helpers are well-factored and focused. The main complexity concerns are:

1. `launchAndRegister()` takes 6 parameters (bundle into an options object)
2. Rollback destroy-and-warn logic is duplicated twice (extract a small helper)
3. `onExit` callback nesting could be flattened with a private helper

None of these are architecturally concerning -- they are refinements to already-reasonable code. The overall decomposition of the 711-line `EventDrivenWorkerPool` into 16 focused private methods with clear section headers is well-structured. The `RecoveryManager` refactoring (extracting `handleDeadWorker()` and `isWorkerAlive()`) is a clean simplification that reduces nesting in `cleanDeadWorkerRegistrations()`.
