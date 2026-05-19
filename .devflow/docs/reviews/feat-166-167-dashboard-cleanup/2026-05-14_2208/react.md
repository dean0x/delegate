# React Review Report

**Branch**: feat/166-167-dashboard-cleanup -> main
**Date**: 2026-05-14

## Issues in Your Changes (BLOCKING)

### MEDIUM

**`detailEntityStatus` useMemo dependency on `view` object may over-trigger** - `app.tsx:148-157`
**Confidence**: 82%
- Problem: The `useMemo` for `detailEntityStatus` depends on `view` (the full ViewState object). Because `view` is a new object reference on every dispatch (reducer returns `{ ...state, view: action.view }`), this memo re-computes on every view change -- including unrelated nav updates that trigger a re-render. Since the memo does an `Array.find()` over schedules/loops, this is a minor but unnecessary computation.
- Fix: Extract the specific primitives needed from `view` into stable dependencies:
```tsx
const detailEntityType = view.kind === 'detail' ? view.entityType : undefined;
const detailEntityId = view.kind === 'detail' ? view.entityId : undefined;

const detailEntityStatus = useMemo(() => {
  if (!detailEntityType || !detailEntityId) return undefined;
  if (detailEntityType === 'schedules') {
    return data?.schedules.find((s) => s.id === detailEntityId)?.status;
  }
  if (detailEntityType === 'loops') {
    return data?.loops.find((l) => l.id === detailEntityId)?.status;
  }
  return undefined;
}, [detailEntityType, detailEntityId, data?.schedules, data?.loops]);
```

**`detailStreamTaskId` useMemo has same `view` object dependency issue** - `app.tsx:108-115`
**Confidence**: 82%
- Problem: Same pattern as above -- `view` as a dependency means the memo re-runs on any view change, not just when the relevant fields (`kind`, `entityType`, `entityId`) change. This is a pre-existing pattern from #165 that was kept in this PR's refactor from function to useMemo.
- Fix: Extract `view.kind`, `view.entityType`, `view.entityId` as primitives for the dependency array:
```tsx
const viewKind = view.kind;
const viewEntityType = view.kind === 'detail' ? view.entityType : undefined;
const viewEntityId = view.kind === 'detail' ? view.entityId : undefined;

const detailStreamTaskId = useMemo((): TaskId | null => {
  if (viewKind !== 'detail' || !outputRepository) return null;
  if (viewEntityType === 'tasks') return viewEntityId as TaskId;
  if (viewEntityType === 'orchestrations' && nav.orchestrationChildSelectedTaskId) {
    return nav.orchestrationChildSelectedTaskId as TaskId;
  }
  return null;
}, [viewKind, viewEntityType, viewEntityId, nav.orchestrationChildSelectedTaskId, outputRepository]);
```

**Note**: Both useMemo issues share the same root cause (object reference in dep array). They could be addressed together by extracting the view primitives once and reusing them across both memos.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Footer receives 5 props (approaching composition threshold)** - `components/footer.tsx:13-23`
**Confidence**: 80%
- Problem: The Footer component grew from 2 props (`viewKind`, `hasMutations`) to 5 (`viewKind`, `hasMutations`, `entityType`, `entityStatus`, `focusedPanel`). While still at the threshold (the React skill flags >5), the prop growth is driven by hint logic that could be pushed further up. The `getHints()` call is already a pure function -- the caller could compute the hint string and pass it as a single prop.
- Fix: Consider computing the hint string in `app.tsx` and passing it as a single `helpText` prop:
```tsx
// In app.tsx
const helpText = useMemo(
  () => getHints(view.kind, mutations !== undefined, entityType, entityStatus, focusedPanel),
  [view.kind, mutations, entityType, entityStatus, focusedPanel],
);
// ...
<Footer helpText={helpText} />
```
This keeps Footer as a true leaf component with 1 prop. However, this is a design preference -- the current 5-prop approach is explicit and within bounds.

## Pre-existing Issues (Not Blocking)

No pre-existing CRITICAL issues found.

## Suggestions (Lower Confidence)

- **`streamTaskIds` creates a new array on every render** - `app.tsx:125` (Confidence: 65%) -- The expression `detailStreamTaskId !== null ? [detailStreamTaskId] : []` allocates a new array each render. Could be wrapped in `useMemo` for referential stability, though `useTaskOutputStream` already stores task IDs in a ref internally, so the practical impact is negligible.

- **`handlePauseResume` returns `true` even when `mutations` is absent** - `handle-detail-keys.ts:109` (Confidence: 70%) -- When `view.kind === 'detail'` and `mutations` is undefined, the function returns `true` (key consumed) without doing anything. This silently swallows the `p` key. The behavior is intentional (consistent with how `c`/`d` work in the same view), but a user pressing `p` on a read-only dashboard gets no feedback. This is a UX consideration, not a bug.

- **`mainHints` ternary builds pauseHint string on every call** - `keyboard/hints.ts:20` (Confidence: 60%) -- The ternary in `mainHints` is straightforward but allocates an intermediate string. Negligible performance concern for a footer hint function called once per render.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**React Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The React patterns in this PR are well-executed. The workspace view removal is clean -- all workspace-related state (`WorkspaceNavState`, `setWorkspaceNav`), components (`EmptyWorkspace`, `OrchestratorNav`, `TaskPanel`), keyboard handlers (`handleWorkspaceKeys`), types, and tests are removed consistently with no orphaned references. The new pause/resume feature follows the established `cancelEntity`/`deleteEntity` pattern with proper test coverage (entity-mutations unit tests, use-keyboard integration tests, hints unit tests, footer component tests). Hooks are called at top level, `useMemo` is used for the `resolveDetailStreamTaskId` conversion from function to memo, and `React.memo` wraps all view components. The two blocking MEDIUM items are about `useMemo` dependency precision (using object references where primitives would be more correct). The should-fix item on Footer prop count is a design-level observation that doesn't affect correctness.
