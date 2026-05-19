# Regression Review Report

**Branch**: feat/simplify-event-system-88 -> main
**Date**: 2026-03-16
**Commits**: 5 (dd3ff3a, b180f88, 9f5f39d, 5ed284f, e5f5b2f)

## Summary of Changes

This PR is a Phase 1 simplification of the event system, moving from a "pure event-driven" architecture to a "hybrid" approach where:

- **Commands** (state changes) still flow through EventBus
- **Queries** (reads) now use direct repository access instead of event request-response

Key removals:
- 3 source files deleted: `AutoscalingManager`, `QueryHandler`, `OutputHandler`
- 3 test files deleted: corresponding tests for removed modules
- 16 event types removed from the union (query events, informational events, dead events)
- `TaskPersisted` intermediate event eliminated (PersistenceHandler now calls QueueHandler directly)

Net: -2,993 lines removed, +638 lines added across 39 files.

---

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Stale documentation reference: TaskPersisted in TASK-DEPENDENCIES.md** - `docs/TASK-DEPENDENCIES.md:88,90,674`
- Problem: The docs still reference `TaskPersisted` event and `QueueHandler.handleTaskPersisted()` in the dependency flow diagram and code references. This event was removed and replaced with a direct `QueueHandler.enqueueIfReady()` call from PersistenceHandler.
- Impact: Developers following these docs will be confused by references to an event that no longer exists.
- Fix: Update the task delegation flow diagram in `docs/TASK-DEPENDENCIES.md` to show the new direct call pattern:
  ```
  TaskDelegated
    --> PersistenceHandler saves task
        --> QueueHandler.enqueueIfReady() (direct call)
  ```
  Also update the code reference at line 674 to point to `enqueueIfReady()`.

**Stale documentation reference: TaskPersisted in TASK_ARCHITECTURE.md** - `docs/architecture/TASK_ARCHITECTURE.md:93,117,202,303,305`
- Problem: TASK_ARCHITECTURE.md still references `TaskPersisted` event in multiple places: event lifecycle (line 93), flow diagram (line 117), QueueHandler section (line 202), and handler code block (lines 303-305). This document was NOT updated by the PR even though EVENT_FLOW.md was.
- Impact: Architecture documentation diverges from implementation. New contributors will expect a `TaskPersisted` event that no longer exists.
- Fix: Update all five references in TASK_ARCHITECTURE.md to reflect the new direct call pattern. Lines 93 and 117 should show PersistenceHandler calling QueueHandler directly. Lines 202-305 should document `enqueueIfReady()` instead of `handleTaskPersisted()`.

**Stale test documentation: TaskPersisted in TESTING_ARCHITECTURE.md** - `tests/TESTING_ARCHITECTURE.md:312`
- Problem: Example code in TESTING_ARCHITECTURE.md shows `await waitForEvent(eventBus, 'TaskPersisted')` which references a removed event.
- Impact: Copy-paste of test patterns will produce broken tests.
- Fix: Update the example to match the new flow. Since PersistenceHandler now calls QueueHandler directly, the example should either listen for `TaskQueued` or demonstrate the direct-call testing pattern.

**Stale comment in index.ts** - `src/index.ts:4`
- Problem: File header still says "Main entry point with autoscaling" but autoscaling was removed in this PR.
- Impact: Minor misleading comment, but part of this diff's scope.
- Fix: Change to "Main entry point" or "Main entry point for Autobeat MCP Server".

### LOW

**Stale comments in worker-handler.test.ts** - `tests/unit/services/handlers/worker-handler.test.ts:127,167`
- Problem: Mock class JSDoc comments still reference the old event patterns they replaced: "replaces the NextTaskQuery event pattern" and "replaces the TaskStatusQuery event pattern".
- Impact: Minor documentation drift, but these comments describe a migration that is now complete.
- Fix: Update comments to describe current purpose, e.g., "Mock TaskQueue for direct dequeue testing" and "Mock TaskRepository for direct lookup testing".

---

## Issues in Code You Touched (Should Fix)

