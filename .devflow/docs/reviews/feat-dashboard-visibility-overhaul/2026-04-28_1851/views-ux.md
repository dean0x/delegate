# Plan Alignment — Views & UX Review Report

**Branch**: feat/dashboard-visibility-overhaul -> main
**Date**: 2026-04-28
**Focus**: Plan alignment of all dashboard views against specification

## Issues in Your Changes (BLOCKING)

### HIGH

**TaskDetail dispatcher does not pass dependencies or usage props** - `src/cli/dashboard/views/detail-view.tsx:58`
**Confidence**: 95%
- Problem: The plan (section 5.1) requires TaskDetail to show a "Dependencies section: Blocked by / Blocks with status badges" and a "Usage section: token/cost info when available." The TaskDetail component itself implements both sections (it accepts `dependencies`, `dependents`, and `usage` props), but the DetailView dispatcher at line 58 renders `<TaskDetail task={task} animFrame={animFrame} />` without passing any of these props. The dependencies and usage data are never resolved or forwarded from the dispatcher, so these sections will never render in practice.
- Fix: The dispatcher needs to resolve dependency and usage data from `DashboardData` and pass them to TaskDetail:
```tsx
case 'tasks': {
  const task = data?.tasks.find((t) => t.id === entityId);
  if (task === undefined) return <NotFound entityType={entityType} entityId={entityId} />;
  // Resolve dependencies/dependents from task.dependsOn/task.dependents arrays
  const dependencies = (task.dependsOn ?? []).map((depId) => {
    const depTask = data?.tasks.find((t) => t.id === depId);
    return { taskId: depId, status: depTask?.status ?? 'unknown' };
  });
  const dependents = (task.dependents ?? []).map((depId) => {
    const depTask = data?.tasks.find((t) => t.id === depId);
    return { taskId: depId, status: depTask?.status ?? 'unknown' };
  });
  // Usage would need to be fetched as detail extra (similar to iterations/executions)
  return <TaskDetail task={task} animFrame={animFrame} dependencies={dependencies} dependents={dependents} />;
}
```

**Entity browser row missing `agent` column specified in plan** - `src/cli/dashboard/components/entity-browser-panel.tsx:7`
**Confidence**: 90%
- Problem: The plan (section 4) specifies entity row columns as: `cursor(2) + icon(2) + shortId(13) + status(11) + elapsed(6-7) + agent(8) + preview(flex)`. The implementation has `cursor(2) + icon(2) + shortId(13) + status(11) + elapsed(7) + description(flex)` -- it is missing the `agent(8)` column entirely. The `agent` field is available on tasks, orchestrations, and pipelines and is a useful distinguisher when multiple agents are in use.
- Fix: Add a COL_AGENT_W = 8 column between elapsed and description. Extract agent from the entity in `getEntityDisplayFields` and render it in EntityRow. For entity types without agent (schedules), display a dash.

**No truncation notice when FETCH_LIMIT reached** - `src/cli/dashboard/components/entity-browser-panel.tsx`
**Confidence**: 88%
- Problem: The plan (section 4) specifies "Truncation notice when FETCH_LIMIT reached." The `use-dashboard-data.ts` defines `FETCH_LIMIT = 50` and uses it when fetching entities, but neither the EntityBrowserPanel nor the MetricsView displays any truncation notice when the returned count equals the limit. Users with >50 entities in a category will see exactly 50 items with no indication that more exist.
- Fix: Pass the FETCH_LIMIT as a prop or compare `items.length >= 50` in EntityBrowserPanel to show a footer message like `"Showing first 50 — more items exist"`.

### MEDIUM

**CountsPanel file still exists as dead code** - `src/cli/dashboard/components/counts-panel.tsx`
**Confidence**: 92%
- Problem: The plan states "EntityBrowserPanel replaces CountsPanel (not just alongside it -- CountsPanel should be gone)." CountsPanel is no longer imported anywhere (confirmed via grep), but the file `counts-panel.tsx` still exists on disk. While not functionally harmful, it contradicts the plan requirement and adds confusion.
- Fix: Delete `src/cli/dashboard/components/counts-panel.tsx` and any associated test file.

