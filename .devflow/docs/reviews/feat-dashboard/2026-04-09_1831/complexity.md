# Complexity Review Report

**Branch**: feat-dashboard -> main
**Date**: 2026-04-09

## Issues in Your Changes (BLOCKING)

### HIGH

**useKeyboard handler exceeds recommended function length (216 lines, cyclomatic complexity ~15)** - `src/cli/dashboard/use-keyboard.ts:64-215`
**Confidence**: 85%
- Problem: The `useKeyboard` hook contains a single `useInput` callback spanning ~150 lines with 14 distinct key-handling branches. While each branch is individually simple, the aggregate function has high cyclomatic complexity (~15 decision points) and exceeds the 50-line critical threshold. This makes it difficult to see at a glance which keys do what without reading the entire function.
- Fix: Extract main-view and detail-view key handlers into separate named functions, then dispatch in `useInput`:
```typescript
function handleDetailKeys(input: string, key: Key, params: KeyHandlerParams): boolean {
  if (key.escape || key.backspace) { params.setView({ kind: 'main' }); return true; }
  if (key.upArrow || input === 'k') { /* scroll up */ return true; }
  if (key.downArrow || input === 'j') { /* scroll down */ return true; }
  return false;
}

function handleMainKeys(input: string, key: Key, params: KeyHandlerParams): boolean {
  // Tab, Shift+Tab, 1-4, arrows, Enter, f handlers
}

// In useKeyboard:
useInput((input, key) => {
  if (input === 'q') { exit(); return; }
  if (input === 'r') { refreshNow(); return; }
  if (view.kind === 'detail') { handleDetailKeys(input, key, ...); return; }
  handleMainKeys(input, key, ...);
});
```

**MainView has repetitive 4-panel rendering pattern (232 lines)** - `src/cli/dashboard/views/main-view.tsx:139-229`
**Confidence**: 82%
- Problem: The `MainView` component repeats a nearly identical Panel+EmptyState+ScrollableList structure four times (loops, tasks, schedules, orchestrations). Each block follows the same pattern: apply filter, check length, render EmptyState or ScrollableList. This inflates the file to 232 lines and makes it hard to change the panel layout uniformly. Cyclomatic complexity is low per-branch but the file length crosses the warning threshold.
- Fix: Extract a generic `PanelWithList` component that accepts the panel config, then map over panel definitions:
```typescript
interface PanelConfig<T extends { status: string }> {
  id: PanelId;
  title: string;
  items: readonly T[];
  counts: Record<string, number>;
  renderItem: (item: T, index: number, isSelected: boolean) => React.ReactNode;
}

function PanelWithList<T extends { status: string }>({ config, nav }: { config: PanelConfig<T>; nav: NavState }) {
  const filtered = applyFilter(config.items, nav.filters[config.id]);
  return (
    <Panel title={config.title} statusSummary={panelStatusSummary(config.counts)} focused={nav.focusedPanel === config.id} filterStatus={nav.filters[config.id]}>
      {filtered.length === 0
        ? <EmptyState entityName={config.id} filterStatus={nav.filters[config.id]} />
        : <ScrollableList items={filtered} selectedIndex={nav.selectedIndices[config.id]} scrollOffset={nav.scrollOffsets[config.id]} viewportHeight={PANEL_VIEWPORT_HEIGHT} renderItem={config.renderItem} />}
    </Panel>
  );
}
```

### MEDIUM

**fetchAllData has 8-way parallel fetch with sequential error unwrapping (8 branches)** - `src/cli/dashboard/use-dashboard-data.ts:44-96`
**Confidence**: 84%
- Problem: The `fetchAllData` function fires 8 parallel fetches then checks each result individually across 8 sequential if-statements (lines 69-77). While each check is trivial, this is a maintenance risk: adding a new entity type requires adding both a Promise.all entry and a corresponding error check. This is moderately complex (cyclomatic complexity ~10) and the 8 individual error checks are mechanically repetitive.
- Fix: Use a helper that unwraps multiple Results at once:
```typescript
function unwrapAll<T>(results: readonly Result<T, Error>[], labels: readonly string[]): Result<T[], string> {
  const values: T[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r.ok) return err(`${labels[i]} failed: ${r.error.message}`);
    values.push(r.value);
  }
  return ok(values);
}
```

**renderIterationRow contains inline duration calculation with 3 nesting levels** - `src/cli/dashboard/views/loop-detail.tsx:22-67`
**Confidence**: 80%
- Problem: The `renderIterationRow` function (46 lines) mixes data transformation (duration calculation, score formatting, truncation) with JSX rendering. The duration computation on lines 31-35 introduces a 3-level nesting block. While below critical thresholds, the mixing of concerns reduces readability.
- Fix: Extract `formatDuration(startedAt, completedAt)` into `format.ts` alongside existing time formatters, keeping `renderIterationRow` focused on rendering.

## Issues in Code You Touched (Should Fix)

_No issues found in this category._

## Pre-existing Issues (Not Blocking)

_No critical pre-existing issues in the changed files._

## Suggestions (Lower Confidence)

- **Magic number 10 for viewport height** - `src/cli/dashboard/use-keyboard.ts:168` (Confidence: 65%) — The hardcoded `viewportHeight = 10` in the scroll calculation duplicates the `PANEL_VIEWPORT_HEIGHT` constant defined in `main-view.tsx`. These could drift apart.

- **buildHealthSummary mixes status semantics across entity types** - `src/cli/dashboard/components/header.tsx:21-46` (Confidence: 70%) — The function hardcodes which statuses map to "running"/"queued"/"failed" per entity type (e.g., schedules use 'active' for running, 'cancelled' for failed). This implicit mapping could become a maintenance concern as new statuses are added.

- **Type assertions in DetailView and useKeyboard** - `src/cli/dashboard/views/detail-view.tsx:60-66`, `src/cli/dashboard/use-keyboard.ts:31` (Confidence: 62%) — Multiple `as` casts (e.g., `entity as Loop`, `as readonly { id: string; status: string }[]`) bypass type narrowing. These work correctly today but could mask type errors if domain types change.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Complexity Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The dashboard feature is well-decomposed overall: clear separation between data fetching (hooks), state management (App), keyboard routing (useKeyboard), and pure rendering (views/components). Files are small and focused, types are immutable and well-defined, and the component hierarchy is flat. The two HIGH findings (useKeyboard length and MainView repetition) are the primary areas where complexity could be reduced through extraction, but neither blocks merging -- they are refactoring opportunities that would improve long-term maintainability.
