# Testing Review Report

**Branch**: feat-dashboard -> main
**Date**: 2026-04-09
**PR**: #131

## Issues in Your Changes (BLOCKING)

### HIGH

**No tests for `useKeyboard` hook** - `src/cli/dashboard/use-keyboard.ts`
**Confidence**: 92%
- Problem: The `useKeyboard` hook (216 lines) contains all keyboard navigation logic -- Tab/Shift+Tab cycling, arrow key movement, Enter to drill in, Escape to go back, filter cycling (f key), scroll management, and panel number jumping (1-4). None of this logic is tested. This is the most complex behavioral module in the dashboard and contains index clamping, viewport scroll calculations, and filter state transitions that are prone to off-by-one errors.
- Fix: Create `tests/unit/cli/dashboard/use-keyboard.test.tsx` using `ink-testing-library`'s `stdin.write()` to simulate key presses against a test harness that renders a minimal component using `useKeyboard`. Test:
  - Tab/Shift+Tab cycles through panels in order and wraps around
  - Arrow keys move selectedIndex and clamp at boundaries
  - Enter drills into detail view with correct entityType/entityId
  - Escape returns from detail to main view
  - `f` cycles through filter states (null -> running -> completed -> failed -> cancelled -> null)
  - Number keys 1-4 jump to corresponding panel
  - `q` calls exit
  - `r` calls refreshNow
  - Scroll offset advances when selection exceeds viewport

**No tests for `Header` component** - `src/cli/dashboard/components/header.tsx`
**Confidence**: 85%
- Problem: The `Header` component contains `buildHealthSummary()`, a non-trivial aggregation function that sums running/queued/failed counts across 4 entity types with specific status-to-category mappings (e.g., schedules use 'active' for running, loops use 'paused' for queued). Bugs in these mappings would show incorrect health indicators to users, and the logic is completely untested.
- Fix: Create tests or export `buildHealthSummary` as a pure function and unit test it directly. Verify:
  - All-zero data returns "idle"
  - Running tasks/loops/schedules/orchestrations counted correctly
  - Error display when `error` prop is non-null (shows "DB error" text)
  - Version display renders correctly

**No tests for `ScrollableList` component** - `src/cli/dashboard/components/scrollable-list.tsx`
**Confidence**: 82%
- Problem: `ScrollableList` implements viewport clipping and scroll indicators ("more" arrows). It slices items based on `scrollOffset` and `viewportHeight`, adjusts the effective viewport height for indicator presence, and computes `isSelected` based on absolute index. This viewport arithmetic is not tested. Scroll indicators appearing/disappearing at boundaries is a common source of visual bugs.
- Fix: Test via `ink-testing-library` render:
  - Items within viewport are visible, items outside are not
  - Scroll-up indicator appears when `scrollOffset > 0`
  - Scroll-down indicator appears when more items exist below viewport
  - Selected item gets `isSelected=true` in renderItem callback

### MEDIUM

**No tests for `TableRow` component** - `src/cli/dashboard/components/table-row.tsx`
**Confidence**: 80%
- Problem: `TableRow` applies `truncateCell` and `.padEnd()` to format cells, and uses `bold`/`inverse` for selection highlighting. The cell formatting and selection indicator are untested. This is a leaf component with simple logic, but it is used in every panel row, so incorrect formatting would be visually widespread.
- Fix: Render a `TableRow` with a few cells and verify:
  - Cell text appears in output
  - Selected row shows selection indicator
  - Non-selected row does not show selection indicator

**No tests for `Field` / `LongField` / `StatusField` components** - `src/cli/dashboard/components/field.tsx`
**Confidence**: 80%
- Problem: Three field layout components used across all detail views are untested. While they are simple, `Field` has a specific label padding width (22 chars) and `LongField` uses wrapped text. Any breaking change to these components would cascade through all detail views silently.
- Fix: Render each component and verify label and value text appear in the output.

