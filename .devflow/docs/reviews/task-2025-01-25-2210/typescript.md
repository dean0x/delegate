# TypeScript Review Report

**Branch**: task-2025-01-25_2210 -> main
**Date**: 2026-02-18
**Focus**: Type safety, generics usage, utility types, `any` types, type narrowing, Result type consistency, interface design

---

## Issues in Your Changes (BLOCKING)

### CRITICAL

**Non-null assertion on potentially undefined `scheduledAtMs`** - `/Users/dean/Sandbox/delegate/src/adapters/mcp-adapter.ts:908`
- **Confidence**: HIGH (cross-validated by Quality H2)
- Problem: `nextRunAt = scheduledAtMs!;` uses a non-null assertion that can fail at runtime. When `scheduleType` is `'one_time'` and `scheduledAt` is validated, this is logically safe -- but the code structure does not let the type system prove it. The early return for `!data.scheduledAt` at line 839 sets `scheduledAtMs`, but the code path at line 908 is in a separate `else` branch that TypeScript cannot narrow through. If future refactoring changes the validation order, the assertion becomes a null-pointer crash.
- Impact: Potential runtime `undefined` being assigned where `number` is expected, causing a `new Date(undefined)` at line 956 producing `Invalid Date`.
- Fix: Restructure the control flow so the `else` branch explicitly narrows:
  ```typescript
  } else {
    if (scheduledAtMs === undefined) {
      return {
        content: [{ type: 'text', text: 'scheduledAt must be provided for one-time schedules' }],
        isError: true,
      };
    }
    nextRunAt = scheduledAtMs;
  }
  ```

### HIGH

**Unsafe `as Priority` type assertion** - `/Users/dean/Sandbox/delegate/src/adapters/mcp-adapter.ts:915`
- **Confidence**: HIGH (unchallenged)
- Problem: `priority: data.priority as Priority | undefined` is an unsafe type assertion. The Zod schema validates `data.priority` as `z.enum(['P0', 'P1', 'P2'])`, which is a `string` enum. Casting from `'P0' | 'P1' | 'P2' | undefined` to `Priority | undefined` works only because the Priority enum has identical string values. If the enum values ever diverge from the string literals, this cast silently breaks.
- Impact: Type safety violation that bypasses the compiler's checks.
- Fix: Map the Zod-validated string to the enum explicitly:
  ```typescript
  priority: data.priority ? Priority[data.priority as keyof typeof Priority] : undefined,
  ```
  Or better, use a lookup map that fails loudly on mismatch.

**Unsafe `as ScheduleStatus` assertion** - `/Users/dean/Sandbox/delegate/src/adapters/mcp-adapter.ts:988`
- **Confidence**: HIGH (unchallenged)
- Problem: `status as ScheduleStatus` casts a Zod-validated string to the enum. Same risk as the Priority cast above.
- Impact: If `ScheduleStatus` enum values ever diverge from the string literals in the Zod schema, this silently passes invalid data to the repository.
- Fix: Use a mapping function or validate that the string is a valid enum member at runtime.

**Unsafe `as` casts on event objects in ScheduleExecutor** - `/Users/dean/Sandbox/delegate/src/services/schedule-executor.ts:85,95,100,105,110`
- **Confidence**: HIGH (cross-validated by Architecture, Quality H4)
- Problem: The `subscribeToTaskEvents` method uses `event as ScheduleExecutedEvent`, `event as TaskCompletedEvent`, etc. The EventBus `subscribe` method already provides proper generic typing (`subscribe<T extends DelegateEvent>(eventType: T['type'], handler: EventHandler<T>)`), so these handlers should be typed at subscription time, not via runtime casts.
- Impact: Loss of compile-time type safety. If the event interface changes, the cast silently produces wrong types.
- Fix: Use the generic parameter on `subscribe`:
  ```typescript
  this.eventBus.subscribe<ScheduleExecutedEvent>('ScheduleExecuted', async (event) => {
    this.markScheduleRunning(event.scheduleId, event.taskId);
  });
  ```
  This is how `ScheduleHandler.subscribeToEvents()` does it (line 108), providing properly typed event parameters without casts.

