# Code Review Summary

**Branch**: feat-165-168-dashboard-detail-views -> main
**Date**: 2026-05-13_2319
**PR**: #172 — Dashboard detail view improvements (task output streaming #165, loop eval data #168)

## Merge Recommendation: CHANGES_REQUESTED

**Summary**: The PR introduces well-structured dashboard improvements with solid Ink patterns and comprehensive tests. However, six HIGH-severity issues must be addressed before merge: duplicated output rendering logic, oversized handler functions and prop interfaces, missing MCP test coverage, performance inefficiencies, and unbounded state values.

---

## Issue Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------|----------|------|--------|-----|-------|
| Blocking | 0 | 6 | 2 | 0 | **8** |
| Should Fix | 0 | 0 | 4 | 0 | **4** |
| Pre-existing | 0 | 0 | 0 | 0 | **0** |

---

## Blocking Issues (Must Fix Before Merge)

### HIGH Severity

**1. useEffect without dependency array causes unnecessary measurement on every render (95% confidence)**
- **Files**: `src/cli/dashboard/views/task-detail.tsx:78-85`, `src/cli/dashboard/views/orchestration-detail.tsx:404-411`
- **Impact**: `measureElement()` runs on every render, including animation frame ticks (every 250ms), even when metadata content is unchanged
- **Reviewers**: Architecture, Performance, React, Reliability, TypeScript, UI-Design (6 reviewers)
- **Fix**: Add a dependency array tracking the metadata-affecting props:
```tsx
useEffect(() => {
  if (metadataRef.current) {
    const { height } = measureElement(metadataRef.current);
    if (height !== metadataHeight) {
      setMetadataHeight(height);
    }
  }
}, [task, dependencies, dependents, usage, animFrame]); // for task-detail
   // [orchestration, children, costAggregate, animFrame] for orchestration-detail
```
  OR, if this is intentional Ink measurement pattern (no useLayoutEffect equivalent), add a DECISION comment:
```tsx
// DECISION: No dependency array — Ink lacks useLayoutEffect. measureElement()
// must run after Yoga layout to get accurate height. The !== guard prevents
// infinite re-render loops. This is standard Ink measurement idiom.
useEffect(() => { ... });
```

---

**2. Duplicated output rendering logic across TaskDetail and OrchestrationDetail (95% confidence)**
- **Files**: `src/cli/dashboard/views/task-detail.tsx:199-228`, `src/cli/dashboard/views/orchestration-detail.tsx:489-518`
- **Impact**: Nearly identical output stream rendering (empty-state text, OutputStreamView wiring, separator, metadata measurement) across two files; changes require coordinated edits
- **Reviewers**: Architecture, Complexity, Consistency, React (4 reviewers)
- **Fix**: Extract a reusable `DetailOutputPanel` component or `useElementHeight` hook:
```tsx
// useElementHeight.ts
function useElementHeight(ref: React.RefObject<any>): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (ref.current) {
      const { height: measured } = measureElement(ref.current);
      if (measured !== height) setHeight(measured);
    }
  }, [height]); // or with proper deps as above
  return height;
}

// DetailOutputPanel.tsx
function DetailOutputPanel({
  stream, terminalRows, outputVisible, outputAutoTail,
  outputScrollOffset, taskStatus, taskIdLabel, metadataHeight
}: Props): ReactElement | null {
  const layout = computeDetailOutputLayout(terminalRows, metadataHeight);
  if (layout.tooSmall) return <Text dimColor>(terminal too small for output)</Text>;
  return (
    <>
      <Text>{/* separator */}</Text>
      <OutputStreamView {...} />
    </>
  );
}
```

---

**3. `handleDetailKeys` function exceeds complexity thresholds (95% confidence)**
- **File**: `src/cli/dashboard/keyboard/handle-detail-keys.ts:46-266`
- **Impact**: 220-line function with ~25 cyclomatic complexity (CRITICAL threshold: 20); five behavioral groups mixed
- **Reviewers**: Complexity, Reliability (2 reviewers)
- **Fix**: Extract each numbered section into its own function with a thin dispatcher:
```typescript
function handleEscReturn(view: ViewState, setView: SetViewFn): boolean { ... }
function handleOutputControls(input: string, view: DetailView, setNav: SetNavFn): boolean { ... }
function handleLoopNavigation(input: string, key: string, params: KeyParams): boolean { ... }
function handleOrchestrationNavigation(input: string, key: string, params: KeyParams): boolean { ... }
function handleGenericScroll(input: string, key: string, params: KeyParams): boolean { ... }

export function handleDetailKeys(input: string, key: string, params: KeyParams): boolean {
  const view = params.viewRef.current;
  if (view.kind !== 'detail') return false;
  if (handleEscReturn(view, setView)) return true;
  if (handleOutputControls(input, view, setNav)) return true;
  if (handleLoopNavigation(input, key, params)) return true;
  if (handleOrchestrationNavigation(input, key, params)) return true;
  return handleGenericScroll(input, key, params);
}
```

