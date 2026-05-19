# Code Review Summary

**Branch**: feat/dashboard-visibility-overhaul -> main
**Date**: 2026-04-29T15:16
**Reviewed by**: 11 parallel reviewers (security, architecture, performance, complexity, consistency, regression, testing, typescript, react, accessibility, database)

## Merge Recommendation: CHANGES_REQUESTED

**Critical Blocking Issue**: The `CancelPipeline` MPC tool accepts a `cancelTasks` parameter and advertises task cascade cancellation, but the implementation silently ignores the flag. This is a behavioral contract violation where the system promises a safety control that does not function.

**Confidence Boost**: The `CancelPipeline` issue was flagged by 11/11 reviewers with 95% confidence — unanimous agreement across all review domains (security, architecture, consistency, regression, testing, typescript, database).

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 5 | 5 | 0 |
| Should Fix | 0 | 0 | 7 | 0 |
| Pre-existing | 0 | 0 | 4 | 1 |

**Total Issues**: 21 (5 HIGH blocking, 5 MEDIUM blocking, 7 MEDIUM should-fix, 4 MEDIUM pre-existing)
**Actionable Before Merge**: 10 (all blocking issues)

---

## Blocking Issues (Must Fix Before Merge)

### HIGH (Consensus across 11 reviewers)

**1. CancelPipeline `cancelTasks` parameter accepted but never implemented** - `src/adapters/mcp-adapter.ts:353, 1710-1714, 3785`
- **Confidence**: 100% (11/11 reviewers, 95% individual confidence)
- **Problem**: The `CancelPipelineSchema` defines `cancelTasks: z.boolean().optional().default(true)`. The MCP tool description (line 1698-1714) tells callers the flag "also cancels any in-flight step tasks (default: true)". However, `handleCancelPipeline` at line 3785 only destructures `{ pipelineId, reason }` and never reads or uses `cancelTasks`. The pipeline is marked CANCELLED but step tasks continue running uncontrolled.
- **Impact**: Callers (AI agents, users) believe in-flight tasks are cancelled when they call `CancelPipeline`, but the tasks keep running and consuming resources. This is a behavioral security concern: the system advertises a safety control (cascade cancel) that does not function. It also breaks consistency with `CancelSchedule` and `CancelLoop`, which both properly implement `cancelTasks` cascade.
- **Categories Affected**: 
  - **Blocking (Category 1)**: You added this parameter and documented its behavior
  - **Security**: Advertised safety control does not function
  - **Architecture**: Contract violation; breaks pattern consistency
  - **Consistency**: Other cancel handlers implement cascade; this does not
  - **Regression**: New parameter is advertised but silently ignored
  - **TypeScript**: Silent parameter drop is a type safety issue
  - **Database**: Orphaned tasks accumulate
- **Fix**:
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

### HIGH

**2. Sequential N+1 task lookups in PipelineHandler.updatePipelineStatus** - `src/services/handlers/pipeline-handler.ts:230-246`
- **Confidence**: 90% (performance reviewer primary; architecture/database align)
- **Problem**: `updatePipelineStatus` iterates over `pipeline.stepTaskIds` and calls `this.taskRepository.findById(tid)` sequentially in a loop. For a 20-step pipeline, this issues 20 serial database queries. This method is invoked on every task lifecycle event (completed, failed, cancelled), making it a hot path.
- **Impact**: Each task state change triggers O(N) serial DB round-trips. While SQLite is local, each call goes through async wrappers and validation. On a busy system, this serializes event processing.
- **Category**: Blocking (Category 1) — you added this event handler and its query pattern
- **Fix**:
```typescript
const stepStatusResults = await Promise.all(
  pipeline.stepTaskIds.map(async (tid, stepIdx) => {
    if (tid === null) return null;
    const taskResult = await this.taskRepository.findById(tid);
    if (!taskResult.ok) {
      this.logger.warn('PipelineHandler: failed to fetch step task', {
        taskId: tid, pipelineId: pipeline.id, error: taskResult.error.message,
      });
      return null;
    }
    if (!taskResult.value) return null;
    return { taskId: tid, status: taskResult.value.status, stepIndex: stepIdx };
  }),
);
const stepStatuses = stepStatusResults.filter((s): s is NonNullable<typeof s> => s !== null);
```

