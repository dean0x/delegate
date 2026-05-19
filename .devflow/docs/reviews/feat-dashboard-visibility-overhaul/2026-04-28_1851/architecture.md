# Architecture Review Report

**Branch**: feat/dashboard-visibility-overhaul -> main
**Date**: 2026-04-28T18:51
**Scope**: 59 files, +4942/-653 lines, 13 commits

## Issues in Your Changes (BLOCKING)

### HIGH

**DIP Violation: PipelineHandler depends on concrete SQLitePipelineRepository** - `src/services/handlers/pipeline-handler.ts:19`, `src/services/handler-setup.ts:34,77,206`
**Confidence**: 95%
- Problem: `PipelineHandler` imports and depends on `SQLitePipelineRepository` (concrete class) rather than the `PipelineRepository` interface from `src/core/interfaces.ts`. This violates the Dependency Inversion Principle. The handler-setup module also uses the concrete type when extracting the dependency from the container. The root cause is that `findActiveByTaskId(taskId)` exists only on the concrete class and is missing from the `PipelineRepository` interface.
- Impact: Cannot substitute the repository in tests or swap implementations without changing the handler. All other handlers in the codebase (UsageCaptureHandler, OrchestrationHandler, etc.) depend on interfaces, making this inconsistent.
- Fix: Add `findActiveByTaskId(taskId: TaskId): Promise<Result<readonly Pipeline[]>>` to the `PipelineRepository` interface in `src/core/interfaces.ts`, then change `pipeline-handler.ts` and `handler-setup.ts` to import and reference `PipelineRepository` instead of `SQLitePipelineRepository`.

```typescript
// src/core/interfaces.ts — add to PipelineRepository
findActiveByTaskId(taskId: TaskId): Promise<Result<readonly Pipeline[]>>;

// src/services/handlers/pipeline-handler.ts — change import
import type { PipelineRepository } from '../../core/interfaces.js';
// and change deps/field type to PipelineRepository
```

**Missing 'pipeline' case in handleActivitySelect callback** - `src/cli/dashboard/app.tsx:167-180`
**Confidence**: 95%
- Problem: The `handleActivitySelect` callback in `app.tsx` handles `task`, `loop`, `orchestration`, and `schedule` kinds but is missing the `pipeline` case. Since `ActivityEntry.kind` now includes `'pipeline'` (added in `domain.ts:899`) and the activity feed builder creates pipeline entries (added in `activity-feed.ts:150-158`), selecting a pipeline entry from the activity feed will silently do nothing.
- Impact: Pipeline activity entries appear in the feed but clicking/selecting them produces no navigation. This is a functional gap in the new pipeline visibility feature.
- Fix: Add the `'pipeline'` case to the switch statement:

```typescript
case 'pipeline':
  setView(openDetail('pipelines', entry.entityId as never, 'main'));
  break;
```

**Missing 'pipelines' case in activity feed Enter handler (keyboard)** - `src/cli/dashboard/keyboard/handle-main-keys.ts:109-132`
**Confidence**: 95%
- Problem: The keyboard Enter handler for activity feed entries (lines 109-132) dispatches on `entityType` but only handles `tasks`, `loops`, `orchestrations`, and `schedules`. When `entityType === 'pipelines'` (from `activityKindToEntityType` which correctly maps `'pipeline' -> 'pipelines'`), the switch falls through with no action. This is the keyboard counterpart to the `handleActivitySelect` gap above.
- Impact: Pressing Enter on a pipeline activity entry does nothing despite the entry being visible and selectable.
- Fix: Add the `'pipelines'` case after the `'schedules'` case:

```typescript
case 'pipelines':
  setView({
    kind: 'detail',
    entityType: 'pipelines',
    entityId: entry.entityId as PipelineId,
    returnTo: 'main',
  });
  break;
```

### MEDIUM

