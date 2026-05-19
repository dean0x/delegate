# Code Review Summary

**Branch**: feat/dashboard-visibility-overhaul -> main
**Date**: 2026-04-28
**Reviewers**: 9 domain specialists (pipeline-entity, views-ux, keyboard-nav, visual-design, workspace-fold, architecture, testing, react, database)

---

## Merge Recommendation: CHANGES_REQUESTED

This branch delivers a comprehensive dashboard visibility overhaul with strong foundational work on pipeline entities, responsive layout, and keyboard navigation. However, **12 blocking issues across 4 critical areas** must be resolved before merge:

1. **Pipeline event lifecycle** (3 events defined but never emitted)
2. **Activity feed integration** (pipeline entries exist but cannot be navigated to)
3. **Visual design compliance** (4 HIGH priority visual gaps)
4. **Workspace fold incompleteness** (3 HIGH priority interactive features missing)

All issues are in YOUR CHANGES and are actionable. The codebase quality is solid; fixes are straightforward and follow established patterns.

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------|----------|------|--------|-----|-------|
| Blocking | 0 | 12 | 8 | 0 | **20** |
| Should Fix | 0 | 0 | 7 | 0 | 7 |
| Pre-existing | 0 | 0 | 3 | 0 | 3 |

---

## BLOCKING ISSUES (Must Fix Before Merge)

### HIGH (12 issues)

**1. Missing PipelineCreated event emission** (Pipeline Entity Review)
- **File**: `src/services/schedule-manager.ts:400-428`
- **Confidence**: 95%
- **Problem**: Event type defined in `events.ts` but never emitted when `createPipeline()` saves the entity. Other handlers cannot react to new pipelines.
- **Impact**: Pipeline creation events are silently lost.
- **Fix**: After `pipelineRepository.save()` succeeds, emit `PipelineCreated` with `{ pipelineId, steps: pipelineEntity.steps.length }`.

**2. Missing PipelineStatusChanged event emission** (Pipeline Entity Review)
- **File**: `src/services/handlers/pipeline-handler.ts:239-262`
- **Confidence**: 92%
- **Problem**: Status transition events (PENDING → RUNNING) are not emitted, only terminal events (Completed/Failed/Cancelled).
- **Impact**: Pipeline status change tracking is incomplete; event-driven consumers cannot track intermediate states.
- **Fix**: In `emitPipelineEvent()`, emit `PipelineStatusChanged` before terminal events.

**3. Missing PipelineStepCompleted event emission** (Pipeline Entity Review)
- **File**: `src/services/handlers/pipeline-handler.ts:83-98`
- **Confidence**: 92%
- **Problem**: When individual steps complete, no `PipelineStepCompleted` event is emitted for step-level progress tracking.
- **Impact**: Step-level progress data is unavailable to activity feed and progress tracking.
- **Fix**: Emit `PipelineStepCompleted` in `updatePipelineStatus()` for each completed step (with deduplication to avoid re-emitting).

**4. CancelPipeline missing cascade cancellation** (Pipeline Entity Review + Views Review)
- **File**: `src/adapters/mcp-adapter.ts:350-353, 3749-3831`
- **Confidence**: 95%
- **Problem**: Schema lacks `cancelTasks` parameter (present in `CancelSchedule` and `CancelLoop`). Handler only cancels pipeline status without cascading to in-flight step tasks.
- **Impact**: Cancelling a running pipeline does not stop its tasks, leaving them running orphaned.
- **Fix**: Add `cancelTasks: z.boolean().optional().default(true)` to schema. Iterate `pipeline.stepTaskIds` and emit `TaskCancellationRequested` for each non-null task.

**5. TaskDetail missing dependency/usage data resolution** (Views & UX Review)
- **File**: `src/cli/dashboard/views/detail-view.tsx:58`
- **Confidence**: 95%
- **Problem**: The dispatcher renders `<TaskDetail task={task} animFrame={animFrame} />` without passing `dependencies`, `dependents`, and `usage` props. TaskDetail component supports these props but they're never resolved or passed through.
- **Impact**: Dependencies and usage sections in TaskDetail never render, even though infrastructure exists.
- **Fix**: Resolve `task.dependsOn/dependents` from `data?.tasks` and pass as props. Fetch usage data as detail extra (similar to iterations/executions).

**6. Entity browser missing agent column** (Views & UX Review)
- **File**: `src/cli/dashboard/components/entity-browser-panel.tsx:7`
- **Confidence**: 90%
- **Problem**: Plan specifies `agent(8)` column between elapsed and description. Implementation is missing it entirely.
- **Impact**: Cannot distinguish entities by agent when multiple agents are in use.
- **Fix**: Add `COL_AGENT_W = 8` column. Extract agent from entity in `getEntityDisplayFields()`, display as dash for entities without agent.

