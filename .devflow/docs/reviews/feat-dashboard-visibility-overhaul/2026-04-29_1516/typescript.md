# TypeScript Review Report

**Branch**: feat/dashboard-visibility-overhaul -> main
**Date**: 2026-04-29

## Issues in Your Changes (BLOCKING)

### HIGH

**Unsafe `as Task` type assertion — `getStatus()` returns `Task | readonly Task[]`** - `src/adapters/mcp-adapter.ts:3690`
**Confidence**: 90%
- Problem: `this.taskManager.getStatus(taskId)` returns `Result<Task | readonly Task[]>` (per `src/core/interfaces.ts:448`). The code asserts `taskResult.value as Task` without narrowing, which silently drops the `readonly Task[]` branch. If `getStatus` is called with a `taskId` argument it likely returns a single `Task`, but the type system does not guarantee this.
- Fix: Use a type guard or narrow with `Array.isArray()`:
```typescript
const val = taskResult.value;
const task = Array.isArray(val) ? val[0] : val;
if (!task) return { ...base, taskStatus: null, taskDuration: null, agent: null };
```

**`cancelTasks` parameter accepted but silently ignored in `handleCancelPipeline`** - `src/adapters/mcp-adapter.ts:3785`
**Confidence**: 95%
- Problem: `CancelPipelineSchema` accepts `cancelTasks: z.boolean().optional().default(true)` (line 353), and the MCP tool description says "By default, also cancels any in-flight step tasks" (line 1698). However, `handleCancelPipeline` only destructures `{ pipelineId, reason }` from `parseResult.data` and never reads or acts on `cancelTasks`. This means the API advertises task cancellation cascade but does not implement it.
- Fix: Destructure `cancelTasks` and, when true, iterate `pipeline.stepTaskIds` and emit `TaskCancellationRequested` for each non-null in-flight task (same pattern as `ScheduleManagerService.cancelSchedule`):
```typescript
const { pipelineId, reason, cancelTasks } = parseResult.data;
// ... after pipeline update succeeds ...
if (cancelTasks) {
  for (const tid of pipeline.stepTaskIds) {
    if (tid === null) continue;
    await this.eventBus.emit('TaskCancellationRequested', {
      taskId: tid,
      reason: reason ?? `Pipeline ${pipelineId} cancelled`,
    });
  }
}
```

### MEDIUM

**Duplicated formatting functions across `cost-tile.tsx` and `stats-tile.tsx`** - `src/cli/dashboard/components/stats-tile.tsx:30-48`
**Confidence**: 85%
- Problem: `formatCost()`, `formatTokens()`, and `formatDurationMs()` are defined locally in both `cost-tile.tsx` and `stats-tile.tsx`. Both files also import from `../format.js`. These utility functions belong in the shared `format.ts` module for single source of truth.
- Fix: Move `formatCost`, `formatTokens`, and `formatDurationMs` into `src/cli/dashboard/format.ts` and import from there in both tile components. `ThroughputTile` also duplicates `formatDurationMs`.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`aggregateStatus` uses `string[]` instead of a discriminated union for task statuses** - `src/services/handlers/pipeline-handler.ts:303`
**Confidence**: 80%
- Problem: The `aggregateStatus` method accepts `statuses: string[]` and compares against string literals (`'cancelled'`, `'failed'`, `'completed'`). The project already has a `TaskStatus` enum/type in `domain.ts`. Using `string` loses type safety and allows unrecognized status values to silently pass through without compiler warnings. The `stepStatuses` array also uses `status: string` (line 230).
- Fix: Import `TaskStatus` and type the status fields accordingly:
```typescript
private aggregateStatus(statuses: TaskStatus[], totalSteps: number): PipelineStatus
```

## Pre-existing Issues (Not Blocking)

(None at CRITICAL severity in files reviewed but not modified.)

## Suggestions (Lower Confidence)

- **`ThroughputTile` is still exported but may be unreferenced** - `src/cli/dashboard/components/throughput-tile.tsx` (Confidence: 65%) -- The `StatsTile` consolidates cost + throughput into one tile. `ThroughputTile` still exists with visual styling updates (`flexGrow`, `borderColor`) but may no longer be rendered anywhere. If so, it should be removed alongside the deleted `CountsPanel`.

- **`ENTITY_BROWSER_VIEWPORT_HEIGHT` constant could drift from actual layout** - `src/cli/dashboard/keyboard/constants.ts:51` (Confidence: 70%) -- The constant is `10` as a fallback for keyboard handlers, but `browserViewportHeight` in `metrics-view.tsx:106` is computed dynamically from `layout.bottomRowHeight`. If the layout constants change, the keyboard constant could desync, causing scroll calculations to be slightly off. Consider passing the computed viewport height into keyboard handlers.

- **`detail-view.tsx` dependency resolution performs O(n) `find` per dependency** - `src/cli/dashboard/views/detail-view.tsx:62-63` (Confidence: 60%) -- For each `depId` in `task.dependsOn`, a linear `.find()` scans all tasks. With many tasks, this is quadratic. A `Map<string, Task>` pre-built once would be more efficient, but this is unlikely to matter at current dashboard scale.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**TypeScript Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The branch demonstrates good TypeScript practices overall: proper `readonly` props on interfaces, branded type usage for entity IDs, `React.memo` with `displayName`, `Result` types throughout, and clean removal of dead code (`activityFocused`, `activitySelectedIndex`, `CountsPanel`). The handler-setup change from concrete `SQLitePipelineRepository` to interface `PipelineRepository` is a proper DIP improvement.

The two HIGH issues should be addressed: (1) the `as Task` assertion bypasses a union return type, and (2) `cancelTasks` is advertised in the API schema but never used, which is a contract violation that could confuse callers relying on the documented behavior.
