# Reliability Review Report

**Branch**: feat-165-168-dashboard-detail-views -> main
**Date**: 2026-05-13

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Unbounded output scroll offset (] key) -- no upper clamp at input site** - `src/cli/dashboard/keyboard/handle-detail-keys.ts:91-96`
**Confidence**: 82%
- Problem: The `]` key handler increments `detailOutputScrollOffset` without any upper bound. While the downstream `OutputStreamView` does clamp via `Math.min(scrollOffset, Math.max(0, totalLines - 1))` at line 65 of `output-stream-view.tsx`, the NavState value itself grows unbounded with repeated key presses. If a user holds `]` on an empty or short stream, the offset can reach arbitrarily large values. This is a bounded-iteration-adjacent issue: the state value has no explicit ceiling.
- Impact: The functional effect is benign because the view clamps, but the state drifts arbitrarily far from the valid range. A later `[` scroll-up would require many presses to return to visible content, degrading UX. No crash risk, but violates the principle of explicit bounds on all state values.
- Fix: Clamp at the input site, mirroring the `[` handler's `Math.max(0, ...)` pattern:
```typescript
if (input === ']') {
  setNav((prev) => {
    // Clamp is also applied downstream in OutputStreamView, but
    // keeping state bounded avoids drift on rapid key repeat.
    const maxOffset = Math.max(0, (params.dataRef.current?./* stream line count */ ?? 0) - 1);
    return {
      ...prev,
      detailOutputScrollOffset: Math.min(prev.detailOutputScrollOffset + 1, maxOffset),
    };
  });
  return true;
}
```
Note: The stream line count is not directly available in the key handler params today. An alternative is to add a hard ceiling (e.g., `Math.min(prev.detailOutputScrollOffset + 1, 10_000)`) as a safety net, since the downstream clamp already handles correctness. Either approach satisfies the reliability principle.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**useEffect without dependency array runs on every render** - `src/cli/dashboard/views/task-detail.tsx:78-85`, `src/cli/dashboard/views/orchestration-detail.tsx:404-411`
**Confidence**: 85%
- Problem: Both `TaskDetail` and `OrchestrationDetail` use `useEffect(() => { ... })` with no dependency array for measuring metadata height via `measureElement()`. This effect fires on every render cycle. Inside, it calls `measureElement()` and conditionally calls `setMetadataHeight()` only when the value changes, which prevents an infinite render loop. However, calling `measureElement()` on every render is unnecessary work when the metadata content has not changed. In Ink's terminal rendering model, renders are frequent (animation ticks every 250ms, data polling, key presses).
- Impact: Minor performance overhead -- `measureElement()` is called on every render even when metadata is static. The conditional `setMetadataHeight` guard prevents cascading re-renders, so there is no runaway loop risk. This is a performance concern within a reliability context: unnecessary work per render tick.
- Fix: Add a dependency array or use a `useLayoutEffect` with appropriate deps. Since the metadata height depends on the data props, a pragmatic approach is to keep the effect but acknowledge this is an intentional Ink pattern for post-render measurement. If this is deliberate (Ink lacks ResizeObserver), add a comment documenting the intent:
```typescript
// Runs on every render intentionally -- Ink has no ResizeObserver equivalent;
// measureElement() is the only way to track layout height changes after
// content reflows. The conditional setMetadataHeight guard prevents loops.
useEffect(() => {
  if (metadataRef.current) {
    const { height } = measureElement(metadataRef.current);
    if (height !== metadataHeight) {
      setMetadataHeight(height);
    }
  }
}); // No deps: intentional, see comment above
```

## Pre-existing Issues (Not Blocking)

No CRITICAL pre-existing issues found in reviewed files.

## Suggestions (Lower Confidence)

- **`renderConvergenceLine` array copy on every call** - `src/cli/dashboard/views/loop-detail.tsx:128` (Confidence: 65%) -- `[...iterations].reverse()` creates a full copy of the iterations array on each render. For loops with many iterations (the function caps at 20 scored items but copies the full array first), this is an allocation in a render path. The outer `useMemo` in the component does not memoize this call. Low impact given the ITERATION_VIEWPORT_HEIGHT=12 cap and the 20-item slice, but worth noting for reliability-conscious allocation discipline.

- **`scoredIterations` filtering duplicated between component and `renderConvergenceLine`** - `src/cli/dashboard/views/loop-detail.tsx:276` (Confidence: 62%) -- The `LoopDetail` component filters `scoredIterations` to determine `showTrend`, then `renderConvergenceLine` performs the same filter internally. This double-pass is redundant work per render. Not a reliability risk, but a minor allocation concern.

- **`new Map()` allocation on every detail render** - `src/cli/dashboard/app.tsx:165` (Confidence: 60%) -- `const streamTaskStatuses: ReadonlyMap<TaskId, string> = view.kind === 'workspace' ? childTaskStatuses : new Map();` allocates a new empty Map on every render when in detail mode. Should be a module-level constant `const EMPTY_MAP = new Map()` to avoid per-render allocation.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Reliability Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The changes are well-structured with proper bounds on all navigation operations (Math.max/Math.min clamping), defensive guards for empty arrays, and graceful degradation for small terminals. The convergence trend function has an explicit 20-item cap. Key reliability strengths: iteration selection uses stable domain keys (iterationNumber) rather than array indices, the `computeDetailOutputLayout` is a pure function with a clear "too small" fallback, and all keyboard handlers return early on empty data. The two conditions are: (1) clamp or cap the `]` scroll offset at the input site to match the `[` handler's defensive pattern, and (2) document the intentional no-deps useEffect for metadata measurement.
