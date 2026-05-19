# Architecture Review Report

**Branch**: feat/worker-coordination-89 -> main
**Date**: 2026-03-17
**Commits**: 7324e28, 0c496f3

## Summary of Changes

This PR introduces SQLite-based worker coordination for cross-process visibility:
1. New `WorkerRepository` interface + `SQLiteWorkerRepository` implementation for tracking active workers in DB
2. New `WorkerRegistration` domain type for cross-process coordination
3. PID-based crash recovery replacing the 30-minute staleness heuristic in `RecoveryManager`
4. `ResourceMonitor` now uses DB-based global worker count instead of in-memory settling heuristic
5. `ProcessConnector` gains periodic output flushing (500ms interval) to `OutputRepository`
6. `TaskManager.getLogs()` falls back to DB output when in-memory is empty (cross-process reads)
7. Database migration v9 adds `workers` table with proper indexes and FK constraints

## Issues in Your Changes (BLOCKING)

### HIGH

**OutputRepository interface defined in implementation layer, not core** - `src/implementations/output-repository.ts:15`
- Problem: The `OutputRepository` interface is defined inside `src/implementations/output-repository.ts` alongside its SQLite implementation. This PR extends its usage to three additional consumers (`ProcessConnector`, `TaskManagerService`, `EventDrivenWorkerPool`), all of which now import from the implementations layer. The services layer (`task-manager.ts:30`, `process-connector.ts:9`) imports directly from `../implementations/output-repository.js`, which violates the dependency direction rule: services should depend on core abstractions, not implementation details.
- Impact: Every consumer of `OutputRepository` is coupled to the implementation file. If a second implementation were added (e.g., a file-based or cloud-backed output store), you would need to update import paths across all consumers. This also creates an inconsistency: `WorkerRepository` is correctly placed in `core/interfaces.ts` while `OutputRepository` is not.
- Fix: Move the `OutputRepository` interface to `src/core/interfaces.ts` (alongside `WorkerRepository`, `TaskRepository`, etc.) and re-export from the implementation file for backward compatibility if needed. This is a pre-existing issue that this PR significantly amplifies by adding three new cross-layer imports.
- Category: Should-Fix (pre-existing interface, but this PR triples the coupling surface)

**ProcessConnector instantiated inside EventDrivenWorkerPool constructor** - `src/implementations/event-driven-worker-pool.ts:40`
- Problem: `EventDrivenWorkerPool` directly instantiates `ProcessConnector` via `new ProcessConnector(outputCapture, logger, outputRepository)`. This is tight coupling -- the pool creates its own collaborator rather than receiving it through constructor injection. Furthermore, `ProcessConnector` lives in the services layer, and `EventDrivenWorkerPool` lives in the implementations layer, creating a bidirectional cross-layer dependency (implementations -> services for ProcessConnector, services -> implementations for OutputRepository imports).
- Impact: `ProcessConnector` cannot be substituted in tests for the worker pool, and the pool is tightly bound to its flush-timing behavior. The cross-layer import (`src/implementations/event-driven-worker-pool.ts:17` imports from `../services/process-connector.js`) inverts the normal dependency direction.
- Fix: Inject `ProcessConnector` (or a narrower interface like `ProcessOutputConnector`) via the constructor instead of instantiating it internally. This would also resolve the bidirectional cross-layer dependency.
- Category: Should-Fix (pre-existing `new ProcessConnector()` pattern, but this PR adds `OutputRepository` as a new parameter passed through solely for internal instantiation)

### MEDIUM

**Duplicate mock factory functions across 7+ test files** - multiple test files
- Problem: `createMockWorkerRepo` / `createMockWorkerRepository` is copy-pasted identically across 7 test files (event-flow.test.ts, task-persistence.test.ts, worker-pool-management.test.ts, event-driven-worker-pool.test.ts, system-resource-monitor.test.ts, recovery-manager.test.ts, handler-setup.test.ts). Similarly, `createMockOutputRepository` / `createMockOutputRepo` is duplicated across 7 test files. The project already has a `TestWorkerRepository` class in `tests/fixtures/test-doubles.ts`, yet tests create local vi.fn()-based mocks instead.
- Impact: When the `WorkerRepository` or `OutputRepository` interface changes (e.g., adding a method), every single mock factory must be updated independently. This already happened -- every factory has the exact same 7 methods. DRY violation compounds maintenance cost.
- Fix: Consolidate into shared factories in `tests/fixtures/test-doubles.ts` or a new `tests/fixtures/mock-factories.ts`. For tests needing `vi.fn()` call assertions, create a factory function that wraps `TestWorkerRepository` methods with spies, or create a single `createMockWorkerRepository()` in a shared location.
- Category: Blocking (all new code introduced by this PR)

**500ms hardcoded flush interval in ProcessConnector** - `src/services/process-connector.ts:70`
- Problem: The periodic output flush interval is hardcoded as `500` milliseconds. This is not configurable and not derived from the `Configuration` object. For high-throughput scenarios, this could create excessive DB writes (every 500ms per active worker). For long-running tasks, this creates unnecessary write amplification since `save()` does full `INSERT OR REPLACE` each time.
- Impact: With 5 concurrent workers, this generates 10 DB writes per second regardless of whether output changed. The `save()` call does a full snapshot write, not an incremental append, which is wasteful when output hasn't changed between intervals.
- Fix: Make the flush interval configurable via `Configuration`, and consider tracking a dirty flag on the in-memory buffer to skip flushes when no new output has been captured since the last flush.
- Category: Blocking (new code)

