# Testing Review Report

**Branch**: feat/dashboard-visibility-overhaul -> main
**Date**: 2026-04-29T15:16

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

**No tests for PipelineHandler new event handling (handleScheduleExecuted, PipelineStepCompleted, PipelineStatusChanged)** - `src/services/handlers/pipeline-handler.ts:97-141,187-197,276-281`
**Confidence**: 95%
- Problem: The PipelineHandler gained three significant new behaviors in this PR: (1) `handleScheduleExecuted` subscribes to `ScheduleExecuted` events and populates `stepTaskIds` by matching step scheduleIds to active pipelines; (2) `PipelineStepCompleted` emission when a step task completes (lines 187-197); (3) `PipelineStatusChanged` emission on every status transition (lines 276-281). The existing `pipeline-handler.test.ts` has zero coverage for any of these behaviors -- no test references `ScheduleExecuted`, `findActiveByStepScheduleId`, `PipelineStepCompleted`, or `PipelineStatusChanged`.
- Fix: Add tests for:
  - `ScheduleExecuted` event with a `taskId` populating the correct `stepTaskIds` slot
  - `ScheduleExecuted` event without `taskId` is a no-op
  - `PipelineStepCompleted` emitted when a step task completes (but not when it fails/is cancelled)
  - `PipelineStatusChanged` emitted on status transition (PENDING -> RUNNING, RUNNING -> COMPLETED, etc.)
  - `PipelineStatusChanged` NOT emitted when status is unchanged (idempotent event)

**No tests for PipelineRepository.findActiveByStepScheduleId** - `src/implementations/pipeline-repository.ts:320-330`
**Confidence**: 92%
- Problem: A new repository method `findActiveByStepScheduleId` was added that scans active pipelines and filters by step scheduleId in JSON. The existing `pipeline-repository.test.ts` has zero tests for this method. This method involves JSON parsing of step definitions for schedule ID matching -- a pattern that warrants explicit test coverage for correctness.
- Fix: Add test cases for:
  - Returns pipelines where a step contains the target scheduleId
  - Returns empty array when no active pipeline has the scheduleId
  - Only returns active (pending/running) pipelines, not terminal ones
  - Handles pipelines with multiple steps correctly (matches the right step index)

### MEDIUM

**No tests for StatsTile component** - `src/cli/dashboard/components/stats-tile.tsx:1-85`
**Confidence**: 88%
- Problem: `stats-tile.tsx` is a brand new component (85 lines) with formatCost, formatTokens, formatDurationMs helpers and conditional rendering logic (cache display, top entries). Unlike its sibling `ActivityTile` which received a full test file (`activity-tile.test.tsx`), StatsTile has zero test coverage. The component has non-trivial formatting logic (M/K abbreviations, duration formatting) and conditional branches (cacheCreationInputTokens > 0, cacheSavings > 0, top.length > 0).
- Fix: Add `tests/unit/cli/dashboard/stats-tile.test.tsx` covering:
  - Title rendering
  - Cost formatting ($X.XX)
  - Token abbreviations (K, M thresholds)
  - Duration formatting (minutes+seconds vs seconds-only)
  - Cache rows shown/hidden based on zero vs non-zero values
  - Top entries list rendering (0, 1, 3+ entries)