**`as unknown as` double cast for correlation ID** - `/Users/dean/Sandbox/delegate/src/services/handlers/schedule-handler.ts:503`
- **Confidence**: HIGH (cross-validated by Architecture, Quality H4, Security SF1)
- Problem: `(e as unknown as { __correlationId?: string }).__correlationId` is a type-unsafe double cast to access an undocumented internal property. This pattern also appears in the `respondError` and `respond` calls at lines 514, 527, 540, 552 where `this.eventBus` is cast to `{ respondError?: ... }` and `{ respond?: ... }`.
- Impact: These casts bypass the type system entirely. If `__correlationId` is removed or renamed, this silently produces `undefined`. If `respondError`/`respond` methods change signature, the calls fail silently.
- Fix: If the request-response correlation pattern is a first-class feature of the EventBus, it should be part of the `EventBus` interface definition. Add `respond` and `respondError` methods to the interface, and include `correlationId` in the event type:
  ```typescript
  // In BaseEvent or a RequestEvent extension:
  export interface RequestEvent extends BaseEvent {
    __correlationId?: string;
  }
  ```

**`Record<string, unknown>` response object** - `/Users/dean/Sandbox/delegate/src/adapters/mcp-adapter.ts:1068`
- **Confidence**: MEDIUM (unchallenged, but lower severity than other findings)
- Problem: `const response: Record<string, unknown>` is a weakly-typed container. It can hold anything and provides no compile-time checking for the shape of the JSON response. The `history` field is dynamically added at line 1100 without any type checking.
- Impact: If the response shape needs to change, there is no compiler support to catch breakage.
- Fix: Define an explicit response interface:
  ```typescript
  interface ScheduleDetailResponse {
    success: boolean;
    schedule: { /* typed fields */ };
    history?: Array<{ /* typed fields */ }>;
  }
  ```

### MEDIUM

**`ScheduleUpdate` type defined but not used where `Partial<Schedule>` is used instead** - `/Users/dean/Sandbox/delegate/src/core/domain.ts:302` vs `/Users/dean/Sandbox/delegate/src/core/interfaces.ts:250`
- **Confidence**: HIGH (cross-validated by Security M3, Architecture: unrestricted updates)
- Problem: `ScheduleUpdate` is defined in domain.ts (line 302) with carefully selected mutable fields. However, `ScheduleRepository.update()` (interfaces.ts line 250) accepts `Partial<Schedule>` instead of `ScheduleUpdate`. Similarly, `ScheduleUpdatedEvent.update` (events.ts line 273) uses `Partial<Schedule>`. This means callers can pass `id`, `taskTemplate`, `createdAt`, and other fields that should be immutable after creation.
- Impact: The `ScheduleUpdate` type exists to restrict which fields can be modified, but it is never enforced. Security reviewer notes this allows arbitrary field mutation through the `ScheduleUpdated` event, including `taskTemplate` modification (prompt injection vector). This elevates the TypeScript concern into a security issue.
- Fix: Use `ScheduleUpdate` consistently:
  ```typescript
  // In ScheduleRepository:
  update(id: ScheduleId, update: ScheduleUpdate): Promise<Result<void>>;
  // In ScheduleUpdatedEvent:
  update: ScheduleUpdate;
  ```

**Missing exhaustive check in `handleScheduleCreated`** - `/Users/dean/Sandbox/delegate/src/services/handlers/schedule-handler.ts:168-206`
- **Confidence**: HIGH (cross-validated by Quality H3 which identifies a concrete consequence)
- Problem: The `if/else if` chain for `schedule.scheduleType` does not handle the case where `scheduleType` is neither `CRON` nor `ONE_TIME`. Since `ScheduleType` is an enum, TypeScript's exhaustiveness checking could catch future additions, but the code uses `if/else if` without a final `else` that would catch unhandled cases.
- Impact: Quality reviewer identified a concrete downstream consequence: if `nextRunAt` remains `undefined` for a CRON schedule because `getNextRunTime` fails at line 299-306, the schedule retains the old (already-past) `nextRunAt`, causing the executor to re-trigger on every tick indefinitely. The missing exhaustive check is part of a broader pattern where `undefined` silently propagates through the update logic.
- Fix: Add an exhaustive else clause:
  ```typescript
  } else {
    const _exhaustive: never = schedule.scheduleType;
    return err(new DelegateError(
      ErrorCode.INVALID_INPUT,
      `Unknown schedule type: ${_exhaustive}`,
      { scheduleId: schedule.id }
    ));
  }
  ```

