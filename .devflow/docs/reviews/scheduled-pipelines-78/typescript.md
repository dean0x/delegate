# TypeScript Review Report

**Branch**: feat/scheduled-pipelines-78 -> main
**Date**: 2026-03-11
**PR**: #80

## Issues in Your Changes (BLOCKING)

### HIGH

**Non-null assertion on `pipelineSteps`** - `/Users/dean/Sandbox/claudine/src/services/handlers/schedule-handler.ts:319`
- Problem: `const steps = schedule.pipelineSteps!;` uses a non-null assertion operator. While the calling code checks `schedule.pipelineSteps && schedule.pipelineSteps.length > 0` before dispatching to `handlePipelineTrigger`, the non-null assertion bypasses TypeScript's type narrowing. If a future refactor calls this method from a different path, there is no compile-time safety net.
- Impact: Violates the TypeScript anti-pattern rule "Non-null abuse: `user!.name!` -> `user?.name` with check". If called without the guard, this would throw at runtime.
- Fix: Accept the already-checked value as a parameter, or add a local type guard:
  ```typescript
  // Option A: Accept steps directly (preferred — caller already has them)
  private async handlePipelineTrigger(
    schedule: Schedule,
    triggeredAt: number,
    steps: readonly PipelineStepRequest[],
  ): Promise<Result<void>> {
    // ...use steps directly, no assertion needed
  }

  // Option B: Local guard with early return
  private async handlePipelineTrigger(schedule: Schedule, triggeredAt: number): Promise<Result<void>> {
    if (!schedule.pipelineSteps || schedule.pipelineSteps.length === 0) {
      return err(new AutobeatError(ErrorCode.INVALID_INPUT, 'Pipeline trigger requires steps'));
    }
    const steps = schedule.pipelineSteps; // TypeScript narrows correctly after the check
    // ...
  }
  ```
- Category: Blocking

---

**Unsafe type assertions from Zod-parsed strings** - `/Users/dean/Sandbox/claudine/src/adapters/mcp-adapter.ts:1597-1611` (handleSchedulePipeline method)
- Problem: Multiple `as Priority | undefined` and `as AgentProvider | undefined` casts on Zod-parsed `data.steps[].priority`, `data.steps[].agent`, `data.priority`, and `data.agent`. While Zod validates the enum values at runtime, the TypeScript compiler loses this connection because the Zod schema uses `z.enum(['P0', 'P1', 'P2'])` (string literals) rather than referencing the `Priority` enum type.
- Impact: If the `Priority` or `AgentProvider` enums ever add/remove values without updating the Zod schema, the cast silently passes invalid values through. This pattern already exists in the pre-existing `handleCreatePipeline` method, but the new code adds 4 more instances.
- Fix: Use `.transform()` on the Zod schema to convert strings to domain types, or use a shared Zod schema that derives from the Priority enum. Since this is a project-wide pattern (pre-existing in `handleCreatePipeline`), this is a MEDIUM-priority improvement that could be addressed in a follow-up.
  ```typescript
  // Example: derive Zod enum from domain type
  const PrioritySchema = z.enum(['P0', 'P1', 'P2']).transform((v) => Priority[v]);
  ```
- Category: Blocking (but acknowledging this is a pre-existing pattern repeated here)

### MEDIUM

**`as string[]` assertion on parsed JSON** - `/Users/dean/Sandbox/claudine/src/implementations/schedule-repository.ts:533` (in `rowToExecution`)
- Problem: `const parsed = JSON.parse(data.pipeline_task_ids) as string[];` uses a type assertion on untrusted data from the database. The `pipeline_steps` field parsing (line 504-508) correctly uses a Zod schema (`PipelineStepsSchema.parse(parsed)`), but `pipeline_task_ids` does not validate.
- Impact: If the database contains corrupted data (e.g., non-string array elements), the code will produce `TaskId` branded types wrapping non-strings. The `catch` block (line 535) handles parse errors but not schema validation errors.
- Fix: Add a Zod schema for `pipeline_task_ids` consistent with how `pipeline_steps` is validated:
  ```typescript
  const PipelineTaskIdsSchema = z.array(z.string().min(1));

  // In rowToExecution:
  if (data.pipeline_task_ids) {
    try {
      const parsed = JSON.parse(data.pipeline_task_ids);
      const validated = PipelineTaskIdsSchema.parse(parsed);
      pipelineTaskIds = validated.map((id) => TaskId(id));
    } catch {
      pipelineTaskIds = undefined;
    }
  }
  ```
- Category: Blocking

---

