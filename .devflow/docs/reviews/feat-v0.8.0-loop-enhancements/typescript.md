# TypeScript Review Report

**Branch**: feat/v0.8.0-loop-enhancements -> main
**Date**: 2026-03-23

## Issues in Your Changes (BLOCKING)

### HIGH

**Unsafe double-cast: `loop.id as unknown as TaskId`** - `src/services/handlers/schedule-handler.ts:560`
**Confidence**: 92%
- Problem: `loop.id` is a `LoopId` branded type, but it is double-cast through `unknown` to `TaskId` to fit the `ScheduleExecutedEvent.taskId` field. This bypasses the type system entirely, creating a runtime value where a `LoopId` masquerades as a `TaskId`. If any downstream consumer of `ScheduleExecutedEvent` uses the `taskId` to query the task repository, it will silently fail to find a match because it is actually a loop ID.
- Fix: Expand the `ScheduleExecutedEvent` interface and `clearRunningScheduleByTask` to accept a union type (`TaskId | LoopId`) or add a dedicated `entityId: string` field. Alternatively, introduce a `ScheduleLoopExecuted` event type. This avoids the unsafe cast while keeping the intent clear:
  ```typescript
  // Option A: Widen the event
  export interface ScheduleExecutedEvent extends BaseEvent {
    type: 'ScheduleExecuted';
    scheduleId: ScheduleId;
    taskId?: TaskId;
    loopId?: LoopId;
    executedAt: number;
  }

  // Option B: Widen clearRunningScheduleByTask
  private clearRunningScheduleByTask(entityId: TaskId | LoopId): void { ... }
  ```

**`--strategy` flag parsed but value discarded** - `src/cli/commands/schedule.ts:159-164`
**Confidence**: 95%
- Problem: The `--strategy` flag is validated (`'retry' | 'optimize'`), the index is incremented to consume the argument, but the parsed value is never stored in any variable. This means `--strategy retry` is silently accepted but has no effect -- the actual strategy is always inferred from `--until` (retry) vs `--eval` (optimize). If a user passes `--strategy optimize --until <cmd>`, the strategy will still be RETRY despite explicitly requesting OPTIMIZE.
- Fix: Either (a) store the value and use it to determine strategy, or (b) remove the `--strategy` flag entirely if it is only informational. Option (b) is safer:
  ```typescript
  // Option A: Store and use strategy
  } else if (arg === '--strategy' && next) {
    if (next !== 'retry' && next !== 'optimize') {
      return err('--strategy must be "retry" or "optimize"');
    }
    explicitStrategy = next; // Store it
    i++;
  }
  // Then in loop config construction:
  // strategy: explicitStrategy === 'optimize' ? LoopStrategy.OPTIMIZE : LoopStrategy.RETRY,

  // Option B: Remove dead code
  // Delete the entire '--strategy' branch
  ```

### MEDIUM

**`LoopConfigSchema.parse()` cast to `LoopCreateRequest` masks type mismatch** - `src/implementations/schedule-repository.ts:583`
**Confidence**: 85%
- Problem: `LoopConfigSchema` uses `z.enum(['retry', 'optimize'])` for `strategy` and `z.enum(['minimize', 'maximize'])` for `evalDirection`, which parse to string literals. However, `LoopCreateRequest.strategy` expects `LoopStrategy` (an enum) and `evalDirection` expects `OptimizeDirection` (an enum). With `strict: true` in tsconfig, TypeScript string enums are nominally typed -- `'retry'` is not assignable to `LoopStrategy.RETRY` without a cast. The `as LoopCreateRequest` cast hides this structural mismatch. If anyone adds a field to `LoopCreateRequest` (e.g., with a non-string type), the cast will silently accept the wrong shape.
- Fix: Use `z.nativeEnum()` for enum fields in the schema, which produces the actual enum type, then use `satisfies` instead of `as`:
  ```typescript
  import { LoopStrategy, OptimizeDirection, Priority } from '../core/domain.js';

  const LoopConfigSchema = z.object({
    // ...
    strategy: z.nativeEnum(LoopStrategy),
    evalDirection: z.nativeEnum(OptimizeDirection).optional(),
    priority: z.nativeEnum(Priority).optional(),
    // ...
  });
  // Then:
  loopConfig = LoopConfigSchema.parse(parsed) satisfies LoopCreateRequest;
  ```
  This follows the same pattern already used in `LoopRowSchema` (line 50) which uses `z.enum()` for DB string values. For the schedule-repository bridge, `z.nativeEnum()` ensures type-safe round-tripping.

