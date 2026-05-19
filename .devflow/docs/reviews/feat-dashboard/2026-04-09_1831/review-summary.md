# Code Review Summary

**Branch**: feat-dashboard -> main
**Date**: 2026-04-09_1831
**PR**: #131

## Merge Recommendation: CHANGES_REQUESTED

This PR introduces a well-architected terminal dashboard (Ink/React CLI) with strong separation of concerns, proper error handling, and clean dependencies on core domain types. The feature is production-ready in terms of architecture and security. However, there are **9 blocking issues across 5 reviewers** that must be resolved before merge:

- **3 HIGH issues in your changes** (type safety, test doubles, component patterns)
- **1 HIGH issue in code you touched** (dependency duplication)
- **5 additional HIGH issues** (keyboard complexity, polling guard, React hooks, performance concerns)

These are not showstoppers but represent important quality gates: type safety, test infrastructure consistency, performance under load, and accessibility compliance.

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------|----------|------|--------|-----|-------|
| Blocking | 0 | 9 | 9 | 0 | 18 |
| Should Fix | 0 | 0 | 8 | 0 | 8 |
| Pre-existing | 0 | 0 | 0 | 1 | 1 |

---

## Blocking Issues (Must Fix Before Merge)

### CRITICAL BLOCKERS
None.

### HIGH BLOCKERS (9 issues)

#### 1. Type Assertions Bypass Safety in detail-view.tsx and use-keyboard.ts
**Files**: `src/cli/dashboard/views/detail-view.tsx:60-66`, `src/cli/dashboard/use-keyboard.ts:31-37`
**Confidence**: 82-85%
**Impact**: Type safety violation; undermines project's "no `any` types" standard

The `detail-view.tsx` uses `entity as Loop`, `entity as Task` after a union-type lookup. Similarly, `use-keyboard.ts` downcasts domain types to `{ id: string; status: string }[]`. Both work at runtime but lose compile-time narrowing.

**Fix**: For detail-view, use overloaded helper functions or inline lookups per case to preserve type narrowing. For use-keyboard, define a shared `Identifiable` interface that domain types structurally satisfy, eliminating casts.

---

#### 2. Branded ID Type Assertions in use-dashboard-data.ts
**File**: `src/cli/dashboard/use-dashboard-data.ts:104,109`
**Confidence**: 80%
**Impact**: Branded type safety loss; silent ID type mismatches

Assertions like `entityId as LoopId` discard branded type protection. If a task ID is used to look up a loop, the assertion silently succeeds and the query returns no data rather than failing at compile time.

**Fix**: Thread branded IDs through `ViewState` using a discriminated union:
```typescript
export type ViewState =
  | { readonly kind: 'main' }
  | { readonly kind: 'detail'; readonly entityType: 'loops'; readonly entityId: LoopId }
  | { readonly kind: 'detail'; readonly entityType: 'tasks'; readonly entityId: TaskId }
  | ...
```

---

#### 3. Field Component Pattern Mismatch
**File**: `src/cli/dashboard/components/field.tsx`
**Confidence**: 85%
**Impact**: Inconsistency with 13 other components; maintenance drift

`Field`, `LongField`, and `StatusField` use bare `export function`, while all other dashboard components use `export const Name: React.FC<Props> = React.memo(...)` with `.displayName`. Missing `React.memo` and `displayName`.

**Fix**: Convert all three to match the established pattern:
```typescript
export const Field: React.FC<FieldProps> = React.memo(({ label, children }) => {
  // ...
});
Field.displayName = 'Field';
```

---

#### 4. Test Doubles Missing countByStatus() Method
**Files**: `tests/fixtures/test-doubles.ts:332`, `tests/unit/services/handlers/worker-handler.test.ts:168`
**Confidence**: 85%
**Impact**: Incomplete interface migration; runtime errors in future tests using these doubles

The `TaskRepository` interface gained `countByStatus()` but two test doubles implementing it were not updated. Since tsconfig excludes tests from type-checking, this doesn't error today but will cause `TypeError` at runtime if tests call the method.

**Fix**: Add `countByStatus()` implementation to both test doubles (return aggregated counts from internal collections).

---

#### 5. Polling Interval Fires Without In-Flight Guard
**File**: `src/cli/dashboard/use-dashboard-data.ts:168`
**Confidence**: 90%
**Impact**: Query pile-up under load; stale-looking UI during write-heavy operations

The 1-second polling fires 8 parallel SQLite queries every second with no guard for in-flight fetches. Under load (many running tasks writing to DB), overlapping polls can queue up, increasing latency and causing stale-looking data.

**Fix**: Add a `fetching` ref guard to skip polls if the previous fetch is still in-flight:
```typescript
const fetching = useRef(false);
const doFetch = useCallback(async () => {
  if (fetching.current) return;
  fetching.current = true;
  try { /* fetch */ }
  finally { fetching.current = false; }
}, [...]);
```

