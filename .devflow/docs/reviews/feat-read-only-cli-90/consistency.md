# Consistency Review Report

**Branch**: feat/read-only-cli-90 -> main
**Date**: 2026-03-18
**PR**: #100

## Issues in Your Changes (BLOCKING)

### HIGH

**OutputRepository interface lives in implementation layer, not core/interfaces.ts** - `src/cli/read-only-context.ts:19`
- Problem: All other repository interfaces (`TaskRepository`, `ScheduleRepository`, `DependencyRepository`, `CheckpointRepository`, `WorkerRepository`) are defined in `src/core/interfaces.ts`. `OutputRepository` is the sole exception, defined in `src/implementations/output-repository.ts`. The new `ReadOnlyContext` imports it from the implementation layer, making this pre-existing inconsistency more visible by expanding its usage surface.
- Impact: The `ReadOnlyContext` interface at line 26 depends on a concrete implementation file (`../implementations/output-repository.js`) for its type, breaking the Dependency Inversion Principle the rest of the codebase follows. This is a pre-existing architectural issue, but the new code amplifies its reach by adding a new consumer.
- Category: **Reclassified to Pre-existing** -- The `OutputRepository` interface placement predates this PR. The new code correctly uses the interface that exists, same as `TaskManagerService` and `EventDrivenWorkerPool`. Not blocking.

### MEDIUM

**Unused import: `ReadOnlyContext` type in test file** - `tests/unit/read-only-context.test.ts:5`
- Problem: `ReadOnlyContext` is imported but never used as a type annotation anywhere in the test file. Only `createReadOnlyContext` is actually called.
- Impact: Unused imports are a lint violation and add noise. The codebase is generally clean of unused imports (session 84 explicitly removed 2 unused imports).
- Fix:
  ```typescript
  // Before
  import { createReadOnlyContext, ReadOnlyContext } from '../../src/cli/read-only-context.js';
  // After
  import { createReadOnlyContext } from '../../src/cli/read-only-context.js';
  ```

**Inconsistent spinner pattern between read-only commands** - `src/cli/commands/schedule.ts:17-20` vs `src/cli/commands/status.ts:10-11` and `src/cli/commands/logs.ts:9-10`
- Problem: In `schedule.ts`, the read-only path creates a spinner, starts it with `'Initializing...'`, calls `withReadOnlyContext(s)`, then stops it with `'Ready'`. In `status.ts` and `logs.ts`, the spinner starts with a contextual message (`'Fetching status for ...'` / `'Fetching logs for ...'`) and never shows an intermediate `'Ready'` state -- it transitions directly to the result. The schedule read-only path introduces a two-phase spinner (`Initializing...` then `Ready`) that the other read-only commands do not use.
- Impact: Minor UX inconsistency. Users see different initialization feedback depending on which read-only command they run.
- Fix: Either adopt the schedule pattern in status/logs (two-phase spinner) or use the status/logs pattern in schedule (single contextual spinner). The status/logs pattern is more concise and matches the existing CLI feel.

**`scheduleGet` silently continues on history fetch failure** - `src/cli/commands/schedule.ts:330-334`
- Problem: When `repo.getExecutionHistory()` fails, the code prints an error via `ui.error()` but continues rendering the schedule details without the history section and without a non-zero exit code. This is a graceful degradation pattern, but it is inconsistent with every other repository call in the same file and in `status.ts` / `logs.ts`, where any failed repository call triggers `process.exit(1)`.
- Impact: The user sees an error message mixed with successful output. The exit code is 0 despite an error. If a consumer scripts against exit codes, they would miss this failure.
- Fix: Either exit with code 1 after logging the error (consistent with all other repo failures), or if graceful degradation is intentional, document it with a comment explaining why history is optional.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**No database cleanup in CLI read-only commands** - `src/cli/commands/status.ts`, `src/cli/commands/logs.ts`, `src/cli/commands/schedule.ts`
- Problem: The read-only commands call `withReadOnlyContext(s)` to get a `ReadOnlyContext` with an open `Database` connection, but never call `ctx.database.close()` before `process.exit()`. The mutation commands using `withServices()` also do not call `container.dispose()` (except `run.ts` which does), so this is consistent with the existing pattern for short-lived CLI commands -- `process.exit()` cleans up. However, the `ReadOnlyContext` interface exposes `database` as a public field, and the tests explicitly call `ctx.database.close()`, creating a consistency gap between test code and production code.
- Impact: Low practical impact since `process.exit()` closes everything, but the tests set an expectation of explicit cleanup that production code does not follow.
- Fix: Either remove `database` from the `ReadOnlyContext` public interface (since CLI commands never need it) and handle cleanup internally, or accept that `process.exit()` handles it. The current approach is fine for CLI commands; the test cleanup is good practice for test isolation.

