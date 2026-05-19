# Architecture Review Report

**Branch**: feat/dashboard-visibility-overhaul -> main
**Date**: 2026-04-29T15:16

## Issues in Your Changes (BLOCKING)

### HIGH

**CancelPipeline `cancelTasks` parameter parsed but never used** - `src/adapters/mcp-adapter.ts:3785`
**Confidence**: 95%
- Problem: The `CancelPipelineSchema` (line 353) defines a `cancelTasks: z.boolean().optional().default(true)` field, the MCP tool description (line 1698) promises "By default, also cancels any in-flight step tasks", and the JSON schema (line 1710-1714) exposes it to callers. However, `handleCancelPipeline` at line 3785 only destructures `{ pipelineId, reason }` and never reads `cancelTasks`. The cancel handler directly updates the pipeline status to CANCELLED without cancelling any step tasks. This is a contract violation: the MCP tool advertises behavior it does not implement. Callers (other Claude Code instances) will believe their step tasks are being cancelled when they are not.
- Fix: Destructure `cancelTasks` and, when true, iterate over `pipeline.stepTaskIds` emitting `TaskCancellationRequested` for each non-null task ID (same pattern as `CancelSchedule` at line 2178 and `CancelLoop`). Example:
  ```typescript
  const { pipelineId, reason, cancelTasks } = parseResult.data;
  // ... after pipeline status update ...
  if (cancelTasks) {
    for (const taskId of pipeline.stepTaskIds) {
      if (taskId !== null) {
        await this.eventBus.emit('TaskCancellationRequested', {
          taskId,
          reason: `Pipeline ${pipelineId} cancelled`,
        });
      }
    }
  }
  ```

**Dead code: `CostTile`, `ThroughputTile`, and `ActivityPanel` no longer imported** - `src/cli/dashboard/components/cost-tile.tsx`, `throughput-tile.tsx`, `activity-panel.tsx`
**Confidence**: 92%
- Problem: `StatsTile` consolidates `CostTile` and `ThroughputTile`; `ActivityTile` replaces `ActivityPanel`. The old components are still defined in their own files but are no longer imported by any production code (verified via grep). This is 3 orphaned module files (~160 lines) that will confuse future developers about which component is canonical. The `ActivityPanel` test file (`activity-panel.test.tsx`) also still exists, testing a component that is no longer used.
- Fix: Delete `cost-tile.tsx`, `throughput-tile.tsx`, and `activity-panel.tsx` (and their test files) or mark them as deprecated with a TODO for removal. The same applies to the `openDetail` function in `types.ts` (exported but no longer imported anywhere).

### MEDIUM

**`handlePipelineStatus` uses `as Task` cast on `getStatus` result** - `src/adapters/mcp-adapter.ts:3690`
**Confidence**: 82%
- Problem: `TaskManager.getStatus(taskId?)` returns `Result<Task | readonly Task[]>`. When called with a specific `taskId`, it returns a single `Task`, but the union type means the cast `as Task` bypasses type narrowing. If the `getStatus` implementation ever changes to return an array even with a specific ID, this cast would silently produce incorrect behavior. This violates the DIP principle: the adapter is making assumptions about the implementation rather than relying on the type contract.
- Fix: Use a type guard or check:
  ```typescript
  const value = taskResult.value;
  const task = Array.isArray(value) ? value[0] : value;
  if (!task) return { ...base, taskStatus: null, taskDuration: null, agent: null };
  ```