**`priority` and `agent` double-cast from Zod output** - `src/adapters/mcp-adapter.ts:2003-2004` and `src/adapters/mcp-adapter.ts:334-335`
**Confidence**: 82%
- Problem: Two separate locations cast Zod-parsed `data.priority` as `Priority | undefined` and `data.agent` as `AgentProvider | undefined`. The Zod schemas use `z.enum(['P0', 'P1', 'P2'])` and `z.enum(AGENT_PROVIDERS_TUPLE)`, which produce string literal types, not the branded enum types. This is the same pattern as the `LoopConfigSchema` issue -- the `as` casts suppress the type mismatch.
- Locations:
  - `src/adapters/mcp-adapter.ts:2003` (handleScheduleLoop)
  - `src/adapters/mcp-adapter.ts:2004` (handleScheduleLoop)
  - `src/adapters/mcp-adapter.ts:196` (handleCreateLoop - pre-existing, same pattern)
  - `src/adapters/mcp-adapter.ts:197` (handleCreateLoop - pre-existing, same pattern)
- Fix: Use `z.nativeEnum(Priority)` and type-safe conversion functions in the Zod schema definitions, or use `toEnum()` helper functions in the handler that return the proper enum type.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`clearRunningScheduleByTask` parameter typed as `string` instead of branded type** - `src/services/schedule-executor.ts:171`
**Confidence**: 80%
- Problem: The method accepts `string` instead of `TaskId | LoopId`. Now that both `TaskId` (from task events) and `LoopId` (from loop events) flow into this method, the parameter type should reflect the actual value space. The current `string` type is too permissive and masks the architectural decision to reuse this method for loop tracking.
- Fix: Type the parameter as `TaskId | LoopId` to document the dual usage:
  ```typescript
  private clearRunningScheduleByTask(entityId: TaskId | LoopId): void {
  ```

**`markScheduleRunning` parameter typed as `string` instead of branded types** - `src/services/schedule-executor.ts:184`
**Confidence**: 80%
- Problem: Same issue as above -- the method now implicitly accepts `LoopId` in the `taskId` slot, but the signature does not reflect this.
- Fix: Update signature to `markScheduleRunning(scheduleId: ScheduleId, entityId: TaskId | LoopId): void`.

## Pre-existing Issues (Not Blocking)

No CRITICAL pre-existing issues found.

## Suggestions (Lower Confidence)

- **Missing exhaustive `never` check in `toLoopStatus`** - `src/implementations/loop-repository.ts:645-657` (Confidence: 70%) -- The `default` branch throws a generic `Error` instead of using the `const _exhaustive: never = value` pattern to catch new enum members at compile time. The Zod schema already validates, so this is defense-in-depth, but it would catch desync between the enum and the switch at build time.

- **`LoopPausedEvent` could carry iteration context** - `src/core/events/events.ts:229-233` (Confidence: 65%) -- The `LoopPausedEvent` carries `force: boolean` but not the current iteration number or task ID. The handler fetches this from the DB, but including it in the event would make the handler more efficient and the event more self-describing.

- **`ScheduleExecution` `recordExecution` relies on positional parameters** - `src/implementations/schedule-repository.ts:257-258` (Confidence: 62%) -- The `recordExecutionStmt` uses positional `?` placeholders (9 values). Adding `loop_id` as the 8th parameter makes this fragile -- a single position error silently misplaces values. Named parameters (like the `save`/`update` statements use) would be safer.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**TypeScript Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The unsafe double-cast (`as unknown as TaskId`) and the dead `--strategy` flag parsing are the two most impactful issues. The double-cast violates the branded type system that is a key safety mechanism in this codebase, and the dead code creates a confusing UX where a documented flag has no effect. The Zod-to-enum cast issues are lower risk since the string enum values happen to match at runtime, but they weaken the type safety guarantees over time.