---

#### 6. useKeyboard Hook Exceeds Safe Function Length
**File**: `src/cli/dashboard/use-keyboard.ts:64-215`
**Confidence**: 85%
**Impact**: High cyclomatic complexity (~15); difficult to review and maintain

The `useKeyboard` hook's main callback spans ~150 lines with 14 distinct key-handling branches, making it difficult to see at a glance which keys do what.

**Fix**: Extract detail-view and main-view key handlers into separate named functions:
```typescript
function handleDetailKeys(input: string, key: Key, params: KeyHandlerParams): boolean { ... }
function handleMainKeys(input: string, key: Key, params: KeyHandlerParams): boolean { ... }
```

---

#### 7. useCallback Dependency Causes Interval Reset on Navigation
**File**: `src/cli/dashboard/use-dashboard-data.ts:159`
**Confidence**: 88%
**Impact**: Unnecessary interval teardown/recreation; potential fetch race conditions

The `doFetch` callback depends on `viewState`, which gets a new object reference every time the user navigates (main->detail or back). This causes the polling interval to tear down and re-create, and previous fetches may still be in-flight when the new interval starts.

**Fix**: Use a ref to keep `viewState` stable across renders:
```typescript
const viewStateRef = useRef(viewState);
viewStateRef.current = viewState;
const doFetch = useCallback(async () => {
  const result = await fetchAllData(ctx, viewStateRef.current);
  // ...
}, [ctx]); // viewState now stable
```

---

#### 8. ScrollableList Uses Array Index as React Key
**File**: `src/cli/dashboard/components/scrollable-list.tsx:41`
**Confidence**: 85%
**Impact**: React anti-pattern; unnecessarily remounts items when scroll offset changes

Using positional index as key causes React to unmount/remount DOM nodes instead of reusing them when scroll offset changes.

**Fix**: Require a stable identifier from the item or accept a `keyExtractor` prop:
```typescript
<Box key={keyExtractor ? keyExtractor(item, absoluteIndex) : item.id}>
```

---

#### 9. string-width Version Mismatch Causes Duplicate Installs
**File**: `package.json:dependencies`
**Confidence**: 90%
**Impact**: Size bloat (+60K); potential measurement inconsistencies between project code and Ink

Project pins `string-width ^7.2.0` but `ink` (primary consumer) depends on `string-width ^8.1.1`. This results in **two separate versions installed** (7.2.0 at top level, 8.2.0 nested under ink/node_modules/). The dashboard imports v7.2.0 while Ink internally uses v8.2.0, potentially causing string measurement inconsistencies.

**Fix**: Upgrade to `string-width ^8.1.1` to deduplicate and align with Ink's dependency.

---

## Should-Fix Issues (Address While Here)

### MEDIUM ISSUES (8 issues)

#### 1. truncateCell Calls stringWidth Per Character (O(n²))
**File**: `src/cli/dashboard/format.ts:107-116`
**Confidence**: 85%
**Impact**: Performance; re-rendered on every 1s poll

The function calls `stringWidth(char)` for every character. With typical prompts 30-60 chars, this is negligible, but with many rows this adds up per poll.

**Fix**: For ASCII-only strings, use simple slice. For Unicode, accumulate width in a single pass without per-character `stringWidth` calls.

---

#### 2. StatusBadge Animation Creates Independent setInterval Per Badge
**File**: `src/cli/dashboard/components/status-badge.tsx:52-55`
**Confidence**: 80%
**Impact**: CPU usage; 15+ independent 250ms intervals in a typical dashboard

Each animated badge creates its own `setInterval`. With 10 running tasks + 3 loops + 2 schedules = 15 intervals firing 4 times/sec = 60 state updates/sec just for animation.

**Fix**: Lift animation to a single shared interval at the `App` level and pass frame index as a prop.

---

#### 3. Status Conveyed Through Color Alone (WCAG SC 1.4.1)
**Files**: 7 occurrences across status-badge.tsx, loop-detail.tsx, schedule-detail.tsx, header.tsx, panel.tsx, main-view.tsx, task-detail.tsx
**Confidence**: 85%
**Impact**: Accessibility; users with color vision deficiency can't distinguish statuses in some views

Color-only status indication violates WCAG 2.2 AA. The main list views are fine (use `statusIcon()` from format.ts), but iteration/execution rows in detail views use color without an icon prefix.

**Fix**: Add `statusIcon(status)` prefix to iteration and execution row status text, matching the pattern in `StatusBadge`.

---

#### 4. StatusBadge Animation Has No Reduced-Motion Opt-Out
**File**: `src/cli/dashboard/components/status-badge.tsx:48-55`
**Confidence**: 82%
**Impact**: Accessibility; users sensitive to motion cannot disable animation

