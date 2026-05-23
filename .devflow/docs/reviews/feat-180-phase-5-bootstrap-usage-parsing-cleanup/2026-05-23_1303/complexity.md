# Complexity Review Report

**Branch**: feat/180-phase-5-bootstrap-usage-parsing-cleanup -> main
**Date**: 2026-05-23
**Cycle**: 3 (incremental from cycle 2 resolution at 3e593d8)

## Cross-Cycle Status

Prior cycle 2 flagged 6 complexity issues (2 HIGH blocking, 1 MEDIUM blocking, 2 MEDIUM should-fix, 1 MEDIUM pre-existing). Resolution summary confirms 17/20 total issues fixed across all reviewers, including all complexity-specific items:

- B3-2: 6 positional params consolidated into `SpawnPromptContext` -- **Fixed**
- B3-3: Duplicated finalize+dispose+exit extracted to `failWith` helper -- **Fixed**
- B3-1: Double `as unknown` cast eliminated by adding `env` to `TmuxSpawnCoreConfig` -- **Fixed**
- B2-1: spawn() 4-level nesting extracted to `tryReuseSession()` -- **Fixed**
- B4-1: `handleOrchestrateInteractive` reduced from 176 to 108 lines via `attachAndFinalize` extraction -- **Fixed**
- B3-5: `resolveContainerDeps` repeated dispose+exit consolidated to `failWith` helper -- **Fixed**
- B4-2: Magic number 2000ms extracted to `EXIT_CALLBACK_DEADLINE_MS` constant -- **Fixed**

All prior complexity issues have been resolved. This cycle evaluates the resolution commits plus any new complexity introduced.

## Issues in Your Changes (BLOCKING)

### HIGH

**`reuseSession()` is 163 lines with two substantial branches** - `event-driven-worker-pool.ts:366-528`
**Confidence**: 85%
- Problem: The `reuseSession()` method is 163 lines (including JSDoc), well past the 50-line warning threshold. The method has two primary branches (`if (!worker)` for re-registration and `else` for in-place remap), each roughly 40-50 lines of business logic. The `else` branch alone handles 5 distinct fix scenarios (B1-1 through B1-5) with DB unregister/re-register, timer restart, and flush cleanup. While each fix is well-documented with inline comments, the aggregate cognitive load of understanding all 5 fix interactions in one method is high.
- Impact: Any future change to the reuse protocol must reason about both branches simultaneously, the interaction between timer restart and DB re-registration, and the sendKeys rollback path. The method's JSDoc header alone is 33 lines documenting 8 protocol steps and 5 fix annotations.
- Fix: Extract the two branches into named private methods:
  ```typescript
  private reRegisterWorkerForReuse(task: Task, entry: PersistentSessionEntry): Result<WorkerState> {
    // B1-1 fix: re-register using stored handle + taskIdRef
    // Set up timers (B1-3 fix)
  }

  private remapExistingWorkerForReuse(worker: WorkerState, task: Task, entry: PersistentSessionEntry): void {
    // B1-4: flush cleanup
    // B1-5: DB re-registration
    // B1-3: timer restart
  }
  ```
  This would reduce `reuseSession()` to ~60 lines of sequential protocol steps (env update, /clear, branch to helper, sendKeys, logging).

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`handleOrchestrateInteractive` still has a residual teardown block (lines 437-445)** - `orchestrate-interactive.ts:437-445`
**Confidence**: 80%
- Problem: After the `failWith` helper was introduced for `resolveContainerDeps` and `spawnAndDeliverPrompt`, the adapter resolution error block at lines 437-445 still uses the raw `ui.error + finalizeInteractiveOrchestration + container.dispose + process.exit` pattern instead of using or adapting the `failWith` helper from `spawnAndDeliverPrompt`. This is the only remaining instance of the 4-line manual teardown in the file.
- Impact: If the teardown sequence changes (e.g., adding telemetry on failure), this spot would be missed.
- Fix: This block falls between `resolveContainerDeps` (which has its own `failWith`) and `spawnAndDeliverPrompt` (which also has its own `failWith`). Since the orchestration exists at this point, the finalization call is required. A file-scoped helper or moving this logic into `spawnAndDeliverPrompt` (which already receives `orchestrationService` and `container`) would eliminate the duplication.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`event-driven-worker-pool.ts` is 1140 lines** - `event-driven-worker-pool.ts`
**Confidence**: 90%
- Problem: The file grew from 1021 lines (cycle 1) to 1140 lines after the B1-x fixes and `tryReuseSession` extraction. It is past the 500-line critical threshold. The persistent session subsystem (`tryReuseSession`, `reuseSession`, `cleanupPersistentSession`, `PersistentSessionEntry`, `persistentSessions` map, `reuseInProgress` set) represents roughly 200 lines that could be a separate class.
- Impact: Any reviewer or contributor must read 1100+ lines to orient in this file.
- Fix: Extract a `PersistentSessionManager` class that owns the `persistentSessions` map, `reuseInProgress` set, `tryReuseSession`, `reuseSession`, and `cleanupPersistentSession`. The worker pool would delegate to it. This was noted in cycle 1 and remains the same recommendation.

## Suggestions (Lower Confidence)

- **`reuseSession` return type `Result<Worker | null>` uses null as sentinel** - `event-driven-worker-pool.ts:371` (Confidence: 68%) -- Using `null` inside a `Result` as a "fall through" signal is unconventional. A discriminated union `{ kind: 'reused'; worker: Worker } | { kind: 'fallthrough' }` would be more explicit. Carried forward from cycle 1; tested and documented, so low priority.

- **`attachAndFinalize` is 83 lines with 3 distinct responsibilities** - `orchestrate-interactive.ts:300-382` (Confidence: 65%) -- SIGINT handler installation/restoration, tmux attach blocking, and finalization+status reporting are three distinct phases. Currently well-structured with comments but could benefit from further extraction if the function grows.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Complexity Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The refactoring from cycle 2 resolution is a substantial improvement. All 7 prior complexity issues were addressed: `spawnAndDeliverPrompt` now uses a context object with a `failWith` helper, the double `as unknown` cast was eliminated by adding `env` to `TmuxSpawnCoreConfig`, `spawn()` nesting was flattened via `tryReuseSession()`, `handleOrchestrateInteractive` dropped from 176 to 108 lines via `attachAndFinalize` extraction, and the magic number was named. The `resolveContainerDeps` and `spawnAndDeliverPrompt` teardown duplication was consolidated.

The one new finding is the `reuseSession()` method at 163 lines, which grew due to the B1-x regression fixes. Each fix is individually well-documented and tested, but the aggregate method is too long for comfortable maintenance. Extracting the two branches into named helpers would bring it under control.

Condition:
1. Extract `reuseSession()` branches into named private methods to reduce its length from 163 to ~60 lines (HIGH).
