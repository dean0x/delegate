# Architecture Review Report

**Branch**: task-2025-01-25_2210 -> main
**Date**: 2026-02-18
**Focus**: SOLID violations, coupling, layering issues, modularity, event-driven architecture consistency
**Revision**: Post-debate (Round 2 -- Final)

---

## Issues in Your Changes (BLOCKING)

### CRITICAL

**[Confidence: HIGH] MCPAdapter directly saves to ScheduleRepository, bypassing event-driven architecture** - `/Users/dean/Sandbox/delegate/src/adapters/mcp-adapter.ts:938`
- Problem: `handleScheduleTask()` calls `this.scheduleRepository.save(schedule)` directly and _then_ emits `ScheduleCreated`. Meanwhile, `ScheduleHandler.handleScheduleCreated()` also calls `this.scheduleRepo.save(updatedSchedule)` at line 210. This creates a dual-write: the adapter saves the schedule first (without `nextRunAt`), then ScheduleHandler receives the event and saves again (with `nextRunAt`). This breaks the event-driven pattern established by every other flow in the system (e.g., `TaskDelegated` -> `PersistenceHandler` saves -> `TaskPersisted` emitted). The adapter layer should emit events and let handlers do persistence.
- Impact: Architectural inconsistency with the rest of the codebase. If the event emission at line 947 fails after the save at line 938, you have a persisted schedule that never gets its `nextRunAt` computed. The dual-write also means two database round-trips for every schedule creation.
- Fix: Remove the direct `save()` call from MCPAdapter. Only emit `ScheduleCreated` and let `ScheduleHandler` handle persistence (it already does). The handler computes `nextRunAt` and saves. This aligns with how `DelegateTask` works: adapter emits `TaskDelegated`, handler persists.
- Cross-reviewer: Security and Performance reviewers both identified consequences of this dual-write (inconsistent state, wasted DB round-trip). Database reviewer identified a cascading consequence: the `INSERT OR REPLACE` SQL pattern in `schedule-repository.ts:117` exists specifically *because* of this dual-write -- a plain `INSERT` would fail on the second save with a unique constraint violation. The silent-overwrite semantics are a symptom of the broken architecture, not an independent design choice. Fixing the dual-write (single persistence path) would allow using explicit `INSERT` for creation and `UPDATE` for modifications. Unchallenged across 4 reviewers.

### HIGH

