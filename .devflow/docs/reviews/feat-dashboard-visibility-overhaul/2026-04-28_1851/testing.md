# Testing Review Report

**Branch**: feat/dashboard-visibility-overhaul -> main
**Date**: 2026-04-28
**Total tests in branch diff**: ~530 (across 18 test files)

## Issues in Your Changes (BLOCKING)

### HIGH

**Pipeline repository missing tests for `findByScheduleId`, `findByLoopId`, and `findActiveByTaskId`** - `tests/unit/implementations/pipeline-repository.test.ts`
**Confidence**: 95%
- Problem: The `SQLitePipelineRepository` exposes 3 public query methods that have zero test coverage: `findByScheduleId(scheduleId)`, `findByLoopId(loopId)`, and `findActiveByTaskId(taskId)`. These are used by `PipelineHandler.onTaskTerminated()` and `ScheduleManager` -- they are in the critical path for pipeline status aggregation and schedule triggers. `findActiveByTaskId` in particular uses a JSON array search pattern (`json_each(step_task_ids)`) that could silently break with schema changes.
- Fix: Add 3 describe blocks to `pipeline-repository.test.ts`:
  ```typescript
  describe('findByScheduleId', () => {
    it('returns pipelines matching the given scheduleId', async () => {
      const pipeline = createPipeline({
        steps: [{ index: 0, prompt: 'A' }],
        scheduleId: ScheduleId('sched-1'),
      });
      await repo.save(pipeline);
      const result = await repo.findByScheduleId(ScheduleId('sched-1'));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error();
      expect(result.value).toHaveLength(1);
      expect(result.value[0].id).toBe(pipeline.id);
    });
    it('returns empty array when no pipelines match', async () => { ... });
  });

  describe('findByLoopId', () => { /* similar pattern */ });

  describe('findActiveByTaskId', () => {
    it('returns active pipelines containing the given taskId in stepTaskIds', async () => { ... });
    it('does not return terminal pipelines', async () => { ... });
    it('returns empty array when taskId is not in any pipeline', async () => { ... });
  });
  ```

**Enter key on pipeline panel does not have dedicated keyboard test** - `tests/unit/cli/dashboard/use-keyboard.test.tsx`
**Confidence**: 85%
- Problem: The `handleMainKeys` function was extended with a `case 'pipelines':` branch for Enter-to-detail navigation (lines 242-249 of handle-main-keys.ts). The `use-keyboard.test.tsx` file does not test pressing Enter when the focused panel is `pipelines` with a pipeline entity selected. While the existing Enter tests cover loops, tasks, schedules, and orchestrations, the new pipeline branch is untested. This is the only entity type added in this branch, making it the highest-risk untested keyboard path.
- Fix: Add a test in the "Enter — drill into detail" describe block:
  ```typescript
  it('Enter from pipelines panel drills into pipeline detail', async () => {
    const data = makeData({
      pipelines: [{ id: 'pipeline-001', status: 'running' }],
    });
    const { lastFrame, stdin } = renderWrapper({
      initialNav: { ...INITIAL_NAV, focusedPanel: 'pipelines' },
      data,
    });
    await press(stdin, '\r');
    expect(lastFrame()).toContain('detail-type:pipelines');
    expect(lastFrame()).toContain('detail-id:pipeline-001');
  });
  ```

### MEDIUM

**No dedicated unit test for `keyboard/hints.ts` module** - `src/cli/dashboard/keyboard/hints.ts`
**Confidence**: 82%
- Problem: The `hints.ts` module exports 4 functions (`mainHints`, `workspaceHints`, `detailHints`, `getHints`) that centralize footer help text. While the `Footer` component tests indirectly cover the output, there is no direct unit test for the hint functions. If someone modifies the hint functions without updating Footer tests, regressions could slip through. The module is pure functions -- trivial to test directly.
- Fix: Create `tests/unit/cli/dashboard/hints.test.ts` with tests for each exported function, particularly `mainHints(true)` vs `mainHints(false)` and `getHints('main'|'workspace'|'detail', boolean)`.

