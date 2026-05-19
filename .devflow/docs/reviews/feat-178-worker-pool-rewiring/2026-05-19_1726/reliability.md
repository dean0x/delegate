# Reliability Review Report

**Branch**: feat/178-worker-pool-rewiring -> main
**Date**: 2026-05-19

## Issues in Your Changes (BLOCKING)

### HIGH

**kill() grace period polling lacks total-timeout enforcement** - `src/implementations/event-driven-worker-pool.ts:246-259`
**Confidence**: 85%
- Problem: The kill() method polls `isAlive()` every 250ms for up to 20 iterations (5s). However, `isAlive()` delegates to `tmuxConnector.isAlive()` which calls `spawnSync('tmux has-session ...')`. If the tmux binary itself hangs (e.g., tmux server is stuck), each `spawnSync` call has no timeout and could block indefinitely. The 20-iteration bound only counts completed iterations, not wall-clock time. With a hung tmux server, a single `isAlive()` call could block forever, making the bounded loop effectively unbounded.
- Fix: Add a timeout to the spawnSync call in the ExecFn wrapper (bootstrap.ts line 509), or add a per-call timeout at the session manager level:
```typescript
// In bootstrap.ts tmuxExec:
const tmuxExec: ExecFn = (cmd) => {
  const result = spawnSync(cmd, { shell: true, encoding: 'utf8', timeout: 10_000 });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status ?? -1 };
};
```

**spawnSync in tmuxExec has no timeout — any tmux command can block indefinitely** - `src/bootstrap.ts:508-511`
**Confidence**: 90%
- Problem: The shared `tmuxExec` function wraps `spawnSync` without a `timeout` option. Every tmux operation (spawn, kill, isAlive, listSessions, sendKeys) flows through this function. If the tmux server becomes unresponsive (e.g., deadlocked, hung on a broken socket), any call through `tmuxExec` will block the entire Node.js event loop indefinitely. This is a single point of failure for the entire application. The `spawnSync` API supports a `timeout` option (in milliseconds) that would kill the child process and return with a non-zero status after the deadline.
- Fix: Add `timeout: 10_000` (or a configurable value) to the spawnSync options:
```typescript
const tmuxExec: ExecFn = (cmd) => {
  const result = spawnSync(cmd, { shell: true, encoding: 'utf8', timeout: 10_000 });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
  };
};
```

### MEDIUM

**handleWorkerCompletion race: heartbeat timer fires after completionHandled but before clearTimeoutForWorker** - `src/implementations/event-driven-worker-pool.ts:558-579`
**Confidence**: 80%
- Problem: The heartbeat timer (line 559, 30s interval) calls `this.handleWorkerCompletion(worker.taskId, 1)` when it detects a dead session. However, if onExit fires first and sets `completionHandled = true` (line 613), the heartbeat path is correctly guarded. But there is a narrow window in the opposite direction: if the heartbeat fires and enters `handleWorkerCompletion` (past the guard at line 609), and then `onExit` fires before the heartbeat path reaches `cleanupWorkerState`, the `onExit` path will also enter `handleWorkerCompletion` concurrently. Since `handleWorkerCompletion` is not atomic and the guard is a non-atomic boolean check+set (lines 609-613), two microtask-scheduled entries could both pass the guard. In practice, Node.js single-threaded event loop makes true concurrency impossible within synchronous code, but the `flushOutput(taskId)` in the onExit callback (line 363-368) introduces an async gap before `handleWorkerCompletion` is called, during which the heartbeat timer tick could fire.
- Fix: Clear the heartbeat timer in the onExit callback before the async flush, or move the `completionHandled` check to a method that also clears all timers atomically:
```typescript
onExit: (code: number | null, _signal?: string) => {
  const workerId = this.taskToWorker.get(taskId);
  if (workerId) {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.completionHandled = true; // Guard early, before async gap
      this.stopFlushing(worker);
      if (worker.heartbeatTimer) {
        clearInterval(worker.heartbeatTimer);
        worker.heartbeatTimer = undefined;
      }
    }
  }
  this.flushOutput(taskId)
    .catch((e) => this.logger.error('Final flush failed', toError(e), { taskId }))
    .finally(() => {
      this.outputCapture.clear(taskId);
      this.handleWorkerCompletion(taskId, code ?? 0);
    });
},
```

