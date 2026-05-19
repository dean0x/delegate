# Consistency Review Report

**Branch**: feat-dashboard -> main
**Date**: 2026-04-09
**PR**: #131

## Issues in Your Changes (BLOCKING)

### HIGH

**Mixed component definition patterns in field.tsx** - `src/cli/dashboard/components/field.tsx`
**Confidence**: 85%
- Problem: `Field`, `LongField`, and `StatusField` use bare `export function` declarations, while every other dashboard component (13 total) uses the `export const Name: React.FC<Props> = React.memo(...)` pattern with a `.displayName` assignment. The three Field components lack both `React.memo` wrapping and `displayName`.
- Fix: Convert to match the established pattern:
```tsx
export const Field: React.FC<FieldProps> = React.memo(({ label, children }) => {
  return (
    <Box flexDirection="row" marginBottom={0}>
      <Text bold color="cyan">
        {label.padEnd(22, ' ')}
      </Text>
      <Text>{children}</Text>
    </Box>
  );
});
Field.displayName = 'Field';
```
Apply the same conversion to `LongField` and `StatusField`.

### MEDIUM

**FILTER_CYCLE missing `paused` status for schedule-specific semantics** - `src/cli/dashboard/use-keyboard.ts:15`
**Confidence**: 82%
- Problem: The global `FILTER_CYCLE` is `[null, 'running', 'completed', 'failed', 'cancelled']`. For schedules, the relevant active status is `active` (not `running`), and `paused`/`expired` are valid statuses. For loops, `paused` is a valid status. The filter cycle does not include `paused` or `active`, so users cannot filter schedules to active-only or loops to paused-only. The health summary in `header.tsx` counts `active` and `paused` states, but the filter never matches them.
- Fix: Either (a) make FILTER_CYCLE per-panel to reflect each entity's actual status values, or (b) extend the shared cycle to include `active` and `paused`:
```ts
const FILTER_CYCLE: readonly (string | null)[] = [null, 'running', 'active', 'completed', 'failed', 'paused', 'cancelled'];
```

**`statusColor` exported from status-badge.tsx but `statusIcon` lives in format.ts** - `src/cli/dashboard/components/status-badge.tsx:14` / `src/cli/dashboard/format.ts:61`
**Confidence**: 80%
- Problem: Two closely related status-mapping functions (`statusColor` and `statusIcon`) live in different modules. `statusIcon` is in the pure `format.ts` utilities file; `statusColor` is in the `status-badge.tsx` component file. Both are pure functions that map a status string to a display value. This splits what is logically a single concern across two locations.
- Fix: Move `statusColor` to `format.ts` alongside `statusIcon`, then import it into `status-badge.tsx`. This keeps all status-display mapping in one module.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`ScheduleExecution` type imported from `interfaces.ts` instead of `domain.ts`** - `src/cli/dashboard/types.ts:7`, `src/cli/dashboard/views/schedule-detail.tsx:4`
**Confidence**: 82%
- Problem: All other domain entity types (`Task`, `Loop`, `Schedule`, `Orchestration`, `LoopIteration`) are imported from `core/domain.ts`. However, `ScheduleExecution` is imported from `core/interfaces.ts`. While this may be where the type is defined, the dashboard imports create an inconsistent import source for closely related types. A reader seeing `ScheduleExecution` come from `interfaces.ts` while everything else comes from `domain.ts` will wonder if it was intentional.
- Fix: If `ScheduleExecution` cannot be re-exported from `domain.ts`, add a comment in `types.ts` explaining why the import source differs:
```ts
// ScheduleExecution is defined in interfaces.ts (not domain.ts) because it is a repository-level type
import type { ScheduleExecution } from '../../core/interfaces.js';
```

## Pre-existing Issues (Not Blocking)

_No pre-existing consistency issues found._

## Suggestions (Lower Confidence)

- **Duplicated `makeTask`/`makeLoop`/`makeSchedule`/`makeOrchestration`/`makeDashboardData` fixtures across test files** - `tests/unit/cli/dashboard/detail-view.test.tsx`, `tests/unit/cli/dashboard/main-view.test.tsx`, `tests/unit/cli/dashboard/use-dashboard-data.test.ts` (Confidence: 70%) -- The same fixture factory functions are defined independently in 3 test files with slightly different defaults. Extracting a shared `tests/unit/cli/dashboard/fixtures.ts` would reduce duplication and ensure test fixtures stay consistent as the domain types evolve.

- **Magic number 22 for label padding** - `src/cli/dashboard/components/field.tsx:19` (Confidence: 65%) -- The pad width 22 is hardcoded in `Field` and `StatusField`. A named constant (e.g., `LABEL_WIDTH = 22`) would make the relationship between the two functions explicit and make future adjustments easier.

- **Hardcoded viewport height of 10** - `src/cli/dashboard/views/main-view.tsx:6`, `src/cli/dashboard/use-keyboard.ts:168` (Confidence: 62%) -- `PANEL_VIEWPORT_HEIGHT = 10` appears in `main-view.tsx` and a matching literal `10` in `use-keyboard.ts:168`. These should reference the same constant to prevent drift if one is changed without the other.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Consistency Score**: 8/10
**Recommendation**: CHANGES_REQUESTED

The dashboard feature introduces a well-structured React/Ink component tree with strong internal consistency across most files (readonly props, React.memo, displayName, architecture comments, pure format utilities, Result-type error handling). The `countByStatus()` additions across all 4 repositories are uniformly implemented. The blocking HIGH issue is the field.tsx component pattern mismatch, and the two MEDIUM issues (filter cycle coverage, split status-mapping location) are worth addressing for maintainability. Overall this is a high-quality, consistent addition.
