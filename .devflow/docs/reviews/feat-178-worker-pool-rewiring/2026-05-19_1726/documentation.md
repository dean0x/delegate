# Documentation Review Report

**Branch**: feat/178-worker-pool-rewiring -> main
**Date**: 2026-05-19

## Issues in Your Changes (BLOCKING)

### HIGH

**CLAUDE.md File Locations table missing new `src/core/tmux-types.ts`** - `CLAUDE.md:270-315`
**Confidence**: 95%
- Problem: The PR introduces a new core-layer module `src/core/tmux-types.ts` that defines the consumer-facing port interfaces (`TmuxConnectorPort`, `TmuxSessionManagerCorePort`, `TmuxHandle`, `OutputMessage`, `SpawnCallbacks`). This is a key architectural file in the core layer, but it is not listed in the File Locations table. The table already lists every other core-layer module (domain.ts, events.ts, dependency-graph.ts, orchestrator-scaffold.ts). Developers looking for tmux port contracts will not find them here.
- Fix: Add a row to the File Locations table:
  ```
  | Tmux port interfaces | `src/core/tmux-types.ts` |
  ```

**CLAUDE.md Testing section references stale mock names** - `CLAUDE.md:232`
**Confidence**: 88%
- Problem: The Testing guidelines say "all tests use mocks (MockWorkerPool, MockProcessSpawner)". The PR rewires EventDrivenWorkerPool to use TmuxConnectorPort, and the test fixtures now include `createMockTmuxConnector`. The MockProcessSpawner name is misleading for the new architecture since workers are tmux-based, not process-based. The reference should reflect the current mock landscape so developers know which mocks to use.
- Fix: Update the line to:
  ```
  - **No real process spawning** - all tests use mocks (MockWorkerPool, MockTmuxConnector)
  ```
  Or include both if ProcessSpawner mocks remain in use for backward-compat tests.

**CLAUDE.md Architecture Notes missing tmux/worker pool architecture** - `CLAUDE.md:50-64`
**Confidence**: 85%
- Problem: The Architecture Notes section describes the "Hybrid Event-Driven System" and lists all key handlers, but says nothing about the worker pool runtime model. After this PR, the worker pool is fundamentally different: workers are tmux sessions (not child processes), identified by session name (not PID), with a C-c graceful-kill sequence. This is a significant architectural change that future developers need to understand. The section is where developers first look for the system's architecture.
- Fix: Add a brief note after the handler list:
  ```
  **Worker Runtime (Phase 3)**: Workers run as tmux sessions, not child processes.
  `EventDrivenWorkerPool` uses injected `TmuxConnectorPort` for all lifecycle operations.
  Workers are identified by tmux session name; `WorkerRegistration.pid` is 0 (sentinel).
  Kill sequence: C-c (graceful) -> 5s grace period -> force-destroy.
  Requires tmux >= 3.0.
  ```

### MEDIUM

**CLAUDE.md missing `EventDrivenWorkerPool` in File Locations table** - `CLAUDE.md:270-315`
**Confidence**: 82%
- Problem: The File Locations table lists repositories, handlers, and other implementations, but `src/implementations/event-driven-worker-pool.ts` (the central worker lifecycle module, heavily modified in this PR) is absent. It is the second-largest implementation file and the core of the worker subsystem.
- Fix: Add a row:
  ```
  | Worker pool | `src/implementations/event-driven-worker-pool.ts` |
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**RecoveryManager docstring header outdated** - `src/services/recovery-manager.ts:1-4`
**Confidence**: 82%
- Problem: The file-level docstring says "Event-driven recovery manager for startup task restoration / Handles loading tasks from database and emits events for recovery actions". After this PR, RecoveryManager also performs tmux session liveness checks as an alternative to PID checks. The docstring does not mention tmux or session-based recovery, which is now a core responsibility.
- Fix: Update the file docstring:
  ```typescript
  /**
   * Event-driven recovery manager for startup task restoration
   * Handles loading tasks from database and emits events for recovery actions.
   * Phase 3: Supports tmux session-based liveness checks alongside PID-based checks.
   */
  ```

**`recoverRunningTasks` docstring references PID-only model** - `src/services/recovery-manager.ts:394-413`
**Confidence**: 80%
- Problem: The long docstring for `recoverRunningTasks` is titled "PID-BASED RECOVERY for RUNNING tasks" and says "Checks if ... ownerPid is alive". After this PR, tmux workers use session liveness instead of PID. The actual code handles both paths (lines 427-432), but the docstring only describes the PID path, which is misleading.
- Fix: Update the title and description to reflect both paths:
  ```typescript
  /**
   * PID/SESSION-BASED RECOVERY for RUNNING tasks
   *
   * WHY THIS EXISTS:
   * Tasks stuck in RUNNING status are typically from crashed workers or server shutdowns.
   * ...
   * WHAT IT DOES:
   * - Checks if the task has a worker row in the workers table
   * - For tmux workers (pid=0): checks session liveness via sessionName
   * - For process workers: checks if ownerPid is alive
   * - If alive -> leave it alone
   * - If dead -> mark FAILED immediately
   * ...
   */
  ```

## Pre-existing Issues (Not Blocking)

### MEDIUM

**docs/FEATURES.md references PID-based crash detection without tmux context** - `docs/FEATURES.md:361,644`
**Confidence**: 80%
- Problem: FEATURES.md describes "SQLite Worker Coordination: workers table with PID-based crash detection". After this PR, crash detection uses tmux session liveness for tmux workers. This will become stale documentation when the feature ships. Not blocking since the file was not modified in this PR.
- Fix: Update at release time to mention dual-mode crash detection (PID and tmux session).

## Suggestions (Lower Confidence)

- **Missing CHANGELOG entry** - `CHANGELOG.md` (Confidence: 75%) -- This is a breaking change (WorkerRegistration.pid=0, EventDrivenWorkerPoolDeps interface changed, requires tmux >= 3.0). The CHANGELOG [Unreleased] section was not updated. Typically done at release time per project convention, so may be intentional.

- **ProcessSpawnerAdapter.buildTmuxCommand returns stub data** - `src/implementations/process-spawner-adapter.ts:50-62` (Confidence: 70%) -- The method changed from returning an error to returning stub/fake TmuxSpawnConfig data (`command: 'echo'`, `taskId: 'task-unknown'`). The `as unknown as TmuxSpawnConfig` cast bypasses type safety. No JSDoc explains this is a test-only shim. A brief comment would prevent confusion.

- **No docs/architecture/ update for tmux worker model** - `docs/architecture/EVENT_FLOW.md` (Confidence: 65%) -- EVENT_FLOW.md references `WorkerPool.onWorkerExit()` which no longer exists in the tmux model. The architecture docs were not updated, though they are rarely modified outside releases.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 3 | 1 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Documentation Score**: 6/10
**Recommendation**: CHANGES_REQUESTED

**Rationale**: The code itself has excellent inline documentation -- JSDoc comments, DESIGN DECISION annotations, and clear step-by-step comments throughout the new tmux integration. However, the project-level documentation (CLAUDE.md) has not been updated to reflect the architectural shift from process-based to tmux-based workers. CLAUDE.md is the primary orientation document for developers (and AI agents), and three gaps -- missing Architecture Notes, missing File Locations entries, and stale Testing mock references -- mean developers will get an outdated mental model of the worker subsystem. The `recoverRunningTasks` docstring titled "PID-BASED RECOVERY" is also misleading given the dual-mode recovery now implemented. These are straightforward text updates that should be addressed before merge. Applies PF-001 (do not defer issues to a future PR).