**`formatElapsed` tests use `Date.now()` directly -- timing sensitivity risk** - `tests/unit/cli/dashboard/detail-view.test.tsx:575-602`
**Confidence**: 82%
- Problem: The `formatElapsed` tests at lines 575-602 compute expected values based on `Date.now()` subtraction. If the test process stalls between the subtraction and the assertion (e.g., GC pause, context switch), the computed elapsed time could drift by 1 second, causing "45s" to become "46s". This is a known flaky test pattern per the testing skill. The `relativeTime` tests in `format.test.ts` have the same issue but are slightly more resilient because they use the `now` constant captured once at the top.
- Fix: Use `vi.useFakeTimers()` and `vi.setSystemTime()` to freeze `Date.now()` during these tests. This eliminates all timing sensitivity:
  ```typescript
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_700_000_000_000); });
  afterEach(() => { vi.useRealTimers(); });
  ```

**Duplicated fixture factories across test files** - `tests/unit/cli/dashboard/detail-view.test.tsx`, `tests/unit/cli/dashboard/main-view.test.tsx`
**Confidence**: 80%
- Problem: `makeTask()`, `makeLoop()`, `makeSchedule()`, `makeOrchestration()`, and `makeDashboardData()` factory functions are duplicated between `detail-view.test.tsx` and `main-view.test.tsx` (and partially in `use-dashboard-data.test.ts`). The two `makeTask()` implementations diverge in required fields -- the detail-view version includes `model`, `workingDirectory`, `startedAt`, `timeout` while the main-view version does not. This makes it easy for fixtures to drift out of sync with the domain type as the project evolves.
- Fix: Extract shared factories into a `tests/unit/cli/dashboard/__fixtures__/factories.ts` file. Import from both test files. Keep fixture defaults minimal (only required fields), letting each test provide overrides for the fields it cares about.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**No integration test for `countByStatus` repository methods** - `src/implementations/task-repository.ts`, `loop-repository.ts`, `schedule-repository.ts`, `orchestration-repository.ts`
**Confidence**: 83%
- Problem: Four new `countByStatus()` methods were added to repository implementations as part of this PR. These methods execute `SELECT status, COUNT(*) ... GROUP BY status` SQL queries. The only test coverage comes from mocked calls in `use-dashboard-data.test.ts`, which does not verify the actual SQL query returns correct results. Existing repository test files (`tests/unit/implementations/task-repository.test.ts`, etc.) do not have tests for `countByStatus()`.
- Fix: Add tests to each repository's existing test file. Insert a few entities with different statuses, call `countByStatus()`, and verify the returned map matches expected counts.

## Pre-existing Issues (Not Blocking)

_None identified._

## Suggestions (Lower Confidence)

- **`App` component integration test** - `src/cli/dashboard/app.tsx` (Confidence: 70%) -- The root `App` component orchestrates the data hook, keyboard hook, and view routing. A lightweight integration test rendering `App` with a mock `ReadOnlyContext` could verify that the main view appears on mount and that pressing keys triggers expected view transitions. However, this may be impractical due to Ink's lifecycle and interval-based polling.

- **`startDashboard` entry point error paths** - `src/cli/dashboard/index.tsx` (Confidence: 65%) -- The entry point has TTY guard, terminal size guard, and cleanup logic. These are inherently hard to test (process.exit, alternate screen), and testing them may not provide sufficient ROI. Consider documenting these as manual test scenarios instead.

- **`relativeTime` future-time test buffer fragility** - `tests/unit/cli/dashboard/format.test.ts:57` (Confidence: 68%) -- The test adds a `30_000ms` buffer to avoid boundary flakiness, which is a workaround rather than a fix. Using fake timers would be cleaner.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 3 | 4 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Testing Score**: 6/10
**Recommendation**: CHANGES_REQUESTED

### Assessment Rationale

The 156 tests that exist are well-structured: they test behavior not implementation, use `ink-testing-library` correctly, follow AAA pattern, and cover format utilities thoroughly. Test names clearly describe expected behavior. The `use-dashboard-data` tests properly verify Result-type error handling and graceful degradation.

However, coverage has a significant gap: the `useKeyboard` hook -- the most complex behavioral module with 216 lines of navigation, filtering, scrolling, and view-transition logic -- has zero tests. The `Header` health summary aggregation and `ScrollableList` viewport clipping are also untested. These three untested modules represent the primary interaction and data-display paths of the dashboard. The timing-sensitive test pattern using raw `Date.now()` introduces a flaky test risk that should be addressed before merge.