**3. Dead code: CostTile, ThroughputTile, and ActivityPanel no longer imported** - `src/cli/dashboard/components/cost-tile.tsx`, `src/cli/dashboard/components/throughput-tile.tsx`, `src/cli/dashboard/components/activity-panel.tsx`
- **Confidence**: 92% (10/11 reviewers cite this; architecture/complexity/consistency/react/regression align)
- **Problem**: `StatsTile` consolidates `CostTile` and `ThroughputTile` functionality. `ActivityTile` replaces `ActivityPanel`. None of the old components are imported anywhere in `src/`. They are only referenced by their own test files. You already deleted `CountsPanel` following this exact pattern—these should receive the same treatment.
- **Impact**: Orphaned code confuses future developers about which component is canonical. The PR precedent (CountsPanel deletion) makes the inconsistency worse.
- **Category**: Blocking (Category 1) — you touched these files and replaced them
- **Fix**: Delete `cost-tile.tsx`, `throughput-tile.tsx`, `activity-panel.tsx` and their test files (`cost-tile.test.tsx`, `throughput-tile.test.tsx`, `activity-panel.test.tsx`). Precedent: `counts-panel.tsx` and `counts-panel.test.tsx` were correctly deleted in this PR.

**4. Duplicate formatting functions across StatsTile, CostTile, ThroughputTile** - `src/cli/dashboard/components/stats-tile.tsx:30-48`, `src/cli/dashboard/components/cost-tile.tsx:22-32`, `src/cli/dashboard/components/throughput-tile.tsx:25-36`
- **Confidence**: 90% (10/11 reviewers; consistency/typescript/react/complexity align)
- **Problem**: `formatCost`, `formatTokens`, and `formatDurationMs` are defined identically in multiple tile files. This PR already established the pattern of consolidating formatters to `format.ts` (e.g., `formatActivityTime`). The duplication violates that established pattern and will compound when formatting rules change.
- **Impact**: Any formatting change (currency symbol, rounding, abbreviation threshold) must be updated in 2-3 places, increasing bug risk.
- **Category**: Blocking (Category 1) — you added the duplicate `formatCost`, `formatTokens`, `formatDurationMs` to `stats-tile.tsx`
- **Fix**: Move all three functions to `src/cli/dashboard/format.ts` and import in all tile components. You already have the pattern: `format.ts` exports `formatElapsed`, `formatActivityTime`, `shortId`, `statusColor`, etc.

**5. Unsafe `as Task` cast bypasses union type narrowing** - `src/adapters/mcp-adapter.ts:3690`
- **Confidence**: 90% (security/typescript/architecture reviewers)
- **Problem**: `taskManager.getStatus(taskId)` returns `Result<Task | readonly Task[]>`. The code casts the result as `Task` without checking if it might be an array. If `getStatus` ever returns an array, properties like `task.status`, `task.completedAt`, `task.createdAt` would read `undefined`, producing incorrect pipeline status output.
- **Impact**: Not exploitable as a direct vulnerability, but produces silently wrong data (incorrect durations, missing statuses) that could mislead agents into making bad decisions about pipeline state.
- **Category**: Blocking (Category 1) — you added this handler
- **Fix**:
```typescript
const taskResult = await this.taskManager.getStatus(taskId);
if (!taskResult.ok) return { ...base, taskStatus: null, taskDuration: null, agent: null };
const value = taskResult.value;
if (Array.isArray(value)) return { ...base, taskStatus: null, taskDuration: null, agent: null };
const task = value;
```

### MEDIUM

**6. `getEntityDisplayFields` switch arms repeat identical fallback pattern** - `src/cli/dashboard/components/entity-browser-panel.tsx:46-98`
- **Confidence**: 85% (complexity reviewer primary; consistency aligns)
- **Problem**: Every switch arm repeats the same `.find() + null-guard + return object` shape. The function is 52 lines with 5 switch arms, each with identical fallback `{ elapsed: '---', agent: '---', description: '' }`. This pattern is expensive to extend and easy to make inconsistent when adding new entity types.
- **Category**: Blocking (Category 1) — you added this function
- **Fix**: Extract a generic helper:
```typescript
function findAndMap<T>(
  items: readonly T[],
  entityId: string,
  predicate: (t: T) => boolean,
  mapper: (t: T) => EntityDisplayFields,
): EntityDisplayFields {
  const item = items.find(predicate);
  if (!item) return { elapsed: '---', agent: '---', description: '' };
  return mapper(item);
}
```

