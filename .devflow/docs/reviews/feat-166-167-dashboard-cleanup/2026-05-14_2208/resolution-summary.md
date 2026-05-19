# Resolution Summary

**Branch**: feat/166-167-dashboard-cleanup -> main
**Date**: 2026-05-14_2208
**Review**: .docs/reviews/feat-166-167-dashboard-cleanup/2026-05-14_2208
**Command**: /resolve

## Decisions Citations

- avoids PF-001 — batch-2, hints:18-21:ui-design (sub-issue a marked false positive with reasoning, not deferred)
- avoids PF-002 — batch-3, docs/FEATURES:336:pre-existing (fixed in-scope, no migration)

## Statistics
| Metric | Value |
|--------|-------|
| Total Issues | 11 |
| Fixed | 8 |
| False Positive | 3 |
| Deferred | 0 |
| Blocked | 0 |

## Fixed Issues
| Issue | File:Line | Commit |
|-------|-----------|--------|
| Module header JSDoc says "cancel/delete" — updated to include pause/resume | `entity-mutations.ts:1-5` | 1a0caf7 |
| EntityKind JSDoc says "cancel/delete" — updated to include pause/resume | `entity-mutations.ts:12-14` | 1a0caf7 |
| pauseOrResumeEntity catch block missing recovery comment | `entity-mutations.ts:123-126` | 1a0caf7 |
| DashboardMutationContext JSDoc outdated — added pause/resume | `types.ts:38` | 1a0caf7 |
| Stale WorkspaceView JSDoc reference — updated to "App" | `use-task-output-stream.ts:7` | 1a0caf7 |
| Stale "workspace views" in FEATURES.md — updated to "detail views" | `docs/FEATURES.md:336` | 1a0caf7 |
| Raw string literals in detailHints — replaced with enum constants + filtered inapplicable output hints for schedules/loops | `hints.ts:36-41` | 3525961 |
| 19 inline setTimeout(20) calls — extracted flushAsyncMutation() helper with JSDoc | `use-keyboard.test.tsx` | 926f1a5 |

## False Positives
| Issue | File:Line | Reasoning |
|-------|-----------|-----------|
| Main-view hint string ~130 chars may wrap on narrow terminals | `hints.ts:18-21` | Pre-existing concern predating this PR. Implementing responsive hint abbreviation would require terminal-width-aware logic in a pure function — non-trivial scope addition unrelated to #166/#167. |
| useMemo deps on `view` object cause over-computation | `app.tsx:108-115,148-157` | `view` does NOT change identity on every dispatch. The reducer's TICK_ANIM returns `{ ...state, animFrame: ... }` — object spread preserves `state.view` as the same reference. `view` only gets a new identity on SET_VIEW. Both useMemo hooks correctly depend on `[view, ...]`. |
| Duplicated entity-status .find() between app.tsx and handle-detail-keys.ts | `handle-detail-keys.ts:111-121` | Intentional. handlePauseResume reads from `dataRef.current` (latest data via ref) to avoid stale closures in Ink's useInput. The app.tsx useMemo closes over render-time data. Threading the memo value into the handler would introduce a stale-data bug. The two lookups serve categorically different purposes. |

## Deferred to Tech Debt
(none)

## Blocked
(none)
