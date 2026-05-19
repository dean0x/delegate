# Architecture Review Report

**Branch**: feat/simplify-event-system-88 -> main
**Date**: 2026-03-16
**PR**: #91
**Commits**: 5 (dd3ff3a, b180f88, 9f5f39d, 5ed284f, e5f5b2f)

## Change Summary

This PR implements a three-part simplification of the event system:

1. **Phase 1a**: Replace query events with direct repository calls (TaskStatusQuery, TaskLogsQuery, NextTaskQuery, ScheduleQuery removed)
2. **Phase 1b**: Linearize TaskPersisted trigger chain (PersistenceHandler calls QueueHandler.enqueueIfReady() directly instead of emitting TaskPersisted event)
3. **Phase 1c**: Remove 9 informational/dead events and dead code (WorkerSpawned, WorkerKilled, TaskDeleted, TaskConfigured, TaskResumed, SystemResourcesUpdated, RecoveryStarted, RecoveryCompleted, LogsRequested)

Additionally: AutoscalingManager, QueryHandler, and OutputHandler are entirely deleted. Architecture is reclassified from "pure event-driven" to "hybrid event-driven".

**Scale**: 39 files changed, 638 insertions, 2,993 deletions (net -2,355 lines)

---

## Issues in Your Changes (BLOCKING)

### MEDIUM

**PersistenceHandler now has a direct dependency on QueueHandler** - `src/services/handlers/persistence-handler.ts:20-26`
- Problem: PersistenceHandler imports and holds a direct reference to the concrete QueueHandler class. This creates tight coupling between two peer handlers that previously communicated through the EventBus abstraction. The constructor takes `QueueHandler` (concrete class) rather than an interface.
- Impact: If QueueHandler's `enqueueIfReady()` signature changes, PersistenceHandler must change. This violates the Dependency Inversion Principle -- a high-level module (persistence) depends on a concrete low-level module (queue). More critically, the handler setup in `handler-setup.ts:197-207` must now coordinate creation order (QueueHandler first, then PersistenceHandler), introducing implicit temporal coupling.
- Fix: Extract an interface for the enqueue-if-ready capability:
  ```typescript
  // In core/interfaces.ts
  export interface TaskEnqueuer {
    enqueueIfReady(task: Task): Promise<Result<void>>;
  }

  // PersistenceHandler depends on interface
  constructor(
    private readonly repository: TaskRepository,
    private readonly enqueuer: TaskEnqueuer,
    logger: Logger,
  ) { ... }
  ```
  QueueHandler implements `TaskEnqueuer`. This preserves the linearized call chain while respecting DIP. However, this is a MEDIUM concern because the linearization itself is a pragmatic and well-documented choice. The concrete dependency is constrained to handler-setup.ts wiring.

**WorkerHandler now holds both EventBus and direct repository/queue references** - `src/services/handlers/worker-handler.ts:56-68`
- Problem: WorkerHandler's constructor takes 7 dependencies: config, workerPool, resourceMonitor, eventBus, taskQueue, taskRepo, and logger. The addition of taskQueue and taskRepo (previously accessed via events) means this single handler now has broad knowledge of the system. While each dependency is used for a clear purpose, this approaches the threshold where a class knows too much about its collaborators.
- Impact: Testing requires more setup. The class has multiple reasons to change (worker spawning logic, queue interaction, repository queries, cancellation validation). This is a mild SRP concern.
- Fix: This is acceptable as-is given the performance benefits of removing event indirection for dequeue and task lookups. The handler's concerns are tightly related (worker lifecycle management). Monitor for further growth. No immediate action required.

---

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Request-response pattern retained in EventBus interface but no longer used by application code** - `src/core/events/event-bus.ts:21-25`
- Problem: The `request()` method on the EventBus interface and its full implementation in InMemoryEventBus (correlation IDs, pending requests map, timeout handling, cleanup intervals) are retained, but all callers (TaskManager, WorkerHandler, QueueHandler, ScheduleHandler) were migrated to direct repository calls. The `onRequest` convenience method also remains. The comment says "Request-response (request) pattern retained for internal use" but there are no internal callers.
- Impact: ~150 lines of dead code in event-bus.ts (PendingRequest interface, request(), respond(), respondError(), cleanupStaleRequests(), onRequest()). This adds maintenance burden and cognitive overhead for developers reading the EventBus. The cleanup interval timer also runs needlessly.
- Fix: Search the codebase for any remaining callers of `eventBus.request()`. If none exist, remove the request-response infrastructure entirely in a follow-up. At minimum, add a TODO comment noting this is dead code pending removal.

**OutputCaptured event still in events.ts but OutputHandler was deleted** - `src/core/events/events.ts:89-94`
- Problem: The OutputCapturedEvent type remains in the event union, but the OutputHandler that previously subscribed to it was deleted. The event is still emitted by BufferedOutputCapture, but no handler processes it.
- Impact: Events are emitted into the void -- the EventBus logs "No subscribers for event type" at debug level for every output capture. This is wasted work (event creation, handler lookup, logging) on a hot path (output is captured continuously during task execution).
- Fix: Either (a) remove OutputCapturedEvent emission from BufferedOutputCapture since it serves no purpose, or (b) document why it is retained (e.g., for future use by plugins/extensions). Option (a) is preferred to reduce noise.

