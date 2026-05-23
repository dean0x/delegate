# Reliability Review Report

**Branch**: feat/180-phase-5-bootstrap-usage-parsing-cleanup -> main
**Date**: 2026-05-23

## Issues in Your Changes (BLOCKING)

### HIGH

**Stale onExit callback closure in persistent session reuse -- crash during 2nd+ iteration loses completion event** - `src/implementations/event-driven-worker-pool.ts:188,252-336`
**Confidence**: 92%
- Problem: `createCallbacks(task.id)` at line 188 creates an `onExit` closure bound to the **initial** iteration's `taskId`. When `reuseSession()` is called for subsequent iterations, it updates `taskToWorker` (deletes old taskId, inserts new taskId) but does NOT replace the `onExit` callback registered with the TmuxConnector. If the agent crashes or the tmux session dies during the 2nd or later iteration, the connector fires `onExit` with the original (stale) taskId. `handleWorkerCompletion` then calls `this.taskToWorker.get(staleTaskId)` which returns `undefined`, logs "Worker completion for unknown task", and **does not emit TaskCompleted/TaskFailed**. The LoopHandler never receives the terminal event for the current iteration's task, causing the loop to stall in RUNNING indefinitely.
- Impact: A persistent session crash during any non-first iteration silently orphans the loop. The loop never advances and never terminates. Only manual cancellation recovers it. This violates the bounded-iteration reliability principle -- the loop effectively becomes unbounded because its termination signal is lost.
- Fix: Either (a) update the TmuxConnector's stored callbacks during `reuseSession` so `onExit` always fires with the current taskId, or (b) maintain a mutable "current taskId" reference in the WorkerState that the onExit closure reads indirectly rather than capturing a fixed value:

```typescript
// Option (b): Use a mutable ref object instead of a direct closure
interface TaskIdRef { current: TaskId }

private createCallbacks(taskIdRef: TaskIdRef): SpawnCallbacks {
  return {
    onOutput: (msg: OutputMessage) => {
      const captureResult = this.outputCapture.capture(taskIdRef.current, ...);
      // ...
    },
    onExit: (code: number | null, _signal?: string) => {
      const taskId = taskIdRef.current;
      // ... existing logic using taskId ...
    },
  };
}
```

Then in `reuseSession`, update `taskIdRef.current = task.id`. This keeps the closure alive but points it at the current iteration's taskId.

**WorkerState.task remains stale after reuseSession -- worker references wrong task** - `src/implementations/event-driven-worker-pool.ts:312-313,333`
**Confidence**: 88%
- Problem: `reuseSession` updates `taskToWorker` mapping but returns `existingWorker` (line 333) whose `task` field still references the **previous** iteration's Task object (`readonly task: Task` at line 58). The caller (LoopHandler/WorkerHandler) receives a Worker whose `taskId` matches the old iteration, not the new one. This also means `cleanupWorkerState(workerId, taskId)` called later may use the wrong taskId for DB unregistration and event emission.
- Impact: Stale `worker.taskId` causes incorrect task attribution in completion events, output flushing, and DB cleanup. The scope of impact is limited because LoopHandler tracks tasks independently via `taskToLoop`, but the inconsistency could surface as orphaned output or double-decrement of the monitor count.
- Fix: Create a new WorkerState object with the updated task reference during reuse:

```typescript
const updatedWorker: WorkerState = {
  ...existingWorker,
  task,
  completionHandled: false,  // Reset for new iteration
};
this.workers.set(workerId, updatedWorker);
```

### MEDIUM

**No upper bound on SIGINT count in interactive orchestrator** - `src/cli/commands/orchestrate-interactive.ts:296-306`
**Confidence**: 82%
- Problem: The SIGINT handler increments `sigintCount` without bound. After `sigintCount >= 2`, every subsequent Ctrl+C calls `tmuxConnector.destroy(handle)` again. While `destroy()` is documented as idempotent, repeated synchronous `spawnSync` calls (`tmux kill-session`) on every keypress wastes resources and could produce confusing error output.
- Impact: Low practical impact since users rarely press Ctrl+C many times, but it violates bounded-operation principles. Each destroy call involves a `spawnSync` which blocks the event loop.
- Fix: Guard the destroy call with a one-shot flag:

```typescript
let forceDestroyed = false;
process.on('SIGINT', () => {
  sigintCount++;
  cancelled = true;
  if (sigintCount >= 2 && !forceDestroyed) {
    forceDestroyed = true;
    tmuxConnector.destroy(handle);
  } else if (sigintCount === 1) {
    tmuxConnector.sendControlKeys(handle, 'C-c');
  }
});
```

