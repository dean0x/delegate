# Regression Review Report

**Branch**: feat-165-168-dashboard-detail-views -> main
**Date**: 2026-05-13
**PR**: #172 — Two dashboard improvements: #165 stream task output in detail views, #168 surface evaluation data in loop detail

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

### MEDIUM

(none)

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Loop detail ↑/↓ behavior change** - `src/cli/dashboard/keyboard/handle-detail-keys.ts:108-154` (Confidence: 65%) — Previously ↑/↓ in loop detail scrolled the content (same as schedules/pipelines). Now ↑/↓ moves iteration selection. This is an intentional feature upgrade (the previous TODO at line 146-152 on main explicitly requested this), and the ScrollableList handles viewport scrolling internally — but users accustomed to the old scroll behavior in loop detail may be surprised. The new behavior is documented in the JSDoc and footer hints.

- **`useEffect` without dependency array** - `src/cli/dashboard/views/task-detail.tsx:78-85`, `src/cli/dashboard/views/orchestration-detail.tsx:404-411` (Confidence: 60%) — Both `useEffect(() => { measureElement(...) })` calls have no dependency array, causing them to run on every render. This is a known Ink pattern for measuring dynamic content and is guarded by `if (height !== metadataHeight)` to prevent infinite loops. Not a regression, but worth noting for future maintainers.

- **`detailOutputVisible` defaults to `false` for orchestration detail** - `src/cli/dashboard/keyboard/handle-main-keys.ts:112` (Confidence: 65%) — When entering orchestration detail from the main panel, `detailOutputVisible` is set to `panel === 'tasks'` which is `false` for orchestrations. The user must press `o` to see child output. This is intentional per the comment on line 111 but is a different default than task detail (which defaults to visible). Could be surprising for users who expect to see output immediately when selecting a child in orchestration detail.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 0 | 0 |

**Regression Score**: 9/10
**Recommendation**: APPROVED

## Regression Analysis Details

### Exports & API Surface

- **No exports removed**: `git diff main...HEAD | grep "^-export"` produced zero results.
- **No files deleted**: `git diff main...HEAD --name-status | grep "^D"` produced zero results.
- **New exports added**: `resolveIterationIndex` (helpers.ts), `renderConvergenceLine` (loop-detail.tsx), `computeDetailOutputLayout` (layout.ts), `DetailOutputLayout` (layout.ts) — all additive, no consumer impact.

### Type & Interface Changes

- **NavState extended** (types.ts): 4 new readonly fields added — `detailOutputVisible`, `detailOutputAutoTail`, `detailOutputScrollOffset`, `loopIterationSelectedNumber`. All optional-compatible with defaults in INITIAL_NAV. No field removed or renamed.
- **DetailReturnTarget union extended** (types.ts): New `{ kind: 'loops', ... }` variant added. Existing `'main' | 'workspace' | { kind: 'orchestrations', ... }` unchanged. Additive change — no consumer breakage.
- **Component props extended**: `TaskDetailProps`, `OrchestrationDetailProps`, `LoopDetailProps`, `DetailViewProps` all received new optional props with defaults. No existing props removed or type-changed.

### MCP API Changes

- **LoopStatus tool schema**: New optional `includeEvalResponse` boolean parameter (defaults to false). Backward-compatible — existing callers without this parameter see no change.
- **LoopStatus response**: 3 new fields added to loop config section (`evalType`, `judgeAgent`, `judgePrompt` — all `?? null`). Iteration history gains optional `evalResponse` field only when `includeEvalResponse=true`. All additive, no field removed.

### Behavioral Changes

- **Loop detail ↑/↓ keys**: Changed from generic scroll to iteration selection. Intentional feature delivery — the TODO on main (line 146-152) explicitly requested this. The iteration table already existed; this wires up navigation.
- **Footer hint text**: Changed from `↑↓ scroll` to `↑↓ select · Enter detail · o output · [/] scroll · G tail`. Tests updated accordingly. The change reflects the new navigation model.
- **Orchestration detail child navigation**: Now also resets `detailOutputAutoTail: true` and `detailOutputScrollOffset: 0` on ↑/↓. This ensures each child starts with fresh output state — intentional UX improvement.

### Migration Completeness

- **All INITIAL_NAV references updated**: Both `src/cli/dashboard/app.tsx` and all test files (`nav-reducer.test.ts`, `use-keyboard.test.tsx`) include the 4 new NavState fields.
- **Keyboard handler ordering preserved**: The 5-step ordering (Esc → output controls → loop → orchestration → generic scroll) correctly gates each handler to its entity type. No key conflicts.
- **Tests comprehensive**: 701 dashboard tests pass. New tests cover: `resolveIterationIndex` (5 tests), `renderConvergenceLine` (12 tests), `computeDetailOutputLayout` (7 tests), keyboard output controls (7 tests), keyboard loop iteration navigation (5 tests), NavState reducer fields (7 tests), footer hint update (1 test).

### Knowledge Context

- **PF-001** (do not defer review issues): No issues deferred — all findings reported above.
- **PF-002** (no migration for zero-user features): Not applicable — all changes are additive with backward-compatible defaults.