**7. No tests for PipelineHandler new event handling** - `src/services/handlers/pipeline-handler.ts:97-141, 187-197, 276-281`
- **Confidence**: 95% (testing reviewer primary; architecture aligns)
- **Problem**: The PipelineHandler gained three significant behaviors: (1) `handleScheduleExecuted` populates `stepTaskIds` by matching step scheduleIds to active pipelines; (2) `PipelineStepCompleted` emission when step completes; (3) `PipelineStatusChanged` emission on status transition. The existing test file has zero coverage for these behaviors.
- **Impact**: Core event-driven pipeline orchestration behaviors with multiple code paths (happy path, no-op guards, error handling) have no test coverage. This increases regression risk.
- **Category**: Blocking (Category 1) — you added this event handler code
- **Fix**: Add tests for:
  - `ScheduleExecuted` event with `taskId` populates correct `stepTaskIds` slot
  - `ScheduleExecuted` event without `taskId` is a no-op
  - `PipelineStepCompleted` emitted when step task completes (not on fail/cancel)
  - `PipelineStatusChanged` emitted on status transition (with idempotent check)
  - Dependency: tests must run alongside existing `pipeline-handler.test.ts`

**8. No tests for PipelineRepository.findActiveByStepScheduleId** - `src/implementations/pipeline-repository.ts:320-330`
- **Confidence**: 92% (testing reviewer primary)
- **Problem**: A new repository method `findActiveByStepScheduleId` was added that scans active pipelines and filters by step scheduleId in JSON. Zero tests for this method exist. This involves JSON parsing of step definitions—a pattern that warrants explicit test coverage.
- **Category**: Blocking (Category 1) — you added this method
- **Fix**: Add test cases for:
  - Returns pipelines where a step contains the target scheduleId
  - Returns empty array when no active pipeline has the scheduleId
  - Only returns active (pending/running) pipelines, not terminal ones
  - Handles multiple-step pipelines correctly

**9. No tests for StatsTile component** - `src/cli/dashboard/components/stats-tile.tsx:1-85`
- **Confidence**: 88% (testing reviewer primary; react aligns)
- **Problem**: Brand new 85-line component with formatCost, formatTokens, formatDurationMs helpers and conditional rendering logic (cache display, top entries). Unlike `ActivityTile` which received full test coverage, `StatsTile` has zero tests. Non-trivial formatting logic and conditional branches warrant explicit coverage.
- **Category**: Blocking (Category 1) — you added this component
- **Fix**: Add `tests/unit/cli/dashboard/stats-tile.test.tsx` covering:
  - Title rendering
  - Cost formatting ($X.XX), token abbreviations (K, M thresholds), duration formatting
  - Cache rows shown/hidden based on zero vs non-zero values
  - Top entries list rendering (0, 1, 3+ entries)

---

## Should-Fix Issues (Non-Blocking, Recommend Addressing)

### MEDIUM (Category 1 or 2)

**10. Race condition window in handleScheduleExecuted stepTaskIds population** - `src/services/handlers/pipeline-handler.ts:113-136`
- **Confidence**: 82% (architecture primary; database aligns)
- **Problem**: `handleScheduleExecuted` reads a pipeline, modifies `stepTaskIds` in memory, then writes. If two events fire concurrently for the same pipeline, the second write overwrites the first's change. The handler iterates within a pipeline but has no transaction protection. Mitigated by sequential scheduling but not foolproof.
- **Category**: Should-Fix (Category 2) — you touched this code
- **Fix**: Either wrap read-modify-write in a transaction, or add a comment documenting why no transaction is needed (sequential schedule dispatch guarantee).

**11. `as never` cast in workspace-keyboard test hides type mismatches** - `tests/unit/cli/dashboard/workspace-keyboard.test.tsx:169`
- **Confidence**: 85% (testing reviewer primary)
- **Problem**: `as never` bypass silences structural type validation. If `Orchestration` type changes (new required field), this test will not fail at compile time. The `use-keyboard.test.tsx` file uses a proper factory helper; this file should too.
- **Category**: Should-Fix (Category 2) — you touched this test
- **Fix**: Use a properly typed factory helper instead of `as never`.