**`scheduleList` and `scheduleGet` accept `ScheduleRepository` directly while `scheduleCreate/Cancel/Pause/Resume` accept `ScheduleService`** - `src/cli/commands/schedule.ts:258,301`
- Problem: The refactored helper functions now use two different abstractions within the same file -- some take a repository (data layer), some take a service (business logic layer). This is architecturally intentional (read-only vs mutation), but creates a visible pattern split within a single module.
- Impact: Future developers may need to understand why some helpers take a repository and others take a service. The dual-abstraction pattern is non-obvious.
- Fix: This is intentional and well-documented via comments at lines 15 and 30. No code change needed, but consider a brief module-level doc comment noting the read-only/mutation split.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`OutputRepository` interface defined in implementation layer** - `src/implementations/output-repository.ts:15`
- Problem: Every other repository interface (`TaskRepository`, `ScheduleRepository`, `DependencyRepository`, `CheckpointRepository`, `WorkerRepository`) is defined in `src/core/interfaces.ts`. `OutputRepository` alone is defined alongside its implementation in `src/implementations/output-repository.ts`.
- Impact: Violates the Dependency Inversion Principle pattern the rest of the codebase follows. Any consumer must import from the implementation layer to reference the interface.
- Fix: Move `OutputRepository` interface to `src/core/interfaces.ts` alongside the other repository interfaces. Update imports in `bootstrap.ts`, `task-manager.ts`, `process-connector.ts`, `event-driven-worker-pool.ts`, and the new `read-only-context.ts`.

### LOW

**`status.ts` imports `Task` type but uses it only for a type assertion in the list path** - `src/cli/commands/status.ts:1,66`
- Problem: `import type { Task } from '../../core/domain.js'` is used only at line 66 (`result.value as Task[]`). The single-task path at line 25 uses `result.value` directly without a type assertion, which is more idiomatic.
- Impact: The type assertion at line 66 is a cast rather than relying on the repository's return type. Minor style inconsistency.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 3 | 0 |
| Should Fix | - | 0 | 2 | 0 |
| Pre-existing | - | - | 1 | 1 |

**Consistency Score**: 7/10

The PR introduces a well-conceived `ReadOnlyContext` pattern that cleanly separates read-only CLI commands from mutation commands. The core abstraction (`createReadOnlyContext` returning `Result<ReadOnlyContext>`) follows the codebase's Result pattern consistently. The refactored commands correctly use direct repository access for queries, matching the hybrid architecture's design intent. The new test file follows established testing patterns (temp directory isolation, `beforeEach`/`afterEach` cleanup, Result unwrapping). The issues found are minor: an unused import, a spinner UX inconsistency between read-only commands, and a graceful-degradation decision in `scheduleGet` that deviates from the fail-fast pattern used everywhere else.

**Recommendation**: APPROVED_WITH_CONDITIONS

Conditions:
1. Remove the unused `ReadOnlyContext` import from the test file
2. Consider aligning the `scheduleGet` history-failure behavior with the fail-fast pattern used by all other repository calls, or add a comment justifying the graceful degradation
