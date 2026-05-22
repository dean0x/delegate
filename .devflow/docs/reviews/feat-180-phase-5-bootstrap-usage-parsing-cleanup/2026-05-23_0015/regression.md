# Regression Review Report

**Branch**: feat/180-phase-5-bootstrap-usage-parsing-cleanup -> main
**Date**: 2026-05-23

## Issues in Your Changes (BLOCKING)

### HIGH

**Stale onExit callback after persistent session reuse drops crash detection** - `src/implementations/event-driven-worker-pool.ts:312-313`
**Confidence**: 85%
- Problem: `reuseSession()` updates `taskToWorker` to map the new task ID to the worker, but the `onExit` callback in the TmuxConnector's `ActiveSession` still captures the ORIGINAL task ID in its closure (from `createCallbacks(task.id)` during the first spawn). If the persistent session crashes during the second or later iteration, `onExit` fires with the original task ID, `taskToWorker.get(originalTaskId)` returns undefined, and `handleWorkerCompletion` logs "Worker completion for unknown task" and returns without emitting `TaskFailed`. The current iteration's task remains stuck in RUNNING until recovery picks it up.
- Fix: Either (a) update the connector's callbacks on reuse to reference the current task ID, or (b) maintain a reverse mapping from original task ID to current task ID so `handleWorkerCompletion` can resolve the stale reference. The simplest approach is to keep the old taskId in `taskToWorker` as well:
```typescript
// In reuseSession(), keep old mapping as alias instead of deleting:
// this.taskToWorker.delete(existingWorker.task.id);  // <-- remove this delete
this.taskToWorker.set(task.id, workerId);
// Then in handleWorkerCompletion, both old and new taskId will resolve.
```
  However, this introduces a leak unless old mappings are cleaned up after each iteration.

**AUTOBEAT_WORKER env var leaked into interactive orchestration sessions** - `src/implementations/base-agent-adapter.ts:422`
**Confidence**: 82%
- Problem: The old `spawnInteractive()` explicitly stripped `AUTOBEAT_WORKER` from the spawned process's environment (`const { AUTOBEAT_WORKER: _, ...interactiveEnv } = cfg.env`). The new path through `buildTmuxCommand()` -> `resolveSpawnConfig()` -> `buildSpawnEnv()` always includes `AUTOBEAT_WORKER: 'true'` (line 422). The tmux session manager's `injectEnvironment()` then sets this in the tmux session. This means the agent running inside the interactive orchestration session now sees `AUTOBEAT_WORKER=true`, changing its behavior compared to the pre-Phase 5 implementation. The agent may suppress interactive features, alter its MCP configuration, or behave differently when it detects it is a "worker".
- Fix: In `orchestrate-interactive.ts`, after calling `adapter.buildTmuxCommand()`, strip `AUTOBEAT_WORKER` from the config's env before passing to `tmuxConnector.spawn()`:
```typescript
const { config: tmuxConfig, prompt: tmuxPrompt } = tmuxCommandResult.value;
// Strip AUTOBEAT_WORKER — interactive sessions are not background workers
if (tmuxConfig.env) {
  const { AUTOBEAT_WORKER: _, ...interactiveEnv } = tmuxConfig.env;
  tmuxConfig = { ...tmuxConfig, env: interactiveEnv };
}
```

### MEDIUM

**Stale onOutput callback captures output under wrong task ID during session reuse** - `src/implementations/event-driven-worker-pool.ts:599-606`
**Confidence**: 80%
- Problem: The `onOutput` callback created by `createCallbacks(task.id)` captures the original task ID in its closure. After `reuseSession()`, output from the second iteration is still routed to `outputCapture.capture(originalTaskId, ...)`. While the Stop hook writes message files attributed to the new task ID (because `AUTOBEAT_TASK_ID` is updated via `setEnvironment`), the connector's `onOutput` callback delivers them tagged with the original task ID. This means task output in the database may be attributed to the wrong task.
- Fix: Similar to the onExit issue, either update the callbacks or maintain a mapping. The cleanest approach is to introduce a mutable `currentTaskId` reference in the callback closure that `reuseSession` can update.

