# Architecture Review Report

**Branch**: feat-165-168-dashboard-detail-views -> main
**Date**: 2026-05-13
**PR**: #172

## Issues in Your Changes (BLOCKING)

### HIGH

**Duplicated output rendering logic across TaskDetail and OrchestrationDetail** - `src/cli/dashboard/views/task-detail.tsx:199-228`, `src/cli/dashboard/views/orchestration-detail.tsx:489-518`
**Confidence**: 85%
- Problem: The output stream rendering block (empty-state text, `OutputStreamView` wiring, `tooSmall` guard, separator, viewport height computation) is nearly identical between `TaskDetail` and `OrchestrationDetail`. Both components independently implement the same `useRef`/`useState`/`useEffect`/`measureElement` pattern for metadata height measurement (lines 74-85 in task-detail, 400-411 in orchestration-detail). This is tight coupling through duplication -- a change to the output panel layout requires coordinated edits in two files.
- Fix: Extract a shared `DetailOutputPanel` component that encapsulates the `metadataRef` measurement, `computeDetailOutputLayout` call, empty state, `tooSmall` guard, separator, and `OutputStreamView` delegation. Both detail views would compose it:
  ```tsx
  <DetailOutputPanel
    stream={stream}
    terminalRows={terminalRows}
    outputVisible={outputVisible}
    outputAutoTail={outputAutoTail}
    outputScrollOffset={outputScrollOffset}
    taskStatus={task.status}
    taskIdLabel={task.id.slice(0, 12)}
  >
    {/* metadata content as children, measured via ref */}
  </DetailOutputPanel>
  ```
  This also eliminates the duplicated `useEffect` without dependency array (see next finding).

**useEffect without dependency array runs on every render** - `src/cli/dashboard/views/task-detail.tsx:78-85`, `src/cli/dashboard/views/orchestration-detail.tsx:404-411`
**Confidence**: 82%
- Problem: Both components call `useEffect(() => { ... })` with no dependency array. This effect runs after every render, calling `measureElement()` each time. While the `if (height !== metadataHeight)` guard prevents infinite re-render loops, running layout measurement on every render is architecturally wrong for a component inside `React.memo`. The effect should only re-run when the metadata content actually changes (which is driven by props). In Ink's terminal rendering model this is less costly than in a browser DOM, but it sets a bad precedent and violates the project's React rule: "Complete useEffect dependency arrays."
- Fix: This is an Ink-specific trade-off -- `measureElement` needs to run after layout, and Ink does not provide a `useLayoutEffect` equivalent that fires after Yoga layout. The no-dependency-array pattern is an intentional Ink idiom for measuring rendered content. Add an explicit comment documenting this design decision:
  ```typescript
  // DECISION (#165): No dependency array — Ink's measureElement() must run after
  // every Yoga layout pass to get accurate height. The !== guard prevents state loops.
  // This is standard Ink measurement idiom; React.memo on the outer component limits
  // how often this effect actually fires.
  useEffect(() => {
  ```

### MEDIUM

**DetailView prop interface growing toward "god props" pattern** - `src/cli/dashboard/views/detail-view.tsx:49-73`
**Confidence**: 80%
- Problem: `DetailViewProps` now has 12 props, most of which are only relevant to specific entity types (output props for tasks/orchestrations, iteration selection for loops). The component acts as a pass-through dispatcher, threading props that are irrelevant for 3 of the 5 entity types. This is a shallow module -- it exposes more interface surface than it hides complexity. As more detail features are added (e.g., pipeline step output, schedule execution logs), this interface will continue to grow.
- Fix: Consider a discriminated-union approach where each entity type's extra props are grouped:
  ```typescript
  type DetailViewExtra =
    | { readonly entityType: 'tasks'; readonly stream?: OutputStreamState; readonly outputVisible?: boolean; ... }
    | { readonly entityType: 'loops'; readonly selectedIterationNumber?: number | null; }
    | { readonly entityType: 'orchestrations'; readonly taskStreams?: ...; readonly childOutputVisible?: boolean; ... }
    | { readonly entityType: 'schedules' | 'pipelines' }
  ```
  This is not blocking since the current flat interface works correctly, but should be addressed before the next feature adds more entity-specific props.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**NavState accumulates flat fields for entity-specific concerns** - `src/cli/dashboard/types.ts:137-154`
