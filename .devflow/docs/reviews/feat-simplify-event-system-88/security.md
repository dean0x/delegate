# Security Review Report

**Branch**: feat/simplify-event-system-88 -> main
**Date**: 2026-03-16
**PR**: #91
**Commits**: 5 (dd3ff3a, b180f88, 9f5f39d, 5ed284f, e5f5b2f)

## Overview

This PR simplifies the event system by:
1. Removing 9 informational/dead events and associated dead code (QueryHandler, OutputHandler, AutoscalingManager)
2. Replacing query events (TaskStatusQuery, TaskLogsQuery, NextTaskQuery, ScheduleQuery) with direct repository calls
3. Linearizing the TaskPersisted trigger chain (PersistenceHandler now calls QueueHandler.enqueueIfReady directly)
4. Removing WorkerSpawned, WorkerKilled, SystemResourcesUpdated, RecoveryStarted, RecoveryCompleted events

The net change is -2,993 lines / +638 lines across 39 files, predominantly removing indirection.

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Unbounded query exposure via getStatus()** - `src/services/task-manager.ts:113`
- Problem: `getStatus()` without a `taskId` calls `this.taskRepo.findAllUnbounded()` which returns ALL tasks with no pagination limit. This is not a new call -- the previous code used `QueryHandler` which also called `findAllUnbounded()` -- but it is now more directly exposed. In a long-running server with thousands of accumulated tasks, this could be used (intentionally or not) to cause memory exhaustion (Denial of Service).
- Impact: Memory exhaustion / DoS if task table grows large. OWASP A04 (Insecure Design - missing resource limits).
- Category: Should-Fix (the pattern existed before, but this PR preserved it when it had the opportunity to improve it during the migration to direct calls).
- Fix: Consider using the paginated `findAll(limit, offset)` method, or add a reasonable default limit:
  ```typescript
  // Option A: Use paginated findAll with a sensible default
  return this.taskRepo.findAll(1000, 0);

  // Option B: Keep unbounded but add a comment acknowledging the risk
  // TODO(#31): Add pagination support to getStatus (tech debt)
  return this.taskRepo.findAllUnbounded();
  ```
  Note: There is already a reference to tech debt issue #31 for pagination. This is informational since the behavior is unchanged.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**QueueHandler.enqueueIfReady() public method lacks caller validation** - `src/services/handlers/queue-handler.ts:58`
- Problem: The `enqueueIfReady(task: Task)` method was previously a private event handler (`handleTaskPersisted`) that could only be invoked via the event bus. It is now a public method that is called directly by `PersistenceHandler`. While the current codebase only calls it from `PersistenceHandler`, the method accepts a full `Task` object and enqueues it unconditionally (after dependency check). If any future caller passes a Task with manipulated fields (e.g., already-completed status, or a task that was never persisted), it would be enqueued for execution.
- Impact: Low-to-medium. Currently safe because PersistenceHandler is the only caller and it passes the just-persisted task. However, the expanded surface area means future callers could misuse this method. Defense in depth recommends validating the task state.
- Category: Should-Fix (the method surface changed from private/event-driven to public/direct).
- Fix: Add a guard validating the task is in a queueable state:
  ```typescript
  async enqueueIfReady(task: Task): Promise<Result<void>> {
    // Guard: only enqueue tasks in QUEUED state
    if (task.status !== 'queued') {
      this.logger.warn('Refusing to enqueue task not in QUEUED state', {
        taskId: task.id,
        status: task.status,
      });
      return ok(undefined);
    }
    // ... rest of method
  }
  ```

### LOW

**Removed WorkerKilled event reduces security audit trail** - `src/implementations/event-driven-worker-pool.ts:156`
- Problem: The `WorkerKilled` event was removed from the `kill()` method. Previously, killing a worker emitted an event that could be consumed by monitoring or audit logging systems. With this removal, worker termination (which can happen during task cancellation) is no longer observable through the event bus. While the logger still captures the kill action, structured event-based audit trails are lost.
- Impact: Reduced observability for security-relevant operations (worker lifecycle). In a multi-user scenario, tracking which workers were killed and when is useful for incident response.
- Category: Should-Fix (code was modified to remove this).
- Fix: This is acceptable for the simplification goals. Ensure the logger captures sufficient context for worker kills. The current implementation does log worker kills at the `WorkerHandler` level.

### LOW