### MEDIUM

**QueueHandler.enqueueIfReady() called before eventBus is set** - `src/services/handlers/queue-handler.ts:58-118`, `src/services/handler-setup.ts:196-214`
- Problem: `QueueHandler.enqueueIfReady()` emits `TaskQueued` via `this.eventBus` (line 101). However, when PersistenceHandler calls `enqueueIfReady()` during the `TaskDelegated` flow, the `eventBus` field is set in `setup()` (line 34). The handler-setup code creates QueueHandler first (line 196), passes it to PersistenceHandler (line 207), then registers both via the standard handler registry which calls `setup(eventBus)`. Since both are registered and setup is called in the same registry pass, this works. However, if `enqueueIfReady()` were called before `setup()` completes (e.g., during bootstrap race), the `eventBus` would be undefined and the `TaskQueued` event would not fire, leading to tasks stuck in queue with no worker spawning.
- Impact: In the current code path this is safe because bootstrap always calls `setupEventHandlers()` before task delegation starts. But the defense-in-depth is weak -- the only guard is the `if (this.eventBus)` check that silently logs an error rather than failing.
- Fix: Consider either (a) passing `eventBus` as a constructor parameter to QueueHandler (matching WorkerHandler's pattern), or (b) adding an assertion/guard in `enqueueIfReady()` that fails fast if eventBus is not set. This is a "should fix" since the current ordering is correct but fragile.

---

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Stale autoscaling references in test documentation** - `tests/e2e/test-plans/009-autoscaling-basic.md`, `tests/e2e/test-plans/010-autoscaling-resource-limits.md`, `tests/README.md:90`, `tests/TESTING_ARCHITECTURE.md:46`
- Problem: E2E test plans and test documentation still reference autoscaling as a feature. The AutoscalingManager was entirely removed in this PR.
- Impact: These test plans describe testing a feature that no longer exists. Not blocking since these are e2e test plan files (not executed code), but should be cleaned up.
- Fix: Remove or archive the autoscaling test plans, update references in test README.

**Stale autoscaling reference in test fixture** - `tests/fixtures/test-doubles.ts:624`
- Problem: Comment references "production autoscaling concern" but autoscaling was removed.
- Impact: Minor documentation drift.
- Fix: Update comment to reference current worker management concern.

### LOW

**PersistenceHandler now depends directly on QueueHandler (concrete class)** - `src/services/handlers/persistence-handler.ts:20,25`
- Problem: PersistenceHandler imports and takes `QueueHandler` as a concrete dependency rather than an interface. This is a pre-existing architectural pattern choice in this PR (intentional replacement of event indirection with direct call), but it creates a coupling between two handlers.
- Impact: Testing requires mocking a concrete class. The test already demonstrates this with `mockQueueHandler as unknown as QueueHandler`. This is workable but less clean than an interface.
- Fix: Consider extracting an `Enqueueable` interface with `enqueueIfReady(task: Task): Promise<Result<void>>` and depending on that. Low priority since the current approach works and the coupling is intentional.

---

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 4 | 1 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 2 | 1 |

**Regression Score**: 8/10

The code changes themselves are regression-free. All 16 removed event types have been verified to have zero remaining references in `src/`. The migration from event-driven queries to direct repository calls is complete and consistent. Tests have been properly updated or removed. The deduction is for stale documentation that references removed events (`TaskPersisted` in 3 doc files, autoscaling in index.ts comment), which creates a risk of developer confusion but does not affect runtime behavior.

**Recommendation**: APPROVED_WITH_CONDITIONS

Conditions:
1. Update `docs/TASK-DEPENDENCIES.md` to remove `TaskPersisted` references (3 locations)
2. Update `docs/architecture/TASK_ARCHITECTURE.md` to remove `TaskPersisted` references (5 locations)
3. Update `tests/TESTING_ARCHITECTURE.md` example at line 312
4. Fix `src/index.ts` header comment (line 4)

These are all documentation-only fixes and should take minimal effort. No code logic changes required.
