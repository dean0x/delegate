# Security Review Report

**Branch**: feat/scheduled-pipelines-78 -> main
**Date**: 2026-03-18
**PR**: #80
**Reviewer Focus**: Security vulnerability detection (injection, auth, secrets, business logic)

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Missing Zod validation on `pipeline_task_ids` JSON parse** - `/Users/dean/Sandbox/claudine/src/implementations/schedule-repository.ts:540`
- Problem: When deserializing `pipeline_task_ids` from the database, the code uses `JSON.parse(data.pipeline_task_ids) as string[]` with a bare type assertion instead of Zod schema validation. By contrast, `pipeline_steps` (line 501) and `task_template` (line 491) both use proper Zod `.parse()` validation. This inconsistency means a malformed or corrupted `pipeline_task_ids` value (e.g., an array containing non-strings, or an object) would pass through silently and be wrapped with `TaskId()` without type checking.
- Impact: If the database is corrupted or tampered with, invalid data flows into the domain layer unchecked. While the `catch` block on line 542 prevents crashes, the `as string[]` assertion bypasses type safety on the happy path.
- Category: Blocking (new code in this PR)
- Fix:
```typescript
// Add a Zod schema at module level:
const PipelineTaskIdsSchema = z.array(z.string().min(1));

// In rowToExecution():
if (data.pipeline_task_ids) {
  try {
    const parsed = JSON.parse(data.pipeline_task_ids);
    const validated = PipelineTaskIdsSchema.parse(parsed);
    pipelineTaskIds = validated.map((id) => TaskId(id));
  } catch {
    // Non-fatal: log but don't fail
    pipelineTaskIds = undefined;
  }
}
```

---

**Pipeline step `workingDirectory` not re-validated at trigger time** - `/Users/dean/Sandbox/claudine/src/services/handlers/schedule-handler.ts:363-366`
- Problem: When a scheduled pipeline triggers, `handlePipelineTrigger` passes `step.workingDirectory` directly to `createTask` without calling `validatePath()`. Validation only occurs at schedule creation time in `schedule-manager.ts:364-377`. If the filesystem state changes between schedule creation and trigger time (e.g., a symlink is created that now points outside the allowed base), the previously-validated path may no longer be safe.
- Impact: Time-of-check-to-time-of-use (TOCTOU) gap. For a recurring cron schedule, there could be days or weeks between creation and trigger. An attacker with local filesystem access could create a symlink race condition. This is LOW risk in practice because (a) the attacker needs local FS access, and (b) `workingDirectory` sets the CWD for a Claude Code instance, not direct file I/O.
- Category: Blocking (new code in this PR, but severity is medium not critical)
- Fix: Consider re-validating at trigger time, or document this as an accepted trade-off:
```typescript
// In handlePipelineTrigger, before createTask:
if (step.workingDirectory) {
  const pathResult = validatePath(step.workingDirectory);
  if (!pathResult.ok) {
    this.logger.warn('Pipeline step workingDirectory invalid at trigger time', {
      scheduleId, step: i, workingDirectory: step.workingDirectory,
    });
    // Skip step or cancel pipeline
  }
}
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Cancellation race in `cancelSchedule` with `cancelTasks`** - `/Users/dean/Sandbox/claudine/src/services/schedule-manager.ts:246-282`
- Problem: The `ScheduleCancelled` event is emitted (line 246) before the task cancellation loop (line 264). The schedule handler processes `ScheduleCancelled` and sets status to CANCELLED. Meanwhile, if the schedule executor triggers between the status update and the task cancellation loop, it would find the schedule CANCELLED and skip. However, the task cancellation loop fetches history from the repository with `getExecutionHistory(scheduleId, 1)` -- if a new execution was recorded between schedule cancellation and the history fetch, the wrong execution's tasks could be targeted.
- Impact: In practice this is a narrow timing window and unlikely in single-threaded Node.js event loop execution. The risk is LOW for production but worth documenting.
- Category: Should Fix (same function, logic gap in new code)
- Fix: Consider fetching the execution history before emitting the cancel event to capture the correct execution snapshot:
```typescript
// Fetch execution snapshot BEFORE cancelling schedule
let taskIdsToCancel: TaskId[] = [];
if (cancelTasks) {
  const historyResult = await this.scheduleRepository.getExecutionHistory(scheduleId, 1);
  if (historyResult.ok && historyResult.value.length > 0) {
    const latestExecution = historyResult.value[0];
    taskIdsToCancel = [...(latestExecution.pipelineTaskIds ?? (latestExecution.taskId ? [latestExecution.taskId] : []))];
  }
}

