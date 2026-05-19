# Resolution Summary

**Branch**: feat/166-167-dashboard-cleanup -> main
**Date**: 2026-05-14
**Review**: .docs/reviews/feat-166-167-dashboard-cleanup/2026-05-14_1749/
**Command**: /resolve

## Statistics
| Metric | Value |
|--------|-------|
| Total Issues | 11 |
| Fixed | 8 |
| False Positive | 2 |
| Deferred | 0 |
| Blocked | 0 |
| Pre-existing (no action) | 1 |

## Fixed Issues
| Issue | File:Line | Commit |
|-------|-----------|--------|
| Extract nested ternary to useMemo | `app.tsx:204-212` | `4ba7773` |
| Tighten FooterProps/hints types (string → PanelId) | `hints.ts:26`, `footer.tsx:17-19` | `4ba7773` |
| Conditionalize main-view "p pause/resume" by focusedPanel | `hints.ts:13-18` | `4ba7773` |
| JSDoc section numbering (4→5, 5→6) | `handle-detail-keys.ts:184,278` | `87562af` |
| Add handlePauseResume to dispatcher comment | `handle-detail-keys.ts:342-347` | `87562af` |
| Remove stale workspace-view.tsx from CLAUDE.md | `CLAUDE.md:297` | `064723a` |
| Update OrchestratorChild JSDoc (workspace → orchestration detail) | `domain.ts:885` | `064723a` |
| Add footer detail-view + hints.test.ts unit tests | `footer.test.tsx`, `hints.test.ts` | `0d42d25` |

## False Positives
| Issue | File:Line | Reasoning |
|-------|-----------|-----------|
| Fire-and-forget comment on void pauseOrResumeEntity | `handle-detail-keys.ts:114,119` | `void` prefix is the established codebase pattern — adjacent cancelEntity/deleteEntity use the same bare `void` without comments. Adding one only here would be inconsistent. |
| handlePauseResume consumes 'p' without mutations | `handle-detail-keys.ts:109` | Pre-existing pattern. 'p' is not used by downstream handlers; silent consumption is intentional and harmless. |

## Deferred to Tech Debt
_(none)_

## Blocked
_(none)_

## Simplification Pass
| Change | File | Rationale |
|--------|------|-----------|
| Convert resolveDetailStreamTaskId to useMemo | `app.tsx` | Matches adjacent detailEntityStatus pattern, removes unnecessary intermediate |
| Remove 5 archaeology tests | `footer.test.tsx` | Guarded against removed pre-redesign hints ("1-4 jump", "Tab cycle") — positive tests already cover current behavior |
| Consolidate getHints() tests 5→3 | `hints.test.ts` | Original tests re-proved delegation already covered by mainHints/detailHints blocks |

## Commits Created
1. `4ba7773` refactor(dashboard): tighten footer hint types and panel-conditional p hint
2. `87562af` docs(dashboard): fix JSDoc section numbering and handler list in handle-detail-keys
3. `064723a` docs: remove stale workspace view references after #166 deletion
4. `0d42d25` test(dashboard): add hints unit tests and footer detail-view pause/resume tests
5. `(latest)` refactor(dashboard): simplify resolution fixes
