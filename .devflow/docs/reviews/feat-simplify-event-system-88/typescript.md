# TypeScript Review Report

**Branch**: feat/simplify-event-system-88 -> main
**Date**: 2026-03-16
**Commits**: 5 (dd3ff3a, b180f88, 9f5f39d, 5ed284f, e5f5b2f)
**Scope**: Remove 9 dead/informational events, replace query events with direct calls, linearize TaskPersisted trigger chain

## Issues in Your Changes (BLOCKING)

### CRITICAL

None.

### HIGH

None.

### MEDIUM

**1. Type assertion narrows union without exhaustive check** - `src/services/handlers/dependency-handler.ts:344`
- Problem: `failure.type as 'cycle' | 'depth' | 'system'` uses a type assertion to narrow from the full union `'ok' | 'cycle' | 'depth' | 'system'`. The guard on line 339 (`failure.error !== null` + `failure && failure.error`) ensures `type` is not `'ok'` at runtime, but TypeScript cannot verify this statically. The `as` cast silently bypasses the type checker.
- Impact: If the `validateSingleDependency` return type ever gains a new variant with a non-null error and a different type string, this cast would silently accept it. Low risk today but fragile under evolution.
- Fix: Refine the return type of `validateSingleDependency` to use a discriminated union so TypeScript can narrow automatically:
  ```typescript
  type ValidationResult =
    | { depId: TaskId; error: null; type: 'ok' }
    | { depId: TaskId; error: Error; type: 'cycle' | 'depth' | 'system' };

  // Then the find + guard narrows correctly without a cast:
  const failure = validationResults.find(
    (r): r is Extract<ValidationResult, { error: Error }> => r.error !== null
  );
  if (failure) {
    await this.handleValidationFailure(task.id, task.dependsOn, failure);
    // no `as` needed
  }
  ```
- Category: Blocking (this line is modified in this branch)

### LOW

**2. `enqueueIfReady` is public but only called internally** - `src/services/handlers/queue-handler.ts:58`
- Problem: The new `enqueueIfReady(task: Task): Promise<Result<void>>` method is declared as `async` public. It is only called by `PersistenceHandler.handleTaskDelegated()`. Exposing it publicly widens the API surface unnecessarily.
- Impact: Any consumer with a `QueueHandler` reference can call `enqueueIfReady` outside the intended call path. Minor coupling concern.
- Fix: Since `PersistenceHandler` already receives `QueueHandler` as a constructor dependency (concrete type, not interface), keeping it public is functionally required for the current design. However, if an interface were introduced (e.g., `EnqueueReady`), this could be narrowed. Acceptable as-is; note for future.
- Category: Blocking (new code in this branch)

## Issues in Code You Touched (Should Fix)

### MEDIUM

**3. `as Partial<Task>` assertions bypass type narrowing** - `src/services/handlers/persistence-handler.ts:90,118,146,172,198`
- Problem: Five occurrences of `as Partial<Task>` on the update payloads. These casts are needed because `repository.update()` expects `Partial<Task>` but the object literals contain fields like `status` (enum), `completedAt` (number), etc. that TypeScript infers as narrower literal types. The cast suppresses excess property checks, meaning a typo or invalid field would not be caught.
- Impact: If a field name is misspelled (e.g., `completeAt` instead of `completedAt`), TypeScript will not flag it. This is a pre-existing pattern, but all five occurrences are in functions that are part of the reviewed diff (subscriptions changed in `setup()`).
- Fix: Consider typing the update parameter as `Partial<Pick<Task, 'status' | 'completedAt' | 'exitCode' | 'duration' | 'startedAt' | 'workerId'>>` on the repository interface, or use `satisfies Partial<Task>` (TypeScript 4.9+) to preserve excess property checking while verifying assignability.
- Category: Should-Fix (same file, functions adjacent to your changes)

**4. `error as Error` assertion in catch blocks** - `src/services/handlers/worker-handler.ts:455,480`
- Problem: Two catch blocks use `error as Error` and `err as Error` without runtime validation. If the thrown value is not an `Error` (e.g., a string or number), this assertion would produce an object that lacks `.message` and `.stack`.
- Impact: The logger would receive a non-Error object as the second argument. Most loggers handle this gracefully, but it violates the TypeScript skill's guidance to prefer type guards over unsafe assertions.
- Fix: Apply the same normalization pattern used at line 414:
  ```typescript
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  this.logger.error('Error handling worker completion', normalizedError, { taskId, exitCode });
  ```
