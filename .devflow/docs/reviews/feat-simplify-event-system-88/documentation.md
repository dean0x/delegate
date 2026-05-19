# Documentation Review Report

**Branch**: feat/simplify-event-system-88 -> main
**Date**: 2026-03-16
**PR**: #91

## Overview

This PR simplifies the event system by: (1a) replacing query events with direct repository calls, (1b) linearizing the TaskPersisted trigger chain, and (1c) removing 9 informational/dead events and dead code. It removes AutoscalingManager, QueryHandler, OutputHandler, and multiple event types (TaskPersisted, TaskDeleted, WorkerSpawned, WorkerKilled, LogsRequested, TaskConfigured, TaskResumed, RecoveryStarted, RecoveryCompleted, SystemResourcesUpdated, NextTaskQuery, TaskStatusQuery, TaskLogsQuery, ScheduleQuery, and their response types).

The documentation updates in this PR are substantial and well-executed. CLAUDE.md, EVENT_FLOW.md, TASK_ARCHITECTURE.md, and HANDLER-DECOMPOSITION-INVARIANTS.md were all updated. However, several documentation files outside the direct scope of changes still contain stale references that contradict the new architecture.

---

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Event count comment may become stale** - `src/core/events/events.ts:4`
- Problem: The comment states "25 event types remain after Phase 1 simplification." While currently accurate (25 interfaces, 25 union members), hardcoding a count in a comment creates a maintenance burden -- any future event addition will cause drift.
- Fix: Remove the count or replace with a general statement:
  ```typescript
  * Queries use direct repository access (no query events).
  * Simplified in Phase 1 -- removed query and informational events.
  ```

---

## Issues in Code You Touched (Should Fix)

### HIGH

**TASK_ARCHITECTURE.md still references TaskPersisted event throughout** - `docs/architecture/TASK_ARCHITECTURE.md:93,117,202,303,305`
- Problem: Section 2.2 "Lifecycle with Dependencies" still shows `TaskPersisted` as lifecycle step 2. Section 2.3 "Complete Flow Diagram" still shows `[TaskPersistedEvent] (saved to DB)` and `QueueHandler.handleTaskPersisted()`. Section 3.2 "Event Flow Architecture" shows `TaskPersisted -> Check: isBlocked(task)?`. Section 5.2 "Dependency-Aware Queueing" shows `handleTaskPersisted` code example. These all reference a deleted event type.
- Impact: Actively misleading -- developers reading this document will look for an event that no longer exists. The new flow is PersistenceHandler saving and directly calling `QueueHandler.enqueueIfReady()`.
- Fix: Update section 2.2 step 2 to describe the new direct call from PersistenceHandler to QueueHandler. Update section 2.3 diagram to remove `[TaskPersistedEvent]` and show `QueueHandler.enqueueIfReady()`. Update section 3.2 diagram to show `enqueueIfReady()` instead of `TaskPersisted`. Replace section 5.2 code example with the new `enqueueIfReady()` method signature.

**TASK_ARCHITECTURE.md section 8.4 contradicts the new hybrid architecture** - `docs/architecture/TASK_ARCHITECTURE.md:686-691`
- Problem: States "3. No direct repository access from outside handlers" -- this is the old "pure event-driven" rule. The entire point of this PR is to enable direct repository access for queries from TaskManager and WorkerHandler.
- Impact: Directly contradicts the architectural change made in this PR. A developer reading this section would believe direct repo access is prohibited.
- Fix: Update section 8.4 to reflect the hybrid pattern:
  ```
  1. **Commands**: Fire-and-forget `emit()`
  2. **Queries**: Direct repository calls (TaskRepository, OutputCapture)
  3. **State changes** MUST go through events
  ```

**TASK_ARCHITECTURE.md section 12 "Events vs Direct Access" guideline is wrong** - `docs/architecture/TASK_ARCHITECTURE.md:776-783`
- Problem: Shows direct repository access as "BAD" pattern with a red X, and events as the only correct "GOOD" pattern. This contradicts the PR's explicit intent to make direct repo reads the standard approach for queries.
- Impact: Actively misleading -- marks the new recommended pattern as incorrect.
- Fix: Update to show the hybrid pattern: events for commands/state changes, direct access for reads.

### MEDIUM

**TASK-DEPENDENCIES.md references deleted event flow** - `docs/TASK-DEPENDENCIES.md:88-91,674`
- Problem: The event flow diagram (line 88-91) shows `TaskPersisted -> QueueHandler.handleTaskPersisted()`. The code references section (line 674) mentions `handleTaskPersisted()` in queue-handler.ts. Both reference a deleted event and method.
- Impact: Misleading to developers working on the dependency system. The new flow calls `enqueueIfReady()` directly.
- Fix: Update line 88-91 to show PersistenceHandler calling `QueueHandler.enqueueIfReady()` directly. Update line 674 to reference `enqueueIfReady()`.

