# Consistency Review Report

**Branch**: feat/scheduled-pipelines-78 -> main
**Date**: 2026-03-11
**PR**: #80
**Files Changed**: 21 (2,208 additions, 183 deletions)

---

## Issues in Your Changes (BLOCKING)

### HIGH

**Duplicated `afterScheduleId` resolution logic in `handlePipelineTrigger`** - `/Users/dean/Sandbox/claudine/src/services/handlers/schedule-handler.ts:327-345`
- Problem: The `handlePipelineTrigger` method contains 18 lines of inline `afterScheduleId` resolution logic that duplicates the extracted `resolveAfterScheduleDependency` helper (lines 456-483). The single-task path correctly calls the shared helper, but the pipeline path inlines its own version with slightly different behavior (no "already resolved" log message, returns `TaskId[]` instead of a modified `TaskTemplate`).
- Impact: Two divergent implementations of the same business logic. If `afterScheduleId` resolution logic changes, only one path might be updated.
- Fix: Refactor `resolveAfterScheduleDependency` to return the dependency `TaskId` (or `undefined`) instead of a modified task template, then use it from both `handleSingleTaskTrigger` and `handlePipelineTrigger`:
```typescript
private async resolveAfterScheduleTaskId(schedule: Schedule): Promise<TaskId | undefined> {
  if (!schedule.afterScheduleId) return undefined;
  const historyResult = await this.scheduleRepo.getExecutionHistory(schedule.afterScheduleId, 1);
  if (!historyResult.ok || historyResult.value.length === 0) return undefined;
  const latestExecution = historyResult.value[0];
  if (!latestExecution.taskId) return undefined;
  const depTaskResult = await this.taskRepo.findById(latestExecution.taskId);
  if (!depTaskResult.ok || !depTaskResult.value || isTerminalState(depTaskResult.value.status)) {
    this.logger.info('afterSchedule dependency already resolved, skipping', { ... });
    return undefined;
  }
  this.logger.info('Injected afterSchedule dependency', { ... });
  return latestExecution.taskId;
}
```

**`createSchedule` still uses inline validation while `createScheduledPipeline` uses extracted `validateScheduleTiming`** - `/Users/dean/Sandbox/claudine/src/services/schedule-manager.ts:64-155` vs `345`
- Problem: The `validateScheduleTiming` helper was extracted to share timing validation between `createSchedule` and `createScheduledPipeline`, but `createSchedule` was never refactored to use it. The exact same validation logic (schedule type, cron, timezone, scheduledAt, expiresAt, nextRunAt) exists inline in `createSchedule` (lines 64-155) and again in `validateScheduleTiming` (lines 491-577).
- Impact: Two copies of identical validation logic. If validation rules change (e.g., new constraints on expiresAt), only one path might be updated. The JSDoc comment on `validateScheduleTiming` even says "shared between createSchedule and createScheduledPipeline" but `createSchedule` does not call it.
- Fix: Refactor `createSchedule` to call `validateScheduleTiming`:
```typescript
async createSchedule(request: ScheduleCreateRequest): Promise<Result<Schedule>> {
  const timingResult = this.validateScheduleTiming(request);
  if (!timingResult.ok) return timingResult;
  const { scheduledAtMs, expiresAtMs, nextRunAt, timezone } = timingResult.value;
  // ... continue with path validation, agent resolution, schedule creation
}
```

### MEDIUM

**`nextRunAt` fallback uses `undefined` in `SchedulePipeline` response but `null` everywhere else** - `/Users/dean/Sandbox/claudine/src/adapters/mcp-adapter.ts:1616`
- Problem: The `handleSchedulePipeline` response maps `nextRunAt` with `undefined` as the fallback:
  ```typescript
  nextRunAt: schedule.nextRunAt ? new Date(schedule.nextRunAt).toISOString() : undefined,
  ```
  All other schedule responses use `null`:
  - `handleScheduleTask` (line 1203): `... : null`
  - `handleListSchedules` (line 1244): `... : null`
  - `handleGetSchedule` (line 1307): `... : null`
