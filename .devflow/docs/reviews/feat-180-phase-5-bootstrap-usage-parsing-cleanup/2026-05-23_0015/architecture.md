# Architecture Review Report

**Branch**: feat/180-phase-5-bootstrap-usage-parsing-cleanup -> main
**Date**: 2026-05-23

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

**WorkerPool.reuseSession mutates WorkerState task field without updating the object** - `src/implementations/event-driven-worker-pool.ts:312`
**Confidence**: 85%
- Problem: `reuseSession()` deletes the old `taskToWorker` mapping and adds the new one, but the `WorkerState` object referenced by `existingWorker` still carries the old `task` field (line 333 returns `ok(existingWorker)` with stale `.task` and `.taskId`). `WorkerState` extends the immutable `Worker` interface with `readonly` fields, yet the reuse logic relies on the `taskToWorker` map being updated to serve as the source of truth for task-to-worker association. The returned worker's `.taskId` diverges from the live map, which means any downstream code that reads `worker.taskId` from the return value (rather than the map) will see the previous iteration's task ID.
- Impact: Potential for stale task ID in event emissions or logging if any consumer of the `spawn()` return value uses `.taskId` directly. Currently the worker pool's own `handleWorkerCompletion` uses the `taskToWorker` map (correct path), but the caller (`WorkerHandler.spawnWorker`) may read the returned worker's `taskId`.
- Fix: Create a new WorkerState with the updated task reference when reusing, or update the fields in-place if mutability is intentional (and document the departure from immutability):
  ```typescript
  // Option A: create a new worker state with updated task
  const reusedWorker: WorkerState = { ...existingWorker, task, taskId: task.id };
  this.workers.set(workerId, reusedWorker);
  this.taskToWorker.delete(existingWorker.task.id);
  this.taskToWorker.set(task.id, workerId);
  return ok(reusedWorker);
  ```

### MEDIUM

**Interactive orchestrator duplicates tmux validation logic** - `src/cli/commands/orchestrate-interactive.ts:100-125`
**Confidence**: 82%
- Problem: `validateTmux()` in `orchestrate-interactive.ts` reimplements tmux version parsing and validation that already exists in `TmuxValidator` (used by bootstrap). The CLI path explicitly skips the bootstrap validator (CLI mode does not validate tmux eagerly), then re-implements it with slightly different code: `spawnSync('tmux', ['-V'])` vs the validator's `exec` abstraction, and manual regex parsing vs the validator's parse logic. This creates two sources of truth for tmux version validation, violating DRY and risking divergence.
- Impact: If the minimum tmux version changes or the version parsing needs fixing, two locations must be updated. The duplicated code lacks the DI-friendly `ExecFn` abstraction, making it untestable without mocking `child_process` at module level.
- Fix: Inject `TmuxValidator` or resolve it from the container and call `validate()` directly:
  ```typescript
  // Instead of custom validateTmux():
  const validator = new TmuxValidator({ exec: tmuxExec });
  const validationResult = validator.validate();
  if (!validationResult.ok) {
    ui.error(`tmux validation failed: ${validationResult.error.message}\n...`);
    process.exit(1);
  }
  ```
  The DECISION comment at line 97-99 justifies why validation happens at the call site (only CLI path needing tmux), but the implementation should reuse the existing validator, not rewrite it.

## Issues in Code You Touched (Should Fix)

### HIGH

(none)

### MEDIUM

**reuseSession error path returns err but does not fall through to fresh spawn** - `src/implementations/event-driven-worker-pool.ts:279,292,307`
**Confidence**: 83%
- Problem: The DESIGN DECISION comment at line 249-251 states: "On any failure, fall through to fresh spawn by destroying the stale session and removing it from persistentSessions." However, when `setEnvironment`, `sendKeys(/clear)`, or the worker-state-missing check fails, the method returns `err(...)` immediately -- it does NOT fall through to a fresh spawn. The caller (`spawn()`) receives the error and propagates it upward. This contradicts the documented design decision. The only case where a fallback to fresh spawn actually occurs is when the session is dead (lines 211-218 in `spawn()` -- the `isAlive` check before entering `reuseSession`).
- Impact: A transient tmux env-var or sendKeys failure will fail the entire iteration rather than gracefully falling back to a fresh session. This could cause a loop iteration to fail unnecessarily.
- Fix: Return a sentinel (e.g., `ok(null)`) from `reuseSession` on recoverable failures, and have `spawn()` check for it and proceed to `launchAndRegister`. Or restructure so `reuseSession` internally calls `launchAndRegister` as its fallback:
  ```typescript
  // In spawn(), after reuseSession returns err:
  const reuseResult = await this.reuseSession(task, psk, existing, prompt);
  if (reuseResult.ok) return reuseResult;
  // Fall through to fresh spawn (launchAndRegister below)
  this.logger.info('Persistent session reuse failed — spawning fresh', { ... });
  ```