**Grid mode `v` toggle not available from orchestration detail view** - `src/cli/dashboard/use-keyboard.ts:67`
**Confidence**: 85%
- Problem: The plan (section 5.5) specifies "Grid mode via `v` toggle (absorbs workspace)" for OrchestrationDetail. The `v` key currently toggles between main and workspace views at the global level (line 67: `if (input === 'v' && view.kind !== 'detail')`), but when viewing an orchestration detail (`view.kind === 'detail'`), the `v` key is explicitly excluded. This means a user viewing an orchestration in list mode cannot press `v` to switch to grid mode from within the detail view. They must go back to main, then press `v` to workspace. The workspace view does render OrchestrationDetail in grid mode, but there is no in-detail toggle as the plan specifies.
- Fix: In `handleDetailKeys`, when `view.entityType === 'orchestrations'` and `input === 'v'`, dispatch a view change to `{ kind: 'workspace', orchestrationId: view.entityId }` (or implement an in-detail viewMode toggle).

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`o` key for live output stream toggle in TaskDetail not implemented** - `src/cli/dashboard/app.tsx:138-139`
**Confidence**: 82%
- Problem: The plan (section 5.1) lists "Live output stream toggle (`o` key) -- or at least infrastructure for it." The code at app.tsx:138-139 has a comment: "Phase C prep: a future `o` toggle in task detail would also enable streaming here." and "That requires keyboard handler changes (handle-detail-keys) deferred to a later phase." The infrastructure for streaming exists (useTaskOutputStream), but the `o` key binding and the stream rendering in task detail are not present. The plan's "or at least infrastructure for it" qualifier does provide some flexibility, but the comment explicitly defers it without any infrastructure hook for the key binding.
- Fix: At minimum, add a no-op `o` key handler in `handleDetailKeys` for `view.entityType === 'tasks'` that toggles a nav state flag, even if the rendering is deferred. Or document the deferral as an explicit plan deviation.

**LoopDetail iteration rows not selectable for Enter navigation** - `src/cli/dashboard/views/loop-detail.tsx`
**Confidence**: 80%
- Problem: The plan (section 5.3) states "Iteration list selectable (Enter navigates to task detail)." The LoopDetail renders iterations via ScrollableList with `selectedIndex={-1}` (hard-coded), meaning no row is ever visually selected, and there is no keyboard handling in `handleDetailKeys` for loop detail that would allow row selection or Enter navigation to a task detail. The iteration rows do display taskId but are not interactive.
- Fix: Track a `loopIterationSelectedIndex` in NavState and add keyboard handling in `handleDetailKeys` for `view.entityType === 'loops'` that supports row selection and Enter to drill into the iteration's task.

**ScheduleDetail execution rows not selectable for Enter navigation** - `src/cli/dashboard/views/schedule-detail.tsx`
**Confidence**: 80%
- Problem: The plan (section 5.4) states "Execution history selectable (Enter navigates to appropriate detail)." Similar to LoopDetail, the ScheduleDetail uses ScrollableList with `selectedIndex={-1}` and no keyboard handling for row selection or Enter navigation exists in `handleDetailKeys` for schedule detail views.
- Fix: Same pattern as LoopDetail -- add selection tracking and Enter handler for schedule executions.

**PipelineDetail stages not navigable via Enter to task detail** - `src/cli/dashboard/views/pipeline-detail.tsx`
**Confidence**: 80%
- Problem: The plan (section 5.2) states "Enter on step navigates to task detail (or at least the data is there)." The data is indeed present (stepTasks are resolved in the dispatcher), but the ScrollableList uses `selectedIndex={-1}` and there is no keyboard handling for pipeline detail row selection or drill-through. The plan qualifier "(or at least the data is there)" provides partial cover, but the data resolution alone is insufficient for the intended UX.
- Fix: Add selection tracking and Enter navigation in `handleDetailKeys` for `view.entityType === 'pipelines'`.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Activity feed handleActivitySelect missing pipeline kind** - `src/cli/dashboard/app.tsx:166-183`
**Confidence**: 85%
- Problem: The `handleActivitySelect` callback maps activity entry kinds to detail views for task, loop, orchestration, and schedule, but does not handle the `pipeline` kind. Since the activity feed now includes pipeline entries (confirmed in activity-feed.ts), pressing Enter on a pipeline activity row will silently do nothing.
- Fix: Add a `case 'pipeline':` branch that calls `setView(openDetail('pipelines', entry.entityId as never, 'main'))`.

## Suggestions (Lower Confidence)

- **TaskDetail usage data not fetched as detail extra** - `src/cli/dashboard/use-dashboard-data.ts` (Confidence: 70%) -- The DashboardData type and TaskDetail component support usage data, but `fetchDetailExtra` does not appear to fetch task usage when viewing a task detail. This may need a `usageRepository.findByTaskId(entityId)` call added to the detail data fetching logic.

