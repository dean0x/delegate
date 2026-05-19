# Security Review Report

**Branch**: feat/dashboard-visibility-overhaul -> main
**Date**: 2026-04-29T15:16

## Issues in Your Changes (BLOCKING)

### HIGH

**CancelPipeline `cancelTasks` parameter accepted but silently ignored** - `src/adapters/mcp-adapter.ts:3785`
**Confidence**: 95%
- Problem: The `CancelPipelineSchema` (line 353) defines `cancelTasks: z.boolean().optional().default(true)` and the MCP tool description (line 1712) tells callers the flag "also cancels in-flight step tasks (default: true)". However, in `handleCancelPipeline` (line 3785), only `pipelineId` and `reason` are destructured from `parseResult.data` -- `cancelTasks` is never read or acted upon. The pipeline entity status is set to CANCELLED but associated step tasks continue running uncontrolled.
- Impact: Callers (including AI agents) believe in-flight tasks are cancelled when they invoke `CancelPipeline`, but the tasks keep running and consuming resources. This is a behavioral security concern: the system advertises a safety control (cascade cancel) that does not function. An agent relying on this to stop runaway work would be silently ignored.
- Fix: Destructure and implement `cancelTasks` in `handleCancelPipeline`:
```typescript
const { pipelineId, reason, cancelTasks } = parseResult.data;
// ... after pipeline status is updated to CANCELLED ...
if (cancelTasks) {
  const activeTaskIds = pipeline.stepTaskIds.filter(
    (id): id is TaskId => id !== null
  );
  for (const taskId of activeTaskIds) {
    const cancelResult = await this.eventBus.emit('TaskCancellationRequested', {
      taskId,
      reason: `Pipeline ${pipelineId} cancelled${reason ? `: ${reason}` : ''}`,
    });
    if (!cancelResult.ok) {
      this.logger.warn('Failed to cancel pipeline step task', {
        taskId, pipelineId, error: cancelResult.error.message,
      });
    }
  }
}
```

### MEDIUM

**Unsafe `as Task` cast on overloaded return type** - `src/adapters/mcp-adapter.ts:3690`
**Confidence**: 85%
- Problem: `taskManager.getStatus(taskId)` returns `Result<Task | readonly Task[]>`. The code casts the result as `Task` without checking if it might be an array. If a future code path or bug causes `getStatus` to return an array when called with a single ID, properties like `task.status`, `task.completedAt`, `task.createdAt`, and `task.agent` would read `undefined`, producing incorrect or misleading pipeline status output.
- Impact: Not exploitable as a direct vulnerability, but produces silently wrong data (incorrect durations, missing statuses) that could mislead agents into making bad decisions about pipeline state. Defense-in-depth requires validating the return shape.
- Fix: Add a runtime guard:
```typescript
const taskResult = await this.taskManager.getStatus(taskId);
if (!taskResult.ok) return { ...base, taskStatus: null, taskDuration: null, agent: null };
const value = taskResult.value;
if (Array.isArray(value)) return { ...base, taskStatus: null, taskDuration: null, agent: null };
const task = value;
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Migration v24 index creation was non-idempotent (now fixed, verify no rollback gap)** - `src/implementations/database.ts:981-987`
**Confidence**: 82%
- Problem: This branch changes migration v24 index statements from `CREATE INDEX` to `CREATE INDEX IF NOT EXISTS`. This is the correct fix for idempotency, but the migration version number (24) was not bumped. Users who already ran migration v24 with the non-idempotent indexes on a prior build won't re-run it (it is recorded in `schema_migrations`). This is safe only because the indexes already exist for those users -- the fix only protects fresh installs or interrupted migrations.
- Impact: Low actual risk since the indexes either already exist (prior users) or will be created with IF NOT EXISTS (new users). Documenting this as a conscious decision suffices.
- Fix: No code change needed, but add a comment in the migration noting the retroactive idempotency fix:
```typescript
// NOTE: Changed from CREATE INDEX to CREATE INDEX IF NOT EXISTS retroactively
// for idempotency safety. Existing users already have these indexes from v24.
```

## Pre-existing Issues (Not Blocking)

No CRITICAL pre-existing security issues found in the reviewed files.

## Suggestions (Lower Confidence)

- **Race condition in stepTaskIds population** - `src/services/handlers/pipeline-handler.ts:118-122` (Confidence: 70%) -- When `handleScheduleExecuted` fires concurrently for multiple steps of the same pipeline, the read-modify-write on `stepTaskIds` (read pipeline, spread array, update index, save) could lose an update if two events interleave. The `best-effort` design mitigates this (dashboard polling will eventually reflect correct state), but a transaction or optimistic lock would prevent stale overwrites.

- **`taskManager.getStatus` called without null check on `this.taskManager`** - `src/adapters/mcp-adapter.ts:3687` (Confidence: 65%) -- In `handlePipelineStatus`, the code calls `this.taskManager.getStatus(taskId)` but `taskManager` is a required constructor dependency for the adapter, so this is likely always present. However, the pipeline repository has an explicit null guard (`if (!this.pipelineRepository)`) while taskManager does not -- inconsistent defensive patterns.

- **Error message content in MCP responses** - `src/adapters/mcp-adapter.ts:3668` (Confidence: 60%) -- Internal error messages from `result.error.message` are serialized into MCP tool responses. In this local MCP server context this is acceptable for debuggability, but if the MCP server were ever network-exposed, internal error details could leak implementation information.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Security Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The HIGH finding (cancelTasks silently ignored) means the MCP tool advertises a security-relevant behavior -- cascade cancellation of in-flight tasks -- that does not actually function. This should be fixed before merge to prevent agents from operating under false assumptions about their ability to stop work. The remaining findings are lower severity and can be addressed in the same pass.
