# TypeScript Review Report

**Branch**: feat/180-phase-5-bootstrap-usage-parsing-cleanup -> main
**Date**: 2026-05-23

## Issues in Your Changes (BLOCKING)

### CRITICAL

**Persistent session reuse does not update WorkerState.task, WorkerState.taskId, or callbacks** - `src/implementations/event-driven-worker-pool.ts:252-336`
**Confidence**: 95%
- Problem: `reuseSession()` updates the `taskToWorker` map (line 312-313) but does NOT update the `existingWorker.task` or `existingWorker.taskId` fields (both are `readonly` on the `Worker` interface). Additionally, the `onOutput` and `onExit` callbacks created by `createCallbacks(taskId)` capture the ORIGINAL task ID in a closure (line 597). After reuse:
  1. `onOutput` captures output under the old taskId (wrong task attribution)
  2. `onExit` calls `this.taskToWorker.get(oldTaskId)` but the old mapping was deleted at line 312 -- returns `undefined`, so `handleWorkerCompletion` is never reached for the reused iteration
  3. `worker.taskId` on the periodic flush timer (line 646-653) still references the old taskId
  4. `worker.taskId` on the timeout timer (line 793) still references the old taskId
  5. `worker.task` is the old Task object -- if any handler inspects it, they get stale data
- Impact: After the first iteration completes and the session is reused, all subsequent iterations will have broken output capture (attributed to wrong task), broken completion handling (TaskCompleted/TaskFailed events never emitted), broken timeout handling, and broken periodic flushing. The loop will appear to hang because no terminal event is emitted for the reused task.
- Fix: The `WorkerState` interface needs mutable `task` and `taskId` fields (or create a new WorkerState replacing the old one). The `SpawnCallbacks` need to be re-created or updated to reference the new taskId. In `reuseSession()`:

```typescript
// 1. Update worker state (requires making task/taskId mutable on WorkerState)
existingWorker.taskId = task.id;
existingWorker.task = task;
existingWorker.completionHandled = false;

// 2. Re-create callbacks for the new taskId
// The old onOutput/onExit closures capture the old taskId and cannot be updated.
// Either: 
//   a) Use an indirection (e.g. worker.currentTaskId getter) in callbacks
//   b) Re-register new callbacks with the connector for this session
//   c) Have callbacks look up the current taskId from the worker, not the closure
```

### HIGH

**reuseSession returns stale Worker object to caller** - `src/implementations/event-driven-worker-pool.ts:333`
**Confidence**: 92%
- Problem: `reuseSession` returns `ok(existingWorker)` where `existingWorker` has the old task's `id`, `taskId`, `task`, `startedAt`, etc. The caller (WorkerHandler) receives a Worker whose `taskId` does not match the task it just spawned. WorkerHandler uses the returned Worker to emit `TaskStarted` events and register tracking -- all with incorrect data.
- Fix: Either create a new WorkerState with updated fields, or ensure the returned Worker reflects the new task identity.

## Issues in Code You Touched (Should Fix)

### HIGH

**Orchestrate-interactive: missing cleanup in error paths before tmux session spawn** - `src/cli/commands/orchestrate-interactive.ts:203-209`
**Confidence**: 82%
- Problem: When `adapterResult` fails (line 202), the code calls `finalizeInteractiveOrchestration` and disposes the container, but no tmux session has been created yet at this point. However, `finalizeInteractiveOrchestration` is designed for sessions that were spawned. While this is harmless (it transitions the orchestration to FAILED which is correct), the newly added code path at lines 203-206 calls `finalizeInteractiveOrchestration` before the tmux session exists, which is inconsistent with the other error paths (e.g., line 252-257 where a session was actually spawned).
- Fix: Consider whether `finalizeInteractiveOrchestration` is the correct call here vs. a simpler orchestrationRepo.update() to mark the orchestration as failed.

### MEDIUM