**7. No truncation notice when FETCH_LIMIT reached** (Views & UX Review)
- **File**: `src/cli/dashboard/components/entity-browser-panel.tsx`
- **Confidence**: 88%
- **Problem**: FETCH_LIMIT=50 silently caps entity lists with no user indication. Users with 50+ entities see exactly 50 with no warning more exist.
- **Impact**: Users are unaware when entity lists are incomplete.
- **Fix**: Compare `items.length >= FETCH_LIMIT` and show footer notice: "Showing first 50 — more items exist".

**8. Activity feed missing pipeline navigation (keyboard)** (Keyboard Nav Review + Architecture Review + React Review)
- **File**: `src/cli/dashboard/keyboard/handle-main-keys.ts:109-131`
- **Confidence**: 95%
- **Problem**: Enter handler dispatches on entity type but does not handle `'pipelines'` case. Pipeline activity entries exist but pressing Enter silently does nothing.
- **Impact**: Pipeline entries appear in activity feed but cannot be drilled into via keyboard.
- **Fix**: Add `case 'pipelines':` branch after `'schedules'` that navigates to `{ kind: 'detail', entityType: 'pipelines', entityId, returnTo: 'main' }`.

**9. Activity feed missing pipeline navigation (click/callback)** (Keyboard Nav Review + Architecture Review + React Review)
- **File**: `src/cli/dashboard/app.tsx:167-180`
- **Confidence**: 95%
- **Problem**: `handleActivitySelect` callback handles 4 entity types but missing `'pipeline'` case. Pipeline activity rows exist but clicking them does nothing.
- **Impact**: Pipeline entries appear in activity feed but cannot be drilled into via mouse/selection.
- **Fix**: Add `case 'pipeline':` branch that calls `setView(openDetail('pipelines', entry.entityId as never, 'main'))`.

**10. Tile borders missing gray color** (Visual Design Review)
- **File**: `resources-tile.tsx:41,55`, `cost-tile.tsx:38`, `throughput-tile.tsx:40`
- **Confidence**: 92%
- **Problem**: Plan S3.3 specifies `borderStyle="round" borderColor="gray"`. Implementation has round style but omits `borderColor="gray"` on all tiles.
- **Impact**: Tiles render with default foreground color (white) instead of intended neutral gray, making them visually heavier.
- **Fix**: Add `borderColor="gray"` to outermost Box in each tile's null and data branches.

**11. Cost tile missing cacheCreationInputTokens display** (Visual Design Review)
- **File**: `cost-tile.tsx:34-45`
- **Confidence**: 95%
- **Problem**: Plan S3.4 requires display of `cacheCreationInputTokens` alongside `cacheReadInputTokens`. Only cache reads are shown, not cache creation tokens.
- **Impact**: Users cannot see cache creation token usage, only cache hits.
- **Fix**: Destructure `cacheCreationInputTokens` and render conditionally: `{cacheCreationInputTokens > 0 && <Text>Cache create {formatTokens(cacheCreationInputTokens)} tok</Text>}`.

**12. Activity feed using padEnd instead of Box width** (Visual Design Review)
- **File**: `activity-panel.tsx:57-64`
- **Confidence**: 88%
- **Problem**: Plan S7 specifies `<Box width={N}>` for column alignment. Activity panel uses string `padEnd()` instead, inconsistent with entity browser which correctly uses Box layout.
- **Impact**: Misaligned columns and visual inconsistency with other panels.
- **Fix**: Refactor `renderActivityRow()` to use Box-based columns like EntityRow (time, kind, id, status, action as Box elements).

---

## SHOULD FIX (7 issues - Lower Priority)

### HIGH

**Missing v toggle inside orchestration detail** (Workspace Fold Review)
- **File**: `src/cli/dashboard/use-keyboard.ts:66-74`
- **Confidence**: 95%
- **Problem**: Plan S5.5 requires `v` to toggle between list and grid modes **within** orchestration detail. Current implementation only toggles between main and workspace view kinds; pressing `v` in detail view is ignored.
- **Fix**: When `view.kind === 'detail'` and `entityType === 'orchestrations'`, route `v` to toggle `viewMode` between list and grid.

**Missing w shortcut edge cases** (Workspace Fold Review)
- **File**: `src/cli/dashboard/use-keyboard.ts:82-86`
- **Confidence**: 92%
- **Problem**: Plan S13.5 specifies 5 edge cases for `w`: no orchs (noop), no running (show recent in list), one running (grid), multiple running (first in grid), already in orch detail (toggle). Current implementation unconditionally navigates to workspace without any logic.
- **Fix**: Add orchestration-aware logic before `setView()`: check count, running status, and route to appropriate view.

