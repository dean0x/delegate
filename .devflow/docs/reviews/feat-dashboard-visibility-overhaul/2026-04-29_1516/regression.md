# Regression Review Report

**Branch**: feat/dashboard-visibility-overhaul -> main
**Date**: 2026-04-29T15:16

## Issues in Your Changes (BLOCKING)

### HIGH

**CancelPipeline `cancelTasks` parameter parsed but never used** - `src/adapters/mcp-adapter.ts:353, ~line 3750`
**Confidence**: 95%
- Problem: The `CancelPipelineSchema` was extended with `cancelTasks: z.boolean().optional().default(true)` and the MCP tool description states "By default, also cancels any in-flight step tasks." However, `handleCancelPipeline` only destructures `{ pipelineId, reason }` from the parsed result -- the `cancelTasks` field is silently dropped. The handler cancels the pipeline entity but never cancels the in-flight step tasks, contradicting the advertised behavior. By contrast, `CancelSchedule` (line 2351) and `CancelLoop` (line 2866) both destructure and propagate `cancelTasks` correctly.
- Fix: Destructure `cancelTasks` and, when truthy, iterate `pipeline.stepTaskIds`, filter non-null/non-terminal, and emit `TaskCancellationRequested` for each (mirror the CancelSchedule pattern at lines 2171-2196):
  ```typescript
  const { pipelineId, reason, cancelTasks } = parseResult.data;
  // ... after pipeline status update ...
  if (cancelTasks) {
    for (const taskId of pipeline.stepTaskIds) {
      if (taskId === null) continue;
      await this.eventBus.emit('TaskCancellationRequested', {
        taskId,
        reason: `Pipeline ${pipelineId} cancelled`,
      });
    }
  }
  ```

### MEDIUM

**`w` key is now a no-op without orchestrations -- behavioral regression** - `src/cli/dashboard/use-keyboard.ts:99-115`
**Confidence**: 85%
- Problem: Previously, pressing `w` from any view unconditionally navigated to the workspace view (`setView({ kind: 'workspace' })`). Now it silently returns if no orchestrations exist in the data. Users who relied on `w` to switch to workspace view (even when empty) will find the key does nothing. The change is documented as a DECISION but the regression is that `w` from an empty dashboard now has no visible feedback -- it neither navigates nor shows a message.
- Fix: If this is intentional (workspace requires an orchestration to scope to), document it in the keyboard hints. If not, fall back to `setView({ kind: 'workspace' })` when no orchestrations are present to preserve the previous behavior.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Dead code: CostTile and ThroughputTile are unreferenced** - `src/cli/dashboard/components/cost-tile.tsx`, `src/cli/dashboard/components/throughput-tile.tsx`
**Confidence**: 90%
- Problem: The `MetricsView` replaced `CostTile` and `ThroughputTile` with the new `StatsTile` component. Neither `CostTile` nor `ThroughputTile` is imported anywhere in `src/` anymore (confirmed via grep). Their test files still exist and pass, but the components are dead code. This mirrors the `CountsPanel` deletion pattern but was left incomplete -- `CountsPanel` was correctly deleted along with its test file, but these two were not.
- Fix: Delete `src/cli/dashboard/components/cost-tile.tsx`, `src/cli/dashboard/components/throughput-tile.tsx`, and their test files `tests/unit/cli/dashboard/cost-tile.test.tsx`, `tests/unit/cli/dashboard/throughput-tile.test.tsx`. Alternatively, keep them if they serve a role in narrow/degraded layouts (but they do not -- `StatsTile` is used in both narrow and full modes).

**Dead code: `openDetail` function and `ActivityPanel` component still exported** - `src/cli/dashboard/types.ts:124-140`, `src/cli/dashboard/components/activity-panel.tsx`
**Confidence**: 82%
- Problem: The `openDetail` helper function in `types.ts` is no longer imported by any consumer in `src/` (the only importer `app.tsx` had its import removed). `ActivityPanel` similarly has no importers in `src/` now that `MetricsView` uses `ActivityTile` instead. Test files still import both. These are dead code in the production codebase.
- Fix: Either remove these dead exports and their test files, or annotate them with `@deprecated` JSDoc if they are intentionally preserved for future use.

## Pre-existing Issues (Not Blocking)

No critical pre-existing regressions found.

## Suggestions (Lower Confidence)

- **PipelineStatus response shape change is additive but undocumented** - `src/adapters/mcp-adapter.ts:3680-3721` (Confidence: 65%) -- The `PipelineStatus` MCP tool response now includes `taskStatus`, `taskDuration`, and `agent` per step. While additive (not breaking), MCP consumers that perform strict shape validation may reject the extra fields. Consider noting this in changelog/release notes.

- **`v` key inconsistency between `main` and `w` paths** - `src/cli/dashboard/use-keyboard.ts:80-82` (Confidence: 62%) -- Pressing `v` from main view dispatches `{ kind: 'workspace' }` without `orchestrationId` (unscoped workspace), while `w` requires orchestrations to exist and always scopes to one. This asymmetry may confuse users who expect `v` and `w` to reach the same workspace state.

- **`as Task` cast in PipelineStatus handler** - `src/adapters/mcp-adapter.ts:3690` (Confidence: 60%) -- `taskResult.value as Task` casts without runtime guard. If `getStatus(taskId)` ever returns `Task[]` (the union includes it), this would silently produce wrong behavior. A narrowing check would be safer.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Regression Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The branch is largely regression-safe with thorough test updates. The primary concern is the `CancelPipeline` `cancelTasks` parameter being advertised but silently ignored -- this is an intent-vs-reality mismatch where the schema, description, and documentation all promise task cancellation cascade, but the implementation never performs it. The dead code left behind (CostTile, ThroughputTile, ActivityPanel, openDetail) is non-blocking but should be cleaned up for codebase hygiene. The `w` key behavioral change is documented via a DECISION comment but represents a regression for users in empty-orchestration scenarios.
