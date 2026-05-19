# Visual Design Review Report

**Branch**: feat/dashboard-visibility-overhaul -> main
**Date**: 2026-04-28T18:51

## Issues in Your Changes (BLOCKING)

### HIGH

**Tile borders missing borderColor="gray" per plan S3.3** - `resources-tile.tsx:41,55`, `cost-tile.tsx:38`, `throughput-tile.tsx:40`
**Confidence**: 92%
- Problem: Plan section 3.3 specifies all three tile borders use `borderStyle="round" borderColor="gray"`. The implementation adds `borderStyle="round"` but omits `borderColor="gray"` on all four Box elements across the three tiles. Without the explicit gray, Ink defaults to the terminal foreground color (typically white), making the tiles visually heavier than intended by the neutral/dim layer in the color palette (plan S3.1).
- Fix: Add `borderColor="gray"` to each tile's outermost Box:
  ```tsx
  <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
  ```
  Apply to `resources-tile.tsx` (both null and data branches), `cost-tile.tsx`, and `throughput-tile.tsx`.

**Cost tile missing cacheCreationInputTokens display per plan S3.4** - `cost-tile.tsx:34-45`
**Confidence**: 95%
- Problem: Plan section 3.4 requires "cacheCreationInputTokens displayed alongside cache read". The `TaskUsage` interface includes `cacheCreationInputTokens` (domain.ts:868) but the cost tile destructures only `cacheReadInputTokens` and never references `cacheCreationInputTokens`. Users cannot see how many tokens were spent on cache creation, only cache reads.
- Fix: Destructure and display `cacheCreationInputTokens`:
  ```tsx
  const { totalCostUsd, inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens } = costRollup24h;
  // ...
  {cacheCreationInputTokens > 0 && <Text>Cache create {formatTokens(cacheCreationInputTokens)} tok</Text>}
  {cacheReadInputTokens > 0 && <Text>Cache read {formatTokens(cacheReadInputTokens)} saved</Text>}
  ```

**Activity feed uses padEnd alignment instead of Box width per plan S7** - `activity-panel.tsx:57-64`
**Confidence**: 88%
- Problem: Plan section 7 specifies "Row alignment with `<Box width={N}>` (not padEnd)". The activity panel uses `padEnd(COL_ID_W)` and `padEnd(COL_STATUS_W)` on strings, then concatenates them in a single `<Text>` element. The entity browser panel correctly uses `<Box width={N}>` (entity-browser-panel.tsx:113-134), creating an inconsistency between the two panels and deviating from the plan's explicit requirement.
- Fix: Refactor `renderActivityRow` to use Box-based columns like `EntityRow`:
  ```tsx
  <Box flexDirection="row">
    <Box width={5}><Text>{timeStr}</Text></Box>
    <Box width={7}><Text>{kind}</Text></Box>
    <Box width={13}><Text>{id}</Text></Box>
    <Box width={11}><Text>{status}</Text></Box>
    <Box flexGrow={1}><Text>{action}</Text></Box>
  </Box>
  ```

**Activity feed column widths mismatch plan S7** - `activity-panel.tsx:35-37`
**Confidence**: 90%
- Problem: Plan section 7 specifies columns: `time(5) + kind(7) + shortId(13) + status(11) + action(flex)`. The implementation uses `COL_KIND_W = 5` (plan says 7), `COL_ID_W = 8` (plan says 13). The `kind` column at 5 chars cannot fully display "sched" (5 chars) with trailing space, and `shortId` returns 12 chars by default (format.ts:252) which overflows the 8-char column.
- Fix: Update column widths to match the plan:
  ```ts
  const COL_KIND_W = 7;   // 'task   '|'loop   '|'orch   '|'sched  '|'pipe   '
  const COL_ID_W = 13;    // shortId output (12 chars) + 1 padding
  ```

### MEDIUM

**Status color for 'active' is cyan, plan specifies green (S3.2)** - `format.ts:52-55`
**Confidence**: 82%
- Problem: Plan section 3.2 specifies `active: ● (green)` and section 3.1's semantic layer assigns green to "completed/active". The `statusColor` function groups `active` with `running` and `planning` returning cyan. This means the "active" schedule status (which indicates a schedule is enabled and triggering) renders as cyan instead of green, losing the semantic distinction between "actively running" (cyan) and "enabled/active" (green).
- Fix: Move `active` to the green branch:
  ```ts
  case 'completed':
  case 'triggered':
  case 'active':
    return 'green';
  ```

**MetricsLayout missing browserHeight/activityHeight per plan S4.3** - `layout.ts:15-23`
**Confidence**: 85%
- Problem: Plan section 4.3 specifies `computeMetricsLayout` should include `browserHeight` and `activityHeight` with layout regions: tileRow (~25%), browser (~45%), activity (~30%). The MetricsLayout interface only has `topRowHeight` and `bottomRowHeight`. The entity browser and activity panel share `bottomRowHeight` as a single horizontal row, but there is no explicit height allocation for each. The MetricsView computes `browserViewportHeight` inline (metrics-view.tsx:107) as a workaround.
- Fix: Add explicit height fields to MetricsLayout:
  ```ts
  export interface MetricsLayout {
    // ...existing fields...
    readonly browserHeight: number;
    readonly activityHeight: number;
  }
  ```
  And compute them in `computeMetricsLayout` with the ~45%/~30% split from the plan. This would also let MetricsView drop the inline `Math.max(4, layout.bottomRowHeight - 4)` computation.