**Streaming gated only on workspace view kind** (Workspace Fold Review)
- **File**: `src/cli/dashboard/app.tsx:140`
- **Confidence**: 90%
- **Problem**: `streamingEnabled = view.kind === 'workspace'`. When `v` toggle is implemented and orch detail shows grid mode via detail route, streaming will be disabled because view kind is `'detail'` not `'workspace'`.
- **Fix**: Update condition to also enable streaming when `view.kind === 'detail'` and in grid mode.

**Incomplete activity feed column widths** (Visual Design Review)
- **File**: `activity-panel.tsx:35-37`
- **Confidence**: 90%
- **Problem**: Plan S7 specifies `time(5) + kind(7) + shortId(13) + status(11) + action(flex)`. Implementation uses `kind(5)` and `id(8)`, causing truncation (shortId=12 chars overflows 8).
- **Fix**: Update `COL_KIND_W = 7` and `COL_ID_W = 13`.

**Status color for 'active' is cyan instead of green** (Visual Design Review)
- **File**: `format.ts:52-55`
- **Confidence**: 82%
- **Problem**: Plan S3.2 specifies `active: ● (green)`. Implementation groups `active` with `running`/`planning` returning cyan.
- **Fix**: Move `active` to green branch with `completed`/`triggered`.

**PipelineHandler depends on concrete SQLitePipelineRepository** (Architecture Review + Database Review)
- **File**: `src/services/handlers/pipeline-handler.ts:19`, `src/services/handler-setup.ts:34,77,206`
- **Confidence**: 95%
- **Problem**: DIP violation. Handler imports concrete class instead of interface. Root cause: `findActiveByTaskId()` not on interface.
- **Fix**: Add `findActiveByTaskId(taskId: TaskId): Promise<Result<readonly Pipeline[]>>` to `PipelineRepository` interface. Update handler and handler-setup to depend on interface.

**Missing IF NOT EXISTS on migration v24 indexes** (Database Review)
- **File**: `src/implementations/database.ts:981-987`
- **Confidence**: 95%
- **Problem**: All 5 `CREATE INDEX` statements lack `IF NOT EXISTS`. All other migrations (v1-v22) use it for idempotency. Violates migration contract.
- **Fix**: Add `IF NOT EXISTS` to all 5 index creation statements.

---

## MEDIUM ISSUES (8 issues - Suggestions)

These are in code you touched or nearby and should be addressed:

| Issue | File | Confidence | Type | Summary |
|-------|------|------------|------|---------|
| stepTaskIds never populated with actual task IDs | `src/services/schedule-manager.ts:402-428` | 85% | Behavioral | Pipeline status tracking inert for schedule-triggered pipelines; need backfill when tasks dispatched |
| PipelineStatus tool does not resolve step tasks | `src/adapters/mcp-adapter.ts:3674-3678` | 82% | Feature | Returns raw taskId only; plan requires resolved task status/duration |
| ReadOnlyContext missing dependencyRepository | `src/cli/dashboard/read-only-context.ts:41-51` | 88% | Design | Plan requires it; dashboard features may need dependency data |
| CountsPanel dead code still on disk | `src/cli/dashboard/components/counts-panel.tsx` | 92% | Cleanup | Plan says replace CountsPanel entirely; file should be deleted |
| Grid mode v toggle not available from orch detail | `src/cli/dashboard/use-keyboard.ts:67` | 85% | Behavioral | v blocked in detail view; breaks plan S5.5 |
| o key infrastructure missing in task detail | `src/cli/dashboard/app.tsx:138-139` | 82% | Feature | Deferred per code comment; no infrastructure hook even for future phases |
| LoopDetail iteration rows not selectable | `src/cli/dashboard/views/loop-detail.tsx` | 80% | Behavioral | selectedIndex=-1, no Enter handler for row navigation |
| ScheduleDetail execution rows not selectable | `src/cli/dashboard/views/schedule-detail.tsx` | 80% | Behavioral | selectedIndex=-1, no Enter handler for row navigation |

---

## ACCEPTED DEVIATIONS

| Item | Rationale |
|------|-----------|
| CreatePipeline response field name (pipelineEntityId vs pipeline_id) | Tentative -- likely intentional camelCase for API consistency; confirm intent |
| MetricsLayout missing browserHeight/activityHeight | Workaround acceptable for Phase A; inline computation (metrics-view.tsx:107) is functional |
| Responsive mode 'standard' (60-119 cols) missing | Reasonable descope; three modes cover essential breakpoints |
| Footer hint text all dimColor (no key highlighting) | Acceptable cosmetic descope if explicitly documented; no functional impact |
| N+1 query in PipelineHandler (per-step findById) | Acceptable at current scale (<50 steps typical); add guard if needed later |
| CancelPipeline in MCP adapter bypassing event bus | Inconsistent but non-fatal; direct update works; should emit event for handler consistency |
| Inline arrow function in MetricsView defeating ActivityPanel memo | Real issue but low severity for terminal renderer; useMemo wrap is straightforward |