**[Confidence: HIGH] MCPAdapter takes optional ScheduleRepository and EventBus, violating its own interface contract** - `/Users/dean/Sandbox/delegate/src/adapters/mcp-adapter.ts:108-109`
- Problem: `scheduleRepository?: ScheduleRepository` and `eventBus?: EventBus` are optional constructor parameters. Every schedule handler method then performs runtime null checks (`if (!this.scheduleRepository || !this.eventBus)`). This is defensive programming that hides a wiring bug at construction time. In `bootstrap.ts:360-364`, both are always provided, so the optionality serves no purpose in production.
- Impact: ISP/DIP violation. The adapter accepts incomplete configuration silently instead of failing fast at construction. If a future refactor removes the DI wiring, the adapter won't crash at startup - it will silently return "Schedule repository not available" errors at runtime, which is harder to diagnose.
- Fix: Make both parameters required. If scheduling is optional as a feature, gate it at the bootstrap level (don't register schedule tools), not inside the adapter with runtime null checks. Alternatively, split scheduling into a separate adapter class (ISP).
- Cross-reviewer: TypeScript reviewer independently flagged the optional typing. Unchallenged.

**[Confidence: HIGH] ScheduleHandler.handleScheduleQuery uses unsafe type casting to access correlationId** - `/Users/dean/Sandbox/delegate/src/services/handlers/schedule-handler.ts:503`
- Problem: `(e as unknown as { __correlationId?: string }).__correlationId` and `(this.eventBus as { respondError?: ... }).respondError?.(...)` are unsafe casts that bypass TypeScript's type system. This indicates the EventBus request/response pattern is not properly typed.
- Impact: If the EventBus changes its internal API, these casts will silently break at runtime with no compile-time warning. The pattern is also duplicated 4 times in the same method (lines 513-514, 526-527, 539-540, 552-553). This is not merely a TypeScript style issue -- it reveals a missing architectural abstraction. The request/response event pattern has no typed interface, forcing handlers to reach into implementation details.
- Fix: Extend the `BaseEvent` interface or create a `RequestEvent` interface that includes `correlationId`. Add `respond()` and `respondError()` to the `EventBus` interface if they are legitimate API methods. If they are internal implementation details, the handler should not be reaching into them.
- Cross-reviewer: TypeScript reviewer flagged same casts. Architecture and TypeScript concerns are complementary here -- TypeScript flags the cast, architecture flags the missing abstraction.

**[Confidence: HIGH] ScheduleExecutor constructor has side effects (event subscription)** - `/Users/dean/Sandbox/delegate/src/services/schedule-executor.ts:76`
- Problem: Constructor calls `this.subscribeToTaskEvents()` which subscribes to 5 events. This is inconsistent with the project's established factory pattern where `ScheduleHandler` and `DependencyHandler` use `static async create()` specifically to separate construction from initialization. The executor subscribes eagerly in the constructor, making it impossible to construct without side effects.
- Impact: Testability is reduced. You cannot create a `ScheduleExecutor` instance without it immediately subscribing to events on the bus. In contrast, `ScheduleHandler` uses a factory pattern that the codebase explicitly documents as the preferred approach.
- Fix: Adopt the same factory pattern used by `ScheduleHandler`. Move `subscribeToTaskEvents()` into a `static create()` method or a separate `initialize()` method. This keeps the constructor pure and makes the executor testable without a live event bus.
- Cross-reviewer: Quality reviewer flagged testability concerns around this. Unchallenged.

**[Confidence: HIGH] ScheduleExecutor directly calls `scheduleRepo.update()` in `handleMissedRun` FAIL policy** - `/Users/dean/Sandbox/delegate/src/services/schedule-executor.ts:351-354`
- Problem: When `MissedRunPolicy.FAIL`, the executor directly updates the schedule status to CANCELLED via `this.scheduleRepo.update()` and records execution via `this.scheduleRepo.recordExecution()`. This bypasses the event-driven pattern. The normal flow should be: executor detects missed run -> emits event -> handler updates state. The executor already emits `ScheduleMissed` at line 356, but the handler never acts on it for the FAIL case because the executor already did the work.
- Impact: Layering violation. The executor (timer/polling service) is performing state mutations that should be the handler's responsibility. This duplicates persistence logic between executor and handler.
- Fix: Emit `ScheduleCancelled` event (or a dedicated `ScheduleMissedFail` event) and let `ScheduleHandler` handle the state transition and execution recording. The executor should only detect and emit, not mutate.
- Cross-reviewer: Quality reviewer noted the executor has no handler for ScheduleMissed events, confirming the flow is incomplete.

**[Confidence: HIGH] ScheduleExecutor.updateNextRun() directly updates repository** - `/Users/dean/Sandbox/delegate/src/services/schedule-executor.ts:382-418`
- Problem: Same layering violation as above. The executor directly calls `scheduleRepo.update()` to set `nextRunAt` and `status`. The SKIP policy (line 334) calls `updateNextRun()` which does a direct repo update. This makes the executor a mixed-responsibility component: it both detects due schedules AND manages their state.
- Impact: The executor has repository as a dependency for both reads (findDue) and writes (update). The handler pattern in this codebase intentionally separates "detect" from "persist" through events.
- Fix: Move all write operations out of the executor. For SKIP, emit an event like `ScheduleSkipped` and let the handler recalculate and persist `nextRunAt`.

### MEDIUM

**[Confidence: HIGH] `handleScheduleTriggered` creates tasks directly instead of going through TaskManager** - `/Users/dean/Sandbox/delegate/src/services/handlers/schedule-handler.ts:266-267`
- Problem: `createTask(schedule.taskTemplate)` and `this.taskRepo.save(task)` create and persist a task directly, then emit `TaskDelegated`. The normal task creation flow goes through `TaskManagerService.delegate()` which emits `TaskDelegated` and lets `PersistenceHandler` save. Here the handler saves first, then emits, duplicating persistence and potentially double-saving.
- Impact: Scheduled tasks bypass any validation or enrichment that `TaskManagerService.delegate()` performs (e.g., worktree default config application). If TaskManager gains new pre-delegation logic, scheduled tasks will miss it.
- Fix: Either emit `TaskDelegated` with the created task and let `PersistenceHandler` handle save (remove `taskRepo.save()`), or call through `TaskManager.delegate()` to ensure consistent task creation flow.

**[Confidence: HIGH] ScheduleHandler subscribes to TaskCompleted/TaskFailed but does nothing with them** - `/Users/dean/Sandbox/delegate/src/services/handlers/schedule-handler.ts:572-592`
- Problem: Both `handleTaskCompleted` and `handleTaskFailed` are no-ops - they just log debug messages. The comments acknowledge this: "best-effort tracking" and "future enhancement." These dead subscriptions add noise and consume event bus listener slots.
- Impact: Two event subscriptions that do nothing. The EventBus has configurable listener limits (`maxListenersPerEvent`). Each no-op subscription wastes a slot and adds processing overhead per task completion/failure event.
- Fix: Remove these subscriptions until the feature is actually implemented (YAGNI). The `ScheduleExecutor` already handles task completion tracking via its own subscriptions to `TaskCompleted`/`TaskFailed` (lines 94-102). Add them back when the Task-to-Schedule linkage is built.

**[Confidence: HIGH] Repository `update()` uses read-modify-write without transaction protection** - `/Users/dean/Sandbox/delegate/src/implementations/schedule-repository.ts:214-238`
- Problem: `update()` does `findById()` then `save()` as two separate operations. Between the read and write, another process could modify the schedule (TOCTOU). This is the exact pattern the CLAUDE.md warns about: "Use synchronous `db.transaction()` for atomicity."
- Impact: The existing codebase uses synchronous SQLite transactions for TOCTOU protection (documented in CLAUDE.md for dependency management). The schedule repository skips this protection. Concurrent schedule triggers could lead to lost updates (e.g., two ticks both read runCount=5, both write runCount=6, losing an increment).
- Fix: Wrap the read-modify-write in `this.db.transaction()` as a synchronous operation, matching the pattern used by `SQLiteDependencyRepository`.
- Cross-reviewer: Database and Performance reviewers independently flagged this same issue. Triple-confirmed.

---

## Issues Validated from Other Reviewers (Architectural Impact)

### CRITICAL (Cross-Concern)

**[Confidence: HIGH] Path traversal in handleScheduleTask -- missing validatePath** - `/Users/dean/Sandbox/delegate/src/adapters/mcp-adapter.ts:916`
- Originally raised by: Security reviewer
- Architecture impact: `handleDelegateTask` calls `validatePath(data.workingDirectory)` at line 524, but `handleScheduleTask` passes `data.workingDirectory` directly into the task template at line 916 with zero validation. This is not just a security bug but an architectural consistency violation -- the schedule creation path does not mirror the task delegation path's boundary validation. The template is persisted to database and later used to create real tasks, meaning the path traversal payload survives across the entire schedule lifecycle.

### HIGH (Cross-Concern)

**[Confidence: HIGH] Infinite retrigger when getNextRunTime fails** - `/Users/dean/Sandbox/delegate/src/services/handlers/schedule-handler.ts:299-306`
- Originally raised by: Quality reviewer
- Architecture impact: When `getNextRunTime` returns an error at line 300-306, `newNextRunAt` remains `undefined`, so the schedule update at line 340 does not include a new `nextRunAt`. The schedule retains its old `nextRunAt` (which is in the past, since we just triggered it). Every subsequent executor tick will find this schedule due again, creating an infinite trigger loop. This is an architectural gap in error handling -- the error path needs to either advance the schedule to the next run or pause it.

**[Confidence: HIGH] Missing executor lifecycle integration** - `/Users/dean/Sandbox/delegate/src/bootstrap.ts:417-428`
- Originally raised by: Quality reviewer
- Architecture impact: `bootstrap.ts` starts the executor at line 420 but there is no shutdown integration. The `stop()` method exists (`schedule-executor.ts:187`) but nothing in the system calls it. The existing `handlerRegistry` pattern provides `shutdown()` coordination, but the executor is not registered in it. On process exit, the timer interval (even `.unref()`'d) may fire during shutdown and attempt to query a closing database.

**[Confidence: HIGH] ScheduleUpdate type exists but is not used at the repository boundary** - `/Users/dean/Sandbox/delegate/src/core/domain.ts:302-313` vs `/Users/dean/Sandbox/delegate/src/core/interfaces.ts:250`
- Originally raised by: TypeScript reviewer
- Architecture impact: `ScheduleUpdate` (domain.ts:302) correctly restricts which fields are updatable. But the repository interface uses `Partial<Schedule>` (interfaces.ts:250), which allows updating `id`, `createdAt`, and other immutable fields. The domain type exists for exactly this purpose but isn't used where it matters. The repo interface should use `ScheduleUpdate` to enforce the contract.

---

## Issues in Code You Touched (Should Fix)

### HIGH

**[Confidence: MEDIUM] Event type union `DelegateEvent` grows unbounded** - `/Users/dean/Sandbox/delegate/src/core/events/events.ts:314-367`
- Problem: This PR adds 10 new event types to an already large discriminated union (now ~35 types). Each new feature adds more events. The union is used in `EventHandler<T extends DelegateEvent>` which means every handler's type parameter grows.
- Impact: TypeScript compilation time increases with union size. More importantly, there's no namespace organization - task events, schedule events, worker events, and system events all live in one flat union.
- Fix: Consider organizing events into sub-unions (`ScheduleEvent`, `TaskEvent`, `WorkerEvent`) that compose into `DelegateEvent`. This isn't blocking but should be addressed before the next feature adds more events.

### MEDIUM

**[Confidence: HIGH] `ErrorCode.TASK_NOT_FOUND` reused for schedule not found** - `/Users/dean/Sandbox/delegate/src/services/handlers/schedule-handler.ts:250-253`
- Problem: When a schedule is not found (line 250, 434), the code uses `ErrorCode.TASK_NOT_FOUND`. Schedules are not tasks.
- Impact: Misleading error codes in logs and error responses. A consumer seeing `TASK_NOT_FOUND` for a schedule query will be confused.
- Fix: Add `SCHEDULE_NOT_FOUND` to `ErrorCode` enum, or use a more generic `RESOURCE_NOT_FOUND`.

---

## Challenges to Other Reviewers

### Performance: Sequential schedule processing is intentional (DISAGREE on severity)

The performance reviewer flags the `for...await` loop at `schedule-executor.ts:243-245` as HIGH. Sequential processing is an architectural choice -- it prevents thundering herd of simultaneous `ScheduleTriggered` events. The `runningSchedules` Map concurrency prevention depends on sequential processing. Parallelizing with `Promise.all` would allow a schedule to be triggered twice before the first trigger's `ScheduleExecuted` event marks it running. **Recommend: LOW/MEDIUM.**

### Performance: Zod validation on every row is correct design (DISAGREE)

`ScheduleRowSchema.parse(row)` in `rowToSchedule()` is validate-at-boundary, which the CLAUDE.md explicitly mandates ("Parse, don't validate - Zod schemas"). The repository is the system boundary between SQLite and domain. Expected schedule count is tens to low hundreds. **Recommend: Not flagged or LOW.**

### Performance: SELECT * in SQLite is not a concern (DISAGREE)

In SQLite, `SELECT *` vs named columns has negligible performance difference. SQLite reads entire rows from B-tree pages regardless. `findDue()` runs once per minute. **Recommend: Not flagged.**

### Database: CHECK constraints on numeric columns (REVISED -- now agree on MEDIUM)

Originally challenged as overstated. After Round 2 discussion with database reviewer, I concede: the project already adds CHECK constraints on all enum columns in migrations v2/v3, so not adding them to numeric columns (`run_count >= 0`, `max_runs >= 1`) is inconsistent with the established defense-in-depth pattern. Application-level validation exists but database-level constraints are the project's convention. Accept MEDIUM severity.

---

## Pre-existing Issues (Not Blocking)

### MEDIUM

**[Confidence: MEDIUM] `TaskEventEmitter` interface in interfaces.ts is unused** - `/Users/dean/Sandbox/delegate/src/core/interfaces.ts:335-346`
- Problem: `TaskEventEmitter` with its `on()` overloads and `emit(event: string, ...args: any[])` appears to be a legacy interface predating the EventBus. It uses `any[]` which violates the project's "No any types" principle.
- Impact: Dead code that could confuse new contributors into using the wrong event system.
- Fix: Remove if confirmed unused.

### LOW

**[Confidence: MEDIUM] `parseCronExpression` in cron.ts exposes third-party library types** - `/Users/dean/Sandbox/delegate/src/utils/cron.ts:154-171`
- Problem: Returns `Result<CronExpression, DelegateError>` where `CronExpression` is imported from `cron-parser`. This leaks a third-party type through the module's public API.
- Impact: If `cron-parser` is replaced, all consumers of `parseCronExpression` must change.
- Fix: Either keep this function internal (don't export from `utils/index.ts`) or wrap the return type.

---

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 1 | 5 | 3 | - |
| Cross-concern (validated) | 1 | 3 | - | - |
| Should Fix | - | 1 | 1 | - |
| Pre-existing | - | - | 1 | 1 |

**Architecture Score**: 5/10
**Recommendation**: CHANGES_REQUESTED

### Core Architectural Issues (in priority order)

1. **Dual persistence paths**: MCPAdapter saves directly AND ScheduleHandler saves via events. Pick one. The entire codebase routes persistence through handlers.

2. **ScheduleExecutor has too many responsibilities**: It reads from repo, writes to repo, and emits events. In the established architecture, services detect/emit, handlers persist.

3. **Missing boundary validation**: `handleScheduleTask` skips `validatePath()` that `handleDelegateTask` applies. The schedule path must mirror the task path's boundary protections.

4. **Infinite retrigger on cron parse failure**: When `getNextRunTime` fails, the schedule's `nextRunAt` stays in the past, causing every tick to retrigger it.

5. **Missing TOCTOU protection**: The schedule repository's `update()` uses read-modify-write without transaction, contradicting the project's documented convention (CLAUDE.md).