**Race condition window in `handleScheduleExecuted` stepTaskIds population** - `src/services/handlers/pipeline-handler.ts:113-136`
**Confidence**: 80%
- Problem: `handleScheduleExecuted` reads a pipeline, copies `stepTaskIds`, sets one index, and updates. If two step schedules fire concurrently for the same pipeline, both read the same snapshot, and the second update overwrites the first's change. The handler iterates `pipelinesResult.value` (a loop) but within each pipeline there is no optimistic concurrency or transaction. The comment says "best-effort" which acknowledges this, but for immediate pipelines where steps fire in rapid sequence this is a realistic scenario.
- Fix: Either use a database-level atomic operation (e.g., `UPDATE pipelines SET step_task_ids = json_set(step_task_ids, ?, ?) WHERE id = ? AND status IN ('pending','running')`) or add a retry-on-conflict pattern. Given the "best-effort" design choice, consider at minimum adding a warning log when the write succeeds but the read-back shows a different value.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`StatsTile` duplicates formatting functions from `CostTile`** - `src/cli/dashboard/components/stats-tile.tsx:30-48`
**Confidence**: 85%
- Problem: `formatCost`, `formatTokens`, and `formatDurationMs` are defined locally in `StatsTile`. `formatCost` and `formatTokens` were already defined identically in `cost-tile.tsx`, and `formatDurationMs` is similar to patterns in `throughput-tile.tsx`. With `CostTile` and `ThroughputTile` now dead code, these functions should be extracted to the shared `format.ts` module (which already hosts `formatElapsed`, `shortId`, `statusColor`, etc.) to follow the existing codebase pattern of centralized formatting.
- Fix: Move `formatCost`, `formatTokens`, and `formatDurationMs` to `src/cli/dashboard/format.ts` and import them in `stats-tile.tsx`.

**`ActivityTile` column width constants diverge from `ActivityPanel`** - `src/cli/dashboard/components/activity-tile.tsx:24-25` vs `activity-panel.tsx:29-31`
**Confidence**: 80%
- Problem: `ActivityTile` defines `COL_TIME_W = 6` and `COL_KIND_W = 14` while `ActivityPanel` defines `COL_TIME_W = 5` and `COL_KIND_W = 14` plus `COL_ID_W = 13`. These similar-but-different constants for the same domain concept create inconsistency. Since `ActivityPanel` is now dead code, this is primarily a hygiene issue, but if both components were to coexist it would cause visual misalignment.
- Fix: Extract shared column width constants to a common location or remove the dead `ActivityPanel` entirely.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`openDetail` function exported but unused** - `src/cli/dashboard/types.ts:124-140`
**Confidence**: 90%
- Problem: The `openDetail` overloaded function is still exported from `types.ts` but no production code imports it. The removal of `handleActivitySelect` in `app.tsx` was the last consumer. This is dead code in a core types file.
- Fix: Remove the function or add a deprecation notice.

### LOW

**`ActivityPanel` still has `onSelect` prop and interactive selection logic** - `src/cli/dashboard/components/activity-panel.tsx`
**Confidence**: 88%
- Problem: `ActivityPanel` retains full interactive selection props (`selectedIndex`, `scrollOffset`, `focused`, `onSelect`) but is no longer mounted anywhere. The test file `activity-panel.test.tsx` still tests this dead component. This will cause confusion about which activity component is canonical.
- Fix: Delete `activity-panel.tsx` and its test file in a cleanup commit.

## Suggestions (Lower Confidence)

- **Potential SRP concern: `handlePipelineStatus` does N+1 task lookups** - `src/adapters/mcp-adapter.ts:3681-3699` (Confidence: 70%) -- The handler executes `Promise.all` over step tasks to resolve statuses. For large pipelines (up to 20 steps), this generates 20 individual `getStatus` calls. Consider a batch `findByIds` repository method.

- **`PipelineHandler.handleScheduleExecuted` has broad scope** - `src/services/handlers/pipeline-handler.ts:97-141` (Confidence: 65%) -- This handler subscribes to ALL `ScheduleExecuted` events but only acts on a narrow subset (immediate pipeline steps). The early return when `!e.taskId` helps, but the `findActiveByStepScheduleId` query runs on every single-task schedule execution too. In high-volume schedule systems this could be noisy.

- **`w` shortcut hardcodes orchestration selection heuristic** - `src/cli/dashboard/use-keyboard.ts:100-114` (Confidence: 62%) -- The `w` key now implements business logic (find running orchestration, fall back to most recent) directly in a keyboard hook. This could be extracted to a pure function for testability.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 1 | 1 |

**Architecture Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The DIP fix for `PipelineHandler` (using `PipelineRepository` interface instead of `SQLitePipelineRepository` concrete) is an excellent architectural improvement. The dashboard refactoring cleanly removes the activity-focus navigation complexity. However, the `CancelPipeline` contract violation (promising task cancellation without implementing it) is a HIGH-severity issue that should be resolved before merge, and the dead code from the tile consolidation should be cleaned up.