---

## WHAT'S WORKING WELL

| Component | Strength |
|-----------|----------|
| **Pipeline Entity** | Domain types, migration v24, repository follow established patterns. Branded IDs, Zod validation, Result types, factory functions all present. |
| **Pipeline Handler** | Correctly routes through event bus, does not access DB directly. Event emission for terminal states works well. |
| **Views Architecture** | Component structure is clean. React.memo + displayName pattern consistent. Props interfaces are readonly. |
| **Keyboard Navigation** | Reducer pattern is solid. 5-panel Tab cycling works correctly. Enter drill-through and Esc return functional. |
| **Layout & Rendering** | Entity browser panels well-designed with proper cursor, selection, filtering. Progress bar Unicode rendering is correct. |
| **Test Coverage** | 530+ tests across 18 files. Pipeline handler, repository, dashboard components all have meaningful coverage. |
| **Visual Design** | Color palette implementation mostly correct. Status icons mostly correct (one Unicode glyph issue). Tile styling mostly complete. |
| **Workspace Fold Rendering** | Structural refactor successful. workspace-view.tsx correctly deleted. Components (TaskPanel, OrchestratorNav, EmptyWorkspace) reused properly. |

---

## PRIORITIZED FIX LIST

Fix in this order for maximum impact and minimum refactoring:

### Phase 1: Pipeline Events & Navigation (Unblocks entire feature)
1. Add 3 event emission calls (PipelineCreated, PipelineStatusChanged, PipelineStepCompleted)
2. Add pipeline cases to activity feed navigation (2 locations: keyboard + callback)
3. Add `cancelTasks` parameter to CancelPipeline schema + cascade implementation

**Estimated effort**: 2-3 hours (straightforward additions following existing patterns)

### Phase 2: Visual Design Compliance (10-minute fixes)
4. Add `borderColor="gray"` to tile borders (3 files, 1-line each)
5. Add `cacheCreationInputTokens` destructure and display (cost-tile.tsx)
6. Fix activity feed column widths (COL_KIND_W, COL_ID_W constants)
7. Refactor activity feed to use Box width instead of padEnd

**Estimated effort**: 1 hour

### Phase 3: Workspace Fold Completion (Enables interactive toggle features)
8. Implement `v` toggle in orchestration detail for list/grid switching
9. Implement `w` shortcut edge cases with orchestration-aware logic
10. Update `streamingEnabled` condition to include grid-mode-detail

**Estimated effort**: 2-3 hours (requires careful state routing)

### Phase 4: Supporting Fixes (Polish & consistency)
11. Add `findActiveByTaskId` to `PipelineRepository` interface (DIP violation)
12. Add `IF NOT EXISTS` to migration v24 indexes
13. Resolve TaskDetail dependency/usage data in dispatcher
14. Add missing agent column to entity browser
15. Add truncation notice to entity browser
16. Add detail row selection/Enter navigation for loops and schedules

**Estimated effort**: 3-4 hours

---

## Quality Assessment

| Dimension | Status | Notes |
|-----------|--------|-------|
| **Correctness** | 90% | Core logic is sound; behavioral gaps are in event emission and UI integration, not domain logic |
| **Consistency** | 85% | Mostly follows project patterns; few deviations (padEnd vs Box, DIP violation on handler) |
| **Completeness** | 70% | Feature is ~70% feature-complete against plan; interactive toggles incomplete; event lifecycle incomplete |
| **Testing** | 85% | Good coverage overall; 3 repository methods untested; 2 keyboard paths untested; weak assertions in 2 files |
| **Architecture** | 85% | Strong foundation; one DIP violation; hybrid event-driven mostly consistent; workspace fold structurally sound but behavioral incomplete |

---

## Summary

This is a **solid, ambitious change** that delivers significant dashboard improvements (entity browser, responsive layout, keyboard navigation, pipeline visibility) but requires finishing work in 4 areas before merge:

1. **Events** (define but never emit pattern)
2. **Navigation** (entries exist but unreachable)
3. **Visual compliance** (4 plan specs incomplete)
4. **Interactive features** (workspace fold incomplete)

All issues are straightforward to fix and follow established patterns. **Estimated total fix time: 8-12 developer hours.** No architectural refactoring needed; all fixes are additive or simple rewires.

**Recommendation**: Request changes, prioritize Phase 1 (events + navigation), then Phase 2 (visual), then Phases 3-4. Once Phase 1 completes, the feature is functionally usable.