## Pre-existing Issues (Not Blocking)

### MEDIUM

**OrchestrationManagerService cancel path has asymmetric event emission** - `src/services/orchestration-manager.ts:607-671`
**Confidence**: 80%
- Problem: For interactive mode cancels, the DB update (`updateIfStatus`) happens BEFORE `OrchestrationCancelled` is emitted at line 677. However, for standard mode cancels via `loopService.cancelLoop()`, the loop handler emits its own events, and then `OrchestrationCancelled` is emitted at line 677. The interactive path updates the DB directly, while the standard path delegates to the loop service. Both paths emit `OrchestrationCancelled` at the end (line 677), but only the interactive path also updates the orchestration status inline. This means if the `OrchestrationCancelled` emit fails for interactive mode, the DB is already updated but the event-driven subscribers (like `AttributedTaskCancellationHandler`) never fire.
- Impact: Attributed task cancel cascade may not fire for interactive orchestrations if the event emit fails. Low probability but architecturally inconsistent with the event-driven-first pattern.

### LOW

**`persistent` field on TmuxSpawnCoreConfig is declared but never set** - `src/core/tmux-types.ts:91`
**Confidence**: 82%
- Problem: The `persistent?: boolean` field on `TmuxSpawnCoreConfig` is documented as controlling "persistent session mode (Phase 5)" but no code path in this PR sets it to `true`. The `buildTmuxCommand()` in `BaseAgentAdapter` does not include a `persistent` property in the returned config object. This appears to be a forward declaration for a feature path that is not yet wired.
- Impact: Dead config field. Not harmful, but adds confusion about what triggers persistent vs. non-persistent behavior.

## Suggestions (Lower Confidence)

- **`cleanupPersistentSession` worker state leak** - `src/implementations/event-driven-worker-pool.ts:402-421` (Confidence: 70%) -- `cleanupPersistentSession` destroys the tmux session and removes from `persistentSessions`, but does not call `cleanupWorkerState()` for the associated worker. The worker's heartbeat timer, flush interval, and `workers` map entry may persist after the session is gone. Whether this is intentional (cleanup happens via onExit callback) should be documented.

- **300ms /clear settle delay is a magic constant** - `src/implementations/event-driven-worker-pool.ts:295` (Confidence: 65%) -- The 300ms delay after sending `/clear` in `reuseSession()` is an undocumented magic constant. If the agent is slow to process `/clear`, the new prompt may arrive before the context reset completes. A named constant with a DECISION comment would clarify the reasoning.

- **`tmuxExec` injection available but not used for interactive validation** - `src/cli/commands/orchestrate-interactive.ts:100` (Confidence: 65%) -- `orchestrate-interactive.ts` uses `spawnSync('tmux', ['-V'])` directly while `bootstrap.ts` uses an injectable `tmuxExec`. The interactive path is not unit-testable for tmux validation failures without module-level mocking.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | - |
| Should Fix | - | 0 | 1 | - |
| Pre-existing | - | - | 1 | 1 |

**Architecture Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The Phase 5 migration is architecturally sound overall: the tmux session reuse design (persistent session map, per-key concurrency guard, cleanup lifecycle) follows established patterns. The dead code removal (ProcessSpawner, InteractiveSpawnOptions, MockProcessSpawner) is clean and complete -- `avoids PF-002` (no migration path needed for unpublished internal interfaces). The DI boundaries are respected (TmuxConnectorPort, TmuxSessionManagerCorePort in core layer; implementations stay in implementations layer). The cancel path backward compatibility (sessionName-first, pid-fallback) is well-reasoned.

The blocking HIGH is the stale `WorkerState` returned from `reuseSession()` -- the returned worker carries the previous iteration's task ID while the internal maps have been updated. This creates an inconsistency that should be resolved before merge. The design decision comment about error fallback to fresh spawn (MEDIUM Should Fix) does not match the actual control flow, which returns errors immediately rather than falling through.
