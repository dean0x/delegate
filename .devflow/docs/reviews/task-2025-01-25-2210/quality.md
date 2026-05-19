# Quality Review Report

**Branch**: task-2025-01-25_2210 -> main
**Date**: 2026-02-18 (updated after debate round)
**Focus**: Complexity, Test Gaps, Pattern Violations, Regressions, Naming, Consistency

---

## Debate Challenges

### Challenges TO other reviewers

**1. Performance P2 "Sequential schedule processing" is correct but overstated**

Performance reviewer flags sequential processing in `schedule-executor.ts:243-245` and recommends `Promise.allSettled`. I agree this is suboptimal but challenge the severity. Each `executeSchedule` call only emits an event -- the actual DB work happens asynchronously in the handler. The `emit()` call itself is fast. More importantly, `Promise.allSettled` introduces a new problem: if two schedules for the same template fire simultaneously, you lose the sequential ordering guarantee that prevents races in the handler. The architecture reviewer correctly identifies that the executor should only detect and emit, so the real bottleneck is handler processing, not the executor loop. This should be LOW, not HIGH.

**2. Database reviewer's "INSERT OR REPLACE silently overwrites" (DB finding #4) is overstated**

Schedule IDs use `crypto.randomUUID()` with a `schedule-` prefix (`domain.ts:1039`). UUID collision probability is astronomically low. The `save()` method is intentionally dual-purpose (used by both create and update paths in the repository). While I agree a dedicated UPDATE statement would be cleaner (and would fix the read-modify-write concern simultaneously), calling this a blocking issue based on UUID collision risk is not realistic. Downgrade to MEDIUM.

**3. Security M1 "No rate limiting on schedule creation" -- agree but note this is not a new pattern**

The existing `DelegateTask` handler also has no rate limiting on task creation. The task queue has concurrency limits via the worker pool, but nothing prevents creating thousands of queued tasks. The schedule rate limit concern is valid but should be classified as PRE-EXISTING pattern gap, not BLOCKING for this PR alone. The security reviewer correctly identifies the risk but should acknowledge the consistency with existing task creation.

**4. Architecture reviewer's "ScheduleExecutor constructor side effects" finding is valid but exaggerated to HIGH**

The architecture reviewer flags constructor-time event subscriptions as HIGH. I agree this is inconsistent with the `ScheduleHandler` factory pattern. However, the existing `InMemoryEventBus` constructor also performs initialization work, and `EventDrivenWorkerPool` subscribes to events in its constructor (checked). The inconsistency is real but it is a pattern that already exists in the codebase. Should be MEDIUM.

### Challenges FROM other reviewers to my findings

**Self-correction: M3 (`useWorktree` default change) is WITHDRAWN**

I initially flagged the `useWorktree` default changing from `true` to `false` as a regression. After checking the main branch, the Zod schema ALREADY had `.default(false)` on main. The only change in this PR is correcting the JSON schema description to match the actual runtime default. This is a documentation fix, not a behavioral change. Finding withdrawn.

**Self-correction: H3 severity validated by multiple reviewers**

My infinite-retrigger finding (H3) is independently corroborated by the architecture reviewer (who notes the executor writes directly to the repo) and performance reviewer (who flags the read-modify-write pattern). The combination makes this worse than I initially stated: the failed `getNextRunTime` leaves the old `nextRunAt` in place, the executor re-finds it as "due" every 60 seconds, and each retrigger does a full read-modify-write update. Severity confirmed HIGH.

---

## Final Findings (Post-Debate)

### BLOCKING -- Must fix before merge

**H1. ScheduleExecutor not stopped during graceful shutdown** - `/Users/dean/Sandbox/delegate/src/index.ts:75-94` and `/Users/dean/Sandbox/delegate/src/core/container.ts:202-240`
- **Confidence**: HIGH (unchallenged -- no other reviewer addressed shutdown lifecycle)
- Problem: `ScheduleExecutor.start()` is called in bootstrap but neither the `shutdown()` handler nor `container.dispose()` calls `stop()`. The timer is `.unref()`'d so it won't block exit, but during graceful shutdown, ticks can fire against closed resources.
- Fix: Add `scheduleExecutor.stop()` to `container.dispose()`, before killing workers.

**H2. Non-null assertion on `scheduledAtMs`** - `/Users/dean/Sandbox/delegate/src/adapters/mcp-adapter.ts:908`
- **Confidence**: HIGH (corroborated by TypeScript reviewer as CRITICAL)
- Problem: `nextRunAt = scheduledAtMs!;` uses non-null assertion. TypeScript cannot prove this is safe across the code path.
- Fix: Add explicit guard before assignment.

