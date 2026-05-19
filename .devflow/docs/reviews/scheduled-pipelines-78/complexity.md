# Complexity Review Report

**Branch**: feat/scheduled-pipelines-78 -> main
**Date**: 2026-03-11
**PR**: #80

## Issues in Your Changes (BLOCKING)

### HIGH

**Duplicated afterScheduleId resolution logic** - `src/services/handlers/schedule-handler.ts:327-345`
- Problem: `handlePipelineTrigger` contains an inline copy of the same "resolve afterScheduleId dependency" logic that `resolveAfterScheduleDependency` already encapsulates (lines 455-485). The pipeline version resolves to `TaskId[]` while the single-task version resolves to a modified `taskTemplate`, but the core lookup-check-decide flow (fetch history, get latest execution, check terminal state) is duplicated across 4 nesting levels.
- Impact: Two places to maintain the same logic. If the resolution behavior changes (e.g., checking multiple recent executions), both paths must be updated independently. The inline version also adds nesting depth 4, making the function harder to scan.
- Fix: Refactor `resolveAfterScheduleDependency` to return the resolved `TaskId | undefined` instead of a modified template, then have both `handleSingleTaskTrigger` and `handlePipelineTrigger` consume that single primitive. Example:
```typescript
private async resolveAfterScheduleTaskId(
  afterScheduleId: ScheduleId
): Promise<TaskId | undefined> {
  const historyResult = await this.scheduleRepo.getExecutionHistory(afterScheduleId, 1);
  if (!historyResult.ok || historyResult.value.length === 0) return undefined;

  const latestExecution = historyResult.value[0];
  if (!latestExecution.taskId) return undefined;

  const depTaskResult = await this.taskRepo.findById(latestExecution.taskId);
  if (!depTaskResult.ok || !depTaskResult.value || isTerminalState(depTaskResult.value.status)) {
    return undefined;
  }
  return latestExecution.taskId;
}
```
Then in `handleSingleTaskTrigger`:
```typescript
const afterTaskId = schedule.afterScheduleId
  ? await this.resolveAfterScheduleTaskId(schedule.afterScheduleId)
  : undefined;
const taskTemplate = afterTaskId
  ? { ...schedule.taskTemplate, dependsOn: [...(schedule.taskTemplate.dependsOn ?? []), afterTaskId] }
  : schedule.taskTemplate;
```
And in `handlePipelineTrigger`:
```typescript
const step0DependsOn = schedule.afterScheduleId
  ? await this.resolveAfterScheduleTaskId(schedule.afterScheduleId).then(id => id ? [id] : undefined)
  : undefined;
```

---

**Duplicated validation logic in createSchedule vs validateScheduleTiming** - `src/services/schedule-manager.ts:64-198` vs `src/services/schedule-manager.ts:491-573`
- Problem: `createSchedule` (lines 64-198, ~135 lines) contains the exact same validation chain that was extracted into `validateScheduleTiming` (lines 491-573) for `createScheduledPipeline`. The extracted method exists but `createSchedule` was never refactored to use it. This means the same cron validation, timezone validation, scheduledAt parsing, expiresAt parsing, and nextRunAt computation are duplicated verbatim.
- Impact: Two copies of ~80 lines of validation logic. Changes to validation rules (e.g., allowing past `scheduledAt` for catch-up modes) would need to be applied in two places. This is the definition of a maintainability issue.
- Fix: Refactor `createSchedule` to call `validateScheduleTiming`:
```typescript
async createSchedule(request: ScheduleCreateRequest): Promise<Result<Schedule>> {
  const timingResult = this.validateScheduleTiming(request);
  if (!timingResult.ok) return timingResult;
  const { scheduledAtMs, expiresAtMs, nextRunAt, timezone } = timingResult.value;

  // Validate workingDirectory
  let validatedWorkingDirectory: string | undefined;
  if (request.workingDirectory) {
    const pathValidation = validatePath(request.workingDirectory);
    if (!pathValidation.ok) {
      return err(new AutobeatError(ErrorCode.INVALID_DIRECTORY, ...));
    }
    validatedWorkingDirectory = pathValidation.value;
  }

  // Resolve agent, create schedule, emit event ... (remaining ~30 lines)
}
```
This would reduce `createSchedule` from ~135 lines to ~50 lines and eliminate the duplication.

---

**Duplicated missedRunPolicy ternary chain in CLI** - `src/cli/commands/schedule.ts:172-175` and `src/cli/commands/schedule.ts:222-228`
- Problem: The nested ternary for mapping `missedRunPolicy` string to enum is duplicated between the pipeline branch and the single-task branch of `scheduleCreate`. The same 4-level ternary appears twice within the same function.
- Impact: Same mapping logic in two places within 60 lines of each other. The ternary itself is hard to parse (4 levels deep).
- Fix: Extract to a local helper at the top of `scheduleCreate`, or reuse the existing `toMissedRunPolicy` from `schedule-manager.ts` which does the same thing:
```typescript
import { toMissedRunPolicy } from '../../services/schedule-manager.js';
// Then use directly in both branches:
missedRunPolicy: missedRunPolicy ? toMissedRunPolicy(missedRunPolicy) : undefined,
```

### MEDIUM

**handlePipelineTrigger function length (130 lines)** - `src/services/handlers/schedule-handler.ts:317-446`
- Problem: `handlePipelineTrigger` is ~130 lines with 3-4 nesting levels in the task creation loop. It handles afterScheduleId resolution, task creation with dependency wiring, partial failure cleanup, execution recording, schedule state update, event emission, and logging. This exceeds the 50-line warning threshold.
- Impact: Harder to understand, test individual paths, and modify safely. The cleanup-on-failure path (lines 372-396) is nested inside a for-loop inside the function.
- Fix: The function already calls helper methods (`recordFailedExecution`, `recordTriggeredExecution`, `updateScheduleAfterTrigger`), which is good. Further decomposition could extract the task creation loop into a `createPipelineTasks(steps, defaults, step0DependsOn)` method and the event emission loop into `emitTaskDelegatedEvents(tasks, scheduleId)`.

