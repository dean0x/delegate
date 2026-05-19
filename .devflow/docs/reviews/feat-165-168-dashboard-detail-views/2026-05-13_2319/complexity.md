# Complexity Review Report

**Branch**: feat-165-168-dashboard-detail-views -> main
**Date**: 2026-05-13
**PR**: #172 — Two dashboard improvements: #165 stream task output in detail views, #168 surface evaluation data in loop detail

## Issues in Your Changes (BLOCKING)

### HIGH

**`handleDetailKeys` function length and cyclomatic complexity** - `src/cli/dashboard/keyboard/handle-detail-keys.ts:46-266`
**Confidence**: 90%
- Problem: The `handleDetailKeys` function spans 220 lines (entire file minus imports and module docblock). With the addition of output controls (section 2), loop iteration navigation (section 3), and the existing orchestration navigation (section 4) and generic scroll (section 5), the cyclomatic complexity is approximately 25 (counting all if/else branches). This exceeds the CRITICAL threshold of 20 for cyclomatic complexity and the HIGH threshold of 50 lines for function length. The numbered section comments help readability, but the function remains a single monolith that handles 5 distinct behavioral groups.
- Fix: Extract each numbered section into its own function, mirroring the existing `handleMainKeys`/`handleDetailKeys` split pattern. For example:
  ```typescript
  function handleEscReturn(view, setView): boolean { ... }
  function handleOutputControls(input, view, setNav): boolean { ... }
  function handleLoopNavigation(input, key, params): boolean { ... }
  // handleDetailKeys becomes a thin dispatcher:
  export function handleDetailKeys(input, key, params): boolean {
    if (view.kind !== 'detail') return false;
    if (handleEscReturn(view, setView)) return true;
    if (handleOutputControls(input, view, setNav)) return true;
    if (handleLoopNavigation(input, key, params)) return true;
    if (handleOrchestrationNavigation(input, key, params)) return true;
    return handleGenericScroll(input, key, params);
  }
  ```

**`OrchestrationDetailProps` interface has 18 properties** - `src/cli/dashboard/views/orchestration-detail.tsx:46-82`
**Confidence**: 85%
- Problem: The `OrchestrationDetailProps` interface now has 18 properties after adding the 4 output-related props (`childOutputVisible`, `childOutputAutoTail`, `childOutputScrollOffset`, `terminalRows`). This significantly exceeds the WARNING threshold of 5 parameters. While some props are optional and the component uses destructuring with defaults, the sheer count makes the component harder to reason about, test, and maintain. The output-related props form a cohesive group that could be a single object.
- Fix: Group the 4 output-related props into a single `OutputConfig` interface:
  ```typescript
  interface DetailOutputConfig {
    readonly visible: boolean;
    readonly autoTail: boolean;
    readonly scrollOffset: number;
    readonly terminalRows: number;
  }
  // Then in props:
  readonly childOutputConfig?: DetailOutputConfig;
  ```
  This pattern would also apply to `TaskDetailProps` (which has the same 4 props as `stream`, `outputVisible`, `outputAutoTail`, `outputScrollOffset`, `terminalRows`) and `DetailViewProps`.

### MEDIUM

**`renderConvergenceLine` duplicated maximize/minimize branches** - `src/cli/dashboard/views/loop-detail.tsx:140-163`
**Confidence**: 85%
- Problem: The maximize and minimize branches in the `for` loop are structurally identical — only the comparison operators are swapped. This is classic boolean complexity where the two code paths share the same structure but differ only in a single comparison direction. The function has a cyclomatic complexity of ~8 which is in the WARNING range, but the duplication makes it feel higher.
- Fix: Normalize the comparison using a helper:
  ```typescript
  const isBetter = direction === 'maximize'
    ? (a: number, b: number) => a > b
    : (a: number, b: number) => a < b;

  for (const iter of scored) {
    const s = iter.score.toFixed(1);
    let arrow: string;
    if (isBetter(iter.score, runningBest)) {
      arrow = '↑';
      runningBest = iter.score;
    } else if (isBetter(runningBest, iter.score)) {
      arrow = '↓';
    } else {
      arrow = '→';
    }
    parts.push(`${s}${arrow}`);
  }
  ```

**`DetailViewProps` interface has 14 properties** - `src/cli/dashboard/views/detail-view.tsx:49-73`
**Confidence**: 82%
- Problem: The `DetailViewProps` interface grew to 14 properties. As a thin dispatch layer, this component passes output-related props through to child components without using them itself. The prop threading makes the dispatch layer harder to maintain as new features add more props.
- Fix: Same `DetailOutputConfig` grouping as suggested for `OrchestrationDetailProps`. The dispatch layer would pass a single `outputConfig` object rather than threading 4-5 individual props.