**Polling loop in onExit wait has no defensive upper bound on poll interval** - `src/cli/commands/orchestrate-interactive.ts:344-359`
**Confidence**: 80%
- Problem: The `setInterval` poll at 50ms with a 2000ms deadline is bounded, which is good. However, the `poll` variable declaration uses `let` before the `setInterval` assignment, and `deadline` is declared with `setTimeout`. If `setInterval` throws (extremely unlikely in Node.js, but theoretically possible in constrained environments), `poll` is undefined and `clearInterval(poll)` in the deadline handler is a no-op. The pattern is correct but could be more defensive.
- Impact: Negligible in practice. The 2-second deadline ensures the code never blocks indefinitely regardless.
- Fix: No change required -- the 2-second deadline provides the necessary bound. This is informational.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**TmuxConnector.spawn calls validator.validate() on every spawn** - `src/implementations/tmux/tmux-connector.ts:169`
**Confidence**: 83%
- Problem: Each `spawn()` call validates tmux availability (step 1: `this.deps.validator.validate()`). This is a synchronous `spawnSync('tmux', ['-V'])` call. With persistent session reuse, `spawn()` is called once per loop, so the cost is amortized. However, bootstrap now also validates eagerly (lines 556-569 in `bootstrap.ts`), making the per-spawn validation redundant in server/run mode.
- Impact: Minor -- a ~5-20ms redundant `spawnSync` call per spawn. Not a hot path, but wasteful.
- Fix: Consider caching the validation result in the connector (validated-once flag) or removing the per-spawn check now that bootstrap validates eagerly. The CLI mode (`orchestrate -i`) validates separately, so all paths are covered.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**gracefulShutdownSession uses a fixed 3-second sleep** - `src/implementations/event-driven-worker-pool.ts:501`
**Confidence**: 85%
- Problem: The 3-second `setTimeout` in `gracefulShutdownSession` is a fixed sleep that blocks the kill flow. For `killAll()` with N workers, this serializes to N * 3 seconds of wall time (since `kill()` is called sequentially via `Promise.all` but each one awaits the 3-second sleep internally).
- Impact: With 10 workers, shutdown takes at least 30 seconds. The comment at line 497-500 acknowledges this design. Not introduced by this PR -- pre-existing.

## Suggestions (Lower Confidence)

- **300ms /clear settle time is a magic constant** - `src/implementations/event-driven-worker-pool.ts:295` (Confidence: 65%) -- The 300ms sleep for `/clear` to settle is empirically chosen. A retry with exponential backoff or a sentinel-based confirmation would be more reliable, though the practical failure mode is unclear.

- **reuseSession does not reset completionHandled flag** - `src/implementations/event-driven-worker-pool.ts:333` (Confidence: 70%) -- When `existingWorker` is returned from `reuseSession`, the `completionHandled` flag from the previous iteration is still set if the previous iteration completed normally. If the flag is `true`, the next `handleWorkerCompletion` call for this worker would be silently dropped. This depends on whether the LoopHandler creates a fresh worker via `spawn()` for each iteration (which goes through `reuseSession` and returns the same WorkerState) vs. whether `completionHandled` is reset elsewhere. The interaction needs verification.

- **validateTmux duplicates TmuxValidator logic** - `src/cli/commands/orchestrate-interactive.ts:100-125` (Confidence: 72%) -- The CLI-mode `validateTmux()` function reimplements tmux version parsing that already exists in `TmuxValidator`. This duplication could drift. Consider resolving `TmuxValidator` from the container or extracting a shared function.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Reliability Score**: 5/10
**Recommendation**: CHANGES_REQUESTED

The persistent session reuse mechanism has a fundamental stale-closure bug: the `onExit` callback is bound to the first iteration's taskId and never updated, causing crash detection to silently fail for all subsequent iterations. The stale `WorkerState.task` reference compounds this by producing incorrect task attribution. Both HIGH issues must be resolved before merge to prevent loops from stalling indefinitely on agent crashes -- a direct violation of the bounded-iteration reliability principle.

The SIGINT handling, tmux validation, and kill sequence patterns are well-implemented with proper bounds and fallbacks. The code demonstrates good defensive practices overall (dual-gate session caps, idempotent destroy, per-key concurrency guard). The issues are concentrated in the reuse path, which is the newest and most complex addition.