**Removed RecoveryStarted/RecoveryCompleted events reduce recovery audit trail** - `src/services/recovery-manager.ts:24-176`
- Problem: `RecoveryStarted` and `RecoveryCompleted` events were removed. These provided a structured signal that the recovery process ran. Without them, only log messages indicate recovery occurred. In a security-sensitive deployment, structured events are preferable for automated monitoring.
- Impact: Low. Logger still captures recovery info. This is a defense-in-depth concern.
- Category: Should-Fix.
- Fix: Acceptable trade-off for simplification. The logger.info calls at lines 25 and 169-174 capture the same information.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Math.random() used for non-security identifier generation** - `src/cli/commands/run.ts:113`
- Problem: `Math.random().toString(36).substring(2, 8)` is used to generate a suffix. `Math.random()` is not cryptographically secure.
- Impact: Low in this context (CLI task naming, not a security token). But it is worth noting per security best practices.
- Category: Pre-existing (not modified in this PR).

### LOW

**Request-response pattern retained but unused** - `src/core/events/event-bus.ts:251-332`
- Problem: The `request()` method on `EventBus` is retained along with its correlation ID infrastructure, pending requests map, cleanup intervals, and timeout logic. With the removal of all query events, no production code appears to call `eventBus.request()` anymore. This dead code expands the attack surface slightly (the method is publicly callable) and maintains complexity that could harbor bugs.
- Impact: Low. The method is well-implemented with timeouts and cleanup. But dead code increases maintenance burden.
- Category: Pre-existing (the method exists from before; the PR removed its callers but not the method itself).
- Fix: Consider removing the `request()` method and related infrastructure in a follow-up PR if no callers remain. The EventBus interface comment mentions "retained for internal use" which suggests this is intentional.

### LOW

**No rate limiting on task delegation** - `src/services/task-manager.ts:45-98`
- Problem: The `delegate()` method has no rate limiting. A caller can submit an unlimited number of tasks.
- Impact: Low for an MCP server (single-user tool), but worth noting for defense in depth.
- Category: Pre-existing.

## Security Analysis of Key Changes

### Direct Repository Access (Query Event Removal) - SAFE

The migration from `eventBus.request()` to direct `taskRepo.findById()` and `taskRepo.findAllUnbounded()` calls is a **security improvement**:

1. **Reduced attack surface**: Query events exposed a request-response correlation system (`__correlationId`, `respond()`, `respondError()`) that could theoretically be exploited by a malicious event subscriber that intercepts correlation IDs and sends fake responses. Direct repository calls eliminate this vector entirely.

2. **No new injection risks**: All repository methods use parameterized SQLite prepared statements (verified in `task-repository.ts`). The direct calls pass the same `taskId` values that previously went through events.

3. **No authentication bypass**: The system has no authentication layer (it is a local MCP server), so the architectural change has no auth impact.

### PersistenceHandler -> QueueHandler Direct Call - SAFE

The change from `eventBus.emit('TaskPersisted', ...)` to `this.queueHandler.enqueueIfReady(event.task)` is safe:
- Same data flows (the Task object)
- Same validation (dependency check)
- Tighter coupling but reduced timing/ordering risks

### Removed AutoscalingManager - SAFE

Removing the AutoscalingManager eliminates a class that subscribed to `WorkerKilled` and `SystemResourcesUpdated` events. This was informational/advisory code that logged scaling opportunities but did not perform actual scaling (WorkerHandler handles spawning). No security impact.

### Removed Events - SAFE

All removed events (TaskPersisted, TaskDeleted, WorkerSpawned, WorkerKilled, SystemResourcesUpdated, RecoveryStarted, RecoveryCompleted, TaskResumed, TaskConfigured, LogsRequested) were either informational, dead, or query-related. None carried security-sensitive data. Their removal reduces the event surface area, which is a net positive for security.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 2 |
| Pre-existing | 0 | 0 | 1 | 2 |

**Security Score**: 8/10

The PR is a net security improvement. It reduces the event-driven attack surface, removes unused infrastructure (query events, correlation IDs for queries, AutoscalingManager), and replaces indirect data access with direct repository calls that use parameterized queries. The main concern is the unbounded `findAllUnbounded()` call in `getStatus()` (pre-existing behavior, tracked in #31) and the newly public `enqueueIfReady()` method that could benefit from a status guard.

**Recommendation**: APPROVED

No critical or high security issues found. The one blocking MEDIUM (unbounded query) is pre-existing behavior that was merely preserved during migration, and is already tracked as tech debt (#31). The public method concern on `enqueueIfReady()` is a defensive improvement suggestion, not a blocking issue.