- Category: Should-Fix (these methods are in the same file as your changes; the pattern already exists at line 414)

### LOW

**5. `repositoryResult.value as TaskRepository` assertion in bootstrap** - `src/bootstrap.ts:392`
- Problem: `repositoryResult.value as TaskRepository` casts a generic container value. The DI container returns `unknown`, and this cast bypasses the type check.
- Impact: Minimal -- the container registration on a prior line guarantees the type. But `getFromContainer<TaskRepository>` is used elsewhere in the same function and would be more consistent.
- Fix: Use the same helper pattern:
  ```typescript
  return new RecoveryManager(
    getFromContainer<TaskRepository>(container, 'taskRepository'),
    ...
  );
  ```
- Category: Should-Fix (same function as your changes at lines 338-365)

## Pre-existing Issues (Not Blocking)

### MEDIUM

**6. `any` types in EventBus testing convenience methods** - `src/core/events/event-bus.ts:33,36,38,505,510,525,536,553`
- Problem: Eight occurrences of `any` in the testing convenience methods (`on`, `once`, `onRequest`). Each has a biome-ignore comment explaining why, but the TypeScript skill's iron law is "Unknown over Any."
- Impact: These methods are testing convenience only and don't affect production type safety. The comments justify each exception.
- Fix: None needed -- these are justified exceptions for test API compatibility. Already annotated with biome-ignore comments.
- Category: Pre-existing

**7. `as any` in BaseEventHandler.emitEvent helper** - `src/core/events/handlers.ts:54`
- Problem: `eventBus.emit(eventType as any, payload as any)` -- double `any` cast to work around TypeScript's inability to infer payload type from a string event type.
- Impact: Documented architecture exception with clear justification. The alternative would be no DRY helper.
- Fix: None practical without a major type system redesign. Well documented.
- Category: Pre-existing

**8. `as any` in EventBus.request correlation ID merge** - `src/core/events/event-bus.ts:305`
- Problem: `as any as Omit<T, keyof BaseEvent | 'type'>` -- double assertion to merge `__correlationId` into event payload.
- Impact: Isolated to request-response pattern internal plumbing. Well-contained.
- Fix: Could use a spread type helper, but risk/reward is low.
- Category: Pre-existing

### LOW

**9. Container service type uses `any`** - `src/core/container.ts:11`
- Problem: `type Service = { factory: Factory<any>; singleton: boolean; instance?: any }` uses `any` for container-stored values.
- Impact: DI containers are fundamentally untyped at storage level. This is an industry-standard pattern.
- Fix: None practical -- existential types would be needed.
- Category: Pre-existing

**10. `z.any()` in MCP adapter** - `src/adapters/mcp-adapter.ts:247`
- Problem: Zod schema uses `z.any()` for tool arguments.
- Impact: MCP protocol arguments are dynamically typed by design.
- Fix: None practical for this use case.
- Category: Pre-existing

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 1 |
| Should Fix | - | 0 | 3 | 0 |
| Pre-existing | - | - | 3 | 2 |

**TypeScript Score**: 8/10

The codebase demonstrates strong TypeScript discipline: discriminated unions for events, Result types throughout, proper generic constraints on EventBus, and type-safe dependency injection. The refactoring cleanly removes 9 event types and their associated infrastructure (QueryHandler, OutputHandler, AutoscalingManager) with zero leftover references. The `createEvent` function's `as T` cast is an acceptable trade-off for the builder pattern. The main improvement opportunity is the type assertion in `validateSingleDependency` (issue #1), which could leverage a proper discriminated union return type instead of an `as` cast.

**Recommendation**: APPROVED_WITH_CONDITIONS

Conditions:
1. Consider addressing issue #1 (discriminated union for validation result) to eliminate the only `as` cast introduced by this PR. This is MEDIUM severity and could be deferred to a follow-up if preferred.
2. Issues #3-5 are "Should Fix" items in code adjacent to your changes -- address them while the context is fresh, or create a follow-up issue.