The 250ms dot cycle animation has no way to disable it. Consider checking an environment variable or providing a `--no-animate` CLI flag.

**Fix**: Add environment variable check (e.g., `AUTOBEAT_REDUCE_MOTION=1`) or increase interval to 1000ms+ for reduced-motion default.

---

#### 5. Filter Cycle Missing Statuses (active, paused)
**File**: `src/cli/dashboard/use-keyboard.ts:15`
**Confidence**: 82%
**Impact**: Feature gap; users cannot filter schedules to active-only or loops to paused-only

The `FILTER_CYCLE` is `[null, 'running', 'completed', 'failed', 'cancelled']` but schedules use `active` (not `running`), loops use `paused`, and the health summary in `header.tsx` counts these. Users can't filter by them.

**Fix**: Extend the cycle to include `active` and `paused`: `[null, 'running', 'active', 'completed', 'failed', 'paused', 'cancelled']`.

---

#### 6. statusColor Exported from Component Instead of format.ts
**Files**: `src/cli/dashboard/components/status-badge.tsx:14` vs `src/cli/dashboard/format.ts:61`
**Confidence**: 80%
**Impact**: Code organization; related functions split across modules

`statusColor` and `statusIcon` are logically paired (both map status->display) but live in different modules. Moving `statusColor` to `format.ts` keeps all status-display mapping in one place.

**Fix**: Move `statusColor` function to `format.ts` and import into `status-badge.tsx`.

---

#### 7. Unvalidated JSON.parse of package.json
**File**: `src/cli/dashboard/index.tsx:40`
**Confidence**: 82%
**Impact**: Security; unhandled exception if file is malformed

`JSON.parse(readFileSync(...))` has no try/catch. If package.json is malformed or missing, this throws an unhandled exception.

**Fix**: Wrap in try/catch with graceful fallback:
```typescript
let version = '0.0.0';
try {
  const pkg = JSON.parse(readFileSync(..., 'utf-8')) as { version?: string };
  version = pkg.version ?? '0.0.0';
} catch {
  // Graceful fallback
}
```

---

#### 8. Error Messages May Leak Internal Paths
**File**: `src/cli/dashboard/components/header.tsx:76`
**Confidence**: 80%
**Impact**: Information disclosure; raw error messages may contain database paths, SQL fragments

The header displays raw error messages from database failures, which could leak internal file paths or SQL details.

**Fix**: Truncate or sanitize error messages before display:
```typescript
const displayError = error.length > 80 ? `${error.slice(0, 77)}...` : error;
```

---

## Testing Gaps (Significant)

### HIGH (3 issues)

#### 1. No Tests for useKeyboard Hook (216 lines, most complex module)
**File**: `src/cli/dashboard/use-keyboard.ts`
**Confidence**: 92%

The most complex behavioral module in the dashboard has zero tests. Missing coverage for Tab/Shift+Tab cycling, arrow key movement, Enter drill-in, Escape return, filter cycling, scroll management, and panel jumping (1-4).

**Fix**: Create `tests/unit/cli/dashboard/use-keyboard.test.tsx` with `ink-testing-library` to simulate key presses and verify navigation behavior.

---

#### 2. No Tests for Header Component
**File**: `src/cli/dashboard/components/header.tsx`
**Confidence**: 85%

The `buildHealthSummary()` function aggregates counts across 4 entity types with status-to-category mappings. Completely untested; bugs would show incorrect health indicators to users.

**Fix**: Test `buildHealthSummary()` directly or via Header integration tests.

---

#### 3. No Tests for ScrollableList Component
**File**: `src/cli/dashboard/components/scrollable-list.tsx`
**Confidence**: 82%

The viewport clipping and scroll indicator logic is untested. Scroll indicators appearing/disappearing at boundaries is a common source of visual bugs.

**Fix**: Test via `ink-testing-library` render to verify item visibility, scroll indicators, and selection state.

---

### MEDIUM (4 issues)

#### 1. formatElapsed Tests Use Date.now() Directly (Flaky)
**File**: `tests/unit/cli/dashboard/detail-view.test.tsx:575-602`
**Confidence**: 82%

Tests compute expected values based on `Date.now()` subtraction. If the test process stalls between subtraction and assertion (GC pause, context switch), the computed elapsed time drifts by 1 second.

**Fix**: Use `vi.useFakeTimers()` and `vi.setSystemTime()` to eliminate timing sensitivity.

---

#### 2. No Tests for TableRow, Field, LongField, StatusField Components
**Confidence**: 80%

These are leaf components used throughout detail views. Simple logic but no test coverage.

**Fix**: Render each component and verify text appears correctly.

---

#### 3. No Integration Tests for countByStatus() Repository Methods
**Files**: All 4 repository implementations
**Confidence**: 83%

