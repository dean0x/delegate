# Performance Review Report

**Branch**: feat/simplify-event-system-88 -> main
**Date**: 2026-03-16
**PR**: #91

## Issues in Your Changes (BLOCKING)

### CRITICAL

None.

### HIGH

None.

### MEDIUM

**findAllUnbounded() exposed through new direct query path** - `src/services/task-manager.ts:113`
- Problem: `getStatus()` without a `taskId` now calls `this.taskRepo.findAllUnbounded()` directly. Previously this went through the QueryHandler event route which had the same behavior, so the underlying query is unchanged. However, the direct call path makes it easier to overlook that this performs an unbounded `SELECT *` on the tasks table. With sufficient task volume (thousands of completed tasks that persist beyond the 7-day cleanup window), this will cause memory pressure and slow responses.
- Impact: Latency and memory proportional to total row count. Not a regression from the previous code (QueryHandler did the same thing), but the simplification makes this a good time to address it.
- Fix: Consider adding pagination or at minimum a result limit. The `findAll()` with limit already exists in the repository interface. This is a pre-existing design gap now more visible due to the refactoring:
  ```typescript
  // Current (unbounded)
  return this.taskRepo.findAllUnbounded();

  // Suggested: use existing findAll with sensible limit
  return this.taskRepo.findAll(500);
  ```
- Category: Should-Fix (same function you modified)

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Sequential event emissions in resolveDependencies loop** - `src/services/handlers/dependency-handler.ts:531-643`
- Problem: The `resolveDependencies()` method iterates over dependents and for each one: (1) emits `TaskDependencyResolved`, (2) calls `isBlocked()`, (3) calls `getDependencies()`, (4) possibly calls `findById()`, and (5) emits either `TaskCancellationRequested` or `TaskUnblocked`. All of these are awaited sequentially inside the loop. For a task with N dependents, this produces N sequential database round-trips for `isBlocked` plus N for `getDependencies` plus event emissions.
- Impact: When a high-fanout task completes (many tasks depend on it), resolution time grows linearly with the number of dependents. Each iteration involves 2-3 DB queries and 1-2 event emissions. With 10+ dependents, this could become noticeable.
- Fix: This is a pre-existing pattern, not introduced by this PR. The batch resolution (`resolveDependenciesBatch`) was already an improvement. Further optimization would require a batch `isBlocked` check, which is a larger refactor best done in a follow-up.
- Category: Pre-existing (not modified in this PR, only the event types were trimmed)

### LOW

**Redundant resource monitor event emission removed -- positive change** - `src/implementations/resource-monitor.ts:266-280`
- Problem: Not a problem. The removal of the `SystemResourcesUpdated` event emission in `performResourceCheck()` eliminates an event that was emitted on a periodic timer (every ~60s) but had zero subscribers. This was pure overhead: event creation, handler lookup, and debug logging every interval.
- Impact: Positive -- removes unnecessary event bus traffic. Approximately 1 event creation + Map lookup + logging per monitoring interval saved.
- Category: Positive change (no action needed)

**Removal of TaskPersisted event indirection -- positive change** - `src/services/handlers/persistence-handler.ts:74-75`
- Problem: Not a problem. Previously PersistenceHandler emitted a `TaskPersisted` event, which QueueHandler subscribed to. Now PersistenceHandler calls `queueHandler.enqueueIfReady()` directly. This eliminates: (1) event object creation via `createEvent()` (UUID generation + timestamp), (2) EventBus handler lookup and dispatch, (3) Promise.all wrapper overhead, and (4) performance logging in the EventBus emit path.
- Impact: Positive -- saves ~0.1-0.5ms per task delegation by removing one full event bus round-trip on the critical path (task delegation -> persist -> enqueue -> spawn). For the hot path of task creation, this is a meaningful micro-optimization.
- Category: Positive change (no action needed)

**Removal of NextTaskQuery request-response -- positive change** - `src/services/handlers/worker-handler.ts:379-383`
- Problem: Not a problem. WorkerHandler previously used `eventBus.request<NextTaskQueryEvent>()` to dequeue tasks, which involves: (1) creating a correlation ID, (2) setting up a pending request with timeout, (3) emitting the event, (4) waiting for QueueHandler to respond via the correlation pattern. Now it calls `this.taskQueue.dequeue()` directly -- a synchronous in-memory operation.
- Impact: Positive -- eliminates the most performance-sensitive request-response pattern. The dequeue operation is on the hot path (called every time a worker needs a task). Removing the event indirection saves: UUID generation, Map insertion for pending request, setTimeout for timeout, event dispatch, and promise resolution overhead. Estimated savings: 0.5-2ms per dequeue.
- Category: Positive change (no action needed)

