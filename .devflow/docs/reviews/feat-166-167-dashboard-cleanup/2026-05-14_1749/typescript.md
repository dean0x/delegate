# TypeScript Review Report

**Branch**: feat/166-167-dashboard-cleanup -> main
**Date**: 2026-05-14

## Issues in Your Changes (BLOCKING)

### MEDIUM

**`handlePauseResume` returns `true` for 'p' even when `mutations` is absent, silently swallowing keys for other handlers** - `src/cli/dashboard/keyboard/handle-detail-keys.ts:109`
**Confidence**: 82%
- Problem: When `input === 'p'` and the view is detail but `mutations` is undefined, the function returns `true` at line 109 (`if (view.kind !== 'detail' || !mutations) return true;`). This means the 'p' key is consumed even without mutations, which prevents downstream handlers (loop navigation, orchestration navigation, generic scroll) from processing it. While this is intentional for non-pauseable entity types (the key is "silently consumed"), it also means that in read-only dashboard mode (no mutations context), pressing 'p' in a loop detail eats the key before `handleLoopNavigation` gets it. This is unlikely to cause user-visible issues since 'p' is not a navigation key, but it is a subtle behavioral change compared to the previous code where 'p' would have fallen through to loop/orchestration navigation and been swallowed by the catch-all `return true` there.
- Fix: No code change needed -- the current behavior is acceptable since 'p' is not used by any downstream handler. This is informational only.

**Inline `.find()` in render path for Footer `entityStatus` prop** - `src/cli/dashboard/app.tsx:204-212`
**Confidence**: 80%
- Problem: The nested ternary expression that computes `entityStatus` for the Footer calls `data?.schedules.find(...)` or `data?.loops.find(...)` inline in the JSX render path. These are O(n) array scans executed on every render of the App component. While the arrays are small (capped at `FETCH_LIMIT`), this pattern bypasses React.memo optimization on the Footer -- the `entityStatus` prop will be a new `undefined`/string reference on every render even when the value hasn't changed, causing the Footer to re-render unnecessarily.
- Fix: Extract the status lookup into a `useMemo` or compute it alongside the existing `detailStreamTaskId` computation:
```typescript
const entityStatus = useMemo(() => {
  if (view.kind !== 'detail') return undefined;
  if (view.entityType === 'schedules') return data?.schedules.find((s) => s.id === view.entityId)?.status;
  if (view.entityType === 'loops') return data?.loops.find((l) => l.id === view.entityId)?.status;
  return undefined;
}, [view, data?.schedules, data?.loops]);
```

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`FooterProps.entityType` and `entityStatus` use `string` instead of narrower union types** - `src/cli/dashboard/components/footer.tsx:17-19`
**Confidence**: 85%
- Problem: The new `entityType` and `entityStatus` props are typed as `string | undefined`. The `detailHints` function in `hints.ts:28-35` compares these against string literals `'schedules'`, `'loops'`, `'active'`, `'running'`, `'paused'`. Using `string` instead of the existing branded/union types (`PanelId` for entityType, `ScheduleStatus | LoopStatus` for entityStatus) loses compile-time safety -- a caller could pass `'shedules'` (typo) and get no type error. The `hints.ts` function signature also uses `string` for these parameters.
- Fix: Narrow the types:
```typescript
// footer.tsx
readonly entityType?: PanelId;
readonly entityStatus?: ScheduleStatus | LoopStatus | string;

// hints.ts
export function detailHints(entityType?: PanelId, entityStatus?: string): string {
```
At minimum, `entityType` should use `PanelId` since it always originates from `view.entityType` which is already a `PanelId`-compatible literal union.

## Suggestions (Lower Confidence)

- **Deeply nested ternary in JSX for `entityStatus`** - `src/cli/dashboard/app.tsx:204-212` (Confidence: 70%) -- The 4-level nested ternary computing `entityStatus` inline in JSX is hard to read. Extracting to a named variable or helper function would improve readability, independent of the performance concern noted above.

- **`EMPTY_STATUS_MAP` always passed to `useTaskOutputStream`** - `src/cli/dashboard/app.tsx:131` (Confidence: 65%) -- After removing workspace view, the second-to-last argument to `useTaskOutputStream` is always `EMPTY_STATUS_MAP`. The parameter could be removed from the hook signature to simplify the API, but this is a separate cleanup concern.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**TypeScript Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The changes are clean from a TypeScript perspective. The workspace view removal is thorough -- all `'workspace'` variants are excised from discriminated unions (`ViewState`, `DetailReturnTarget`, `DashboardAction`), the `WorkspaceNavState` type and its factory function are deleted, and all downstream references are updated consistently. The `exhaustive: never` check in `dashboardReducer` confirms no stale union members remain. The new `pauseOrResumeEntity` function follows the same pattern as `cancelEntity` and `deleteEntity`, using the `EntityKind` discriminated routing with proper branded ID casts at the boundary. The `ViewState` union narrowing for `returnTo` (from `'main' | 'workspace'` to just `'main'`) is correct and simplifies the type.

The two blocking items are MEDIUM severity and relate to render-path efficiency and key consumption semantics rather than correctness bugs. The pre-existing `string` typing on Footer props is worth tightening for type safety but does not block merge.