**Missing exhaustive check in `handleMissedRun` switch** - `/Users/dean/Sandbox/delegate/src/services/schedule-executor.ts:324-373`
- **Confidence**: HIGH (unchallenged)
- Problem: The `switch (schedule.missedRunPolicy)` has no `default` case. `MissedRunPolicy` is an enum with three values, but if a new policy is added, the switch silently does nothing.
- Impact: Silent no-op for unhandled missed run policies.
- Fix: Add a `default` case with exhaustive check:
  ```typescript
  default: {
    const _exhaustive: never = schedule.missedRunPolicy;
    this.logger.error('Unknown missed run policy', undefined, {
      scheduleId: schedule.id,
      policy: _exhaustive
    });
  }
  ```

**Silent default in `toMissedRunPolicy` and `toScheduleStatus`** - `/Users/dean/Sandbox/delegate/src/implementations/schedule-repository.ts:378-408`
- **Confidence**: HIGH (cross-validated by Security M4, Database item 8)
- Problem: Both `toMissedRunPolicy()` (line 378) and `toScheduleStatus()` (line 394) have `default:` cases that silently return a fallback value (`MissedRunPolicy.SKIP` and `ScheduleStatus.ACTIVE`). This masks database corruption or schema drift by returning incorrect data.
- Impact: If the database contains an invalid status value, the application silently treats it as SKIP/ACTIVE rather than flagging the corruption. Security reviewer notes this is especially dangerous because defaulting to ACTIVE could re-trigger cancelled schedules.
- Fix: The `default` case should throw an error since the Zod schema validation at the boundary (line 1402) should catch invalid values before reaching these methods:
  ```typescript
  default:
    throw new Error(`Unknown missed_run_policy: ${value}`);
  ```

**`error as Error` unsafe cast in tick()** - `/Users/dean/Sandbox/delegate/src/services/schedule-executor.ts:247,297`
- **Confidence**: MEDIUM (unchallenged, valid but low impact)
- Problem: `this.logger.error('Scheduler tick failed', error as Error)` and `this.logger.error('Failed to execute schedule', error as Error, ...)` cast `unknown` to `Error` without validation. The caught value could be a string, number, or any other type.
- Impact: If the thrown value is not an `Error`, the logger may receive an object without `message` or `stack` properties.
- Fix: Use a type guard or normalize:
  ```typescript
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    this.logger.error('Scheduler tick failed', normalizedError);
  }
  ```

---

## Cross-Review Challenges

### Challenging Performance Finding #4 (Remove Zod validation on hot path)

Performance reviewer suggests removing Zod validation from `rowToSchedule()` on the `findDue` hot path to improve performance. **I disagree with this recommendation.** From a TypeScript type safety perspective:

1. Removing Zod validation makes the `as DelegateRequest` cast at `/Users/dean/Sandbox/delegate/src/implementations/schedule-repository.ts:402-405` completely unchecked, worsening Security's H2 finding (unsafe JSON deserialization).
2. The "parse, don't validate" principle (documented in CLAUDE.md) exists precisely to catch schema drift and corruption at boundaries. The database IS a boundary.
3. The overhead of Zod parsing 50 rows is negligible (sub-millisecond total). The real performance fix is what Performance reviewer already suggests in finding #3: use a projection that excludes `task_template` from the `findDue` query.
4. If the projection fix is applied, the Zod validation only runs when full rows are needed (findById, after trigger), making the hot-path concern moot.

**Recommendation**: Keep Zod validation, fix the query projection instead.

### Validating Architecture Finding: Dual-write

Architecture's CRITICAL finding about the dual-write (MCPAdapter saves at line 938, then ScheduleHandler saves at line 210) is architecturally correct. From the TypeScript perspective, this also creates a type inconsistency: the first save persists a `Schedule` without `nextRunAt`, while the second save persists a `Schedule` with `nextRunAt`. The intermediate database state has an incomplete type (missing a field the domain type says should be computed). This reinforces the architecture finding.

### Validating Quality Finding H3: Infinite retrigger

Quality's H3 (infinite retrigger on `getNextRunTime` failure) is a real and serious bug that my "missing exhaustive check" finding only partially identified. The TypeScript angle: the spread syntax `...(newNextRunAt !== undefined ? { nextRunAt: newNextRunAt } : {})` at line 335 means `nextRunAt` is never explicitly set to `undefined` -- when `newNextRunAt` is `undefined`, the spread contributes nothing, so the old `nextRunAt` persists. This is a TypeScript pattern issue: using conditional spreads to skip fields can silently preserve stale values.

---

## Issues in Code You Touched (Should Fix)

