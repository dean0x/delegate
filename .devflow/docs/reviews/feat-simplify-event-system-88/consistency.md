# Consistency Review Report

**Branch**: feat/simplify-event-system-88 -> main
**Date**: 2026-03-16
**PR**: #91

## Overview

This PR performs a Phase 1 simplification of the event system, converting from a "pure event-driven" architecture to a "hybrid" model where commands flow through events and queries use direct repository access. It removes 9 informational/dead events, eliminates QueryHandler and OutputHandler, deletes the AutoscalingManager, and linearizes the TaskPersisted trigger chain into a direct PersistenceHandler -> QueueHandler call.

39 files changed: 638 insertions, 2,993 deletions (net -2,355 lines).

---

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Stale "autoscaling" reference in src/index.ts doc comment** - `src/index.ts:4`
- Problem: The file-level doc comment reads `Main entry point with autoscaling` but the AutoscalingManager was fully removed in this PR. This is a terminology inconsistency introduced by this PR (the comment was accurate on main, but this PR removed autoscaling without updating this line).
- Impact: Developers reading the entry point will expect autoscaling logic that no longer exists.
- Fix:
  ```typescript
  // Before
  * Main entry point with autoscaling

  // After
  * Main entry point for Autobeat MCP Server
  ```

**Stale "autoscaling workers" in CLAUDE.md project overview** - `CLAUDE.md:7`
- Problem: The project overview still says "autoscaling workers" but the AutoscalingManager was deleted. This line was not modified in the diff, however the CLAUDE.md Architecture Notes section on line 52 WAS updated to say "Hybrid Event-Driven System" -- so one part of the same file was updated while another was not.
- Impact: CLAUDE.md is the primary guidance document for AI coding assistants. Stale architecture terminology here will mislead future sessions.
- Fix:
  ```markdown
  // Before
  Autobeat is an MCP (Model Context Protocol) server that enables task delegation to background Claude Code instances. It uses event-driven architecture with autoscaling workers, task dependencies (DAG-based), and SQLite persistence.

  // After
  Autobeat is an MCP (Model Context Protocol) server that enables task delegation to background Claude Code instances. It uses hybrid event-driven architecture with resource-aware workers, task dependencies (DAG-based), and SQLite persistence.
  ```

---

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Stale comment references removed event name in worker-handler test** - `tests/unit/services/handlers/worker-handler.test.ts:127,167`
- Problem: Comments in the mock classes say `replaces the NextTaskQuery event pattern` and `replaces the TaskStatusQuery event pattern`. These event types no longer exist. The code is correct (direct calls are the new pattern), but the comments reference the old world.
- Impact: Test readers may be confused about removed events that these mocks supposedly replace.
- Fix:
  ```typescript
  // Before
  * Mock TaskQueue for testing -- replaces the NextTaskQuery event pattern
  * Mock TaskRepository for testing -- replaces the TaskStatusQuery event pattern

  // After
  * Mock TaskQueue for testing -- WorkerHandler calls dequeue() directly
  * Mock TaskRepository for testing -- WorkerHandler calls findById() directly
  ```

**Stale `TaskPersisted` reference in TESTING_ARCHITECTURE.md** - `tests/TESTING_ARCHITECTURE.md:312`
- Problem: The testing architecture doc still references `await waitForEvent(eventBus, 'TaskPersisted')` but the `TaskPersisted` event was removed in this PR.
- Impact: Developers following this guide will write tests referencing a non-existent event type.
- Fix: Update the example to use the current flow (either `TaskQueued` or direct call pattern).

### LOW

**`TaskQueuedEvent` type interface is incomplete** - `src/core/events/events.ts:38-41`
- Problem: `TaskQueuedEvent` only declares `taskId: TaskId` but all emit sites (QueueHandler:104-108, RecoveryManager:67-69, RecoveryManager:151-153) also pass `task: Task`. The extra `task` field works at runtime due to TypeScript's structural typing and the `Omit<T, ...>` pattern in the emit signature, but the type is not self-documenting.
- Impact: This is a pre-existing pattern (the `task` field was passed before this PR too), but the PR touched these emit sites and had the opportunity to align the type. This is a minor type documentation concern, not a runtime issue.
- Fix (optional):
  ```typescript
  export interface TaskQueuedEvent extends BaseEvent {
    type: 'TaskQueued';
    taskId: TaskId;
    task?: Task; // Included for downstream consumers (WorkerHandler, etc.)
  }
  ```