**`as never` cast in workspace-keyboard test hides type mismatches** - `tests/unit/cli/dashboard/workspace-keyboard.test.tsx:169`
**Confidence**: 85%
- Problem: The orchestration fixture is cast with `as never` to satisfy the type checker, bypassing all structural type validation. This is a test anti-pattern: if the `Orchestration` type changes (e.g., a required field is added), this test will not fail at compile time -- it will either silently pass with invalid data or fail at runtime with a confusing error. The `use-keyboard.test.tsx` file uses a proper `makeOrchestration` factory helper, but this file hand-builds the object with an escape hatch.
- Fix: Use a properly typed factory helper instead of `as never`:
  ```typescript
  function makeOrchestration(id: string, status = 'running'): Orchestration {
    return {
      id: id as OrchestratorId,
      goal: 'test',
      status: status as OrchestratorStatus,
      agent: 'claude',
      stateFilePath: '/tmp/s',
      workingDirectory: '/tmp',
      maxDepth: 3,
      maxWorkers: 2,
      maxIterations: 10,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as Orchestration;
  }
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Missing test: "w" is no-op when no orchestrations exist** - `src/cli/dashboard/use-keyboard.ts:100-103`
**Confidence**: 88%
- Problem: The `w` shortcut behavior changed significantly: it now checks for orchestrations and is a no-op when none exist. The test was updated from `"w" from main transitions to workspace` to `"w" from main transitions to workspace when orchestrations exist`, but there is no corresponding negative test verifying `w` does nothing when `data.orchestrations` is empty. This is a behavior-critical edge case -- the old behavior (always navigate) was replaced with conditional navigation.
- Fix: Add a test case:
  ```typescript
  it('"w" from main is a no-op when no orchestrations exist', async () => {
    const data = makeDashboardData({ orchestrations: [] });
    const { lastFrame, stdin } = render(<KeyboardWrapper initialView={{ kind: 'main' }} initialData={data} />);
    await press(stdin, 'w');
    expect(lastFrame()).toContain('view:main'); // stays on main
  });
  ```

**Missing test: "v" from orchestration detail navigates to scoped workspace** - `src/cli/dashboard/use-keyboard.ts:72-74`
**Confidence**: 85%
- Problem: A new behavior was added where pressing `v` from an orchestration detail view transitions to a workspace scoped to that orchestration. The existing `v` test only covers a non-orchestration detail (loop detail) where `v` is correctly expected to be ignored. But the new orchestration-detail-to-scoped-workspace path has no test coverage.
- Fix: Add a test case:
  ```typescript
  it('"v" from orchestration detail transitions to scoped workspace', async () => {
    const orch = makeOrchestration('orch-1');
    const data = makeDashboardData({ orchestrations: [orch] });
    const view = { kind: 'detail' as const, entityType: 'orchestrations' as const, entityId: 'orch-1' as OrchestratorId, returnTo: 'main' as const };
    const { lastFrame, stdin } = render(<KeyboardWrapper initialView={view} initialData={data} />);
    expect(lastFrame()).toContain('view:detail');
    await press(stdin, 'v');
    expect(lastFrame()).toContain('view:workspace');
  });
  ```

**Removed activity focus tests leave behavioral gap** - `tests/unit/cli/dashboard/use-keyboard.test.tsx`
**Confidence**: 82%
- Problem: The PR removed the entire `useKeyboard -- activity focus mode` test section (~120 lines, 10 tests) and `useKeyboard -- activity-row cancel/delete (D2)` section (~100 lines, 7 tests) because the activity feed is now a non-interactive tile. This is correct -- the feature was removed. However, the removal leaves no explicit test asserting the negative behavior: that Tab no longer visits an activity pseudo-panel. The Tab cycle test was updated, but there is no explicit regression guard confirming that `activityFocused` state is gone from the nav reducer (e.g., testing that the reducer ignores/rejects an `activityFocused` field).
- Fix: The existing Tab cycle test (`Tab cycles all the way around: loops -> schedules -> orchestrations -> pipelines -> tasks -> loops`) provides reasonable regression coverage. Consider adding a single assertion that NavState does not accept `activityFocused`:
  ```typescript
  it('NavState no longer includes activityFocused', () => {
    // Type assertion: compile-time check that activityFocused is absent
    const nav: NavState = { ...INITIAL_NAV };
    expect('activityFocused' in nav).toBe(false);
  });
  ```
  This is LOW priority since the TypeScript compiler already enforces this -- including only if the project values runtime assertions for removed features.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**No tests for CancelPipeline cancelTasks cascade behavior** - `src/adapters/mcp-adapter.ts:353`
**Confidence**: 80%
- Problem: The `CancelPipeline` MCP tool schema now accepts a `cancelTasks` boolean parameter (default: true) that cascades cancellation to in-flight step tasks. This is a meaningful behavioral change to the MCP adapter that affects the pipeline cancellation contract. While the MCP adapter test file references `CancelPipeline` (21 matches), the new `cancelTasks` parameter and its cascade behavior through the schedule manager may not have dedicated coverage for the new flag.
- Fix: Verify and add test cases covering:
  - `CancelPipeline` with `cancelTasks: true` (default) cancels step tasks
  - `CancelPipeline` with `cancelTasks: false` does NOT cancel step tasks
  - `CancelPipeline` without `cancelTasks` defaults to true

## Suggestions (Lower Confidence)

- **Time-dependent test in ActivityTile** - `tests/unit/cli/dashboard/activity-tile.test.tsx:128-135` (Confidence: 70%) -- The time format test constructs expected HH:MM from `new Date()` and compares against render output. If the test runs across a minute boundary (e.g., 15:59:59.999 -> 16:00:00.001), the expected and rendered times could differ. Consider using a fixed timestamp.

- **Missing PipelineStatus enrichment test** - `src/adapters/mcp-adapter.ts:3680-3699` (Confidence: 65%) -- The `handlePipelineStatus` method was rewritten to resolve each step's task status and duration. This makes the response structure materially different (adds `taskStatus`, `taskDuration`, `agent` per step). Existing MCP adapter tests may not cover the new enriched response shape.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 1 | 0 |
| Should Fix | 0 | 0 | 3 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Testing Score**: 5/10
**Recommendation**: CHANGES_REQUESTED

The primary concern is the complete absence of tests for significant new pipeline handler logic: the `handleScheduleExecuted` event handler, `PipelineStepCompleted` emission, `PipelineStatusChanged` emission, and the `findActiveByStepScheduleId` repository method. These are not trivial UI adjustments -- they are core event-driven pipeline orchestration behaviors with multiple code paths (happy path, no-op guards, error handling). The dashboard UI test changes are thorough and well-structured, but the pipeline/service layer has zero test coverage for its new code.