**Pipeline filter cycle (`f` key) not tested for pipelines panel** - `tests/unit/cli/dashboard/use-keyboard.test.tsx`
**Confidence**: 80%
- Problem: The `FILTER_CYCLES` constant was extended with `pipelines: [null, 'pending', 'running', 'completed', 'failed', 'cancelled']` (constants.ts line 17). The `f` key filter cycling behavior is tested for tasks and loops panels but not for the new pipelines panel. The filter cycle for pipelines includes 'pending' (unlike tasks which use 'queued'), which is a unique status value that could be wrong without a test catching it.
- Fix: Add a filter cycle test for the pipelines panel in the "f — filter cycling" describe block.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`workspace-view.test.tsx` grid rendering tests use `not.toThrow` instead of asserting content** - `tests/unit/cli/dashboard/workspace-view.test.tsx:153-177,179-198,200-224`
**Confidence**: 85%
- Problem: Three test blocks ("grid rendering", "grid-only mode", "fullscreen mode") only assert `expect(() => render(...)).not.toThrow()`. These tests verify the component does not crash but do not check that it renders meaningful output. For example, the fullscreen test does not verify the fullscreen panel renders its task content. This is a weak assertion pattern -- it would pass even if the render produced blank output or dropped all children.
- Fix: Replace `not.toThrow` assertions with content assertions:
  ```typescript
  it('renders 3 children in the grid', () => {
    const { lastFrame } = render(<OrchestrationDetail .../>);
    const frame = lastFrame() ?? '';
    // Assert children content is present
    expect(frame).toContain('task-1');
    expect(frame).toContain('output from task-1');
  });
  ```

**`orchestration-detail.test.tsx` OrchestratorNav test uses weak assertion** - `tests/unit/cli/dashboard/orchestration-detail.test.tsx:381-400`
**Confidence**: 82%
- Problem: The test "renders OrchestratorNav in nav+grid mode with multiple orchestrations" only asserts `expect(allFrames).toBeTruthy()` and `expect(frames.length).toBeGreaterThan(0)`. These assertions pass for any non-empty render. The test should verify that OrchestratorNav renders at least one orchestration goal or ID, confirming the nav panel is actually visible.
- Fix: Assert on specific content from the orchestrations:
  ```typescript
  const allFrames = frames.join('\n');
  expect(allFrames).toContain('orch-g1-001'); // or short ID
  ```

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`detail-view.test.tsx` TaskDetail tests do not pass `dependencies`/`dependents`/`usage` through DetailView dispatcher** - `tests/unit/cli/dashboard/detail-view.test.tsx:533-539`
**Confidence**: 80%
- Problem: The DetailView dispatcher test for tasks (`it('dispatches to TaskDetail for tasks entityType')`) only verifies the basic render. However, the TaskDetail component in the Phase C enhancements section has rich dependency and usage visualization. The DetailView dispatcher for tasks does not pass `dependencies`, `dependents`, or `usage` props through -- it renders `<TaskDetail task={task} animFrame={animFrame} />` without those props. This is a pre-existing design gap: DetailView does not resolve dependency data for tasks (only for loops with iterations and schedules with executions). If dependency/usage resolution is added to DetailView in the future, the test would need to be updated.

## Suggestions (Lower Confidence)

- **Missing cancel/delete mutation tests for pipelines panel** - `tests/unit/cli/dashboard/use-keyboard.test.tsx` (Confidence: 72%) -- The `c` (cancel) and `d` (delete) keyboard mutations are tested for existing entity types but not for the new pipelines panel. The `TERMINAL_STATUSES` constant was extended with `pipelines:` but mutation tests do not cover pipeline entities.

- **Pipeline repository error path not tested** - `tests/unit/implementations/pipeline-repository.test.ts` (Confidence: 65%) -- None of the repository tests exercise error paths (e.g., saving with invalid data, database corruption). While the `tryCatchAsync` wrapper and Zod validation provide safety, there are no tests verifying that these produce proper `Result.err` values. This is consistent with the existing test style for other repositories, so it is a codebase-wide pattern rather than a new gap.

- **Integration test does not exercise pipeline data flow** - `tests/integration/orchestration-workspace.test.ts` (Confidence: 68%) -- The integration test adds `pipelineRepository` to the context but does not seed any pipelines or verify they appear in the fetched data. A pipeline round-trip test would strengthen confidence in the full data pipeline.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

