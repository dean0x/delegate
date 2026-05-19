# Consistency Review Report

**Branch**: feat/dashboard-visibility-overhaul -> main
**Date**: 2026-04-29T15:16

## Issues in Your Changes (BLOCKING)

### HIGH

**CancelPipeline `cancelTasks` parameter accepted but not implemented** - `src/adapters/mcp-adapter.ts:353,3785`
**Confidence**: 95%
- Problem: The `CancelPipelineSchema` (line 353) accepts `cancelTasks: z.boolean().optional().default(true)`, and the MCP tool listing (line 1710-1714) advertises it. However, `handleCancelPipeline` (line 3785) destructures only `{ pipelineId, reason }` and never uses `cancelTasks`. The CancelSchedule handler (line 2351) and CancelLoop handler (line 2866) both use their `cancelTasks` parameter to cascade cancellation to in-flight tasks. This is a pattern inconsistency -- CancelPipeline accepts the parameter, documents it defaults to true, but silently ignores it, breaking the cancel-cascade convention established by the other two cancel handlers.
- Fix: Destructure `cancelTasks` and, when truthy, iterate `pipeline.stepTaskIds` to emit `TaskCancellationRequested` for each non-null, non-terminal step task (same pattern as `ScheduleManagerService.cancelSchedule`).

**Duplicate helper functions across `CostTile`, `ThroughputTile`, and `StatsTile`** - `src/cli/dashboard/components/stats-tile.tsx:30-48`, `src/cli/dashboard/components/cost-tile.tsx:22-32`, `src/cli/dashboard/components/throughput-tile.tsx:25-36`
**Confidence**: 90%
- Problem: `formatCost`, `formatTokens` are duplicated identically in `cost-tile.tsx` and `stats-tile.tsx`. `formatDurationMs` is duplicated identically in `throughput-tile.tsx` and `stats-tile.tsx`. The codebase already consolidated `formatActivityTime` into `format.ts` (this same PR), and other format helpers like `formatElapsed`, `formatMs`, `truncateCell`, `shortId` all live in `format.ts`. The new `StatsTile` introduces three copies of helpers that should be shared. This is the same pattern violation that was fixed for `formatTime` -> `formatActivityTime` in this PR.
- Fix: Move `formatCost`, `formatTokens`, and `formatDurationMs` to `format.ts` and import from there in all three tile components.

### MEDIUM

**Dead code: `CostTile` and `ThroughputTile` remain after `StatsTile` replacement** - `src/cli/dashboard/components/cost-tile.tsx`, `src/cli/dashboard/components/throughput-tile.tsx`
**Confidence**: 92%
- Problem: `StatsTile` merges the functionality of `CostTile` and `ThroughputTile`. Neither `CostTile` nor `ThroughputTile` is imported anywhere in `src/` after this branch. Their only consumers are their own test files (`cost-tile.test.tsx`, `throughput-tile.test.tsx`). This mirrors the `CountsPanel` cleanup already done in this PR (counts-panel.tsx and counts-panel.test.tsx were deleted). The old tiles should receive the same treatment for consistency.
- Fix: Delete `cost-tile.tsx`, `throughput-tile.tsx`, `cost-tile.test.tsx`, and `throughput-tile.test.tsx` -- or add a TODO comment at the top of each noting they are superseded by `StatsTile` and should be removed. The `CountsPanel` deletion in this PR is the precedent.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`handlePipelineStatus` changed from `match(result, { ok, err })` to if/early-return but other MCP handlers still use `match`** - `src/adapters/mcp-adapter.ts:3666-3721`
**Confidence**: 82%
- Problem: The `handlePipelineStatus` method was refactored from the `match(result, { ok, err })` pattern to an if-based early-return pattern (`if (!result.ok) { ... } const pipeline = result.value;`). This is not inherently wrong, but other handle methods in the same file (e.g., `handleTaskStatus`, `handleCancelSchedule`, `handleListSchedules`) use the `match` pattern. Mixing two error-handling styles in the same adapter class reduces readability. The early-return was likely needed here because the ok-path now has `await` calls (task status lookups per step), which cannot be inside the synchronous `match` callback.
- Fix: No immediate action needed -- the deviation is justified by the async requirement. Consider adding a brief inline comment: `// Early-return pattern: ok-path requires async work (task status resolution per step)` to explain the deviation from the `match` pattern used elsewhere.

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **COL_TIME_W inconsistency between ActivityPanel and ActivityTile** - `src/cli/dashboard/components/activity-panel.tsx:29` vs `src/cli/dashboard/components/activity-tile.tsx:24` (Confidence: 72%) -- ActivityPanel uses `COL_TIME_W = 5` while ActivityTile uses `COL_TIME_W = 6`. Both display HH:MM (5 chars), but the tile adds 1 char of gap. Consider aligning the constant values or extracting shared layout constants.

- **`TaskUsage` interface used directly in `StatsTileProps` vs extracting a minimal cost-only interface** - `src/cli/dashboard/components/stats-tile.tsx:25` (Confidence: 65%) -- `CostTile` also used `TaskUsage` directly, so this is consistent with the prior pattern. However, `TaskUsage` pulls in all fields (model, captured_at, etc.) that StatsTile does not use. A narrower interface would be more precise but is a style preference given the existing pattern.

- **`activityKindToEntityType` removed but `panelToEntityKind` kept in helpers.ts** - `src/cli/dashboard/keyboard/helpers.ts` (Confidence: 68%) -- The removal of `activityKindToEntityType` is correct since the activity feed is no longer interactive. However, the two functions were inverse mappings. If activity feed interactivity is restored in the future, this mapping would need to be re-created. A brief comment noting the removal reason would be helpful.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Consistency Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The PR is largely consistent internally -- the dashboard layout overhaul follows existing component patterns (pure components, React.memo, displayName), the NavState interface cleanup is thorough (activityFocused/activitySelectedIndex removed from types, initial state, all test fixtures), and the DIP fix in handler-setup.ts (PipelineRepository interface instead of SQLitePipelineRepository concrete type) improves architectural consistency. The tab label expansion (Scheds->Schedules, Orchs->Orchestrations, Pipes->Pipelines) and activity kind label expansion (orch->orchestration, sched->schedule) are consistently applied across source and tests.

The blocking issues are: (1) CancelPipeline advertises `cancelTasks` but never implements the cascade, breaking the cancel convention established by CancelSchedule and CancelLoop; (2) formatCost/formatTokens/formatDurationMs are duplicated across three files when the PR already established the pattern of extracting shared formatters to format.ts. Both are addressable without design changes.