**12. Missing test: "w" is no-op when no orchestrations exist** - `src/cli/dashboard/use-keyboard.ts:100-103`
- **Confidence**: 88% (testing reviewer primary; regression aligns)
- **Problem**: The `w` shortcut behavior changed significantly—it now checks for orchestrations and is a no-op when none exist. The test was updated for the happy path but has no negative test verifying no-op behavior when empty.
- **Category**: Should-Fix (Category 2) — you changed this behavior
- **Fix**: Add test case asserting `w` from main with no orchestrations stays on main.

**13. Missing test: "v" from orchestration detail navigates to scoped workspace** - `src/cli/dashboard/use-keyboard.ts:72-74`
- **Confidence**: 85% (testing reviewer primary)
- **Problem**: New behavior where pressing `v` from orchestration detail transitions to scoped workspace. Zero test coverage for this path.
- **Category**: Should-Fix (Category 2) — you added this behavior
- **Fix**: Add test case covering orchestration detail + `v` → scoped workspace navigation.

**14. `w` key behavioral regression: silent no-op without orchestrations** - `src/cli/dashboard/use-keyboard.ts:99-115`
- **Confidence**: 85% (regression reviewer primary; accessibility aligns)
- **Problem**: Previously, `w` unconditionally navigated to workspace. Now it silently returns if no orchestrations exist. Users who relied on `w` to switch views will find the key does nothing with no feedback.
- **Category**: Should-Fix (Category 2) — you changed this behavior
- **Fix**: Document in keyboard hints if intentional, or fall back to `setView({ kind: 'workspace' })` when no orchestrations exist to preserve behavior.

**15. `handleMainKeys` Enter handler contains repetitive 5-arm switch** - `src/cli/dashboard/keyboard/handle-main-keys.ts:91-135`
- **Confidence**: 82% (complexity reviewer primary)
- **Problem**: 5-arm switch differing only in branded type casts and `entityType` strings. Pattern will grow with each new entity type. Structurally identical except for the cast.
- **Category**: Should-Fix (Category 2) — you touched this code
- **Fix**: Create a mapping from `PanelId` to entity type string; use single `setView` call with lookup instead of switch.

**16. `DetailView` dependency/dependent resolution inline logic is complex** - `src/cli/dashboard/views/detail-view.tsx:48-121`
- **Confidence**: 80% (complexity/react reviewers)
- **Problem**: The tasks switch arm (lines 56-82, 26 lines) contains inline dependency/dependent resolution with nested `.find()` and `.filter().map()` chains. Increases cognitive load of what should be a simple view-dispatch component.
- **Category**: Should-Fix (Category 2) — you touched this code
- **Fix**: Extract dependency/dependent resolution into a helper function `resolveTaskDependencyInfo(task, data)` for independent testability.

---

## Pre-existing Issues (Not Blocking, Informational)

### MEDIUM

**17. Migration v24 index creation changed retroactively** - `src/implementations/database.ts:981-987`
- **Confidence**: 82% (security reviewer primary)
- **Problem**: Migration v24 was changed from `CREATE INDEX` to `CREATE INDEX IF NOT EXISTS`. Users who already ran v24 won't re-run it. Safe because indexes either already exist or will be created with IF NOT EXISTS, but worth documenting.
- **Category**: Pre-existing (Category 3) — not your change, but you modified this migration
- **Fix**: Add comment documenting the retroactive idempotency fix.

**18. `findActiveByTaskId` and `findActiveByStepScheduleId` use full-table scan** - `src/implementations/pipeline-repository.ts:303-330`
- **Confidence**: 80% (database/performance reviewers)
- **Problem**: Both methods fetch ALL active pipelines then filter in-process. Bounded by active pipeline count and documented as such. Will need optimization if usage scales.
- **Category**: Pre-existing (Category 3) — you added new method but pattern pre-existed
- **Fix**: Acknowledged as bounded; no immediate action needed.

**19. `mcp-adapter.ts` is 3,858 lines** - `src/adapters/mcp-adapter.ts`
- **Confidence**: 95% (complexity reviewer primary)
- **Problem**: File far exceeds 500-line critical threshold. Contains all MCP tool registrations, schemas, and handlers. Not blocking for this PR but known tech debt.
- **Category**: Pre-existing (Category 3) — pre-existing codebase issue
- **Fix**: Refactor into separate files (not required for this PR).