- Impact: JSON serialization difference. `JSON.stringify` omits `undefined` keys entirely but includes `null` keys. Consumers relying on `nextRunAt: null` to detect unscheduled items will get inconsistent behavior from `SchedulePipeline`.
- Fix: Change to `null` for consistency:
```typescript
nextRunAt: schedule.nextRunAt ? new Date(schedule.nextRunAt).toISOString() : null,
```

**`SchedulePipeline` response field order differs from `ScheduleTask`** - `/Users/dean/Sandbox/claudine/src/adapters/mcp-adapter.ts:1608-1620`
- Problem: The `ScheduleTask` response fields are ordered `{success, scheduleId, scheduleType, nextRunAt, timezone, status}` while the `SchedulePipeline` response is `{success, scheduleId, stepCount, scheduleType, nextRunAt, status, timezone}`. The `timezone` and `status` fields swap positions and `stepCount` is inserted between `scheduleId` and `scheduleType`.
- Impact: Minor readability concern. While JSON field order is not semantically significant, consistent field ordering across similar response types aids developer comprehension.
- Fix: Reorder `SchedulePipeline` response to match `ScheduleTask` pattern with additive fields at the end:
```typescript
{
  success: true,
  scheduleId: schedule.id,
  scheduleType: schedule.scheduleType,
  nextRunAt: schedule.nextRunAt ? new Date(schedule.nextRunAt).toISOString() : null,
  timezone: schedule.timezone,
  status: schedule.status,
  stepCount: schedule.pipelineSteps?.length ?? 0,
}
```

**`SchedulePipelineSchema` step description wording inconsistency with `CreatePipelineSchema`** - `/Users/dean/Sandbox/claudine/src/adapters/mcp-adapter.ts:172`
- Problem: `SchedulePipelineSchema` describes its steps array as `'Ordered pipeline steps (executed sequentially on each trigger)'` while `CreatePipelineSchema` (line 145) uses `'Ordered pipeline steps (executed sequentially)'`. The parenthetical modifier is inconsistent between two schemas that describe the same concept.
- Impact: Minor. The added "on each trigger" is actually more informative for the scheduled variant, so this is acceptable divergence. Flagging for awareness.
- Fix: No fix required. The wording is contextually appropriate. If strict consistency is desired, both could use the "on each trigger" variant since `CreatePipeline` also triggers sequentially.

**`CreatePipelineSchema` uses multi-line `.describe()` for `priority` but `SchedulePipelineSchema` uses single-line** - `/Users/dean/Sandbox/claudine/src/adapters/mcp-adapter.ts:148-149` vs `178`
- Problem: In `CreatePipelineSchema`, `priority` has a multi-line layout:
  ```typescript
  priority: z
    .enum(['P0', 'P1', 'P2'])
    .optional()
    .describe('Default priority for all steps (individual steps can override)'),
  ```
  In `SchedulePipelineSchema`:
  ```typescript
  priority: z.enum(['P0', 'P1', 'P2']).optional().describe('Default priority for all steps'),
  ```
  The description is also shorter (missing "(individual steps can override)").
- Impact: Minor formatting and documentation inconsistency. The missing qualifier could confuse MCP consumers about override behavior.
- Fix: Align descriptions: `'Default priority for all steps (individual steps can override)'`

---

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`missedRunPolicy` Zod schemas lack `.describe()` in both `ScheduleTaskSchema` and `SchedulePipelineSchema`** - `/Users/dean/Sandbox/claudine/src/adapters/mcp-adapter.ts:88,177`
- Problem: Both schemas define `missedRunPolicy` without a `.describe()` call:
  ```typescript
  missedRunPolicy: z.enum(['skip', 'catchup', 'fail']).optional().default('skip'),
  ```
  Other fields in the same schemas consistently include `.describe()`. The JSON Schema output for this tool (lines 501, 739) does include a description, but this is the raw `enum` values without explanation. Pre-existing in `ScheduleTaskSchema`, now replicated in `SchedulePipelineSchema`.