**Duplicated output rendering pattern in `task-detail.tsx` and `orchestration-detail.tsx`** - `src/cli/dashboard/views/task-detail.tsx:199-228`, `src/cli/dashboard/views/orchestration-detail.tsx:489-518`
**Confidence**: 83%
- Problem: The output stream rendering section (tooSmall guard, separator, empty state with status-dependent message, OutputStreamView) is structurally identical in both `TaskDetail` and `OrchestrationDetail`. Both components also share the identical `useEffect` + `measureElement` + `computeDetailOutputLayout` setup pattern (lines 74-87 in task-detail, lines 400-413 in orchestration-detail). This duplication increases maintenance burden — any change to the output rendering logic must be made in two places.
- Fix: Extract a reusable `DetailOutputSection` component:
  ```typescript
  function DetailOutputSection({
    stream, layout, scrollOffset, autoTail, label, status
  }: DetailOutputSectionProps): React.ReactElement | null {
    if (layout.tooSmall) return <Text dimColor>(terminal too small for output)</Text>;
    // ... shared rendering logic
  }
  ```
  The `useEffect`/`measureElement` pattern could be extracted into a custom hook: `useMetadataHeight(ref)`.

**Duplicated `useEffect` metadata measurement pattern** - `src/cli/dashboard/views/task-detail.tsx:78-85`, `src/cli/dashboard/views/orchestration-detail.tsx:404-411`
**Confidence**: 82%
- Problem: Identical `useEffect` without a dependency array (runs on every render) that calls `measureElement` and conditionally calls `setMetadataHeight`. This pattern is copy-pasted between the two detail components. The missing dependency array means this effect runs on every render, which is intentional (measurement must track dynamic content height), but the duplication makes it easy for the two implementations to diverge.
- Fix: Extract to a custom hook:
  ```typescript
  function useElementHeight(ref: React.RefObject<DOMElement>): number {
    const [height, setHeight] = useState(0);
    useEffect(() => {
      if (ref.current) {
        const measured = measureElement(ref.current).height;
        if (measured !== height) setHeight(measured);
      }
    });
    return height;
  }
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`OrchestrationDetail` component body spans 170 lines (352-521)** - `src/cli/dashboard/views/orchestration-detail.tsx:352-522`
**Confidence**: 80%
- Problem: The `OrchestrationDetail` component render function body spans approximately 170 lines. While the added output section only accounts for ~30 lines, the overall function length is in the HIGH range (50-200 lines). The grid mode early return (lines 372-388) adds 16 lines of guard conditions. Combined with metadata fields, children section, pagination, and now the output stream section, the function has grown beyond the "explainable in 5 minutes" threshold.
- Fix: The output stream section (lines 489-518) could be extracted to a `DetailOutputSection` component as mentioned above. This would bring the component body closer to 140 lines — still long but more manageable.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`orchestration-detail.tsx` file length: 524 lines** - `src/cli/dashboard/views/orchestration-detail.tsx`
**Confidence**: 80%
- Problem: The file exceeds the CRITICAL threshold of 500 lines. It contains grid mode helpers (88-259), list mode helpers (261-350), and the main component (352-522). The grid mode section alone is 170+ lines and was folded in from a separate file in a prior phase. This PR added ~30 net lines, pushing it over the threshold.
- Fix: Consider extracting grid mode helpers (`renderGrid`, `GridMode`, `getPanelAutoTail`, `getPanelScrollOffset`) into a separate `orchestration-grid-mode.tsx` file. This would bring the main file back under 350 lines and improve navigability.

## Suggestions (Lower Confidence)

- **`streamingEnabled` boolean expression in app.tsx** - `src/cli/dashboard/app.tsx:153-159` (Confidence: 70%) — The 6-line boolean expression with 4 nested conditions is dense but readable thanks to the well-named `detailStreamTaskId` extracted variable. Consider extracting to a named function `isStreamingEnabled()` for self-documentation if more conditions are added.

- **Magic number 512 in evalResponse truncation** - `src/cli/dashboard/views/loop-detail.tsx:234` (Confidence: 65%) — The raw evalResponse is capped at 512 characters via `.slice(0, 512)`. A named constant (e.g., `MAX_RAW_EVAL_DISPLAY_LENGTH`) would improve readability, though the inline comment "cap at 512 chars" partially mitigates this.

- **`app.tsx` prop threading depth** - `src/cli/dashboard/app.tsx:252-257` (Confidence: 62%) — Six new props are threaded from `app.tsx` through `DetailView` to `TaskDetail`/`OrchestrationDetail`. This is standard React prop drilling but increases coupling between the component tree layers. A context provider could reduce this, though for 6 props the current approach is pragmatic.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 3 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Complexity Score**: 6/10
**Recommendation**: CHANGES_REQUESTED

The PR introduces well-structured dashboard features with good patterns (pure functions for testability, DECISION comments, consistent prop naming). The primary concerns are the `handleDetailKeys` function exceeding cyclomatic complexity thresholds (HIGH) and the accumulation of props across detail view components (HIGH). The duplicated output rendering pattern across task-detail and orchestration-detail (MEDIUM) presents a near-term maintenance risk. All issues are addressable through extraction and grouping without architectural changes.