---

**scheduleCreate function length (~160 lines)** - `src/cli/commands/schedule.ts:46-250`
- Problem: `scheduleCreate` is approximately 160 lines covering argument parsing (50 lines), type inference (15 lines), pipeline creation path (45 lines), and single-task creation path (40 lines). The argument parsing loop alone has 15 branches.
- Impact: Exceeds the critical threshold of 50 lines. The function does too many things: parse args, validate, branch into pipeline/single modes, format output.
- Fix: Extract argument parsing into a separate `parseScheduleArgs(args: string[])` function that returns a typed options object, and extract the result display into `displayScheduleResult(result)`. This would bring the main function down to ~30 lines of orchestration.

---

**mcp-adapter.ts file length (1,776 lines)** - `src/adapters/mcp-adapter.ts`
- Problem: The file is now 1,776 lines, well beyond the 500-line critical threshold. The new `SchedulePipelineSchema` adds 32 lines of schema and the `handleSchedulePipeline` method adds 65 lines. The inline JSON Schema for SchedulePipeline in `listTools` adds another 90 lines.
- Impact: Finding and understanding any single handler requires scrolling through nearly 1,800 lines. This is a pre-existing issue that this PR makes slightly worse.
- Fix: This is a pre-existing structural issue. The immediate additions are reasonable in isolation. A future PR could extract schema definitions and tool registration into separate modules.

---

**SchedulePipelineSchema duplicates inline JSON Schema** - `src/adapters/mcp-adapter.ts:157-189` vs `src/adapters/mcp-adapter.ts:679-775`
- Problem: The `SchedulePipelineSchema` Zod definition (lines 157-189) and the inline JSON Schema in `listTools` (lines 679-775) define the same structure twice in different formats. This is a pattern that already exists for other tools, but the pipeline schema is the most complex instance yet (90 lines of inline JSON Schema).
- Impact: Any field change (e.g., adding a new step property) requires updating both the Zod schema and the JSON Schema in lockstep.
- Fix: This is a pre-existing pattern in the codebase. The canonical fix would be to derive JSON Schemas from Zod schemas using `zodToJsonSchema`, but that is a larger architectural change beyond this PR's scope.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Nesting depth 4 in dependency cascade check** - `src/services/handlers/dependency-handler.ts:581-597`
- Problem: The newly added cascade cancellation logic is nested inside: (1) `handleEvent` callback, (2) `for` loop, (3) `if (!isBlockedResult.value)`, (4) `if (depsResult.ok)`, (5) `if (failedDep)`. This reaches 5 levels of nesting.
- Impact: The logic is correct and well-commented, but the nesting depth makes the control flow harder to trace.
- Fix: Use an early continue for the `!depsResult.ok` case:
```typescript
if (!isBlockedResult.value) {
  const depsResult = await this.dependencyRepo.getDependencies(dep.taskId);
  if (!depsResult.ok) {
    // Fall through to unblock path - defensive, don't block on lookup failure
  } else {
    const failedDep = depsResult.value.find(d => d.resolution === 'failed' || d.resolution === 'cancelled');
    if (failedDep) {
      // cascade cancellation...
      continue;
    }
  }
  // Unblock path...
}
```
Or extract to a helper: `private shouldCascadeCancel(taskId: TaskId): Promise<TaskId | null>`.

## Pre-existing Issues (Not Blocking)

### HIGH

**createSchedule not using validateScheduleTiming** - `src/services/schedule-manager.ts:64-198`
- Problem: The `createSchedule` method predates this PR and contains ~80 lines of validation that are now duplicated by the new `validateScheduleTiming` helper. While `validateScheduleTiming` was added in this PR specifically for `createScheduledPipeline`, the original `createSchedule` was not refactored to use it.
- Impact: This creates an immediate debt item. The duplication exists because of this PR's additions, but the original code was not modified. Categorized as blocking since the new helper was introduced alongside it -- see the blocking issue above.

### MEDIUM

**mcp-adapter.ts exceeds 500-line threshold** - `src/adapters/mcp-adapter.ts` (1,776 lines)
- Problem: The file has been growing with each feature release and is now over 3x the recommended file length limit. It contains all Zod schemas, all handler methods, and all JSON Schema definitions for tool registration.
- Impact: Cognitive load for anyone working in this file. New features continue to increase the surface area.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 3 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 1 | 1 | 0 |

**Complexity Score**: 6/10

The PR demonstrates good decomposition instincts -- `handleScheduleTriggered` was split into `handleSingleTaskTrigger`, `handlePipelineTrigger`, and shared helpers (`resolveAfterScheduleDependency`, `recordFailedExecution`, `recordTriggeredExecution`, `updateScheduleAfterTrigger`). This is exactly the right pattern. However, the decomposition was not carried to completion: the `afterScheduleId` resolution logic was duplicated rather than truly shared, and the new `validateScheduleTiming` helper was added for pipelines but not wired into the existing `createSchedule` path, leaving a significant duplication.

**Recommendation**: CHANGES_REQUESTED

The three HIGH-severity blocking issues are all about duplicated logic that was introduced in this PR. The fixes are straightforward refactoring that would reduce code by ~100 lines while improving maintainability. The decomposition direction is correct; it just needs to be completed.
