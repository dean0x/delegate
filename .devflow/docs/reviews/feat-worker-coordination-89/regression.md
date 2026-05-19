# Regression Review Report

**Branch**: feat/worker-coordination-89 -> main
**Date**: 2026-03-17
**Commits**: 7324e28 feat: SQLite worker coordination + output persistence (#89), 0c496f3 fix: address self-review issues

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

**Worker registration happens AFTER in-memory map insertion, creating a window for inconsistent state** - `src/implementations/event-driven-worker-pool.ts:105-123`
- Problem: The spawn flow is: (1) add to in-memory maps (line 105-106), (2) register in DB (line 109), (3) on failure, kill process and remove from maps (line 119-122). Between steps 1 and 2, a concurrent `getWorkerCount()` or `getWorker()` call would see a worker that is not yet registered in the DB. While this window is very short in practice (synchronous SQLite), the ordering creates an opportunity for `canSpawnWorker()` to undercount (DB shows N-1, in-memory shows N).
- Impact: In multi-process scenarios (the primary use case for this feature), a second process could read `getGlobalCount()` as N-1 while the first process has already inserted into its in-memory map, potentially allowing one extra spawn beyond `maxWorkers`.
- Fix: Move the DB registration to happen BEFORE adding to in-memory maps, or accept this as a known tiny race window and document it. The registration error path already handles cleanup correctly.

**`test:implementations` script does not exclude `worker-repository.test.ts`, causing double-execution** - `package.json:28`
- Problem: The `worker-repository.test.ts` was added to `test:repositories` (line 26), but the `test:implementations` script (line 28) runs all files under `tests/unit/implementations/` and only excludes the 5 original repository test files -- not `worker-repository.test.ts`. When running `test:all`, the worker-repository tests will execute twice: once in `test:repositories` and again in `test:implementations`.
- Impact: Double test execution wastes time and memory. In Claude Code's constrained environment, this extra memory usage could contribute to the memory exhaustion problem the test grouping was designed to prevent.
- Fix: Add `--exclude='**/worker-repository.test.ts'` to the `test:implementations` script:
  ```json
  "test:implementations": "NODE_OPTIONS='--max-old-space-size=2048' vitest run tests/unit/implementations --exclude='**/dependency-repository.test.ts' --exclude='**/task-repository.test.ts' --exclude='**/database.test.ts' --exclude='**/checkpoint-repository.test.ts' --exclude='**/output-repository.test.ts' --exclude='**/worker-repository.test.ts' --no-file-parallelism",
  ```

### MEDIUM

**Recovery behavior change: recent RUNNING tasks are now marked FAILED instead of re-queued** - `src/services/recovery-manager.ts:143-175`
- Problem: This is an intentional behavior change, but it is a significant regression in automatic recovery behavior. Previously, RUNNING tasks less than 30 minutes old were re-queued (given a second chance). Now, any RUNNING task without a live worker is immediately marked FAILED. During the first startup AFTER upgrading to this version, all pre-existing RUNNING tasks will have no worker rows in the new `workers` table (the table is empty on first migration). This means every RUNNING task will be marked FAILED on the first recovery pass after upgrade.
- Impact: One-time data loss of in-progress tasks during upgrade. Users upgrading from pre-v1.0 will see all their RUNNING tasks immediately marked as FAILED instead of being given a recovery chance.
- Fix: Consider adding migration-aware logic: if the workers table was just created (migration version 9 was just applied), fall back to the old 30-minute heuristic for that single recovery pass. Alternatively, document this clearly in release notes as a breaking behavior change.

**Process connector exit handler is now asynchronous, changing timing semantics** - `src/services/process-connector.ts:36-42`
- Problem: The `safeOnExit` handler was previously synchronous (calling `onExit(code ?? null)` directly). It is now asynchronous: it calls `flushOutput()` (returns a Promise), then `.then(clear)`, then `.catch(log)`, then `.finally(onExit)`. This means `onExit` is now called on a subsequent microtask tick rather than synchronously. The `handleWorkerCompletion` callback in the worker pool depends on this being called to clean up state and emit events.
- Impact: Any code that assumed synchronous completion notification after process exit will now see a delay. The test updates (adding `await vi.runAllTimersAsync()`) confirm this timing change. In production, this means worker pool state cleanup and event emission happen asynchronously after process exit rather than synchronously.
- Fix: This is intentional to support the flush-before-completion pattern. The tests have been properly updated. However, this should be documented in the PR description as a behavioral change, and callers should be aware that `handleWorkerCompletion` is no longer invoked synchronously on process exit.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**OutputRepository interface defined in implementation file, not core/interfaces.ts** - `src/implementations/output-repository.ts:15-20`
- Problem: The `WorkerRepository` interface was correctly placed in `src/core/interfaces.ts` (following the DIP pattern), but `OutputRepository` -- now used as a dependency in `TaskManagerService`, `ProcessConnector`, and `EventDrivenWorkerPool` -- is still defined in the implementation file. This creates an import from `implementations/` into `services/` and `core/` layers.
- Impact: Architectural inconsistency. Not a regression per se, but this PR introduces three new consumers of `OutputRepository` while keeping the interface in the wrong layer.
- Fix: Move the `OutputRepository` interface to `src/core/interfaces.ts` (separate PR to avoid scope creep).

**Stale constructor signature in TEST_STANDARDS.md** - `tests/TEST_STANDARDS.md:91`
- Problem: The documentation example shows `new TaskManagerService(eventBus, repository, logger, config)` which no longer matches the constructor signature (now requires `outputCapture` and `outputRepository` parameters).
- Impact: Developers following the documentation example will get compile errors.
- Fix: Update the example to match the current constructor signature.

## Pre-existing Issues (Not Blocking)

### LOW

**`settlingWorkers` variable computed but unused for max-workers check** - `src/implementations/resource-monitor.ts:85`
- Problem: `canSpawnWorker()` still computes `settlingWorkers` from `this.recentSpawnTimestamps.length` (line 85) but the max-workers check now uses `globalResult.value` (DB count) exclusively. The `settlingWorkers` count is only used later for the CPU/memory settling check, but its computation at line 85 could be moved closer to its actual use for clarity.
- Impact: Minor readability concern. No functional issue.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 1 |

**Regression Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

### Rationale

The PR introduces a well-designed worker coordination layer with SQLite-backed cross-process visibility. The core regression patterns are sound: no exports removed, no files deleted, no incomplete migrations of constructor call sites (all 23 files updated correctly).

However, two issues warrant changes before merge:

1. **Double test execution** (package.json) is a straightforward fix -- add the exclude for `worker-repository.test.ts` to the `test:implementations` script.

2. **Upgrade path for RUNNING tasks** is the most consequential regression risk. On the first startup after upgrading, ALL RUNNING tasks will be marked FAILED because the workers table starts empty. This is a silent data loss scenario that should either be mitigated with migration-aware recovery logic or explicitly documented as a breaking change in release notes.

The async timing change in `ProcessConnector` is well-handled with proper test updates, and the overall migration of all constructor call sites is thorough and complete.