---

**4. Missing MCP adapter tests for `includeEvalResponse` parameter and new response fields (92% confidence)**
- **File**: `src/adapters/mcp-adapter.ts`
- **Impact**: New user-facing MCP API surface has zero test coverage; callers cannot rely on `includeEvalResponse` gating or eval config fields
- **Reviewers**: Testing (1 reviewer, but foundational gap)
- **Fix**: Add tests mirroring the existing `includeSystemPrompt` pattern (tests/unit/adapters/mcp-adapter.test.ts):
  1. `includeEvalResponse=true` returns `evalResponse` in iteration objects
  2. `includeEvalResponse` omitted (default false) excludes `evalResponse`
  3. Response includes `evalType`, `judgeAgent`, `judgePrompt` fields

---

**5. `new Map()` allocated on every render in app.tsx (95% confidence)**
- **File**: `src/cli/dashboard/app.tsx:165`
- **Impact**: New Map instance created each render in detail mode; causes referential instability in downstream hooks
- **Reviewers**: Performance, React, TypeScript, Reliability (4 reviewers)
- **Fix**: Hoist empty map constant:
```typescript
const EMPTY_STATUS_MAP: ReadonlyMap<TaskId, string> = new Map();

// In component:
const streamTaskStatuses: ReadonlyMap<TaskId, string> =
  view.kind === 'workspace' ? childTaskStatuses : EMPTY_STATUS_MAP;
```

---

**6. `OrchestrationDetailProps` interface has 18 properties (90% confidence)**
- **File**: `src/cli/dashboard/views/orchestration-detail.tsx:46-82`
- **Impact**: Interface exceeds WARNING threshold (5 props); output-related props form cohesive group but are spread flat
- **Reviewers**: Complexity, Architecture (2 reviewers)
- **Fix**: Group output-related props into a single `DetailOutputConfig`:
```typescript
interface DetailOutputConfig {
  readonly visible: boolean;
  readonly autoTail: boolean;
  readonly scrollOffset: number;
  readonly terminalRows: number;
}

// In OrchestrationDetailProps:
readonly childOutputConfig?: DetailOutputConfig;
```
  Apply same pattern to `TaskDetailProps`, `DetailViewProps`, and `app.tsx` prop threading.

---

### MEDIUM Severity

**7. Unbounded output scroll offset (`]` key) with no upper clamp (95% confidence)**
- **Files**: `src/cli/dashboard/keyboard/handle-detail-keys.ts:91-96`, `src/cli/dashboard/views/output-stream-view.tsx`
- **Impact**: `detailOutputScrollOffset` grows unbounded; state diverges from visible position, breaking scroll-up UX after over-scrolling
- **Reviewers**: Reliability, UI-Design, Consistency, Performance (4 reviewers)
- **Fix**: Clamp at input site to match `[` handler's defensive pattern:
```typescript
if (input === ']') {
  setNav((prev) => {
    // Clamp to prevent unbounded growth (view also clamps internally)
    const maxOffset = Math.max(0, (params.dataRef.current?.streamLineCount ?? 0) - 1);
    return {
      ...prev,
      detailOutputScrollOffset: Math.min(prev.detailOutputScrollOffset + 1, maxOffset),
      detailOutputAutoTail: false, // Consistency fix from #8 below
    };
  });
  return true;
}
```

---

**8. Redundant `as TaskId` cast after type guard (90% confidence)**
- **File**: `src/cli/dashboard/keyboard/handle-detail-keys.ts:142`
- **Impact**: `iter.taskId as TaskId` is unnecessary; TypeScript narrows after the guard on line 137
- **Reviewers**: TypeScript (1 reviewer)
- **Fix**: Remove the cast:
```typescript
entityId: iter.taskId, // TypeScript knows this is TaskId after the guard
```

---

## Should-Fix Issues (Recommended for Same PR)

### MEDIUM Severity