**Poll-based wait with `setInterval` has no `unref()` call** - `src/cli/commands/orchestrate-interactive.ts:344-359`
**Confidence**: 85%
- Problem: The `poll` interval (50ms) and `deadline` timeout (2000ms) created to wait for the `agentExited` flag are not `.unref()`-ed. If the process is exiting, these timers could keep it alive briefly. In a CLI command that calls `process.exit()` shortly after, this is unlikely to cause issues in practice, but it violates the project convention of `.unref()` on timers that should not keep the process alive.
- Fix: Add `.unref()` to both the `deadline` timeout and `poll` interval.

### MEDIUM

**`TmuxSpawnCoreConfig.persistent` flag is added to the port interface but no adapter sets it** - `src/core/tmux-types.ts:85-91`, `src/implementations/base-agent-adapter.ts:99-148`
**Confidence**: 80%
- Problem: The `persistent` flag is added to `TmuxSpawnCoreConfig` (the core port interface) and the `TmuxConnector.spawn()` method branches on it (line 173-185 in tmux-connector.ts). However, `BaseAgentAdapter.buildTmuxCommand()` never sets `persistent: true` in the returned config object (line 135-147). The `LoopHandler` sets `persistentSessionKey` on the Task, and the WorkerPool checks for it, but the actual tmux config assembled by the adapter does not include `persistent: true`. This means the setup shim path in `TmuxConnector.spawn()` is never taken in production code, and the persistent session mode is dead code.
- Fix: When `task.persistentSessionKey` is set, the WorkerPool (or the adapter) should set `config.persistent = true` in the TmuxSpawnCoreConfig so the connector uses the setup shim instead of the wrapper pipeline.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`WorkerState` interface uses `readonly` fields from `Worker` but mutates them via direct assignment** - `src/implementations/event-driven-worker-pool.ts:56-65`
**Confidence**: 80%
- Problem: `WorkerState extends Worker` inherits `readonly taskId`, `readonly id`, etc. TypeScript allows mutation of `readonly` fields through the concrete object (not through a reference typed as the interface), but this relies on implementation details and is fragile. The `completionHandled` field is already mutable, but `task` and `taskId` would need to be mutable for the persistent session reuse fix.
- Fix: Consider making `WorkerState` a standalone interface that does not extend `Worker`, or use a wrapper pattern that presents the current state.

## Suggestions (Lower Confidence)

- **Missing type guard for `Orchestration.sessionName`** - `src/core/domain.ts:820-826` (Confidence: 65%) -- `sessionName` is `string | undefined` but could benefit from a branded type (`TmuxSessionName`) to prevent accidental string mixing, consistent with the pattern used for `TaskId`, `WorkerId`, etc.

- **`validateTmux()` duplicates logic from `TmuxValidator`** - `src/cli/commands/orchestrate-interactive.ts:100-125` (Confidence: 70%) -- The inline `validateTmux()` function duplicates version parsing and validation logic that already exists in `TmuxValidator`. However, the comment explains CLI mode skips bootstrap validation, and importing TmuxValidator would add an implementation dependency to a CLI command. Trade-off is reasonable but creates a maintenance burden if version requirements change.

- **`reuseSession` error path returns `err()` but does not fall through to fresh spawn** - `src/implementations/event-driven-worker-pool.ts:278-280, 290-292, 306-308, 322-324` (Confidence: 72%) -- The design decision comment says "On any failure, fall through to fresh spawn" but the actual code returns `err()` from `reuseSession`, and the caller in `spawn()` at line 208 directly returns the result. The caller does not catch err results from `reuseSession` and retry with a fresh spawn.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 1 | 1 | - | - |
| Should Fix | - | 1 | 2 | - |
| Pre-existing | - | - | 1 | - |

**TypeScript Score**: 5/10
**Recommendation**: CHANGES_REQUESTED

The CRITICAL finding in `reuseSession` is a fundamental correctness issue: after the first session reuse, all output capture, completion handling, timeout handling, and periodic flushing operate on the wrong task ID due to closed-over task references in callbacks and readonly fields on WorkerState. This will cause loops to hang silently after iteration 1. The persistent flag on TmuxSpawnCoreConfig also appears to be dead code -- no adapter sets it, so the setup shim path is never reached.