- Impact: Minor. MCP consumers won't get a helpful description for this field in the Zod-based schema. The JSON Schema listing does include some context.
- Fix: Add `.describe('Policy for handling missed runs: skip (default), catchup (run immediately), fail (mark as failed)')` to both.

**`toMissedRunPolicy` exists in two places with slightly different signatures** - `/Users/dean/Sandbox/claudine/src/services/schedule-manager.ts:43` and `/Users/dean/Sandbox/claudine/src/implementations/schedule-repository.ts:564`
- Problem: `ScheduleManagerService.toMissedRunPolicy(value: string | undefined): MissedRunPolicy` (exported, public) and `SQLiteScheduleRepository.toMissedRunPolicy(value: string): MissedRunPolicy` (private method) both map string values to `MissedRunPolicy` enum. The repository version is a private method with a slightly different signature (`string` vs `string | undefined`). This was pre-existing but now `toMissedRunPolicy` is called from more places in the adapter (line 1594 for `SchedulePipeline`).
- Impact: Low risk of divergence, but violates DRY. If a new policy is added, both must be updated.
- Fix: Have the repository import and use the public `toMissedRunPolicy` from `schedule-manager.ts`, or extract to a shared utility.

---

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`afterSchedule` (MCP) vs `afterScheduleId` (domain) naming inconsistency** - `/Users/dean/Sandbox/claudine/src/adapters/mcp-adapter.ts:93,182` vs `/Users/dean/Sandbox/claudine/src/core/domain.ts:263`
- Problem: The MCP adapter Zod schemas use `afterSchedule` as the field name (without "Id" suffix), while the domain types (`Schedule`, `ScheduleRequest`, `ScheduledPipelineCreateRequest`) use `afterScheduleId`. The adapter maps between them at lines 1187 and 1599. This is a pre-existing convention in the ScheduleTask tool, now replicated to SchedulePipeline.
- Impact: Low. The mapping layer handles translation. However, MCP consumers see `afterSchedule` while domain code sees `afterScheduleId`, which could cause confusion.
- Fix: Consider aligning to `afterScheduleId` in a future PR, or document the convention.

### LOW

**Version comment mismatch: v0.6.0 in some places, no version in others** - Various files
- Problem: The `ScheduleExecution.pipelineTaskIds` comment says "v0.6.0" (`/Users/dean/Sandbox/claudine/src/core/interfaces.ts:252`), the MCP tool comment says "v0.6.0" (`/Users/dean/Sandbox/claudine/src/adapters/mcp-adapter.ts:682`), and the migration says "v0.6.0" (`/Users/dean/Sandbox/claudine/src/implementations/database.ts:525`), but `ScheduledPipelineCreateRequest` in domain.ts has no version annotation, nor does the `ScheduleService` interface update.
- Impact: Minor documentation inconsistency. Version annotations are informational.
- Fix: Either annotate all new types consistently with `(v0.6.0)` or remove version annotations (the git history tracks when features were added).

---

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 3 | 0 |
| Should Fix | - | 0 | 2 | 0 |
| Pre-existing | - | - | 1 | 1 |

**Consistency Score**: 6/10
**Recommendation**: CHANGES_REQUESTED

### Rationale

The two HIGH issues represent meaningful pattern violations that should be addressed:

1. **Duplicated `afterScheduleId` logic** - The `handlePipelineTrigger` method inlines resolution logic that has already been extracted into a shared helper (`resolveAfterScheduleDependency`). This is the exact pattern violation the consistency review is designed to catch: a helper was created for reuse but one caller bypasses it.

2. **`createSchedule` was not refactored to use `validateScheduleTiming`** - The helper's own JSDoc claims it is "shared between createSchedule and createScheduledPipeline" but `createSchedule` still uses inline code. This is a ticking maintenance bomb: the two copies will inevitably diverge.

The MEDIUM issues (null vs undefined, response field ordering, description alignment) are lower risk but trivially fixable.