The new `countByStatus()` methods execute SQL queries but are only tested via mocks. Actual SQL results are never verified.

**Fix**: Add tests to existing repository test files. Insert entities with different statuses, call `countByStatus()`, verify returned map matches expected counts.

---

#### 4. Duplicated Test Fixture Factories
**Files**: Multiple test files (detail-view.test.tsx, main-view.test.tsx, use-dashboard-data.test.ts)
**Confidence**: 80%

The same fixture factories are defined independently with slightly different defaults. Extracting to a shared file would reduce duplication and prevent drift as domain types evolve.

**Fix**: Create `tests/unit/cli/dashboard/__fixtures__/factories.ts` and import from all test files.

---

## Type Safety Issues (All HIGH)

The TypeScript reviewer identified **10 type assertions** (`as` casts) where type-safe alternatives exist:
- 4 in detail-view.tsx (entity narrowing)
- 2 in use-dashboard-data.ts (branded ID casts)
- 4 in use-keyboard.ts (structural type downcast)

Additionally:
- **Loose `string` typing** for status parameters (should use union of status enums)
- **statusColor default case** silently handles unknown statuses without exhaustive checking
- **RUNNING_FRAMES array index** not bounds-checked (would need `noUncheckedIndexedAccess`)

---

## Accessibility Issues

**3 HIGH issues** (impacts users with disabilities):

1. **Color-only status indication** (7 locations) — WCAG SC 1.4.1 violation
2. **StatusBadge animation** with no reduced-motion opt-out — WCAG SC 2.3.3
3. **Dim text contrast** in footer help bar — Some terminal color schemes

All have clear mitigation paths documented in the accessibility review.

---

## Performance Observations

The architecture is sound: `React.memo` on all components, efficient SQL queries (`countByStatus` uses `GROUP BY`), clear component hierarchy. The two HIGH issues (polling guard, truncateCell complexity) have straightforward fixes. The per-badge animation is a moderate scalability concern.

---

## Quality Strengths

1. **Clean architecture**: Dashboard depends only on core domain types and repositories. Never on implementations, services, or adapters.
2. **ReadOnlyContext segregation**: Correctly uses Interface Segregation Principle, exposing only 4 read-only repositories.
3. **Functional core / imperative shell**: State in App, views are stateless, hooks encapsulate side effects, format utilities are pure.
4. **Repository extensions are uniform**: The 4 new `countByStatus()` methods are structurally identical across all implementations.
5. **Component decomposition**: Deep modules (ScrollableList, Panel, StatusBadge) hide complexity behind simple interfaces.
6. **Dynamic imports**: The dashboard is lazily loaded, so React/Ink overhead doesn't impact non-dashboard commands.

---

## Action Plan

### Before Merge (Critical Path)
1. Fix branded ID typing in `ViewState` (discriminated union)
2. Remove type assertions in detail-view and use-keyboard (use type guards, shared interfaces)
3. Add `countByStatus()` to test doubles
4. Upgrade `string-width` to ^8.1.1
5. Add in-flight fetch guard to polling loop
6. Extract key handlers from `useKeyboard` hook (split HIGH complexity issue)
7. Use ref for `viewState` in `doFetch` callback (prevent interval reset)
8. Fix `ScrollableList` React key from index to stable identifier
9. Convert Field components to React.memo pattern

### Phase 2 (High Priority, Before Release)
1. Add `statusIcon` to iteration/execution rows (accessibility fix)
2. Add reduced-motion opt-out for StatusBadge (accessibility)
3. Extend FILTER_CYCLE to include `active` and `paused`
4. Move `statusColor` to format.ts
5. Add try/catch around JSON.parse of package.json
6. Sanitize error messages before display
7. Write tests for `useKeyboard`, `Header`, `ScrollableList` hooks/components

### Phase 3 (Should-Fix)
1. Fix truncateCell to avoid O(n²) stringWidth calls
2. Lift StatusBadge animation to shared interval
3. Add fakeTimers to formatElapsed tests
4. Implement integration tests for `countByStatus()` repository methods
5. Extract shared test fixture factories

---

## Summary

This is a **well-architected feature** with strong fundamentals (clean layers, proper error handling, good component decomposition). The **9 HIGH blockers** are quality gates that prevent subtle bugs (type safety holes, test infrastructure gaps, performance issues, accessibility violations) rather than showstoppers. Addressing them will result in a robust, maintainable dashboard that aligns with the project's engineering standards.

The **8 MEDIUM issues** are important for robustness and maintainability but not critical blockers. The **significant testing gaps** (216-line keyboard hook with zero tests, 156 tests but missing key components) should be addressed before release.

**Estimated fix effort**: 6-8 hours for HIGH blockers + testing gaps.