**HANDLER-DECOMPOSITION-INVARIANTS.md references NextTaskQuery** - `docs/architecture/HANDLER-DECOMPOSITION-INVARIANTS.md:59`
- Problem: Step 3 of processNextTask ordering invariants says "Get task THIRD - Via NextTaskQuery event". NextTaskQuery was removed; the worker handler now calls `TaskQueue.dequeue()` directly.
- Impact: Incorrect invariant documentation for a critical safety-related method.
- Fix: Update to "Get task THIRD - Via TaskQueue.dequeue() direct call".

---

## Pre-existing Issues (Not Blocking)

### HIGH

**CLAUDE.md Project Overview still mentions "autoscaling workers"** - `CLAUDE.md:7`
- Problem: The project overview line reads "...event-driven architecture with autoscaling workers, task dependencies (DAG-based), and SQLite persistence." AutoscalingManager was deleted in this PR. The feature description no longer matches reality.
- Impact: First line developers read about the project will set incorrect expectations. Not blocking because it's a pre-existing description and autoscaling was more than just the removed manager, but should be addressed.
- Fix: Update to reflect the current architecture: "...hybrid event-driven architecture with task dependencies (DAG-based) and SQLite persistence."

**README.md architecture section references autoscaling and pure event-driven** - `README.md:210`
- Problem: States "Event-driven system with autoscaling workers and SQLite persistence. Components communicate through a central EventBus, eliminating race conditions and direct state management." Two issues: (1) autoscaling manager was removed, (2) "eliminating...direct state management" contradicts the new hybrid approach where queries use direct repo access.
- Impact: User-facing documentation that misrepresents current architecture.
- Fix: Update to "Hybrid event-driven system with SQLite persistence. Commands flow through a central EventBus; queries use direct repository access."

**FEATURES.md references removed components** - `docs/FEATURES.md:23-41,151-159`
- Problem: Section "Autoscaling & Resource Management" describes AutoscalingManager capabilities. Architecture section lists "Autoscaling Manager: Dynamic worker pool management" and "Event Handlers: Specialized handlers (Persistence, Queue, Worker, Output)" -- Output handler was deleted.
- Impact: Feature documentation describes capabilities that no longer exist as described.
- Fix: Update the autoscaling section to describe the current resource management approach (WorkerHandler handles spawn decisions with resource checks). Remove OutputHandler from the handler list. Update handler list to current set.

**FEATURES.md lists "Zero Direct State" as design pattern** - `docs/FEATURES.md:159`
- Problem: States "Zero Direct State: TaskManager emits events, handlers manage state" which contradicts the hybrid model where TaskManager now directly queries repositories.
- Impact: Misleading architectural claim.
- Fix: Update to reflect hybrid pattern.

### MEDIUM

**tests/TESTING_ARCHITECTURE.md references deleted test file** - `tests/TESTING_ARCHITECTURE.md:46`
- Problem: File tree shows `autoscaling-manager.test.ts` which was deleted in this PR.
- Impact: Test documentation is out of date with current test structure.
- Fix: Remove the deleted test file reference.

**Multiple e2e test plan docs reference autoscaling** - `tests/e2e/test-plans/009-autoscaling-basic.md`, `tests/e2e/test-plans/010-autoscaling-resource-limits.md`
- Problem: These test plans describe testing the AutoscalingManager which was removed.
- Impact: Future test authors may try to implement these plans against non-existent code.
- Fix: Either remove or mark as deprecated/superseded by WorkerHandler resource management tests.

### LOW

**Release notes reference removed components (historical, informational)** - `docs/releases/RELEASE_NOTES_v0.2.1.md:22,54`, `CHANGELOG.md:256,320`
- Problem: Historical release notes mention OutputHandler, WorkerSpawned events, and AutoscalingManager. These are historical records.
- Impact: None -- release notes are point-in-time records and should not be changed.
- Fix: No action needed. These are historical artifacts.

---

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 3 | 2 | 0 |
| Pre-existing | 0 | 2 | 2 | 1 |

**Documentation Score**: 6/10

The PR did an excellent job updating the primary architecture docs (CLAUDE.md Architecture Notes, EVENT_FLOW.md, HANDLER-DECOMPOSITION-INVARIANTS.md partial). However, TASK_ARCHITECTURE.md -- one of the most detailed architecture documents -- was only partially updated. It still contains multiple references to the deleted TaskPersisted event, and critically, its "Implementation Guidelines" section (8.4, 12) actively contradicts the new hybrid architecture by marking direct repository access as prohibited. TASK-DEPENDENCIES.md also has stale event flow diagrams.

**Recommendation**: CHANGES_REQUESTED

The three HIGH should-fix issues in TASK_ARCHITECTURE.md are the main concern. That document's implementation guidelines (sections 8.4 and 12) now explicitly contradict the architectural direction of this PR. A developer following those guidelines would avoid the exact pattern this PR introduces. The stale TaskPersisted references in sections 2.2, 2.3, 3.2, and 5.2 will also confuse anyone working on task delegation or dependency flows.