**Missing 'standard' responsive mode per plan S4.3** - `layout.ts:77-84`
**Confidence**: 80%
- Problem: Plan section 4.3 specifies four responsive modes: `too-small (<14 rows), narrow (<60 cols), standard (60-119), full (>=120)`. The implementation has only three modes: `too-small`, `narrow`, and `full`. The `standard` mode (60-119 cols) is collapsed into `full`. This means terminals between 60 and 119 columns wide receive the full layout rather than a potentially more compact intermediate layout.
- Fix: Add `'standard'` to the MetricsLayout mode union and implement the breakpoint:
  ```ts
  readonly mode: 'full' | 'standard' | 'narrow' | 'too-small';
  // ...
  if (columns >= 120) mode = 'full';
  else if (columns >= 60) mode = 'standard';
  ```
  Then handle `standard` mode in MetricsView (e.g., reduced tile count or narrower entity browser).

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Queued/pending/expired icons are visually identical (all U+25CB)** - `format.ts:76-83`
**Confidence**: 82%
- Problem: The plan specifies `queued: ◦` and `pending: ◦` (both U+25E6, WHITE BULLET) with `expired: ○` (U+25CB, WHITE CIRCLE). The implementation uses `○` (U+25CB, WHITE CIRCLE) for all three: pending, queued, and expired. While the plan's queued/pending distinction is also weak (same glyph), the implementation loses even the planned queued-vs-expired visual difference. All three statuses are indistinguishable in the icon column.
- Fix: Use the plan's intended glyphs:
  ```ts
  pending: '◦', // U+25E6 WHITE BULLET
  queued: '◦',  // U+25E6 WHITE BULLET
  expired: '○', // U+25CB WHITE CIRCLE (distinct from queued/pending)
  ```

## Pre-existing Issues (Not Blocking)

No pre-existing issues found at CRITICAL severity.

## Suggestions (Lower Confidence)

- **Pipeline detail stage rows use padEnd instead of Box width** - `pipeline-detail.tsx:52-77` (Confidence: 65%) -- Stage rows use manual padding (`.padEnd(12, ' ')`, `.padEnd(13, ' ')`, `.padEnd(8, ' ')`) for column alignment rather than the `<Box width={N}>` pattern used in the entity browser panel. While functional, this creates an inconsistency with the Box-based approach used elsewhere in this branch.

- **ProgressBar gap between bracket and blocks** - `progress-bar.tsx:67-74` (Confidence: 62%) -- The `<Box flexDirection="row" gap={1}>` introduces a 1-character gap between `[`, each step segment, and `]`. For a 5-step pipeline at width=40, each step gets 8 chars but the total rendered width exceeds 40 due to the gaps (5 step segments + 2 brackets + 7 gaps = 9 extra chars). The visual width may exceed the intended constraint.

- **Entity browser panel filters items in render path** - `entity-browser-panel.tsx:174` (Confidence: 60%) -- The `filteredItems` array is computed inline during render with `.filter()`. For large item lists on fast polling intervals, this could cause unnecessary array allocations. Wrapping with `useMemo` keyed on `[items, filterStatus]` would be more consistent with the existing memoization pattern in the branch.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 4 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Visual Design Score**: 6/10
**Recommendation**: CHANGES_REQUESTED

### Compliance Summary vs Plan

| Plan Spec | Status | Notes |
|-----------|--------|-------|
| S3.1 Color palette (neutral/dim layer) | PARTIAL | Tile borders missing gray borderColor |
| S3.1 Color palette (accent layer) | PASS | Focus borders use cyan, active items use blue/inverse |
| S3.1 Color palette (semantic layer) | PARTIAL | `active` mapped to cyan instead of green |
| S3.2 Status icons | MOSTLY PASS | All icons present; queued/pending use wrong Unicode codepoint (U+25CB vs U+25E6) |
| S3.3 Tile borders | PARTIAL | borderStyle="round" present; borderColor="gray" missing on all 3 tiles |
| S3.4 Cost tile cacheCreationInputTokens | FAIL | Not displayed; only cacheReadInputTokens shown |
| S4.3 MetricsLayout browserHeight/activityHeight | FAIL | Not in interface; computed inline as workaround |
| S4.3 Responsive modes (4 modes) | PARTIAL | 3 of 4 modes implemented; 'standard' missing |
| S7 Pipeline entries in activity feed | PASS | kind: 'pipeline' with pipelineAction() |
| S7 Row alignment with Box width | FAIL | Uses padEnd string alignment instead |
| S7 Column widths | FAIL | kind=5 (plan=7), shortId=8 (plan=13) |
| S1.7 PanelId union | PASS | All 5 types present |
| S1.7 Panel order | PASS | Tasks first, Pipelines last |