- **LoopDetail does not fetch iterations specific to the viewed loop** - `src/cli/dashboard/views/detail-view.tsx:52` (Confidence: 65%) -- The dispatcher passes `data?.iterations` which appears to be a global iterations list, not filtered to the specific loop being viewed. This may show iterations from other loops or be empty if no fetch is triggered.

- **Entity browser `elapsed` column shows creation time for non-running entities** - `src/cli/dashboard/components/entity-browser-panel.tsx:58` (Confidence: 65%) -- For loops and orchestrations, `formatElapsed(loop.createdAt)` shows age since creation rather than runtime elapsed. The plan column name "elapsed" typically implies active runtime duration, not age.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 3 | 1 | 0 |
| Should Fix | 0 | 0 | 4 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

### Plan Alignment Checklist

| Requirement | Status | Notes |
|-------------|--------|-------|
| **S4: EntityBrowserPanel replaces CountsPanel** | PARTIAL | EntityBrowserPanel works; CountsPanel file still on disk (dead code) |
| **S4: 5 entity tabs** | PASS | Tasks, Loops, Scheds, Orchs, Pipes |
| **S4: Tab badges with inline status counts** | PASS | Running, pending, completed, failed badges |
| **S4: Scrollable entity list with cursor** | PASS | Cursor indicator, scroll up/down arrows |
| **S4: Entity row column widths** | PARTIAL | Missing agent(8) column per spec |
| **S4: Empty states** | PASS | Both zero-entity and filtered-zero states present |
| **S4: Truncation notice** | FAIL | No truncation notice when FETCH_LIMIT reached |
| **S4: extractGroup removed** | PASS | Not found in codebase |
| **S4: Tile + browser + activity layout** | PASS | Top row tiles + bottom row browser + activity |
| **S5.1: Orchestrator attribution** | PASS | Shows orchestratorId when present |
| **S5.1: Dependencies section** | PARTIAL | Component supports it; dispatcher does not pass data |
| **S5.1: Usage section** | PARTIAL | Component supports it; dispatcher does not pass data |
| **S5.1: Live output stream toggle** | FAIL | Deferred per code comment; no infrastructure hook |
| **S5.2: PipelineDetail progress bar** | PASS | Unicode block chars, colored per status |
| **S5.2: PipelineDetail stage list** | PASS | Step index, status, taskId, elapsed, prompt |
| **S5.2: PipelineDetail header fields** | PASS | ID, status, source, priority, agent, model, timing |
| **S5.2: Enter on step -> task detail** | PARTIAL | Data resolved; no keyboard navigation |
| **S5.3: Full eval config fields** | PASS | evalType, judgeAgent, judgePrompt, evalPrompt |
| **S5.3: Best score highlight** | PASS | Bold green for best iteration |
| **S5.3: Git diff summary** | PASS | Shown as dimColor line below row |
| **S5.3: Iteration list selectable** | FAIL | selectedIndex=-1, no Enter handler |
| **S5.4: Pipeline steps section** | PASS | Numbered steps shown when present |
| **S5.4: Execution history selectable** | FAIL | selectedIndex=-1, no Enter handler |
| **S5.5: Progress indicators** | PASS | Workers and children counts shown |
| **S5.5: Grid mode via v toggle** | PARTIAL | v toggles main<->workspace globally, not from detail |
| **S5.5: Grid renders TaskPanel grid** | PASS | Full grid with OrchestratorNav |
| **S5.6: Pipeline detail route** | PASS | case 'pipelines' in dispatcher |
| **S5.6: Data resolution** | PASS | Step tasks resolved from pipeline.stepTaskIds |
| **S13.8: Entity browser empty states** | PASS | Zero entities and filtered zero both handled |
| **S13.8: Pipeline detail zero steps** | PASS | "No steps defined" message |
| **S13.8: Orchestration grid zero children** | PASS | EmptyWorkspace kind="no-children" |
| **S13.8: Orchestration grid no orchestrators** | PASS | EmptyWorkspace kind="no-orchestrators" |

**Views/UX Score**: 6/10
**Recommendation**: CHANGES_REQUESTED

The core view structure is well-implemented with proper component architecture, but several plan-specified interactive features are missing: TaskDetail dependency/usage data resolution in the dispatcher, entity row agent column, truncation notice, and row selection/Enter navigation in loop/schedule/pipeline detail views. The grid mode toggle path is also incomplete from within orchestration detail.