**H3. Infinite retrigger when `getNextRunTime` fails for CRON schedules** - `/Users/dean/Sandbox/delegate/src/services/handlers/schedule-handler.ts:299-306`
- **Confidence**: HIGH (corroborated by architecture + performance reviewers' related findings)
- Problem: When `getNextRunTime` fails, `newNextRunAt` is `undefined`. The spread `...(newNextRunAt !== undefined ? { nextRunAt: newNextRunAt } : {})` means `nextRunAt` is NOT updated. The old (past) value remains, causing the executor to re-trigger every tick indefinitely.
- Fix: On failure, pause the schedule or explicitly clear `nextRunAt`. Always include `nextRunAt` in the update object.

**H4. Unsafe type casts in `handleScheduleQuery`** - `/Users/dean/Sandbox/delegate/src/services/handlers/schedule-handler.ts:503-555`
- **Confidence**: HIGH (corroborated by TypeScript reviewer + architecture reviewer)
- Problem: `as unknown as` casts to access hypothetical `__correlationId`, `respondError`, `respond` on the event bus.
- Fix: Either add these to the EventBus interface or remove the pattern.

### SHOULD-FIX -- Strongly recommended before merge

**M1. Double-save on schedule creation** - `/Users/dean/Sandbox/delegate/src/adapters/mcp-adapter.ts:938` and `/Users/dean/Sandbox/delegate/src/services/handlers/schedule-handler.ts:209-210`
- **Confidence**: HIGH (identified independently by quality, architecture, and performance reviewers)
- Problem: MCP adapter saves to repo, then emits ScheduleCreated. Handler also saves on that event. Schedule saved twice per creation.
- Fix: Remove save from MCP adapter; let handler be sole persistence owner.

**M2. `CancelSchedule` does not validate schedule status** - `/Users/dean/Sandbox/delegate/src/adapters/mcp-adapter.ts:1048-1090`
- **Confidence**: MEDIUM (only flagged by quality reviewer)
- Problem: Can cancel an already-completed or already-cancelled schedule. Inconsistent with Pause/Resume which validate status.
- Fix: Check status before emitting cancel event.

**M4. Dead event subscriptions (TaskCompleted/TaskFailed handlers are no-ops)** - `/Users/dean/Sandbox/delegate/src/services/handlers/schedule-handler.ts:572-592`
- **Confidence**: HIGH (corroborated by architecture + performance reviewers)
- Problem: Subscribed to all task completion events, does nothing. Combined with ScheduleExecutor also subscribing to same events, every task completion fires 4+ redundant handlers.
- Fix: Remove until feature is actually implemented.

**M5. MCP adapter `handleScheduleTask` has high cyclomatic complexity with duplicated validation** - `/Users/dean/Sandbox/delegate/src/adapters/mcp-adapter.ts:839-935`
- **Confidence**: MEDIUM (quality-only finding, but supported by the double-save corroboration)
- Problem: ~100 lines, 9 early-return error paths. Duplicates cron/timezone validation that the handler also performs.
- Fix: Adapter should do Zod boundary validation only; delegate business validation to handler.

**M6. `runningSchedules` map lost on restart** - `/Users/dean/Sandbox/delegate/src/services/schedule-executor.ts:58`
- **Confidence**: HIGH (corroborated by security reviewer as M2)
- Problem: In-memory concurrent execution prevention is not persisted. Process restart loses running state, enabling duplicate executions.
- Fix: At minimum, document limitation. Ideally, check execution history on startup.

### LOW -- Informational

**L1. Inconsistent error code usage** - `/Users/dean/Sandbox/delegate/src/implementations/schedule-repository.ts:224`
- **Confidence**: HIGH (corroborated by architecture reviewer)
- `ErrorCode.TASK_NOT_FOUND` used for missing schedules.

**L2. `defaultTimezone` field never used** - `/Users/dean/Sandbox/delegate/src/services/handlers/schedule-handler.ts:42`
- **Confidence**: HIGH (unchallenged)
- Dead field and options type.

**L3. Missing newline at end of file** - `mcp-adapter.ts` and `domain.ts`
- **Confidence**: HIGH (trivial, verifiable from diff)

~~**M3. `useWorktree` default changed from `true` to `false`**~~ -- **WITHDRAWN**
- The Zod schema already had `.default(false)` on main. This PR only corrects the JSON schema description to match. Not a behavioral change.

---

## Test Coverage Analysis

### Tested:
- `SQLiteScheduleRepository`: 557 lines of thorough tests (save, update, find*, delete, count, recordExecution, getExecutionHistory, enum mappings)
- `cron.ts` utilities: 224 lines (all exported functions, happy/error paths)

### NOT tested (critical gaps):

| Component | Lines | Tests | Risk |
|-----------|-------|-------|------|
| `ScheduleHandler` | 593 | NONE | Contains event lifecycle, state machine, task creation |
| `ScheduleExecutor` | 428 | NONE | Contains timer loop, missed run policies, concurrency guard |
| MCP adapter schedule tools | ~490 | NONE | Contains 6 tool handlers with validation |
| `createSchedule`/`updateSchedule`/`isScheduleActive` | ~30 | NONE | Domain factory functions |

The untested components contain the findings from this and other reviews: the infinite-retrigger bug (H3), the dead event subscriptions (M4), the concurrent execution guard (M6), and the missed run policy logic. Tests would have caught H3 specifically -- a test that stubs `getNextRunTime` to fail and verifies the schedule is paused/stopped rather than left with a stale `nextRunAt`.

**Does existing test coverage address security and performance concerns?** No. The security reviewer's H1 (missing path validation) and H2 (unsafe JSON deserialization) are in the MCP adapter schedule handlers which have zero tests. The performance reviewer's read-modify-write concern (P1) is in the repository `update()` method which IS tested, but the tests are sequential and wouldn't surface the race condition.

---

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 4 | 0 | 0 |
| Should Fix | 0 | 0 | 5 | 3 |
| Pre-existing | 0 | 0 | 0 | 2 |

**Quality Score**: 4/10

**Recommendation**: **CHANGES_REQUESTED**

### Cross-reviewer consensus (findings confirmed by 3+ reviewers):
1. **Double-save** on schedule creation (quality, architecture, performance)
2. **Unsafe type casts** in handleScheduleQuery (quality, architecture, typescript)
3. **Dead event subscriptions** in ScheduleHandler (quality, architecture, performance)
4. **Silent enum defaults** in toMissedRunPolicy/toScheduleStatus (quality, typescript, database, security)
5. **Non-null assertion** on scheduledAtMs (quality, typescript)

### Unique quality findings not raised elsewhere:
1. **H1**: ScheduleExecutor shutdown gap (only quality reviewer)
2. **H3**: Infinite retrigger on getNextRunTime failure (only quality reviewer, though supported by related findings)