**CancelPipeline in MCP adapter bypasses event bus** - `src/adapters/mcp-adapter.ts:3749-3831`
**Confidence**: 85%
- Problem: The `handleCancelPipeline` method in the MCP adapter directly updates the pipeline repository status to `CANCELLED` without emitting a `PipelineCancelled` event. The project follows a hybrid event-driven architecture where state mutations go through the EventBus (documented in CLAUDE.md). The `PipelineCancelled` event type is defined in `events.ts` and the `PipelineHandler.emitPipelineEvent` method emits it for status changes detected from task lifecycle events, but the direct MCP cancel path bypasses this.
- Impact: Any handlers subscribed to `PipelineCancelled` events (or future subscribers) will not be notified when a pipeline is cancelled via the MCP `CancelPipeline` tool. This creates an inconsistency where the same operation has different event semantics depending on the code path.
- Fix: Either emit `PipelineCancelled` via the event bus after the update, or route the cancel through a service method that handles both the update and event emission (consistent with how `cancelSchedule` and `cancelLoop` work).

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Inconsistent defensive access in getPanelItems** - `src/cli/dashboard/keyboard/helpers.ts:34`
**Confidence**: 82%
- Problem: The `pipelines` case uses `data.pipelines ?? []` (defensive fallback) while all other cases (`data.loops`, `data.tasks`, `data.schedules`, `data.orchestrations`) access the property directly without a fallback. Since `DashboardData.pipelines` is typed as `readonly Pipeline[]` (not optional), the `?? []` is unnecessary and creates an inconsistency that suggests `pipelines` might be optional when it is not.
- Fix: Remove the `?? []` fallback to match the other cases:

```typescript
case 'pipelines':
  return toIdentifiables(data.pipelines);
```

## Pre-existing Issues (Not Blocking)

None identified.

## Suggestions (Lower Confidence)

- **Pipeline entity creation not in a transaction with schedule creation** - `src/services/schedule-manager.ts:400-428` (Confidence: 65%) -- The `createPipeline` method creates schedule steps first, then persists the Pipeline entity. If the pipeline save fails, the schedules exist but the pipeline entity does not. The current code logs and continues (non-fatal), which is acceptable for Phase A, but a future phase might want transactional atomicity.

- **Sentinel orchestration object in workspace grid mode** - `src/cli/dashboard/app.tsx:210-225` (Confidence: 65%) -- When no orchestration exists, a hand-built sentinel object is created inline with `as never` casts and hardcoded defaults. This works but is fragile. A factory function or a proper empty-state check at a higher level would be cleaner.

- **ProgressBar uses array index as React key** - `src/cli/dashboard/components/progress-bar.tsx:70` (Confidence: 70%) -- Using `key={idx}` is generally discouraged in React when items could be reordered or change identity. For a fixed-length progress bar this is unlikely to cause issues, but a step-based key (e.g., `key={step.status + idx}`) would be more robust.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 3 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Architecture Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

### Rationale

The overall architecture of this change is strong. The Pipeline entity follows established project conventions well: branded IDs, immutable domain objects with factory functions, Zod boundary validation, Result types for repository operations, event-driven handler with factory pattern, and proper migration. The nav-reducer is a clean Elm-style pattern with exhaustive checking. The component patterns (React.memo, displayName, readonly props, pure functional) are consistent with the rest of the dashboard.

The three HIGH issues should be addressed before merge:

1. **DIP violation** (PipelineHandler on concrete class) is a straightforward fix -- add one method to the interface, change two import lines. This prevents the pattern from being copied by future handlers.

2. **Missing pipeline navigation from activity feed** (two locations: app.tsx callback and keyboard handler) is a functional gap -- pipeline entries appear in the feed but cannot be navigated to. Both are simple one-case additions.

The MEDIUM issue (MCP CancelPipeline bypassing event bus) should be fixed to maintain event-driven consistency but is not blocking since the cancel path works correctly at the data layer.
