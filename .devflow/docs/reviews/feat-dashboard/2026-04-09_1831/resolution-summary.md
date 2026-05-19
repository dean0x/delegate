# Resolution Summary

**Branch**: feat/dashboard -> main
**Date**: 2026-04-09
**Review**: .docs/reviews/feat-dashboard/2026-04-09_1831
**Command**: /resolve

## Statistics
| Metric | Value |
|--------|-------|
| Total Issues | 32 |
| Fixed | 32 |
| False Positive | 0 |
| Deferred | 0 |
| Blocked | 0 |

## Fixed Issues

### Batch 1: types.ts + use-dashboard-data.ts (Type Safety, Performance, React Hooks)
| Issue | File:Line | Commit |
|-------|-----------|--------|
| ViewState discriminated union with branded IDs | types.ts | ac72bd2 |
| Remove `entityId as LoopId/ScheduleId` casts | use-dashboard-data.ts:104 | ac72bd2 |
| In-flight fetch guard (fetching ref) | use-dashboard-data.ts:168 | 3dd2498 |
| Stabilise viewState ref for polling interval | use-dashboard-data.ts:159 | 3dd2498 |
| Extract unwrapOrErr helper for Result unwrapping | use-dashboard-data.ts:44 | a0c0384 |

### Batch 2: use-keyboard.ts (Complexity, Type Safety, Consistency)
| Issue | File:Line | Commit |
|-------|-----------|--------|
| Extend FILTER_CYCLE with active/queued/planning/paused | use-keyboard.ts:15 | dd8719a |
| Identifiable interface (eliminate 4 `as` casts) | use-keyboard.ts:31 | 4903951 |
| Use dataRef to avoid stale closure in setNav | use-keyboard.ts:45 | 752b115 |
| Extract handleDetailKeys/handleMainKeys functions | use-keyboard.ts:64 | 0f8c269 |
| Clamp detail view scroll to content length | use-keyboard.ts:97 | fe04faa |

### Batch 3: format.ts + status-badge.tsx (Performance, Accessibility, Organization)
| Issue | File:Line | Commit |
|-------|-----------|--------|
| Move statusColor to format.ts alongside statusIcon | status-badge.tsx:14 | 040e3ef |
| ASCII fast-path for truncateCell (O(n) fix) | format.ts:107 | 09967a4 |
| Reduced-motion opt-out (AUTOBEAT_REDUCE_MOTION) | status-badge.tsx:48 | f75ba50 |
| Shared animFrame prop (single interval in App) | status-badge.tsx:52 | f75ba50 |
| RUNNING_FRAMES bounds check with nullish coalescing | status-badge.tsx:58 | f75ba50 |

### Batch 4: Components (Consistency, React Patterns, Security)
| Issue | File:Line | Commit |
|-------|-----------|--------|
| Field/LongField/StatusField → React.memo + displayName | field.tsx | 9717b87 |
| Truncate DB error messages in header (80 char limit) | header.tsx:76 | 7791d3b |
| Guard package.json read with try/catch | index.tsx:40 | 1b026a0 |
| ScrollableList keyExtractor prop | scrollable-list.tsx:41 | 542477b |
| Remove redundant inner key props (4 callers) | main-view.tsx:46+ | 542477b |

### Batch 5: Test Doubles + Dependencies
| Issue | File:Line | Commit |
|-------|-----------|--------|
| Add countByStatus() to TestTaskRepository | test-doubles.ts:332 | e52c4d4 |
| Add countByStatus() to MockTaskRepo | worker-handler.test.ts:168 | e52c4d4 |
| Upgrade string-width ^7.2.0 → ^8.2.0 | package.json | cd34413 |

### Batch 6: Detail Views (Type Safety, Accessibility)
| Issue | File:Line | Commit |
|-------|-----------|--------|
| Extract formatDuration utility to format.ts | loop-detail.tsx:22 | 17f8a06 |
| Add statusIcon to loop iteration rows (WCAG 1.4.1) | loop-detail.tsx:46 | 6c78c75 |
| Add statusIcon to schedule execution rows (WCAG 1.4.1) | schedule-detail.tsx:30 | a8e4390 |
| Inline entity lookups (remove 4 `as` casts) | detail-view.tsx:60 | f6566ae |

### Batch 7: Missing Tests
| Issue | File:Line | Commit |
|-------|-----------|--------|
| Freeze time in formatElapsed tests (fake timers) | detail-view.test.tsx:575 | 3440dea |
| Header component + buildHealthSummary tests (20 tests) | header.test.tsx (NEW) | be1c2de |
| ScrollableList component tests (14 tests) | scrollable-list.test.tsx (NEW) | 301a500 |
| useKeyboard hook behavior tests (26 tests) | use-keyboard.test.tsx (NEW) | cee70ea |
| countByStatus SQL integration tests (4 tests) | task-repository.test.ts | ad56b5c |

## False Positives
_None_

## Deferred to Tech Debt
_None_

## Blocked
_None_

## Quality Gates
| Gate | Status |
|------|--------|
| TypeScript (tsc --noEmit) | PASS — 0 errors, 0 warnings |
| Dashboard tests (228) | PASS |
| CLI tests (295) | PASS |
| Repository tests (211) | PASS |
| Simplifier pass | PASS — 5 refinements applied |

## Simplification Applied
- Extracted `formatMs` dedup helper in format.ts (shared by formatElapsed + formatDuration)
- Moved `PANEL_BY_KEY` to module scope as `PANEL_JUMP_KEYS` in use-keyboard.ts
- Renamed cryptic `*U` intermediates in use-dashboard-data.ts
- Replaced nested ternary in schedule-detail.tsx with shared `statusColor()`
- Extended `statusColor` to cover `triggered`/`missed` execution statuses