### Test Coverage Inventory

| Test File | Test Count | Coverage Assessment |
|-----------|-----------|---------------------|
| `pipeline-repository.test.ts` | 16 | **Good** -- CRUD, findAll, findByStatus, countByStatus, findUpdatedSince, delete, step round-trip. **Gap**: findByScheduleId, findByLoopId, findActiveByTaskId |
| `pipeline-handler.test.ts` | 12 | **Excellent** -- All terminal states (completed, failed, cancelled), no-op for non-pipeline tasks, multi-step partial completion stays running, event emission |
| `entity-browser-panel.test.tsx` | 13 | **Good** -- Tab bar, empty states with/without filter, entity rows, cursor, filter behavior, null data, pipeline tab presence |
| `entity-tabs.test.tsx` | 11 | **Good** -- All 5 tabs, active/inactive styling, count badges (running/completed/failed/dash), pipeline counts, zero state |
| `nav-reducer.test.ts` | 14 | **Excellent** -- All 6 action types, immutability, structural sharing, updater freshness |
| `header.test.tsx` | 35 | **Excellent** -- Version, timestamp, quit hint, error display/truncation, health summary (idle, running, queued, failed, aggregation across types, pipeline counts), breadcrumbs for all view states and all entity types |
| `footer.test.tsx` | 17 | **Good** -- Main view hints (1-5 panel, Tab activity, select, detail, refresh, quit), mutations hints, workspace hints, detail hints, negative assertions for pre-redesign artifacts |
| `detail-view.test.tsx` | 98 | **Excellent** -- LoopDetail (13 fields + iterations + eval config + gitDiffSummary), TaskDetail (14 fields + dependencies + usage), ScheduleDetail (10 fields + executions + pipeline steps), OrchestrationDetail (10 fields + progress), DetailView dispatcher (all 5 entity types + not-found + data passing), ProgressBar (empty/partial/full/failed/block chars), PipelineDetail (ID, header, stages, progress, prompts, schedule/loop source), formatElapsed |
| `activity-feed.test.ts` | 32 | **Excellent** -- Merge ordering, limit, verb mapping for all 5 entity kinds (including pipeline: started/completed/failed/failed step N/cancelled) |
| `orchestration-detail.test.tsx` | 24 | **Good** -- Legacy metadata, children section, cost section, D3 drill-through with pagination, grid mode (empty/too-small/no-children/fallback/OrchestratorNav/list-mode default) |
| `workspace-view.test.tsx` | 7 | **Adequate** -- Too-small, no-orchestrators, no-children, grid rendering, grid-only, fullscreen, nav selection/committed. **Gap**: weak assertions (not.toThrow only) |
| `use-dashboard-data.test.ts` | 22 | **Good** -- Poll intervals, buildEntityCounts, fetchAllData (success, error, entity counts, detail-view fetching for loops/schedules/orchestrations, liveness caching), pipeline repository calls |
| `use-keyboard.test.tsx` | 74 | **Good** -- Tab cycling (all 5 panels + activity), Shift+Tab, 1-5 jump keys, arrows, Enter drill, Escape, filter, w/m keys, mutations. **Gap**: Enter on pipelines panel, f filter on pipelines |
| `workspace-keyboard.test.tsx` | 28 | **Good** -- Grid navigation, panel focus, fullscreen toggle |
| `orchestration-workspace.test.ts` | 3 | **Good** -- Full integration: seeded orchestration + loop + tasks + usage, workspace data pipeline, fallback behavior, empty state. Updated with pipelineRepository |

**Testing Score**: 8/10
**Recommendation**: CHANGES_REQUESTED

### Rationale

The test suite is thorough and well-structured, covering 530+ tests across 18 files with strong behavioral testing patterns. The pipeline repository, handler, and dashboard components all have meaningful test coverage. However, 3 public repository methods (`findByScheduleId`, `findByLoopId`, `findActiveByTaskId`) that are on critical paths have zero tests, and the new `Enter` keyboard path for pipelines is untested. These gaps are straightforward to fill and should be addressed before merge.