---

## Pre-existing Issues (Not Blocking)

### LOW

**README.md still references autoscaling** - `README.md:210`
- Problem: `Event-driven system with autoscaling workers and SQLite persistence.` -- this was not changed by the PR and is pre-existing, but is now inconsistent with the architecture after removing AutoscalingManager.
- Impact: User-facing docs describe removed functionality.
- Recommendation: Address in a follow-up documentation cleanup.

**e2e test plans reference autoscaling** - `tests/e2e/test-plans/009-autoscaling-basic.md`, `tests/e2e/test-plans/010-autoscaling-resource-limits.md`
- Problem: These test plan files reference autoscaling behavior that no longer exists with the removal of AutoscalingManager.
- Impact: These are documentation-only test plans (not executed code), but could be confusing.
- Recommendation: Mark as obsolete or remove in a follow-up.

---

## Consistency Analysis

### Pattern Consistency: STRONG

The PR demonstrates excellent consistency in the following areas:

1. **Handler initialization patterns**: The two-tier pattern (standard handlers via `setup(eventBus)`, factory handlers via `static async create()`) is clearly maintained and well-documented in handler-setup.ts. The counts were updated correctly: 3 standard + 3 factory = 6 total.

2. **Result type usage**: All new direct repository calls follow the existing `Result<T>` pattern. No throws introduced. Error handling is consistent across TaskManagerService methods (getStatus, getLogs, retry, resume).

3. **Naming conventions**: All new method names follow camelCase. `enqueueIfReady()` follows the existing pattern of descriptive method names.

4. **Architecture documentation alignment**: CLAUDE.md Architecture Notes, EVENT_FLOW.md, HANDLER-DECOMPOSITION-INVARIANTS.md, and TASK_ARCHITECTURE.md were all updated consistently to reflect "hybrid" terminology.

5. **Event type comment accuracy**: The doc comment claims "25 event types remain" and the union type has exactly 25 members -- verified.

6. **Test patterns**: Tests were updated to match the new direct-call patterns. PersistenceHandler tests correctly use a mock QueueHandler. Integration tests were simplified to match the reduced event chain.

### Pattern Deviation: INTENTIONAL, WELL-JUSTIFIED

1. **PersistenceHandler -> QueueHandler direct call**: This is the only handler-to-handler direct dependency (line 25 of persistence-handler.ts). All other handler communication uses events. This is intentional and explicitly documented -- it linearizes the `TaskDelegated -> [persist] -> [enqueue]` chain which was previously an unnecessary event hop via `TaskPersisted`.

2. **WorkerHandler has both `eventBus` and `taskQueue`/`taskRepo` injected**: This is consistent with the hybrid approach. Commands still emit events (`TaskStarted`, `TaskCompleted`, etc.), while reads use direct repository access. The constructor parameter list is longer but follows the same DI pattern as other handlers.

### Package.json Script Consistency: CORRECT

The `test:handlers` script correctly removed `query-handler.test.ts` and `output-handler.test.ts`. The `test:services` script correctly removed `autoscaling-manager.test.ts`. No orphaned test file references remain.

---

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 1 |
| Pre-existing | 0 | 0 | 0 | 2 |

**Consistency Score**: 8/10

The PR is highly consistent internally. The simplification is applied uniformly: all query events removed, all direct-call replacements follow the same pattern, all documentation updated to "hybrid" terminology. The two blocking-MEDIUM items are minor doc comment oversights (stale "autoscaling" text in index.ts and CLAUDE.md) that take < 1 minute to fix.

**Recommendation**: APPROVED_WITH_CONDITIONS

Conditions:
1. Fix the stale "autoscaling" reference in `src/index.ts:4`
2. Fix the stale "autoscaling workers" reference in `CLAUDE.md:7`

Both are trivial string edits. The architectural consistency of the refactoring itself is excellent -- the hybrid pattern is applied uniformly across all changed files and the documentation accurately reflects the new reality.