### LOW

**Stale import in event-bus.ts** - `src/core/events/event-bus.ts:10`
- Problem: The `createEvent` import is used by both `emit()` and `request()`. If `request()` is removed per the suggestion above, verify whether `createEvent` has other callers in this file.
- Impact: Minor. Only relevant if request-response pattern is removed.
- Fix: Clean up as part of request-response removal.

---

## Pre-existing Issues (Not Blocking)

### MEDIUM

**RecoveryManager directly enqueues tasks and emits TaskQueued, bypassing QueueHandler** - `src/services/recovery-manager.ts:60-76`
- Problem: RecoveryManager calls `this.queue.enqueue(task)` directly and then emits `TaskQueued` manually, rather than going through QueueHandler.enqueueIfReady(). This means recovered tasks skip the dependency-aware queueing logic (isBlocked check, fast-path for blocked tasks). A recovered task with unresolved dependencies would be enqueued and potentially started prematurely.
- Impact: Tasks recovered on startup with pending dependencies could start before their dependencies complete.
- Fix: RecoveryManager should call QueueHandler.enqueueIfReady() for each recovered task, or at minimum check dependency status before enqueuing. This is a pre-existing issue that predates this PR but is now more visible since the PR explicitly established QueueHandler.enqueueIfReady() as the canonical entry point for task queueing.

**ScheduleExecutor has direct repo writes (documented architectural exception)** - `src/services/schedule-executor.ts`
- Problem: Already documented in CLAUDE.md as an architectural exception to the event-driven pattern.
- Impact: Inconsistency in the hybrid architecture model.
- Fix: Already tracked. No action needed in this PR.

### LOW

**TestResourceMonitor and SystemResourceMonitor in the same file** - `src/implementations/resource-monitor.ts`
- Problem: Production and test implementations co-located in the same source file. The test implementation is 113 lines of test infrastructure shipped with production code.
- Impact: Minor bundle size increase. Unclear separation of concerns.
- Fix: Move TestResourceMonitor to `tests/fixtures/` or a dedicated test support directory. Pre-existing, not related to this PR.

---

## Architectural Assessment

### What This PR Gets Right

1. **Pragmatic hybrid architecture**: Replacing event-driven queries with direct repository calls is the correct architectural decision. The previous "pure" event-driven pattern added ~1ms latency and significant code complexity for reads that provided no benefits (no multiple subscribers, no async decoupling needed for queries).

2. **Clean event removal taxonomy**: The removed events fall into clear categories -- query events (replaced by direct calls), informational events (no subscribers), and dead code (unused). This is disciplined pruning, not arbitrary removal.

3. **Linearized trigger chain (PersistenceHandler -> QueueHandler)**: Converting the TaskPersisted event into a direct method call eliminates an unnecessary hop through the EventBus for a relationship that is always 1:1. The new flow (persist -> enqueueIfReady) is easier to trace and debug than (persist -> emit TaskPersisted -> QueueHandler handles -> emit TaskQueued).

4. **Preserved event-driven semantics where they matter**: Commands (TaskDelegated, TaskCancelled, TaskCompleted, etc.) and the dependency resolution chain still flow through events. These are the cases where multiple subscribers and decoupled handlers provide genuine value.

5. **Documentation consistency**: CLAUDE.md, EVENT_FLOW.md, TASK_ARCHITECTURE.md, and code comments all updated to reflect the "hybrid" terminology. No stale documentation claiming "pure event-driven" architecture.

6. **Massive dead code removal**: -2,993 lines removed including AutoscalingManager (297 lines, was a no-op scaling decision logger), QueryHandler (179 lines, pure event indirection), OutputHandler (80 lines, logging-only handler), and their test suites (688 + 365 + 91 lines).

### Architectural Risks

1. **Slippery slope from hybrid to ad-hoc**: The boundary between "commands go through events" and "queries go direct" is clear today but could erode over time. Future developers might bypass events for commands because "direct calls are simpler." The documentation in task-manager.ts header helps mitigate this.

2. **Handler-to-handler direct calls**: The PersistenceHandler -> QueueHandler direct call creates a precedent. If other handlers start calling each other directly, the event-driven benefits (decoupling, observability, handler independence) erode. This specific case is justified (1:1 relationship, performance-sensitive path), but should not be generalized.

---

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 1 |
| Pre-existing | 0 | 0 | 2 | 1 |

**Architecture Score**: 8/10

The hybrid architecture is well-motivated and cleanly executed. The event system retains events where they provide value (commands, multi-subscriber scenarios) and eliminates them where they add pure overhead (queries, 1:1 trigger chains, informational broadcasts). The two blocking MEDIUM items (DIP violation in PersistenceHandler, and WorkerHandler dependency count) are pragmatic trade-offs that are well-documented. The should-fix items (dead request-response infrastructure, orphaned OutputCaptured event) are cleanup work that can follow.

**Recommendation**: APPROVED_WITH_CONDITIONS

Conditions:
1. Consider extracting a `TaskEnqueuer` interface to restore DIP for PersistenceHandler -> QueueHandler (can be follow-up)
2. Track removal of unused request-response infrastructure in EventBus as follow-up issue
3. Address orphaned OutputCapturedEvent emission (either remove or document retention rationale)