## Issues in Code You Touched (Should Fix)

### MEDIUM

**ProcessConnector.flushOutput is public but exposes internal concern** - `src/services/process-connector.ts:113`
- Problem: Both `stopFlushing()` and `flushOutput()` are public methods called directly by `EventDrivenWorkerPool` during `kill()`. This means the pool must know about the connector's internal flushing lifecycle (stop flushing, then flush once, then kill). This is Feature Envy -- the pool orchestrates the connector's internal cleanup sequence.
- Fix: Consider a single `prepareForKill(taskId)` method on `ProcessConnector` that encapsulates the stop-then-flush sequence internally. The pool would call one method instead of managing two operations in the correct order.

**RecoveryManager.recover() has duplicate dead-worker cleanup logic** - `src/services/recovery-manager.ts:36-63` and `src/services/recovery-manager.ts:143-175`
- Problem: Phase 0 iterates all worker registrations and marks tasks as FAILED for dead owner PIDs. Then the RUNNING task loop does the same thing -- looks up worker registration, checks if owner PID is alive, marks as FAILED. A task whose worker was already cleaned in Phase 0 will be found with no worker row in the RUNNING loop and marked FAILED again (double update). While this is idempotent, it represents duplicated logic.
- Impact: Minor performance concern (duplicate DB updates) and maintenance concern (two places to update if the failure-marking logic changes).
- Fix: Phase 0 could collect the set of task IDs it already failed, and the RUNNING task loop could skip those. Or Phase 0 could be removed entirely since the RUNNING task loop already handles "no worker row" correctly.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**OutputRepository interface location (pre-existing)** - `src/implementations/output-repository.ts:15`
- The `OutputRepository` interface has been in the implementations layer since before this PR. All other repository interfaces (`TaskRepository`, `DependencyRepository`, `ScheduleRepository`, `WorkerRepository`, `CheckpointRepository`) live in `core/interfaces.ts`. This is an inconsistency in the architecture that predates this PR. This PR amplifies it by adding 3 new consumers of the interface.

**EventDrivenWorkerPool imports from services layer (pre-existing)** - `src/implementations/event-driven-worker-pool.ts:17`
- The `import { ProcessConnector } from '../services/process-connector.js'` creates a dependency from implementations -> services, which is the reverse of the normal dependency direction (services depend on implementations via core interfaces). This predates the PR.

### LOW

**`now` variable declared but used only once** - `src/services/recovery-manager.ts:141`
- The `const now = Date.now()` is declared before the RUNNING task loop but is only used in the `completedAt` assignment inside the loop. Minor style issue.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 2 | 1 |

## Architectural Assessment

### What This PR Does Well

1. **Clean domain modeling**: `WorkerRegistration` is correctly separated from `Worker` with clear rationale (ephemeral vs. persistent fields). The domain type is in `core/domain.ts` where it belongs.

2. **Interface-first design for WorkerRepository**: The interface is in `core/interfaces.ts`, the implementation is in `implementations/`, and all consumers depend on the interface. This follows the established DIP pattern perfectly.

3. **Synchronous Result<T> design decision**: Making `WorkerRepository` methods synchronous (matching better-sqlite3's nature) is architecturally correct and enables use inside `runInTransaction()`.

4. **PID-based recovery is architecturally superior**: Replacing the 30-minute staleness heuristic with definitive PID-based detection is a sound architectural improvement. It eliminates false positives and false negatives simultaneously.

5. **DB migration is clean**: Version 9 migration follows existing patterns, includes proper indexes, and uses FOREIGN KEY with ON DELETE CASCADE.

6. **Proper cleanup extraction**: The `cleanupWorkerState()` method consolidates cleanup logic that was previously duplicated between `kill()` and `handleWorkerCompletion()`.

### Concerns

1. **OutputRepository interface misplacement is amplified**: This PR correctly places `WorkerRepository` in `core/interfaces.ts` but continues importing `OutputRepository` from the implementations layer. The inconsistency is now more visible.

2. **Constructor parameter growth**: `EventDrivenWorkerPool` now takes 7 constructor parameters. While each is necessary, this is approaching the threshold where a configuration/options object should be considered.

3. **Test mock duplication is significant**: 7 copies of `createMockWorkerRepo` and 7 copies of `createMockOutputRepo` is a maintenance burden that should be addressed before this pattern is replicated further.

**Architecture Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The architectural design of the worker coordination feature itself is solid. The `WorkerRepository` interface placement, the `WorkerRegistration` domain type, and the PID-based recovery approach are all well-designed. However, the duplicate mock factories across 7+ test files (all new in this PR) and the hardcoded flush interval should be addressed. The `OutputRepository` interface misplacement and `ProcessConnector` tight coupling are pre-existing but worth fixing while this area is being actively modified.
