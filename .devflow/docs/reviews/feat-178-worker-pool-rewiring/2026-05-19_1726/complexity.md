# Complexity Review Report

**Branch**: feat/178-worker-pool-rewiring -> main
**Date**: 2026-05-19

## Issues in Your Changes (BLOCKING)

### HIGH

**`spawn()` method exceeds function length threshold (114 lines)** - `src/implementations/event-driven-worker-pool.ts:92`
**Confidence**: 85%
- Problem: The `spawn()` method at lines 92-205 is 114 lines long, well above the 50-line critical threshold. It contains 10 sequential steps with error handling and rollback logic at multiple points. While each step is well-commented with "Step N" labels, the sheer length makes the function hard to reason about as a unit.
- Fix: Extract rollback-heavy steps 6-10 into a private helper (e.g., `spawnSession()` or `launchAndRegister()`), similar to how `TmuxConnector` extracted `createAndRegisterSession()` from its own `spawn()` to keep it under 50 lines. The first 5 steps (guard, resource check, resolve adapter, build config, create callbacks) could remain in `spawn()`, and the remaining steps (tmux spawn, register, setup timeout/heartbeat/flushing, send prompt) move to the helper.

```typescript
// Example extraction — spawn() becomes:
async spawn(task: Task): Promise<Result<Worker>> {
  // Steps 1-5: guard, resource, adapter, config, callbacks (unchanged)
  ...
  // Step 6+: extracted
  return this.launchAndRegister(task, config, prompt, callbacks, adapter);
}

private async launchAndRegister(
  task: Task, config: TmuxSpawnConfig, prompt: string,
  callbacks: SpawnCallbacks, adapter: AgentAdapter,
): Promise<Result<Worker>> {
  // Steps 6-10 with rollback logic
  ...
}
```

---

**`kill()` method exceeds function length threshold (79 lines)** - `src/implementations/event-driven-worker-pool.ts:207`
**Confidence**: 82%
- Problem: The `kill()` method at lines 207-285 is 79 lines with a 6-step internal flow (clear timeout, check alive, send Ctrl-C, poll loop, force-destroy, cleanup). The polling loop (step 4, lines 245-260) with its 250ms intervals and 20-iteration bound is well-bounded but adds to cyclomatic complexity. Nesting reaches 4 levels inside the try block.
- Fix: Extract the graceful-kill sequence (steps 2-5: check alive, send Ctrl-C, poll, force-destroy) into a private helper like `gracefulShutdown(worker)`. This separates the "how to kill a tmux session" concern from the "how to coordinate kill lifecycle" concern.

```typescript
async kill(workerId: WorkerId): Promise<Result<void>> {
  const worker = this.workers.get(workerId);
  if (!worker) return err(...);
  try {
    this.clearTimeoutForWorker(worker);
    this.stopFlushing(worker);
    await this.flushOutput(worker.taskId);
    await this.gracefulShutdownSession(worker);
    this.cleanupWorkerState(workerId, worker.taskId);
    return ok(undefined);
  } catch (error) {
    return err(...);
  }
}

private async gracefulShutdownSession(worker: WorkerState): Promise<void> {
  // Steps 2-5: isAlive check, C-c, poll, force-destroy
}
```

### MEDIUM

**Duplicated tmux/PID liveness branching pattern (2 occurrences)** - `src/services/recovery-manager.ts:171-176`, `src/services/recovery-manager.ts:427-432`
**Confidence**: 88%
- Problem: The exact same nested ternary pattern appears in both `cleanDeadWorkerRegistrations()` (line 172-176) and `recoverRunningTasks()` (line 428-432):
  ```typescript
  const isAlive = isTmuxWorker
    ? reg.sessionName
      ? this.isTmuxSessionAlive(reg.sessionName)
      : false
    : this.isProcessAlive(reg.ownerPid);
  ```
  This is a nested ternary with three branches, duplicated across two methods. The duplication increases the risk of divergence if the liveness logic changes (e.g., adding a new worker type).
- Fix: Extract into a single private method that accepts a `WorkerRegistration` and returns a boolean:

```typescript
/**
 * Determine if a worker is still alive, dispatching to the correct liveness check
 * based on worker type (tmux vs process-based).
 */
private isWorkerAlive(reg: WorkerRegistration): boolean {
  if (reg.pid === 0) {
    // Tmux worker: check session liveness by name
    return reg.sessionName ? this.isTmuxSessionAlive(reg.sessionName) : false;
  }
  return this.isProcessAlive(reg.ownerPid);
}
```

---

**`cleanDeadWorkerRegistrations()` exceeds function length threshold (94 lines)** - `src/services/recovery-manager.ts:164`
**Confidence**: 83%
- Problem: This method at lines 164-257 is 94 lines with 4 levels of nesting (for loop > if dead > if update ok > if emit ok). The method handles: finding all workers, checking liveness, unregistering, looking up task status, updating task to FAILED, emitting TaskFailed, and logging stale heartbeats. This is a lot of responsibility for one method. Most of the nesting depth comes from the "dead worker" branch that performs multiple sequential operations with error handling.
- Fix: Extract the dead-worker handling into a helper method:

```typescript
private async handleDeadWorker(reg: WorkerRegistration, isTmuxWorker: boolean): Promise<void> {
  // Unregister, check terminal, update to FAILED, emit TaskFailed
}
```

This would reduce `cleanDeadWorkerRegistrations()` to roughly 30 lines: iterate workers, check liveness, dispatch to `handleDeadWorker()` or log stale heartbeat.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`bootstrap()` function is 541 lines** - `src/bootstrap.ts:183`
**Confidence**: 90%
- Problem: The `bootstrap()` function spans lines 183-723 (541 lines). This PR added ~30 lines of tmux wiring (lines 504-559), but the function was already far above the critical threshold. The function handles: config loading, logger setup, config validation, event bus creation, database creation, 11 repository registrations, 4 service registrations, proxy setup, agent registry, resource monitor, output capture, tmux wiring, worker pool, handler setup, sanity checks, task manager, MCP adapter, recovery manager, recovery execution, and schedule executor. This is the single largest function in the codebase.
- Fix: While a full refactor of `bootstrap()` is out of scope for this PR, consider extracting the new tmux wiring block (lines 504-559) into a named helper like `registerTmuxInfrastructure()`. This would both reduce the function length and create a clear boundary for the new subsystem. The existing repository registrations (lines 286-354) could similarly be extracted in a future pass.

## Pre-existing Issues (Not Blocking)

### HIGH

**`tmux-connector.ts` file length: 897 lines** - `src/implementations/tmux/tmux-connector.ts`
**Confidence**: 92%
- Problem: This file is 897 lines. While the class itself is well-decomposed into small focused methods, the overall file length makes navigation difficult. The class manages: session lifecycle, fs.watch watchers, sentinel handling, message file handling with sequence ordering, debouncing, staleness detection via shared timer, pending message delivery with gap-filling and force-drain, and cleanup. These are logically distinct concerns packed into one class.
- Fix: In a future PR, consider extracting the message delivery pipeline (pending messages, sequence ordering, gap-filling, force-deliver) into a separate `MessageDeliveryPipeline` class. This would reduce the connector to ~500 lines focused on session lifecycle and event coordination.

### MEDIUM

**`recoverRunningTasks()` is 81 lines with duplicated recovery pattern** - `src/services/recovery-manager.ts:414`
**Confidence**: 80%
- Problem: This method shares a nearly identical "update task to FAILED + emit TaskFailed" pattern with `cleanDeadWorkerRegistrations()`. Both methods perform: `taskRepo.update()` with FAILED status, log the result, then `eventBus.emit('TaskFailed')` with error handling. This recovery pattern is repeated 3 times across the two methods.
- Fix: Extract a `failTaskWithEvent(taskId, errorMessage)` helper to encapsulate the update-and-emit pattern, reducing duplication and the risk of inconsistent error handling.

## Suggestions (Lower Confidence)

- **Nested ternary readability** - `src/services/recovery-manager.ts:172` (Confidence: 70%) -- The triple-nested ternary `isTmuxWorker ? reg.sessionName ? ... : false : ...` is compact but requires careful reading. An `if/else if/else` chain or the suggested `isWorkerAlive()` extraction would be clearer, though the current form is defensible given its well-placed comments.

- **`handleMessageFile()` mixed concerns** - `src/implementations/tmux/tmux-connector.ts:710` (Confidence: 65%) -- At 53 lines, this method handles file reading, JSON parsing, type validation, pending message buffering, ordered delivery, and gap-skip with force-drain. The gap-skip logic (lines 744-761) is its own mini-algorithm. Could benefit from extracting the gap-skip block into a named method.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 1 | 1 | 0 |

**Complexity Score**: 6/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The PR introduces substantial new code (EventDrivenWorkerPool rewrite, TmuxConnector, RecoveryManager extensions) with generally good decomposition -- methods have clear responsibility boundaries, loops are explicitly bounded, and design decisions are well-documented. The main complexity concerns are: (1) two methods in the worker pool exceed the 50-line threshold with high cyclomatic complexity, and (2) a duplicated liveness-check pattern in RecoveryManager that should be extracted to prevent divergence. The TmuxConnector file (897 lines, pre-existing) is large but well-structured internally. The `bootstrap()` function (541 lines, pre-existing with additions) remains the most significant complexity debt in the codebase but is not blocking for this PR.

Conditions for approval:
1. Extract the duplicated tmux/PID liveness branching into a single `isWorkerAlive()` method in RecoveryManager
2. Consider extracting `spawn()` rollback steps and `kill()` graceful-shutdown sequence into helpers to bring both under 80 lines (recommended but not strictly blocking)