**test-factories.ts WorkerPool mock missing cleanupPersistentSession** - `tests/helpers/test-factories.ts:197-207`
**Confidence**: 80%
- Problem: The `workerPool` factory in test-factories uses `as WorkerPool` cast and does not include the new `cleanupPersistentSession` method added to the `WorkerPool` interface. Any test that uses this factory and exercises persistent session cleanup code paths will get a runtime TypeError. The cast bypasses TypeScript's type checking, hiding the interface mismatch.
- Fix: Add `cleanupPersistentSession: vi.fn()` to the mock object:
```typescript
workerPool: (): WorkerPool => {
  return {
    spawn: vi.fn().mockResolvedValue(ok({ id: TEST_CONSTANTS.TEST_WORKER_ID } as unknown)),
    kill: vi.fn().mockResolvedValue(ok(undefined)),
    killAll: vi.fn().mockResolvedValue(ok(undefined)),
    getWorker: vi.fn().mockReturnValue(ok(null)),
    getWorkers: vi.fn().mockReturnValue(ok([])),
    getWorkerCount: vi.fn().mockReturnValue(0),
    getWorkerForTask: vi.fn().mockReturnValue(ok(null)),
    cleanupPersistentSession: vi.fn(),
  } as WorkerPool;
},
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Interactive orchestration session not destroyed on catch-block error path** - `src/cli/commands/orchestrate-interactive.ts:381-385`
**Confidence**: 82%
- Problem: The outer `catch` block at line 381 calls `container.dispose()` and exits, but does not call `tmuxConnector.destroy(handle)` to clean up the tmux session. If an error occurs after the session is spawned but before the attach/finalize flow, the tmux session will be orphaned. The `container.dispose()` will trigger `tmuxConnector.dispose()` which destroys all tracked sessions, so this is partially mitigated. However, if `container` was never assigned (error during `withServices`), the session handle is not in scope. This is a minor gap in the existing error paths.
- Fix: Wrap the session lifecycle in a try/finally that ensures `handle` is destroyed if it was created:
```typescript
let handle: TmuxHandle | undefined;
try {
  // ... spawn sets handle ...
  handle = spawnResult.value;
  // ... rest of flow ...
} catch (error) {
  if (handle) tmuxConnector.destroy(handle);
  // ... existing cleanup ...
}
```

## Pre-existing Issues (Not Blocking)

No critical pre-existing issues detected in the reviewed files.

## Suggestions (Lower Confidence)

- **Persistent session output flushing on reuse boundary** - `src/implementations/event-driven-worker-pool.ts:282` (Confidence: 65%) -- When reusing a session, the output from the previous iteration may still be in the flush pipeline. Calling `flushOutput` before remapping taskToWorker would ensure all output from the previous iteration is persisted under the correct task ID.

- **Bootstrap tmux validation skipped for `run` mode with injected connector** - `src/bootstrap.ts:556` (Confidence: 60%) -- The eager tmux validation at line 556 skips when `options.tmuxConnector` is set (test environments). This is correct, but the comment says "Skipped when a connector is injected (tests) or in CLI mode" -- however, `run` mode will also validate, which adds startup latency for `beat run` commands. This is likely intentional but not documented.

- **reuseSession error paths return err without falling through to fresh spawn** - `src/implementations/event-driven-worker-pool.ts:278-280` (Confidence: 70%) -- The design comment says "On any failure, fall through to fresh spawn by destroying the stale session," but `reuseSession` actually returns `err()` on failure rather than falling through. The caller in `spawn()` receives the error and propagates it up -- it does not retry with a fresh spawn. This seems inconsistent with the stated design.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Regression Score**: 5/10
**Recommendation**: CHANGES_REQUESTED

The PR is a well-structured Phase 5 migration that successfully removes the ProcessSpawner/spawnInteractive dead code (avoids PF-002) and adds persistent session reuse for loops. However, two HIGH-severity regression risks need attention:

1. The stale callback closure in `reuseSession` means session crashes during later iterations will not properly emit TaskFailed events -- tasks will be stuck in RUNNING until recovery.
2. The `AUTOBEAT_WORKER` env var leak into interactive orchestration sessions changes agent behavior compared to the pre-Phase 5 implementation.

Both are fixable with targeted changes. The migration is incomplete on these two points but the overall direction is sound.
