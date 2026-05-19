# TypeScript Review Report

**Branch**: feat/166-167-dashboard-cleanup -> main
**Date**: 2026-05-14

## Issues in Your Changes (BLOCKING)

No CRITICAL or HIGH issues found.

### MEDIUM

**String literals used instead of enum constants for status comparison** - `src/cli/dashboard/keyboard/hints.ts:36-39`
**Confidence**: 85%
- Problem: `detailHints()` compares `entityStatus` against raw string literals (`'active'`, `'running'`, `'paused'`) while the adjacent `entity-mutations.ts` uses the typed enum constants (`ScheduleStatus.ACTIVE`, `LoopStatus.RUNNING`, `LoopStatus.PAUSED`). If the enum values ever change, this function would silently break. The JSDoc comment acknowledges the strings are lowercase but this is fragile coupling.
- Fix: Import and use the enum constants for consistency with the pattern established in `entity-mutations.ts`:
```typescript
import { LoopStatus, ScheduleStatus } from '../../../core/domain.js';

export function detailHints(entityType?: PanelId, entityStatus?: string): string {
  const base = 'Esc back · ...';
  if (entityType === 'schedules' || entityType === 'loops') {
    if (entityStatus === ScheduleStatus.ACTIVE || entityStatus === LoopStatus.RUNNING) {
      return `${base} · p pause`;
    }
    if (entityStatus === ScheduleStatus.PAUSED || entityStatus === LoopStatus.PAUSED) {
      return `${base} · p resume`;
    }
  }
  return base;
}
```

## Issues in Code You Touched (Should Fix)

No issues found.

## Pre-existing Issues (Not Blocking)

No issues found.

## Suggestions (Lower Confidence)

- **`entityStatus` parameter typed as `string` rather than a union** - `src/cli/dashboard/keyboard/hints.ts:33`, `src/cli/dashboard/keyboard/entity-mutations.ts:96` (Confidence: 65%) -- The `entityStatus` parameter is `string` everywhere in the new pause/resume path. A narrower type like `ScheduleStatus | LoopStatus | string` or even a dedicated union would provide better IDE support and catch misuse, though the current approach is consistent with the existing `cancelEntity` pattern which also uses `string`.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**TypeScript Score**: 9/10
**Recommendation**: APPROVED_WITH_CONDITIONS

## Analysis Notes

### Positive TypeScript Patterns

1. **Discriminated union cleanup**: The `ViewState` union was correctly narrowed by removing `'workspace'` from the `kind` discriminant. All downstream consumers (header, footer, keyboard handlers, reducer) were updated consistently. No orphaned union branches remain.

2. **Exhaustive switch retained**: The `dashboardReducer` keeps the `never` exhaustive check in the default case after removing the `SET_WORKSPACE_NAV` and `UPDATE_WORKSPACE_NAV` action variants. The `getHints` switch over `viewKind` is also exhaustive (2 cases, no default needed since the union is `'main' | 'detail'`).

3. **Branded type discipline maintained**: All entity ID casts (`entityId as ScheduleId`, `entityId as LoopId`) follow the established pattern at trust boundaries (keyboard handler -> service call). No raw string IDs leak into service methods.

4. **Type-safe deletion**: Removed `WorkspaceNavState`, `WorkspaceLayout`, `createInitialWorkspaceNavState`, and all associated infrastructure (files deleted). No dangling imports or phantom type references remain. TypeScript compiles clean.

5. **Readonly props throughout**: All new interfaces (`FooterProps`, `OrchestrationDetailProps` changes) maintain the `readonly` modifier on every field.

6. **`useMemo` for derived state**: The `detailStreamTaskId` and `detailEntityStatus` computations in `app.tsx` are correctly wrapped in `useMemo` with appropriate dependency arrays, following the established pattern.

7. **No `any` types introduced**: All new code uses proper types. The new `pauseOrResumeEntity` function parameters are typed with `EntityKind`, branded ID types via cast, and `DashboardMutationContext`.

### Workspace Removal Completeness

The workspace removal (~2,800 lines) was thorough:
- 4 source files deleted (`workspace-types.ts`, `handle-workspace-keys.ts`, `orchestrator-nav.tsx`, `task-panel.tsx`, `empty-workspace.tsx`)
- 4 test files deleted (`workspace-keyboard.test.tsx`, `workspace-view.test.tsx`, `orchestrator-nav.test.tsx`, `orchestration-workspace.test.ts`)
- All `'workspace'` variants removed from union types (`ViewState`, `DetailReturnTarget`, view kind unions)
- `computeWorkspaceLayout` removed from `layout.ts`; `WorkspaceLayout` interface removed
- `DashboardState.workspaceNav` field removed from reducer
- `fetchWorkspaceExtras` and `workspaceData` removed from data pipeline
- `POLL_INTERVAL_BY_VIEW` record narrowed from 3 to 2 keys
- No residual `workspace` string references in `src/cli/dashboard/`