// Then emit cancel event
const emitResult = await this.eventBus.emit('ScheduleCancelled', { scheduleId, reason });
// ...

// Then cancel tasks from the snapshot
for (const taskId of taskIdsToCancel) { ... }
```

### LOW

**Error message leaks internal details in failed execution records** - `/Users/dean/Sandbox/claudine/src/services/handlers/schedule-handler.ts:500-501`
- Problem: The `recordFailedExecution` helper prepends `"Failed to create task: "` and passes the raw error message to the database. If the underlying error contains sensitive information (e.g., file paths, internal state), this is persisted in the `schedule_executions` table and later exposed via `GetSchedule` with history.
- Impact: LOW. This is an MCP server (not web-facing), and the execution history is only accessible via MCP tools or CLI. However, the pattern of storing raw error messages could leak internal details to consumers.
- Category: Should Fix (modified function)
- Fix: Truncate or sanitize the error message before persisting:
```typescript
errorMessage: `Failed to create task: ${errorMessage.substring(0, 200)}`,
```

## Pre-existing Issues (Not Blocking)

### LOW

**`validatePath` uses process.cwd() as default base directory** - `/Users/dean/Sandbox/claudine/src/utils/validation.ts:27`
- Problem: When no `baseDir` is provided, `validatePath` defaults to `process.cwd()`. If the process CWD changes at runtime, the validation boundary changes. This is a pre-existing pattern used by both old and new code.
- Impact: Minimal for this MCP server context. Not introduced by this PR.

### LOW

**No rate limiting on `SchedulePipeline` creation** - `/Users/dean/Sandbox/claudine/src/adapters/mcp-adapter.ts:434`
- Problem: A caller can create unlimited scheduled pipelines (each with up to 20 steps). While individual step counts are bounded (2-20), there is no limit on total schedules. This is pre-existing (same pattern as `ScheduleTask`).
- Impact: Resource exhaustion via schedule flooding. Not introduced by this PR -- same pattern as existing `ScheduleTask` and `CreatePipeline`.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 1 |
| Pre-existing | 0 | 0 | 0 | 2 |

**Security Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

## Conditions for Approval

1. **Add Zod validation for `pipeline_task_ids`** deserialization in `schedule-repository.ts:540` to match the validation pattern already used for `pipeline_steps` and `task_template`. This is a small, straightforward fix.
2. **Consider re-validating workingDirectory at trigger time** for pipeline steps, or document as an accepted TOCTOU trade-off. Given the MCP server context and local-only attack surface, this can be deferred to a follow-up issue if preferred.

## Positive Security Observations

- **Input validation is thorough**: Zod schemas at the MCP boundary (`SchedulePipelineSchema`) enforce step count limits (2-20), prompt length (1-4000), priority enum, agent enum, and schedule type enum.
- **Path validation**: `validatePath()` with symlink resolution is applied to both shared and per-step `workingDirectory` at creation time.
- **SQL injection prevention**: All database operations use parameterized prepared statements -- no string interpolation in SQL.
- **Boundary validation pattern**: `PipelineStepsSchema` validates data read back from the database (parse, don't validate).
- **Proper error handling**: All operations use Result types, no thrown errors in business logic.
- **Immutable data patterns**: Schedule and task objects are readonly, updates create new objects.
- **Audit trail**: All pipeline executions are recorded with full task ID lists for traceability.
- **Cascade cancellation is a security improvement**: The dependency failure cascade fix (DependencyHandler) prevents blocked tasks from running when an upstream task fails -- this closes a correctness gap that could have allowed unintended task execution.