### HIGH

**`EventBus.on/once/onRequest` methods use `any`** - `/Users/dean/Sandbox/delegate/src/core/events/event-bus.ts:28-31`
- **Confidence**: HIGH (cross-validated by Architecture's finding about EventBus casts)
- Problem: These convenience methods on the EventBus interface use `(data: any) => void` and `Promise<Result<any>>`. The new schedule code works around these methods, but the untyped interface encourages unsafe patterns and makes the `as unknown as` casts in schedule-handler.ts necessary.
- Impact: Any consumer of these methods loses all type safety.
- Fix: Consider typing these methods generically or removing them if the typed `subscribe/emit` methods suffice.

### MEDIUM

**`TaskEventEmitter` interface uses `any`** - `/Users/dean/Sandbox/delegate/src/core/interfaces.ts:344-345`
- **Confidence**: HIGH (cross-validated by Architecture: unused legacy interface)
- Problem: `emit(event: string, ...args: any[]): void` and `off(event: string, listener: (...args: any[]) => void): void` use `any[]` parameters. This interface appears to be legacy.
- Impact: Any code using this interface bypasses type checking entirely.
- Fix: Either remove this interface if it is unused (the EventBus interface replaces it), or type it with the event union.

---

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Widespread `as any` casts in task-queue.ts** - `/Users/dean/Sandbox/delegate/src/implementations/task-queue.ts:66,75,107,110,189,190`
- Problem: Multiple `as any` casts to access an `__insertionOrder` property that is not part of the Task interface.
- Impact: Type-unsafe access to an undeclared property.
- Fix: Extend the Task interface or use a wrapper type that includes `__insertionOrder`.

**`as any` casts in cli.ts** - `/Users/dean/Sandbox/delegate/src/cli.ts:165,221,300,354,390`
- Problem: `taskManagerResult.value as any` appears 5 times, completely bypassing type safety on the task manager.
- Impact: All method calls on the task manager in the CLI have no type checking.

**`as any` casts in event-bus.ts** - `/Users/dean/Sandbox/delegate/src/core/events/event-bus.ts:297,501,505,519,529,530,545`
- Problem: Multiple `as any` casts in the EventBus implementation for compatibility methods.

**`error: any` in output-repository.ts and database.ts** - `/Users/dean/Sandbox/delegate/src/implementations/output-repository.ts:161,219`, `/Users/dean/Sandbox/delegate/src/implementations/database.ts:199`
- Problem: Catch clauses use `error: any` instead of `unknown`.

**`data?: any` in types.ts** - `/Users/dean/Sandbox/delegate/src/types.ts:20`
- Problem: Generic error response type uses `any` for data field.

---

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 1 | 5 | 3 | 0 |
| Should Fix | 0 | 1 | 1 | 0 |
| Pre-existing | 0 | 0 | 5 | 0 |

**TypeScript Score**: 6/10

The new scheduling code demonstrates good practices overall: branded types for IDs (`ScheduleId`), immutable interfaces with `readonly`, Result types consistently used, Zod validation at boundaries, and factory functions returning frozen objects. However, the score is pulled down by several unsafe type assertions (`as Priority`, `as ScheduleStatus`, `as unknown as`, `as Error`), a non-null assertion (`scheduledAtMs!`), missing exhaustive checks on discriminated unions, and the mismatch between the defined `ScheduleUpdate` type and the actual `Partial<Schedule>` used in the repository interface.

**Recommendation**: CHANGES_REQUESTED

The CRITICAL non-null assertion and HIGH-severity unsafe casts need to be addressed before merge. The `scheduledAtMs!` assertion can produce runtime errors, and the `as` casts on event types in `ScheduleExecutor` bypass the existing generic type system of the EventBus without justification.

### Top 5 Findings by Confidence

1. **HIGH**: Non-null assertion `scheduledAtMs!` (CRITICAL) - cross-validated by Quality
2. **HIGH**: Unsafe `as unknown as` casts in handleScheduleQuery - cross-validated by Architecture, Quality, Security
3. **HIGH**: `ScheduleUpdate` type defined but not enforced, `Partial<Schedule>` allows unrestricted updates - cross-validated by Security, Architecture
4. **HIGH**: Silent enum defaults in `toMissedRunPolicy`/`toScheduleStatus` masking corruption - cross-validated by Security, Database
5. **HIGH**: Missing exhaustive checks enabling infinite retrigger bug - cross-validated by Quality H3