**Removal of TaskStatusQuery request-response in WorkerHandler** - `src/services/handlers/worker-handler.ts:129,431`
- Problem: Not a problem. Two uses of `eventBus.request<TaskStatusQueryEvent>()` replaced with direct `this.taskRepo.findById()`. This removes request-response overhead (correlation ID, timeout, promise wrapping) for what is fundamentally a synchronous SQLite read.
- Impact: Positive -- saves ~0.5-1ms per call by avoiding the full request-response event cycle. These paths (cancellation validation and worker completion duration calculation) are less hot than dequeue, but still meaningful.
- Category: Positive change (no action needed)

**Removal of 9 dead/informational events** - `src/core/events/events.ts`
- Problem: Not a problem. Removing `RecoveryStarted`, `RecoveryCompleted`, `WorkerSpawned`, `WorkerKilled`, `SystemResourcesUpdated`, `TaskPersisted`, `TaskResumed`, `NextTaskQuery`, `TaskStatusQuery`, and `TaskLogsQuery` eliminates event types that either had no subscribers or were used purely for unnecessary indirection. Each removed event type saves: (1) type definition overhead, (2) handler array allocation in the EventBus Map for subscribed types, (3) event object creation on emit.
- Impact: Positive -- reduces event bus memory footprint and simplifies handler dispatch. The EventBus `handlers` Map shrinks from ~34 event types to ~25.
- Category: Positive change (no action needed)

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Recovery loop emits events sequentially per task** - `src/services/recovery-manager.ts:53-76`
- Problem: The recovery loop iterates over queued tasks and for each one: enqueues (sync), then awaits `eventBus.emit('TaskQueued')`. When many tasks need recovery (e.g., after a crash with 7+ queued tasks), this emits events sequentially. Each emission triggers WorkerHandler's `processNextTask()` which holds the spawn lock.
- Impact: With N queued tasks, recovery takes N * (emit overhead + spawn lock wait). The spawn delay (10s minimum between spawns) means recovery of 7 tasks takes ~70s regardless. This is by design (fork-bomb prevention), but the sequential emission adds unnecessary overhead on top.
- Fix: Consider batching the recovery: enqueue all tasks first, then emit a single "recovery batch ready" event, or emit all TaskQueued events without awaiting each one. This would allow the spawn serialization in WorkerHandler to handle throttling naturally.

### LOW

**EventBus request-response infrastructure remains after all query callers removed** - `src/core/events/event-bus.ts:251-332`
- Problem: The `request()` method, `PendingRequest` tracking, `respond()`, `respondError()`, stale request cleanup interval, and related code all remain in the EventBus, but this PR removed all three query event callers (`TaskStatusQuery`, `TaskLogsQuery`, `NextTaskQuery`). The `request()` pattern was the primary use of correlation IDs and timeouts.
- Impact: Minor memory overhead from cleanup interval and dead code. The `pendingRequests` Map and cleanup interval run perpetually even though no code calls `request()` anymore.
- Fix: Consider removing the request-response infrastructure in a follow-up PR if no future callers are planned. At minimum, the cleanup interval runs every 60s and iterates an always-empty Map.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | - |
| Should Fix | - | 0 | 1 | 0 |
| Pre-existing | - | - | 1 | 1 |

**Performance Score**: 8/10

This PR is a net positive for performance. The primary theme -- replacing event bus indirection (request-response queries, informational events) with direct calls -- eliminates significant overhead on the task delegation and worker processing hot paths:

- **Task delegation path**: Removes 1 event hop (TaskPersisted) by using direct method call from PersistenceHandler to QueueHandler.
- **Worker dequeue path**: Removes request-response overhead (correlation ID, timeout, promise wrapping) by using direct `taskQueue.dequeue()`.
- **Query paths**: Removes 3 request-response round-trips (getStatus, getLogs, cancellation validation) by using direct repository access.
- **Background noise**: Removes ~9 events that were either dead (no subscribers) or purely informational, reducing EventBus dispatch overhead.

Estimated per-task savings on the critical path: 1-3ms total from eliminated event indirection. For a system that orchestrates Claude Code instances (which take seconds to minutes per task), this is not dramatic in absolute terms, but it meaningfully reduces framework overhead and eliminates potential timeout/correlation-ID failure modes.

The one should-fix item (findAllUnbounded in getStatus) is a pre-existing gap made more visible by the refactoring, not a regression.

**Recommendation**: APPROVED