**`as readonly PipelineStepRequest[]` cast after Zod parse** - `/Users/dean/Sandbox/claudine/src/implementations/schedule-repository.ts:506`
- Problem: `pipelineSteps = PipelineStepsSchema.parse(parsed) as readonly PipelineStepRequest[];` casts the Zod output to `readonly PipelineStepRequest[]`. The Zod schema (`PipelineStepsSchema`) defines the shape correctly, but the cast is needed because the Zod inferred type doesn't include the `readonly` modifier. This is an unavoidable TypeScript/Zod friction point.
- Impact: Low real-world risk since Zod validates the shape, but the cast could mask a schema drift if `PipelineStepRequest` gains new required fields that the Zod schema doesn't include.
- Fix: Consider using `z.infer<typeof PipelineStepsSchema>` as the intermediate type and mapping to `PipelineStepRequest` explicitly, or keep the cast but add a comment explaining why it is safe. This is acceptable as-is.
- Category: Blocking (LOW severity, informational)

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`typeof schedule.taskTemplate` return type is inferred, not explicit** - `/Users/dean/Sandbox/claudine/src/services/handlers/schedule-handler.ts:455`
- Problem: `private async resolveAfterScheduleDependency(schedule: Schedule): Promise<typeof schedule.taskTemplate>` uses `typeof schedule.taskTemplate` as the return type. This is a valid TypeScript pattern, but `typeof` on an instance member resolves to the structural type of `Schedule['taskTemplate']`. If the `taskTemplate` field type changes, this method silently follows. An explicit `TaskRequest` return type would be clearer.
- Impact: Readability and intent clarity. The `typeof` pattern is not immediately obvious to all developers.
- Fix:
  ```typescript
  import type { TaskRequest } from '../../core/domain.js';

  private async resolveAfterScheduleDependency(schedule: Schedule): Promise<TaskRequest> {
    // ...
  }
  ```
- Category: Should Fix

---

**`as unknown as ScheduleService` double cast in test** - `/Users/dean/Sandbox/claudine/tests/unit/adapters/mcp-adapter.test.ts:1614`
- Problem: `mockScheduleService as unknown as ScheduleService` is a double-cast that bypasses type checking entirely. The `MockScheduleService` class in the test file implements most of the `ScheduleService` interface but uses a double-cast to avoid implementing it fully.
- Impact: If `ScheduleService` gains new methods, the test mock silently passes without implementing them, leading to potential runtime errors in tests.
- Fix: Have `MockScheduleService` implement `ScheduleService` properly (it already has all the methods), or use `satisfies` to get partial checking:
  ```typescript
  class MockScheduleService implements ScheduleService {
    // ... ensure all methods are present
  }
  ```
- Category: Should Fix (pre-existing pattern, but touched in this PR)

### LOW

**Mutable arrays in `handlePipelineTrigger`** - `/Users/dean/Sandbox/claudine/src/services/handlers/schedule-handler.ts:348-351`
- Problem: `const savedTasks: Task[] = [];` and `const dependsOn: TaskId[] = [];` use mutable arrays. The project follows an "immutable by default" principle (from CLAUDE.md). While mutability is pragmatic for the accumulation loop pattern here, it diverges from the general style.
- Impact: Style consistency. The imperative loop-and-push pattern is clear and efficient here.
- Fix: This is acceptable for the accumulation pattern. No change needed, but worth noting for style consistency.
- Category: Should Fix (LOW, informational)

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`ScheduleCreateRequest.scheduledAt` type inconsistency across layers** - `/Users/dean/Sandbox/claudine/src/core/domain.ts:360` vs `/Users/dean/Sandbox/claudine/src/core/domain.ts:277`
- Problem: `ScheduleCreateRequest.scheduledAt` is `string` (ISO 8601), but `ScheduleRequest.scheduledAt` is `number` (epoch ms). The service layer performs the `Date.parse()` conversion. This is a deliberate boundary design (strings at API boundary, numbers internally), but the naming overlap between `ScheduleCreateRequest` and `ScheduleRequest` can be confusing.
- Impact: Readability. New contributors may confuse the two types.
- Fix: Consider renaming to differentiate, e.g., `ScheduleCreateInput` vs `ScheduleRequest`, or adding JSDoc to clarify the distinction.
- Category: Pre-existing

### LOW

**`Record<string, unknown>` in test helper** - `/Users/dean/Sandbox/claudine/tests/unit/adapters/mcp-adapter.test.ts:2024`
- Problem: `const response: Record<string, unknown> = { ... }` uses a loosely typed record in the `simulateGetSchedule` helper. While acceptable in test code, this loses type safety on the response shape.
- Impact: Test code only; low real-world risk.
- Fix: Define a response type or use `as const` for better inference.
- Category: Pre-existing

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | - | 0 | 2 | 1 |
| Pre-existing | - | - | 1 | 1 |

**TypeScript Score**: 7/10

The code demonstrates strong TypeScript practices overall: proper use of discriminated unions (`Result<T>`), branded types (`ScheduleId`, `TaskId`), readonly interfaces, and Zod boundary validation. The new `ScheduledPipelineCreateRequest` interface follows established patterns well. The main concerns are: (1) a non-null assertion that could be eliminated with a type guard or parameter change, (2) unsafe `as string[]` cast on database JSON that should use Zod validation like its sibling field, and (3) the repeated `as Priority` pattern from Zod-parsed strings that is a project-wide concern.

**Recommendation**: CHANGES_REQUESTED

The non-null assertion on `pipelineSteps!` (HIGH) and the unvalidated `as string[]` cast on `pipeline_task_ids` (MEDIUM) should be addressed before merge. Both have straightforward fixes that improve type safety without changing behavior. The `as Priority` pattern is pre-existing and can be tracked as a separate improvement.
