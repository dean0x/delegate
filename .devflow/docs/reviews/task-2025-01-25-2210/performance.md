# Performance Review Report

**Branch**: task-2025-01-25_2210 -> main
**Date**: 2026-02-17
**Reviewer Focus**: N+1 queries, memory leaks, timer leaks, algorithm issues, I/O bottlenecks, polling efficiency
**Updated**: 2026-02-18 (post-debate round 2 -- accepted challenges from database reviewer)

---

## Issues in Your Changes (BLOCKING)

### HIGH

**1. Read-Modify-Write pattern in `update()` causes double database round-trip** - `/Users/dean/Sandbox/delegate/src/implementations/schedule-repository.ts:214-238`
- **Confidence**: HIGH (corroborated by Database reviewer TOCTOU finding #1, Architecture reviewer MEDIUM finding)
- **Problem**: Every `update()` call first does a full `findById()` (which reads, validates with Zod, and deserializes JSON), then re-serializes and writes back the entire row via `INSERT OR REPLACE`. This means every schedule update does 2 DB round-trips (SELECT + INSERT OR REPLACE) and parses the full row twice (Zod + JSON.parse for task_template).
- **Impact**: The `handleScheduleTriggered` handler in `schedule-handler.ts:340` calls `update()` on every schedule trigger. For CRON schedules firing every minute with multiple active schedules, this compounds. The `ScheduleExecutor.handleMissedRun` with `FAIL` policy at `schedule-executor.ts:351` also calls `update()` followed by `recordExecution()`, totaling 3+ DB operations.
- **Cross-reviewer note**: Database reviewer flagged TOCTOU race here; both issues are solved by the same fix (targeted UPDATE). Architecture reviewer also flagged the read-modify-write as a consistency concern. Three reviewers converging on this issue strengthens the case.
- **Fix**: Use a targeted SQL `UPDATE` statement with only the changed columns instead of the read-modify-write pattern:
  ```typescript
  async update(id: ScheduleId, update: Partial<Schedule>): Promise<Result<void>> {
    return tryCatchAsync(
      async () => {
        const setClauses: string[] = [];
        const params: unknown[] = [];

        if (update.status !== undefined) {
          setClauses.push('status = ?');
          params.push(update.status);
        }
        if (update.nextRunAt !== undefined) {
          setClauses.push('next_run_at = ?');
          params.push(update.nextRunAt);
        }
        // ... other fields
        setClauses.push('updated_at = ?');
        params.push(Date.now());
        params.push(id);

        this.db.prepare(
          `UPDATE schedules SET ${setClauses.join(', ')} WHERE id = ?`
        ).run(...params);
      },
      operationErrorHandler('update schedule', { scheduleId: id })
    );
  }
  ```

**2. Sequential processing of due schedules in tick loop** - `/Users/dean/Sandbox/delegate/src/services/schedule-executor.ts:243-245`
- **Confidence**: MEDIUM (Architecture reviewer may argue event ordering concerns; pragmatically sound but debatable)
- **Problem**: Due schedules are processed sequentially with `await` inside a `for` loop. Each `executeSchedule` call does event emission (which may trigger async handlers) and potentially multiple DB operations.
- **Impact**: If 10 schedules are due simultaneously, they are processed one at a time. Each involves event emission + DB reads + DB writes in the handler chain. The tick loop could take several seconds for a modest number of due schedules, causing schedule drift.
- **Dissent noted**: Architecture reviewer may argue that parallel execution complicates event ordering and error isolation. However, these are independent schedules with no shared state. The event bus handlers are already async. Sequential processing provides no ordering guarantee that matters across independent schedules.
- **Fix**: Use `Promise.allSettled` for independent schedule executions:
  ```typescript
  const results = await Promise.allSettled(
    dueSchedules.map(schedule => this.executeSchedule(schedule, now))
  );
  for (const result of results) {
    if (result.status === 'rejected') {
      this.logger.error('Schedule execution failed', result.reason);
    }
  }
  ```

### MEDIUM

**3. `SELECT *` causes unnecessary `task_template` JSON deserialization on hot path** - `/Users/dean/Sandbox/delegate/src/implementations/schedule-repository.ts:128-171`
- **Confidence**: MEDIUM (downgraded from HIGH after database reviewer challenge -- SQLite is a row-store, column projection has negligible I/O benefit)
- **Problem**: All queries use `SELECT *`. The `findDue` query fetches `task_template` (potentially large serialized JSON) on every 60-second tick, even though the tick decision logic only needs `id`, `nextRunAt`, `missedRunPolicy`, and `status`.
- **Impact**: The real cost is not SQLite I/O (which reads full pages regardless of projection) but the application-layer `JSON.parse(data.task_template)` per row in `rowToSchedule()`. The `task_template` contains `DelegateRequest` with `prompt` up to 4000 chars. This parsing is unnecessary for the tick loop's due-check logic.
- **Debate outcome**: Database reviewer correctly challenged the severity, noting SQLite is a row-store where column projection provides negligible I/O savings. I accepted the downgrade from HIGH to MEDIUM. The remaining concern is application-layer deserialization cost, not database I/O.
- **Fix**: Rather than splitting into two queries (which the database reviewer correctly noted would double round-trips), use lazy parsing -- defer `JSON.parse(task_template)` until `taskTemplate` is actually accessed. Alternatively, accept the overhead at current scale and revisit if schedule counts grow significantly.

### MEDIUM

**4. Zod validation on every row read from database** - `/Users/dean/Sandbox/delegate/src/implementations/schedule-repository.ts:398`
- **Confidence**: LOW (challenge accepted from Database reviewer -- this is premature optimization)
- **Problem**: `ScheduleRowSchema.parse(row)` is called in `rowToSchedule()` for every row read, including the `findDue()` hot path every 60 seconds.
- **Impact**: Negligible at expected scale. The `findDue` path processes single-digit rows per tick. Zod overhead on <10 objects every 60 seconds is microseconds, not milliseconds.
- **Debate outcome**: Database reviewer challenged this as premature optimization, and I accept. The database IS a system boundary per CLAUDE.md's "parse, don't validate" principle. Removing Zod validation weakens data integrity guarantees for negligible performance gain. The `findDue` hot path processes few rows. This finding is withdrawn as a performance concern and reclassified as informational only.
- **Status**: WITHDRAWN (premature optimization at current scale; Zod at boundaries is correct per project principles)

**5. In-memory pagination for `findByStatus` in ListSchedules** - `/Users/dean/Sandbox/delegate/src/adapters/mcp-adapter.ts:996`
- **Confidence**: HIGH (corroborated by Database reviewer finding #2, Quality reviewer finding S1)
- **Problem**: `ListSchedules` calls `findByStatus()` which fetches ALL matching rows, then applies `.slice(offset, offset + limit)` in JavaScript. The `findByStatusStmt` at `schedule-repository.ts:136-138` has no LIMIT/OFFSET.
- **Impact**: If there are thousands of completed/cancelled schedules, all of them get fetched from SQLite, deserialized (including JSON.parse for each task_template), Zod-validated, converted to domain objects, then most are thrown away by the slice.
- **Fix**: Add a `findByStatusPaginated` method or add LIMIT/OFFSET to the existing query:
  ```sql
  SELECT * FROM schedules WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?
  ```

**6. `clearRunningScheduleByTask` uses linear scan** - `/Users/dean/Sandbox/delegate/src/services/schedule-executor.ts:119-126`
- **Confidence**: LOW (technically correct but practically irrelevant at expected scale)
- **Problem**: When a task completes, `clearRunningScheduleByTask` iterates through all entries in `runningSchedules` Map to find the matching taskId. This is O(n) where n is the number of concurrently running schedule tasks.
- **Impact**: Low in practice (few concurrent schedules), but the design is suboptimal. With many concurrent cron schedules, every task completion event triggers this linear scan.
- **Honesty note**: With a realistic maximum of ~50 concurrent schedules, the linear scan takes microseconds. This is a textbook optimization that provides negligible real-world benefit at expected scale. Downgraded from original report.
- **Fix**: Maintain a reverse lookup Map (dual-map pattern).

---

## Issues in Code You Touched (Should Fix)

### HIGH

**7. Event subscriptions in ScheduleExecutor constructor are never unsubscribed** - `/Users/dean/Sandbox/delegate/src/services/schedule-executor.ts:82-113`
- **Confidence**: HIGH (corroborated by Quality reviewer H1 shutdown finding, Architecture reviewer constructor side-effects finding)
- **Problem**: `subscribeToTaskEvents()` subscribes to 5 events (`ScheduleExecuted`, `TaskCompleted`, `TaskFailed`, `TaskCancelled`, `TaskTimeout`) in the constructor, but `stop()` at line 187 only clears the timer. The subscriptions persist even after the executor is stopped. There is no `dispose()` or `destroy()` method, and no subscription IDs are stored for later cleanup.
- **Impact**: This is a resource leak. If the executor is stopped and recreated (e.g., during testing or reconfiguration), orphaned event handlers accumulate on the EventBus. Each leaked handler processes every task event for the lifetime of the process. The EventBus has `maxListenersPerEvent` protection, but repeated stop/start cycles will hit that limit and cause errors.
- **Cross-reviewer note**: Quality reviewer identified the shutdown gap (executor.stop() not called during graceful shutdown). Architecture reviewer flagged constructor side effects. All three findings point to the same root cause: the executor's lifecycle management is incomplete.
- **Fix**: Store subscription IDs and clean them up in `stop()`:
  ```typescript
  private subscriptionIds: string[] = [];

  private subscribeToTaskEvents(): void {
    const sub1 = this.eventBus.subscribe('ScheduleExecuted', ...);
    if (sub1.ok) this.subscriptionIds.push(sub1.value);
    // ... etc
  }

  stop(): Result<void, DelegateError> {
    // ... timer cleanup ...
    for (const id of this.subscriptionIds) {
      this.eventBus.unsubscribe(id);
    }
    this.subscriptionIds = [];
    // ...
  }
  ```

**8. ScheduleHandler subscribes to ALL TaskCompleted/TaskFailed events but handlers are no-ops** - `/Users/dean/Sandbox/delegate/src/services/handlers/schedule-handler.ts:117-118`
- **Confidence**: HIGH (corroborated by Architecture reviewer MEDIUM finding, Quality reviewer M4)
- **Problem**: ScheduleHandler subscribes to `TaskCompleted` and `TaskFailed` events for ALL tasks, not just schedule-spawned tasks. The handlers at lines 572-592 do nothing useful -- they just log a debug message. The comment at line 575 acknowledges "we don't have a direct link from task to schedule."
- **Impact**: Every task completion in the system triggers two no-op handler invocations in ScheduleHandler. Combined with the ScheduleExecutor also subscribing to the same events (lines 94-112), each task completion fires 4 redundant event handlers (2 from ScheduleHandler + 2 for TaskFailed/TaskCancelled in ScheduleExecutor that need to scan the runningSchedules map). This is wasteful I/O and CPU for all non-scheduled tasks.
- **Fix**: Remove the no-op subscriptions from ScheduleHandler (lines 117-118 and handlers at 572-592). The ScheduleExecutor already handles task completion tracking properly via the `runningSchedules` map. Re-add when the task-to-schedule linkage feature is built (YAGNI until then).

### MEDIUM

**9. `handleScheduleTask` in MCP adapter saves schedule then emits ScheduleCreated, but ScheduleCreated handler also saves** - `/Users/dean/Sandbox/delegate/src/adapters/mcp-adapter.ts:938-947`
- **Confidence**: HIGH (corroborated by Architecture reviewer CRITICAL finding, Quality reviewer M1)
- **Problem**: `handleScheduleTask` calls `scheduleRepository.save(schedule)` at line 938, then emits `ScheduleCreated` at line 947. The `handleScheduleCreated` handler in `schedule-handler.ts:210` also calls `scheduleRepo.save(updatedSchedule)`. This means the schedule is written to the database twice -- once directly and once via the event handler.
- **Impact**: Two `INSERT OR REPLACE` operations for every schedule creation. The second write also recalculates `nextRunAt` and re-validates, duplicating work already done in the MCP adapter (lines 898-909).
- **Cross-reviewer note**: Architecture reviewer flagged this as CRITICAL (dual-write violates event-driven pattern). Quality reviewer flagged as M1 (double-save). Four reviewers (architecture, performance, quality, and arguably security via duplicate validation) converge on this independently. This is the strongest consensus finding across the entire review.
- **Fix**: Remove the direct `save()` call from MCPAdapter. Only emit `ScheduleCreated` and let `ScheduleHandler` handle persistence. This aligns with the existing `DelegateTask` flow.

---

## Pre-existing Issues (Not Blocking)

### MEDIUM

**10. `SELECT *` pattern used across all repositories** - `/Users/dean/Sandbox/delegate/src/implementations/task-repository.ts:115-131`, `/Users/dean/Sandbox/delegate/src/implementations/dependency-repository.ts:77-129`
- **Confidence**: MEDIUM
- **Problem**: All repositories use `SELECT *` for every query. As tables grow and columns are added, this fetches increasingly more data than needed.
- **Impact**: For the existing task and dependency repositories, the data volume is manageable. But as the system grows, targeted projections would reduce I/O.

### LOW

**11. `cron-parser` `parseExpression` called twice during schedule creation** - `/Users/dean/Sandbox/delegate/src/utils/cron.ts:24-35` and `/Users/dean/Sandbox/delegate/src/utils/cron.ts:49-67`
- **Confidence**: LOW (micro-optimization, not worth the code change)
- **Problem**: `validateCronExpression` parses the expression once for validation, then `getNextRunTime` parses it again to compute the next run. Both are called in `handleScheduleCreated` (schedule-handler.ts:178-195) and `handleScheduleTask` (mcp-adapter.ts:848-909).
- **Impact**: Parsing is cheap (microseconds), but the double-parse is unnecessary since `getNextRunTime` already throws on invalid expressions. Could use `getNextRunTime` alone -- if it succeeds, the expression is valid.

---

## Findings Adopted from Other Reviewers

### CRITICAL (Quality Reviewer H3)

**12. Infinite retrigger on `getNextRunTime` failure** - `/Users/dean/Sandbox/delegate/src/services/handlers/schedule-handler.ts:299-306`
- **Confidence**: HIGH (Quality reviewer identified, Performance impact confirmed)
- **Problem**: When `getNextRunTime` fails for a CRON schedule, `newNextRunAt` remains `undefined`. The update at line 335 uses a spread that excludes `nextRunAt` when undefined, meaning the old (already-past) `nextRunAt` stays. The executor re-triggers this schedule on every 60-second tick indefinitely.
- **Performance Impact**: Each retrigger causes: 1 `findDue` result, 1 `ScheduleTriggered` event emission, 1 `findById` in handler, 1 `createTask` + `taskRepo.save`, 1 `recordExecution`, 1 `scheduleRepo.update` (with the read-modify-write), 1 `TaskDelegated` event, 1 `ScheduleExecuted` event. That's 5+ DB operations and 3+ event emissions every 60 seconds, indefinitely, spawning a new Claude Code process each time.
- **Fix**: On `getNextRunTime` failure, pause the schedule and explicitly clear `nextRunAt` (see Quality reviewer's fix).

---

## Post-Debate Summary (Round 2 Final)

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 3 | 0 |
| Should Fix | 0 | 2 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 1 |
| Adopted | 1 | 0 | 0 | 0 |
| Withdrawn | 0 | 0 | 0 | 1 |

**Changes from Round 1**:
- Finding #3 (`SELECT *`): Downgraded HIGH -> MEDIUM after database reviewer's challenge (SQLite is a row-store; column projection has negligible I/O benefit; real cost is JSON.parse, not I/O)
- Finding #4 (Zod on hot path): WITHDRAWN after database reviewer's challenge (premature optimization at current scale; parse-don't-validate principle is correct at boundaries)

**Performance Score**: 5/10

**Strongest Findings (HIGH confidence, multi-reviewer consensus)**:
1. **Double-save on schedule creation** (#9) -- 4 reviewers converged independently
2. **Event subscription leak** (#7) -- 3 reviewers converged independently
3. **Read-modify-write in `update()`** (#1) -- 3 reviewers converged independently
4. **No-op event handlers** (#8) -- 3 reviewers converged independently
5. **In-memory pagination** (#5) -- 3 reviewers converged independently
6. **Infinite retrigger** (#12, adopted from Quality) -- correctness AND performance bug

**Findings Survived Challenge (MEDIUM confidence)**:
- Sequential tick processing (#2) -- valid optimization but debatable complexity trade-off
- `SELECT *` JSON deserialization (#3) -- downgraded severity but application-layer cost remains valid

**Findings Withdrawn or De-prioritized**:
- Zod on hot path (#4) -- WITHDRAWN, premature optimization; project principle is correct
- Linear scan in clearRunningScheduleByTask (#6) -- LOW confidence, irrelevant at expected scale

**Recommendation**: CHANGES_REQUESTED

The six HIGH-confidence findings represent genuine performance and correctness issues with strong multi-reviewer consensus. The infinite retrigger (#12) is the most dangerous -- it causes unbounded resource consumption. The double-save (#9) and read-modify-write (#1) cause measurable wasted work on every schedule operation. The subscription leak (#7) is a slow resource exhaustion that compounds over time.
