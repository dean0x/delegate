# Regression Review Report

**Branch**: feat/180-phase-5-bootstrap-usage-parsing-cleanup -> main
**Date**: 2026-05-23
**Prior Resolutions**: Cycle 2 resolved 17/20 issues, 2 false positive. B5-2 removed updateInteractiveOrchestrationPid (avoids PF-002).

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

(none)

## Analysis

### 1. Removed Interface Method: `updateInteractiveOrchestrationPid`

**Confidence**: 95% -- NOT a regression

The method `updateInteractiveOrchestrationPid` was removed from:
- `src/core/interfaces.ts` (OrchestrationService interface)
- `src/services/orchestration-manager.ts` (implementation)
- `tests/unit/interactive-orchestrator.test.ts` (dedicated test suite deleted, 2 callers replaced with direct repo updates)

**Migration completeness**: Verified via `grep -rn` -- zero remaining call sites in `src/` or `tests/`. Only comment references survive (explaining the removal context).

**Backward compatibility**: The `cancelOrchestration` path retains the pre-Phase 5 SIGTERM fallback (`orchestration.pid > 0` branch at `orchestration-manager.ts:603`). Existing DB rows with a PID but no session_name will still be cancelled correctly. This is a clean break -- the removed method had zero external consumers and was only called from `orchestrate-interactive.ts` which now uses tmux sessions exclusively (avoids PF-002).

### 2. Return Type Changes: `resolveContainerDeps` and `spawnAndDeliverPrompt`

**Confidence**: 92% -- NOT a regression

- `resolveContainerDeps`: changed from `Promise<ContainerDeps | null>` to `Promise<ContainerDeps>` (uses `Promise<never>` via `failWith`)
- `spawnAndDeliverPrompt`: changed from `Promise<SpawnedSession | null>` to `Promise<SpawnedSession>` (same pattern)

These are narrowing changes (removing null from the return type). The previous callers had `if (!deps) return;` and `if (!session) return;` guards that are now removed. The `failWith` helper calls `process.exit(1)` -- the function never actually returns null. The old code was equivalent (exit before return) but expressed as `null | T`. The new signature is strictly more correct. No callers outside `orchestrate-interactive.ts` consume these functions (they are module-private).

### 3. `TmuxSpawnCoreConfig.env` Field Addition

**Confidence**: 90% -- NOT a regression

Added `readonly env?: Record<string, string>` to `TmuxSpawnCoreConfig` (core type). This was previously only on `TmuxSessionConfig` (impl type). Since `TmuxSpawnConfig extends TmuxSessionConfig, TmuxSpawnCoreConfig`, both types now declare `env?` with identical type `Record<string, string>`. TypeScript merges these cleanly -- no type conflicts.

This eliminates the unsafe `as unknown as { env?: Record<string, string> }` cast in `orchestrate-interactive.ts:219-224` (old code) by making `rawTmuxConfig.env` type-safe at the core level. Strictly an improvement with no behavioral change.

### 4. B1-1 Fix: WorkerState Re-registration After Loop Iteration Completion

**Confidence**: 88% -- NOT a regression

The `reuseSession` method now handles the case where `cleanupWorkerState` has already removed the WorkerState from `this.workers`. Instead of falling through to a fresh spawn (pre-fix behavior: returns `ok(null)` when worker is missing), it re-registers a new WorkerState using the handle and taskIdRef stored in the `PersistentSessionEntry`.

**Note**: The `PersistentSessionEntry.workerId` is not updated after re-registration. Each iteration creates a new workerId (`worker-beat-${taskN.id}`), but the entry still stores the original workerId. This means every steady-state reuse hits the B1-1 path (worker not found -> re-register). This is correct behavior for the loop lifecycle: `onExit -> cleanupWorkerState` removes the worker between iterations, so re-registration is the expected path. The stale `workerId` in the entry is only used for the `this.workers.get()` check and logging -- no functional impact.

New tests (`B1-1`, `B1-2`, `B1-3`) validate the complete lifecycle: completion -> cleanup -> reuse -> re-register -> timers restart -> exit emits correct task ID.

### 5. B1-3 Fix: Timer Restart After Session Reuse

**Confidence**: 90% -- NOT a regression

Both code paths (B1-1 re-registration and in-place remap) now call `setupTimeoutForWorker`, `setupHeartbeatForWorker`, and `startFlushing` after remapping. Previously, only the fresh-spawn path set up timers. The `onExit` callback stops flushing and heartbeat timers before `handleWorkerCompletion` -- without restarting them on reuse, the session would have no heartbeat updates, no periodic output flushing, and no timeout enforcement. Test `B1-3` validates heartbeat fires after reuse.

### 6. B1-2 Fix: SendKeys Failure Cleanup

**Confidence**: 90% -- NOT a regression

Added `this.cleanupWorkerState(workerId, task.id)` before `this.cleanupPersistentSession(key)` on sendKeys failure in `reuseSession`. Previously, a failed `sendKeys` would destroy the persistent session but leave orphaned timers and stale entries in `this.workers` / `this.taskToWorker`. The new order clears timers first, then destroys the session. Test `B1-2` validates this path.

### 7. Interactive Orchestrator Refactoring: `attachAndFinalize` Extraction

**Confidence**: 92% -- NOT a regression

Phase 4 logic (SIGINT handling, tmux attach, exit detection, finalization) was extracted from `handleOrchestrateInteractive` into a new `attachAndFinalize` function. The behavior is identical -- same SIGINT handler installation/restoration, same attach command, same liveness check, same exit code resolution, same finalization call. The new function returns `Promise<never>` (always calls `process.exit`), and the caller annotates the await with a comment ("this await never returns").

The `EXIT_CALLBACK_DEADLINE_MS = 2000` constant replaces the inline magic number `2000` in the `Promise.race` timeout -- pure rename, no behavioral change.

### 8. Test Updates

**Confidence**: 95% -- NOT a regression

- `updateInteractiveOrchestrationPid` test suite removed (tests for a removed method -- correct)
- 2 tests that called `updateInteractiveOrchestrationPid` now use `orchestrationRepo.update(updateOrchestration(..., { pid: 99999 }))` to seed a PID directly, simulating pre-Phase 5 rows
- 4 new B1-* regression tests added for the worker pool lifecycle fixes
- Test comments clarified to explain why `task1.id` is used for mock simulation (callbacks are keyed by original spawn task ID)
- `_simulateOutput` calls updated to include required `sequence` and `timestamp` fields

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Regression Score**: 9/10
**Recommendation**: APPROVED

All changes are behavior-preserving refactors or well-tested bug fixes. The removed `updateInteractiveOrchestrationPid` method had zero consumers after the interactive orchestrator migrated to tmux sessions (avoids PF-002 -- clean break for zero-user features). The cancel path retains SIGTERM fallback for pre-Phase 5 DB rows. Return type narrowings, `env` field promotion, and the `attachAndFinalize` extraction are all strict improvements with no behavioral regression. The B1-* fixes address real loop lifecycle bugs with comprehensive test coverage.