**Confidence**: 80%
- Problem: `NavState` mixes global navigation state (focusedPanel, selectedIndices, filters, scrollOffsets) with entity-specific detail state (orchestrationChildSelectedTaskId, orchestrationChildPage, detailOutputVisible, detailOutputAutoTail, detailOutputScrollOffset, loopIterationSelectedNumber). These entity-specific fields are only meaningful in detail mode, yet they are carried in every NavState snapshot regardless of view mode. This pattern will grow linearly as new detail features are added.
- Fix: Group detail-specific navigation into a sub-object:
  ```typescript
  readonly detailNav: {
    readonly outputVisible: boolean;
    readonly outputAutoTail: boolean;
    readonly outputScrollOffset: number;
    readonly orchestrationChildSelectedTaskId: string | null;
    readonly orchestrationChildPage: number;
    readonly loopIterationSelectedNumber: number | null;
  };
  ```
  This makes it clear which state is detail-specific and simplifies reset logic (reset `detailNav` as a whole when transitioning out of detail mode).

## Pre-existing Issues (Not Blocking)

_No critical pre-existing issues found in reviewed files._

## Suggestions (Lower Confidence)

- **`as TaskId` casts in handle-detail-keys.ts and detail-view.tsx** - `src/cli/dashboard/keyboard/handle-detail-keys.ts:142`, `src/cli/dashboard/views/detail-view.tsx:119` (Confidence: 65%) -- The `as TaskId` casts at these boundaries are justified by the DECISION comment on line 117-118 of detail-view.tsx, but the iteration drill-through in handle-detail-keys.ts line 142 uses `iter.taskId as TaskId` without a similar justification comment. If the domain type for `LoopIteration.taskId` is already `string` rather than `TaskId`, the cast is a boundary concern that should be documented or handled via a type narrowing function.

- **Output scroll offset unbounded upward** - `src/cli/dashboard/keyboard/handle-detail-keys.ts:91-96` (Confidence: 70%) -- The `]` key handler increments `detailOutputScrollOffset` without an upper bound. While `OutputStreamView` likely clamps internally, the nav state can grow to arbitrarily large values. The `[` handler correctly clamps to `Math.max(0, ...)` on the lower bound, but symmetry suggests adding an upper clamp here or in the view.

- **`parseEvalResponseJson` uses `as Record<string, unknown>` cast** - `src/cli/dashboard/views/loop-detail.tsx:181` (Confidence: 62%) -- After the `typeof parsed !== 'object' || parsed === null` guard, the cast to `Record<string, unknown>` is safe at runtime but could use a Zod schema or a type predicate function for consistency with the project's "parse at boundaries" principle.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Architecture Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The PR follows the established dashboard architecture well: pure view components, keyboard handler separation, pure layout functions, and the existing D3 drill-through pattern for loop iteration navigation. The `DetailReturnTarget` discriminated union extension and `resolveIterationIndex` helper correctly mirror the orchestration drill-through precedent. The MCP adapter change (adding `includeEvalResponse` opt-in) follows the existing `includeSystemPrompt` pattern with an appropriate DECISION comment justifying the default-off choice.

The two HIGH issues are related: the duplicated output rendering block across TaskDetail and OrchestrationDetail should be extracted into a shared component, which would also consolidate the `useEffect`-without-deps pattern into a single, well-documented location. The MEDIUM issues around growing prop interfaces and flat NavState are structural concerns that should be addressed before the next detail feature to prevent further accumulation.

Conditions for approval:
1. Add a DECISION comment to both `useEffect` blocks explaining the no-dependency-array choice (Ink measurement idiom). This is the minimal fix; extraction into a shared component is the preferred fix but acceptable as a follow-up.
2. Acknowledge the output rendering duplication for near-term extraction (next PR touching these files).
