# Regression Review Report

**Branch**: feat/180-phase-5-bootstrap-usage-parsing-cleanup -> main
**Date**: 2026-05-23

## Issues in Your Changes (BLOCKING)

### HIGH

**Persistent session reuse may never execute in the real loop lifecycle** - `src/implementations/event-driven-worker-pool.ts:357-366`
**Confidence**: 82%
- Problem: When a loop iteration completes, `onExit` fires `handleWorkerCompletion` which calls `cleanupWorkerState`, removing the worker from `this.workers` and `this.taskToWorker` maps. The loop handler then processes `TaskCompleted`, creates the next task, and calls `spawn()`. By the time `reuseSession()` runs, `this.workers.get(workerId)` at line 357 returns `undefined` because the worker was already cleaned up. This causes `reuseSession()` to return `ok(null)` and fall through to a fresh spawn every time, making the persistent session reuse path dead code in the normal lifecycle.
- Impact: The intent of persistent sessions (reusing the tmux REPL across loop iterations to avoid session creation overhead) is never realized. Every iteration creates a fresh tmux session. The tmux handle in `persistentSessions` map remains alive but unusable because its WorkerState is gone. The feature works correctly only when spawn is called again before the previous iteration's onExit/completion chain runs (which the tests simulate, but the real event-driven flow does not).
- Fix: `reuseSession()` needs to re-register the worker in `this.workers` and `this.taskToWorker` when the WorkerState is missing but the tmux handle is still alive. Alternatively, `handleWorkerCompletion` should skip `cleanupWorkerState` when the worker belongs to a persistent session -- instead, just emit the event and leave the worker state alive for the next iteration to reuse. A third option: `reuseSession()` should call `registerWorker()` internally when the existing worker state is missing (re-creating the WorkerState from the surviving handle + the new task).

### MEDIUM

**Periodic flushing, heartbeat, and timeout not restarted after session reuse** - `src/implementations/event-driven-worker-pool.ts:310-406`
**Confidence**: 82%
- Problem: When `reuseSession()` succeeds (returns `ok(existingWorker)`), the caller at line 241-242 returns immediately without going through `launchAndRegister()` which calls `startFlushing()`, `setupHeartbeatForWorker()`, and `setupTimeoutForWorker()`. If a previous iteration's `onExit` already called `stopFlushing()` and cleared the heartbeat timer (normal completion flow), the reused session has no periodic output flushing, no heartbeat updates, and no task timeout enforcement.
- Impact: Output from reused iterations is only flushed on exit (final flush), heartbeat DB updates stop (recovery manager may incorrectly flag the worker as stale), and task timeouts are not enforced for subsequent iterations. This is contingent on the HIGH issue above being resolved (since reuse currently doesn't happen in practice).
- Fix: After the successful reuse block (around line 383-385 where task/taskId/completionHandled are updated), restart flushing, heartbeat, and timeout timers:
  ```typescript
  this.setupTimeoutForWorker(existingWorker);
  this.setupHeartbeatForWorker(existingWorker);
  this.startFlushing(existingWorker);
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Dead method `updateInteractiveOrchestrationPid` left in interface and implementation** - `src/core/interfaces.ts:893`
**Confidence**: 85%
- Problem: The `updateInteractiveOrchestrationPid` method is now documented as "pre-Phase 5 legacy path" but has zero callers. The interactive orchestrator exclusively uses `updateInteractiveOrchestrationSessionName`. The method remains in the `OrchestrationService` interface and its implementation in `orchestration-manager.ts`.
- Impact: Dead code increases cognitive load and maintenance burden. Consumers of the `OrchestrationService` interface must implement a method that nothing calls. Applies PF-001 (do not defer to future PR -- clean up while we are here).
- Fix: Remove `updateInteractiveOrchestrationPid` from the `OrchestrationService` interface and its implementation. If backward compatibility is a concern, note that this is an internal interface with no external consumers (avoids PF-002 -- no migration needed for zero-user features).

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Tests don't simulate the real lifecycle for persistent session reuse** - `tests/unit/implementations/event-driven-worker-pool.test.ts:868` (Confidence: 75%) -- The reuse tests call `spawn(task2)` immediately after `spawn(task1)` without simulating task1 completion. In the real flow, task1 completes (onExit -> cleanup) before task2 is spawned. Adding a test that simulates the full lifecycle (spawn -> exit -> spawn) would reveal the HIGH issue above.

- **AUTOBEAT_WORKER stripping uses unsafe double-cast through `unknown`** - `src/cli/commands/orchestrate-interactive.ts:219-224` (Confidence: 65%) -- The env stripping logic casts `rawTmuxConfig` through `unknown` twice to access the `env` property. While the comment explains the type boundary reasoning, a type predicate or type guard would be safer than `as unknown as { env?: ... }`.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Regression Score**: 6/10
**Recommendation**: CHANGES_REQUESTED