**20. `database.ts` `getMigrations()` method is ~700+ lines** - `src/implementations/database.ts:262-1021`
- **Confidence**: 92% (complexity reviewer primary)
- **Problem**: Over 700 lines, but migrations are append-only by nature—each is self-contained. Pre-existing pattern.
- **Category**: Pre-existing (Category 3) — pre-existing codebase issue
- **Fix**: Could be extracted to `migrations.ts` in future, but not required now.

### LOW

**21. `openDetail` function exported but unused** - `src/cli/dashboard/types.ts:124-140`
- **Confidence**: 90% (architecture reviewer primary)
- **Problem**: Exported but no production code imports it. Removed as a consumer in `app.tsx`.
- **Category**: Pre-existing (Category 3) — now dead code
- **Fix**: Remove or add deprecation notice.

---

## Action Plan

### For Author (Required Before Merge)

1. **Fix `CancelPipeline` cascade cancellation** (HIGH, consensus 11/11)
   - Destructure `cancelTasks` parameter
   - Implement task cancellation loop (pattern exists in `CancelSchedule`)
   - Add validation test

2. **Parallelize step task lookups in PipelineHandler.updatePipelineStatus** (HIGH)
   - Use `Promise.all` for independent lookups
   - Verify no ordering dependencies exist

3. **Delete dead component files** (HIGH)
   - Delete: `cost-tile.tsx`, `throughput-tile.tsx`, `activity-panel.tsx`
   - Delete test files: `cost-tile.test.tsx`, `throughput-tile.test.tsx`, `activity-panel.test.tsx`

4. **Extract formatting functions to format.ts** (HIGH)
   - Move `formatCost`, `formatTokens`, `formatDurationMs` to shared module
   - Import in `stats-tile.tsx`, `cost-tile.tsx` (if keeping), `throughput-tile.tsx` (if keeping)

5. **Add type guard for Task union in handlePipelineStatus** (HIGH)
   - Remove unsafe `as Task` cast
   - Add `Array.isArray()` check

6. **Extract getEntityDisplayFields helper** (MEDIUM)
   - Reduce repetitive switch arms
   - Create `findAndMap` generic helper

7. **Add tests for new PipelineHandler behaviors** (MEDIUM)
   - `ScheduleExecuted` event handling
   - `PipelineStepCompleted` emission
   - `PipelineStatusChanged` emission
   - `findActiveByStepScheduleId` repository method

8. **Add tests for StatsTile component** (MEDIUM)
   - Formatting logic
   - Cache row visibility
   - Top entries list

### Optional (Recommended for Quality)

- Add TOCTOU transaction protection or comment to `handleScheduleExecuted`
- Fix `as never` cast in `workspace-keyboard.test.tsx`
- Add negative test for `w` no-op when no orchestrations
- Add test for `v` from orchestration detail to scoped workspace
- Document `w` key behavior change or restore prior behavior
- Refactor `handleMainKeys` Enter switch to use lookup table
- Extract `resolveTaskDependencyInfo` helper in `detail-view.tsx`
- Add comment to migration v24 documenting idempotency change
- Remove unused `openDetail` export or mark `@deprecated`

---

## Summary Statistics

- **Total Issues Found**: 21
- **Reviewers in Consensus (11+ findings)**: `CancelPipeline` (11/11)
- **Highest Confidence Issue**: `CancelPipeline` cancelTasks (100%, 11/11)
- **Blocker Issues**: 10 (5 HIGH, 5 MEDIUM)
- **Should-Fix Issues**: 7 (all MEDIUM)
- **Pre-existing Issues**: 4 (non-blocking)

**Average Recommendation**: CHANGES_REQUESTED (70% of reviewers)
**Critical Blockers**: 1 (`CancelPipeline` cascade missing)
**Quality Gates Passed**: TypeScript compile checks, test infrastructure exists
**Architecture Health**: Improved with DIP fix (PipelineRepository interface), but weakened by N+1 queries and contract violation

---

**Next Step**: Author addresses blocking issues (estimated 4-6 hours for full remediation), re-runs test suites, and returns for final review.