**ProcessSpawnerAdapter.buildTmuxCommand returns fabricated TmuxSpawnConfig for tests** - `src/implementations/process-spawner-adapter.ts:50-62`
**Confidence**: 82%
- Problem: The adapter returns a mock `TmuxSpawnConfig` via `as unknown as TmuxSpawnConfig`, which hides the fact that the object may be missing required fields or have incorrect types. If `EventDrivenWorkerPool.spawn()` passes this config to `tmuxConnector.spawn()`, the mock connector must accept it. But if any code path inspects config fields that are absent (like `staleness`, `env`, `width`, `height`), it will get `undefined` without type warnings. The `as unknown as` double-cast disables all type safety.
- Fix: Either fully construct the `TmuxSpawnConfig` with all required fields, or document that this adapter is test-only and must only be used with `MockTmuxConnector`:
```typescript
buildTmuxCommand(
  options: SpawnOptions & { sessionsDir: string },
): Result<{ readonly config: TmuxSpawnConfig; readonly prompt: string }> {
  const taskId = (options.taskId ?? 'task-unknown') as TaskId;
  const config: TmuxSpawnConfig = {
    name: `beat-${taskId}`,
    command: 'echo',
    cwd: options.workingDirectory || process.cwd(),
    taskId,
    sessionsDir: options.sessionsDir,
    agent: 'claude' as const,
    agentArgs: [],
    // Explicit defaults for all optional fields
  };
  return ok({ config, prompt: options.prompt });
}
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Recovery manager zombie orchestration check uses only PID liveness, not tmux session liveness** - `src/services/recovery-manager.ts:294-339`
**Confidence**: 82%
- Problem: `failZombieRunningOrchestrations()` traces the liveness chain through `checkOrchestrationLiveness()`, which ultimately calls `isProcessAlive()`. With the tmux migration, orchestration workers have `pid=0` (sentinel), and PID-based liveness checks on pid=0 or the old ownerPid (from a previous server instance) will produce incorrect results. The `cleanDeadWorkerRegistrations()` and `recoverRunningTasks()` methods were correctly updated to check `isTmuxSessionAlive()` for tmux workers, but the orchestration zombie detection path was not. It delegates to `checkOrchestrationLiveness` which was not updated in this PR to handle tmux workers.
- Fix: Pass `isTmuxSessionAlive` to `checkOrchestrationLiveness` or update the liveness helper to handle tmux workers (pid=0 with sessionName):
```typescript
liveness = await checkOrchestrationLiveness(o, {
  loopRepo: this.loopRepo,
  taskRepo: this.taskRepo,
  workerRepo: this.workerRepo,
  isProcessAlive: this.isProcessAlive,
  isTmuxSessionAlive: (name: string) => this.isTmuxSessionAlive(name),
});
```

**sharedStalenessTimer not unref'd -- keeps Node.js process alive** - `src/implementations/tmux/tmux-connector.ts:526`
**Confidence**: 85%
- Problem: In `restartSharedStalenessTimer()`, the `setInterval` timer is not `.unref()`'d. The heartbeat timer in `event-driven-worker-pool.ts:581` correctly uses `timer.unref()`, and the flush interval in `event-driven-worker-pool.ts:390` also uses `interval.unref()`. However the shared staleness timer in the connector does not follow this pattern. If all tasks complete but the staleness timer is still running (e.g., because `dispose()` was not called), the Node.js process will not exit naturally, which is a reliability issue for CLI mode and the `beat run` single-task mode.
- Fix: Add `.unref()` after creating the timer:
```typescript
this.sharedStalenessTimer = setInterval(() => this.runSharedStalenessCheck(), minInterval);
this.sharedStalenessTimer.unref();
```

## Pre-existing Issues (Not Blocking)

### MEDIUM

**recovery.recover() is fire-and-forget in bootstrap** - `src/bootstrap.ts:662-666`
**Confidence**: 85%
- Problem: The recovery promise at line 663 is `.then()` handled but never awaited. If recovery fails catastrophically (e.g., database corruption), the error is only logged -- the bootstrap returns `ok(container)` and the MCP server starts serving requests with potentially corrupt state. The `then` handler catches Result errors but not thrown exceptions from the promise chain itself (no `.catch()`).
- Fix: Add `.catch()` to the promise chain, or await the recovery result before returning:
```typescript
recovery.recover()
  .then((result) => {
    if (!result.ok) {
      logger.error('Recovery failed', result.error);
    }
  })
  .catch((e) => {
    logger.error('Recovery threw unexpectedly', e instanceof Error ? e : new Error(String(e)));
  });
```

## Suggestions (Lower Confidence)

- **Wrapper script `while IFS= read -r` hangs on agent that never closes stdout** - `src/implementations/tmux/tmux-hooks.ts:133` (Confidence: 70%) -- If an agent process writes to stdout but never closes it (e.g., hangs without exiting), the `read -r` loop will block indefinitely. The task timeout in the worker pool will eventually kill the session, but the wrapper itself has no independent timeout. The sentinel guard trap fires only on script exit.

- **dispose() calls destroySession synchronously for all sessions** - `src/implementations/tmux/tmux-connector.ts:293-323` (Confidence: 65%) -- During shutdown, `dispose()` iterates all sessions and calls `destroySession()` synchronously (via spawnSync) for each. With many active sessions (up to MAX_CONCURRENT_SESSIONS=20), this could take 20 x 10-20ms = 200-400ms in the best case, but with a hung tmux server (no timeout on spawnSync), it could block indefinitely.

- **MockTmuxConnector callbacks map never cleans up entries** - `tests/fixtures/mocks.ts:148` (Confidence: 60%) -- The `callbacksMap` in `createMockTmuxConnector` is never cleared on destroy/dispose calls. In long-running test suites, entries accumulate. Minor memory concern for tests only.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 1 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Reliability Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The tmux migration is well-structured with good defensive patterns: bounded kill-poll loop (20 iterations), double-completion guard (G2), backpressure guard on flushing (G3), dual-gate session cap, and proper sentinel-guard trap in the wrapper script. The primary reliability concern is the unbounded `spawnSync` timeout in the shared `tmuxExec` function -- a single hung tmux server could freeze the entire Node.js event loop. Adding a timeout to `spawnSync` is a straightforward fix that addresses both HIGH findings simultaneously. The orchestration zombie detection gap (should-fix) is a logical oversight where the tmux liveness path was not propagated to one of the three recovery code paths. The `sharedStalenessTimer.unref()` omission is a clean-shutdown correctness issue that should be fixed for parity with the existing timer patterns.
