# Complexity Review Report

**Branch**: feat/dashboard-visibility-overhaul -> main
**Date**: 2026-04-29

## Issues in Your Changes (BLOCKING)

### HIGH

**`getEntityDisplayFields` switch arms repeat identical fallback pattern (5 occurrences)** -- Confidence: 85%
- `src/cli/dashboard/components/entity-browser-panel.tsx:46-98`
- Problem: Every switch arm in `getEntityDisplayFields` repeats the same `find + null-guard + return { elapsed, agent, description }` shape with identical fallback `{ elapsed: '---', agent: '---', description: '' }`. The function is 52 lines with 5 switch arms, each containing a `.find()` call, a null check, and a return object. This is not deeply nested, but the repetitive structure makes it expensive to add a 6th entity type (every arm must be updated in lockstep) and easy to introduce inconsistency.
- Fix: Extract a generic helper that takes a find predicate and a field-mapper function. The switch would reduce to 5 one-liner calls. Example:
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

### MEDIUM

**`handleMainKeys` Enter handler contains a 5-arm switch for branded type casts (lines 107-133)** -- Confidence: 82%
- `src/cli/dashboard/keyboard/handle-main-keys.ts:91-135`
- Problem: The Enter key handler (lines 91-135, ~44 lines) contains a 5-arm switch statement that differs only in the branded type cast (`as LoopId`, `as TaskId`, etc.) and the `entityType` string. This is a pattern that will grow with each new entity type, and every arm is structurally identical except for the cast.
- Fix: Create a mapping from `PanelId` to entity type string, and use a single `setView` call with an inline cast. The switch becomes a lookup:
  ```typescript
  const PANEL_ENTITY_TYPE: Record<PanelId, string> = {
    loops: 'loops', tasks: 'tasks', schedules: 'schedules',
    orchestrations: 'orchestrations', pipelines: 'pipelines',
  };
  setView({ kind: 'detail', entityType: PANEL_ENTITY_TYPE[panel], entityId: selectedItem.id as never, returnTo: 'main' });
  ```
  Note: The branded type safety is already illusory since the id originates from domain entities matched by panel type, so `as never` (or a per-panel cast map) preserves the same safety.

**`DetailView` switch arms growing in complexity as entity types gain new props** -- Confidence: 80%
- `src/cli/dashboard/views/detail-view.tsx:48-121`
- Problem: The `DetailView` switch has 5 arms spanning 73 lines. The `tasks` arm (lines 56-82, 26 lines) is the most complex, with inline dependency and dependent resolution logic that includes nested `.find()` and `.filter().map()` chains. This inline data transformation increases the cognitive load of what should be a simple view-dispatch component.
- Fix: Extract the dependency/dependent resolution into a helper function (e.g., `resolveTaskDependencyInfo(task, data)`) and call it from the switch arm. This keeps the view dispatch clean and makes the resolution logic independently testable.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`handlePipelineStatus` in mcp-adapter.ts performs serial async task lookups inside `Promise.all`** -- Confidence: 82%
- `src/adapters/mcp-adapter.ts:3653-3722`
- Problem: The function is 70 lines with moderate cyclomatic complexity (5 early returns, nested async map). The `pipeline.steps.map(async ...)` resolves each step sequentially via `this.taskManager.getStatus(taskId)`. While wrapped in `Promise.all`, each individual step lambda is independent -- this is fine for parallelism. However, the function combines argument validation, repository lookup, step-task resolution, and JSON response construction in a single method. This is at the upper boundary of the "one function, one responsibility" principle.
- Fix: Extract the step-resolution logic (`lines 3681-3699`) into a private `resolveStepDetails(pipeline)` helper. This reduces `handlePipelineStatus` to ~30 lines and makes step resolution independently testable.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`mcp-adapter.ts` is 3,858 lines** -- Confidence: 95%
- `src/adapters/mcp-adapter.ts`
- Problem: The file far exceeds the 500-line critical threshold. This is a pre-existing issue predating this PR. The file contains all MCP tool registrations, schemas, and handlers in a single class. While the changes in this PR (handlePipelineStatus, CancelPipeline schema) are individually well-structured, they add to an already over-large file.
- Fix: This is a known tech debt item. Not blocking for this PR.

**`database.ts` `getMigrations()` method is ~700+ lines** -- Confidence: 92%
- `src/implementations/database.ts:262-1021`
- Problem: The `getMigrations()` method returns an array of 24 migration objects, each containing SQL statements. The method is well over 700 lines. However, this is a pre-existing pattern and migrations are append-only by nature -- each migration is self-contained.
- Fix: Not blocking. Could be extracted to a separate `migrations.ts` file in future, but the append-only nature means complexity does not compound.

## Suggestions (Lower Confidence)

- **Repeated default object `{ elapsed: '---', agent: '---', description: '' }` is a magic value** - `src/cli/dashboard/components/entity-browser-panel.tsx:47,52,61,70,79,88` (Confidence: 70%) -- Extract to a named constant `DEFAULT_DISPLAY_FIELDS` to DRY the 6 repetitions and make the default self-documenting.

- **`useKeyboard` hook `v` key handler has 4 nested branches** - `src/cli/dashboard/use-keyboard.ts:71-86` (Confidence: 65%) -- The `v` key handler has an if-chain with 3 view.kind checks plus a fallthrough. This is readable at 15 lines, but could be simplified with a switch on `view.kind`. Borderline concern -- the current early-return style is clear enough.

- **`StatsTile` duplicates `formatCost`/`formatTokens` from `CostTile`** - `src/cli/dashboard/components/stats-tile.tsx:30-38` vs `src/cli/dashboard/components/cost-tile.tsx` (Confidence: 75%) -- Both files define identical `formatCost` and `formatTokens` functions. If `StatsTile` is intended to replace `CostTile`, this duplication is temporary. If both remain, extract to `format.ts`.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 2 | 0 |

**Complexity Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The changes in this PR are a net positive for complexity. The removal of the interactive activity focus mode from `handle-main-keys.ts` eliminated ~80 lines of activity-focused keyboard handling (state machine with esc, up/down, enter, cancel, delete branches), reducing cyclomatic complexity significantly. The `NavState` type is simpler (2 fewer fields). New code (`ActivityTile`, `StatsTile`) is well-factored as small pure components (62 and 85 lines respectively). The `handleMainKeys` function went from ~160 lines to 182 lines but with lower cyclomatic complexity due to removal of the `activityFocused` branching.

The conditions are the HIGH-severity `getEntityDisplayFields` repetition (should extract helper before this pattern spreads further) and the MEDIUM items, which are actionable but non-blocking.