**1. Missing tests for `parseEvalResponseJson` (85% confidence)**
- **File**: `src/cli/dashboard/views/loop-detail.tsx:177-195`
- **Impact**: Complex JSON parsing logic with type coercions has zero unit test coverage; untested edge cases
- **Reviewer**: Testing
- **Recommendation**: Export `parseEvalResponseJson` and add unit tests covering: valid JSON, partial fields, score-as-string, invalid JSON, non-object, unexpected types.

**2. `]` scroll-down does not set `detailOutputAutoTail: false` (82% confidence)**
- **File**: `src/cli/dashboard/keyboard/handle-detail-keys.ts:91-96`
- **Impact**: Inconsistency with `[` key; while harmless in typical flow, the asymmetry is a pattern violation
- **Reviewer**: Consistency
- **Fix**: Add `detailOutputAutoTail: false` to the `]` handler (see blocking issue #7 above; both fixes together).

**3. Missing component-level tests for output rendering behavior (80-82% confidence)**
- **Files**: `src/cli/dashboard/views/task-detail.tsx`, `src/cli/dashboard/views/orchestration-detail.tsx`
- **Impact**: Output stream rendering (empty states, visibility toggle, size guard) has no tests
- **Reviewer**: Testing
- **Recommendation**: Add snapshot or behavioral tests covering output visible/hidden states, empty stream placeholders, and "terminal too small" fallback.

**4. `DetailView` bridge component has inconsistent `detailOutputVisible` default (85% confidence)**
- **File**: `src/cli/dashboard/views/detail-view.tsx:93`
- **Impact**: Default `true` contradicts `OrchestrationDetail`'s default `false`; latent inconsistency (mitigated by app.tsx always passing explicit value)
- **Reviewer**: Consistency
- **Recommendation**: Make prop required (remove default) or add a comment documenting that app.tsx always provides it.

---

## Pre-existing Issues (Not Blocking)

_No critical pre-existing issues identified._

---

## Suggestions (Lower Confidence)

| Issue | Confidence | Notes |
|-------|-----------|-------|
| `resolveDetailStreamTaskId` as inner function | 80% | Defined and immediately invoked; can be inlined as ternary expression |
| `parseEvalResponseJson` return type | 62% | Could use named `ParsedEvalResponse` interface |
| `DetailViewProps` growing toward god object | 80% | Consider discriminated union for entity-specific props in next PR |
| `NavState` mixing global and entity-specific state | 80% | Consider grouping detail-specific state into sub-object |
| `scoredIterations` and `convergenceLine` computed without memoization | 80% | Should use `useMemo` for consistency with `renderIterationRow` |
| Convergence trend line width unbounded | 65% | May wrap on narrow terminals (<80 cols) |

---

## Quality Observations

**Strengths:**
- Solid Ink patterns: pure view components, React.memo on all views, keyboard handler separation
- Excellent test coverage for pure functions: `resolveIterationIndex` (5 tests), `renderConvergenceLine` (12 tests), `computeDetailOutputLayout` (7 tests), keyboard handlers (12 tests)
- Correct use of `DetailReturnTarget` discriminated union and `resolveIterationIndex` mirroring orchestration drill-through pattern
- DECISION comments at key deviation points (e.g., `as TaskId` casts with justification)
- MCP adapter change follows existing `includeSystemPrompt` pattern appropriately

**Concerns:**
- Duplication (output rendering, useEffect pattern) increases maintenance burden
- Function and interface complexity grows without refactoring
- 505 new test lines but gaps in MCP API surface and component rendering tests
- Performance inefficiencies (useEffect on every render, new Map allocation, unmemoized computations)

---

## Action Plan

1. **Extract `DetailOutputPanel` or `useElementHeight` hook** — Eliminates output rendering duplication and consolidates measurement pattern
2. **Split `handleDetailKeys` into focused functions** — Reduces complexity from 25 to ~3 per function
3. **Add `DetailOutputConfig` interface** — Reduces prop interface size by grouping related fields
4. **Fix unbounded scroll offset** — Clamp `]` key handler and make `detailOutputAutoTail` symmetric
5. **Add MCP adapter tests** — Cover `includeEvalResponse` parameter and response fields
6. **Add useEffect dependency array** — Track metadata-affecting props or document Ink-specific pattern
7. **Export and test `parseEvalResponseJson`** — Cover JSON parsing edge cases
8. **Remove redundant `as TaskId` cast** — TypeScript narrows after guard

**Estimated Effort**: ~4-6 hours for primary fixes (duplication, complexity, MCP tests); ~2 hours for polish (casts, consistency).

