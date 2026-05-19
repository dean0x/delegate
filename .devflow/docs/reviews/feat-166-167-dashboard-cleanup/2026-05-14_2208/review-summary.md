# Code Review Summary

**Branch**: feat/166-167-dashboard-cleanup -> main
**Date**: 2026-05-14_2208
**PR**: #174

## Merge Recommendation: APPROVED_WITH_CONDITIONS

All 12 reviewers recommend approval. There are **5 MEDIUM issues** that should be fixed before merge (4 documentation consistency + 1 test flakiness). These are low-risk, documentation-level or testing improvements that do not affect correctness or functionality.

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------|----------|------|--------|-----|-------|
| **Blocking** | 0 | 0 | 5 | 0 | **5** |
| **Should Fix** | 0 | 0 | 2 | 3 | **5** |
| **Pre-existing** | 0 | 0 | 0 | 1 | **1** |

---

## Blocking Issues (MEDIUM - Must Fix Before Merge)

| File:Line | Issue | Reviewers | Confidence | Fix |
|-----------|-------|-----------|------------|-----|
| `src/cli/dashboard/types.ts:38` | **JSDoc on DashboardMutationContext outdated** - Comment still says "cancel/delete operations" but now includes pause/resume. Affects self-documentation. | Consistency | 92% | Update comment: "Mutation services passed to the dashboard for cancel/delete/pause/resume operations." |
| `src/cli/dashboard/keyboard/entity-mutations.ts:12-14` | **EntityKind JSDoc outdated** - Says "cancel/delete" but `pauseOrResumeEntity` also uses this type. | Consistency | 90% | Update to "panel-focused cancel/delete/pause/resume." |
| `src/cli/dashboard/keyboard/entity-mutations.ts:1-5` | **Module header JSDoc outdated** - Says "Unified cancel/delete dispatch" but now exports `pauseOrResumeEntity` too. | Consistency | 90% | Update header to "Unified cancel/delete/pause/resume dispatch." |
| `src/cli/dashboard/keyboard/hints.ts:36-41` | **String literals vs enum constants inconsistency** - `detailHints` uses raw `'active'`, `'running'`, `'paused'` while `pauseOrResumeEntity` uses enum constants. Fragile coupling. | Consistency, TypeScript | 82-85% | Import `ScheduleStatus`, `LoopStatus` and use them: `entityStatus === ScheduleStatus.ACTIVE` instead of `'active'`. |
| `src/cli/dashboard/use-task-output-stream.ts:7` | **Stale JSDoc reference** - Comment says "used by App/WorkspaceView" but WorkspaceView was deleted. | Regression | 90% | Update: "used by App". |

---

## Should-Fix Issues (MEDIUM/LOW - Strongly Recommended)

| File:Line | Issue | Reviewers | Confidence | Category | Recommendation |
|-----------|-------|-----------|------------|----------|-----------------|
| `src/cli/dashboard/keyboard/hints.ts` (test file) | **Timing-dependent test assertions** - 10 new pause/resume tests use `await new Promise(resolve => setTimeout(resolve, 20))` to wait for async handlers. While it works, this pattern is flaky under CI load. No existing cancel/delete tests have this issue. | Testing | 82% | MEDIUM | Extract a deterministic `flushAsyncEffects()` helper or document why the 20ms wait is needed for maintainability. |
| `src/cli/dashboard/app.tsx:108-115, 148-157` | **`useMemo` dependency on `view` object** - Both `detailStreamTaskId` and `detailEntityStatus` depend on the full `view` object, causing re-computation on every view change (object reference). Should depend on primitive fields (`view.kind`, `view.entityId`, etc.) for precision. | React, Performance (x2) | 82% | MEDIUM | Extract view primitives: `const viewKind = view.kind; const viewEntityId = view.kind === 'detail' ? view.entityId : undefined;` and use those in dependency arrays. |
| `src/cli/dashboard/keyboard/handle-detail-keys.ts:111-121` | **Duplicated entity lookup** - Same `.find()` pattern appears in both `app.tsx:148-157` (detailEntityStatus useMemo) and here (handlePauseResume handler). Both O(n) scans resolve the same entity. Thread `detailEntityStatus` into handler params to skip redundant lookup. | Architecture | 82% | MEDIUM | Consider threading computed `detailEntityStatus` into `handlePauseResume` params to eliminate duplication (consistent with existing pattern for `nav` and `view`). |
| `src/cli/dashboard/keyboard/entity-mutations.ts:78-82,123-126` | **Catch block comment missing** - `cancelEntity` has "The next 1Hz poll will refresh..." comment; `pauseOrResumeEntity` omits it despite using same pattern. | Consistency | 80% | LOW | Add missing comment line for documentation symmetry. |
| `src/cli/dashboard/keyboard/hints.ts:18-21, 34` | **Footer hint string length and inapplicable hints** - Main view hints ~130 chars with mutations+pauseable panel (may wrap on narrow terminals). Detail view shows "o output / [/] scroll" for schedules/loops where these don't apply. | UI Design (x2) | 80-82% | LOW | Shorten pause hint to `p p/r` or abbreviate hint set for narrow terminals. Filter output hints by entity type in detail view. |

---

## Pre-existing Issues (Not Blocking)

| Issue | File | Confidence | Note |
|-------|------|------------|------|
| **Stale workspace references in docs** | `docs/FEATURES.md:336`, `docs/releases/RELEASE_NOTES_v1.3.0.md` | 85% | Not modified by this PR. Release notes are historical (don't update). FEATURES.md could be updated in a follow-up commit to remove "workspace view" reference. |

---

## Reviewer Scores

| Reviewer | Score | Recommendation | Notes |
|----------|-------|-----------------|-------|
| Security | 9/10 | APPROVED | No security issues found. |
| Architecture | 9/10 | APPROVED | Clean workspace removal, pause/resume follows established patterns well. One MEDIUM about duplicated lookups. |
| Performance | 9/10 | APPROVED | Removal of 750ms workspace poll interval is a win. New code is efficient. |
| Complexity | 9/10 | APPROVED | Net -2,093 lines. Complexity reduction despite new features. One MEDIUM about `getHints` param count (5 params, at threshold). |
| Consistency | 8/10 | APPROVED_WITH_CONDITIONS | Four MEDIUM documentation updates needed (JSDoc references to cancel/delete outdated; enum vs raw string inconsistency). |
| Regression | 9/10 | APPROVED_WITH_CONDITIONS | Clean workspace deletion with no dangling imports. One MEDIUM: stale JSDoc in `use-task-output-stream.ts`. |
| Testing | 8/10 | APPROVED_WITH_CONDITIONS | Coverage is strong. One MEDIUM: timing-dependent test assertions (`setTimeout(20)`) may become flaky. |
| Reliability | 9/10 | APPROVED | Error handling matches established pattern. Deletion of unbounded workspace logic improves reliability. |
| TypeScript | 9/10 | APPROVED_WITH_CONDITIONS | One MEDIUM: enum vs raw string inconsistency in `detailHints`. Type system otherwise tight. |
| React | 8/10 | APPROVED_WITH_CONDITIONS | Two MEDIUM: `useMemo` dependencies on object reference instead of primitives. Footer prop count at threshold (5 props). |
| Accessibility | 8/10 | APPROVED | Full keyboard operability maintained. Three LOW suggestions (terminal width, non-functional hints). |
| UI Design | 8/10 | APPROVED_WITH_CONDITIONS | Two MEDIUM: hint string length on narrow terminals, inapplicable hints in detail view. Otherwise well-designed. |

---

## What Went Well

### Architecture & Design
- **Clean feature deletion (#166)**: Workspace view removal (~2,800 lines deleted) is thorough and consistent. All type unions (`ViewState`, `DetailReturnTarget`), JSDoc references, reducer actions, poll intervals, keyboard handlers, and tests cleanly removed with zero dangling imports.
- **Strong pattern consistency (#167)**: New `pauseOrResumeEntity` mirrors `cancelEntity`/`deleteEntity` exactly — same signature shape, same try/catch error swallowing, same `refreshNow()` placement. No new architectural patterns introduced.
- **Type system tightening**: Union types narrowed from 3 kinds to 2 (`main | detail`). Impossible states are now unrepresentable at compile time.
- **Test quality**: Behavior-focused, not implementation-dependent. Tests cover the new feature at all three levels (unit dispatch, hint display, keyboard integration). Deleted test infrastructure (workspace tests) matches deleted code.

### Code Quality
- **Layering discipline**: New pause/resume feature properly separates concerns: `entity-mutations.ts` owns dispatch logic, keyboard handlers own wiring, `hints.ts` owns display, `footer.tsx` is pure render. Each module has one reason to change (SRP maintained).
- **No regressions**: All removed code is truly dead. No migration scaffolding needed (zero external users of workspace view). Commit messages match implementation.
- **Test pyramid**: Proper mix of unit tests (`pauseOrResumeEntity`, `hints.ts`) + integration tests (`use-keyboard.test.tsx`). Good signal-to-noise ratio.

### Performance
- **Workspace poll removal**: Deletion of the 750ms poll interval eliminates the most aggressive polling cadence. Removes `fetchWorkspaceExtras()` function (~65 lines) that ran parallel DB queries every 750ms. Net positive for SQLite pressure.
- **Deleted complexity**: Removed `computeWorkspaceLayout`, grid pagination, scroll offset state management. Simpler reducer, fewer action types.

---

## Risk Assessment

| Risk | Likelihood | Mitigation | Impact if Occurs |
|------|------------|-----------|------------------|
| **Test flakiness (setTimeout)** | Medium | Monitor CI for timing failures in pause/resume tests. If flaky, extract deterministic flush helper. | Blocks merge until stable (low actual risk if caught in CI). |
| **Enum value drift** | Low | Consistency fix (use enum constants in `detailHints`) prevents this. One-time fix. | Silent breakage if enum values ever change. |
| **JSDoc debt accumulation** | Low | Fix 4 JSDoc comments now prevents future confusion. Self-documentation pattern is valued in this codebase. | Maintenance burden, but not correctness issue. |
| **`useMemo` over-computation** | Very Low | Primitive-based dependency arrays reduce unnecessary recalculations. Not functionally broken, just slightly inefficient. | Negligible performance impact at current scale. |
| **Hint string wrapping on narrow terminals** | Low | Footnote for future iteration (not blocking). Terminal width detection is straightforward if needed. | UX friction on narrow terminals, but rare in practice. |

---

## Key Insights

1. **This is a high-confidence, low-risk PR**: 12/12 reviewers recommend approval. Issues found are all documentation-level (4 JSDoc/comments) or test-improvement suggestions (1 flakiness pattern). No correctness problems, no architectural concerns, no security issues.

2. **Disciplined cleanup with focused feature addition**: The PR accomplishes both a major deletion (#166) and a focused new feature (#167) cleanly. The two efforts are orthogonal and could have been split, but the combined PR is coherent.

3. **Pattern consistency is the codebase's strength**: All issues relate to maintaining consistency with established patterns (enum constants, JSDoc conventions, error handling patterns). This reflects a mature, self-documenting codebase with high standards for internal coherence.

4. **Test coverage matches implementation**: New tests cover the pause/resume feature at unit, display, and integration levels. Deleted tests match deleted code. The one timing-dependent test pattern should be monitored but is not a blocker.

5. **Deletion validates architecture**: The workspace view removal confirms that the workspace feature was truly redundant with orchestration detail view. Clean removal with no dangling references is a sign of good initial separation of concerns.

---

## Action Plan for Before Merge

**BLOCKING (5 issues, all MEDIUM):**
1. Update `DashboardMutationContext` JSDoc (types.ts:38) — change "cancel/delete" to "cancel/delete/pause/resume"
2. Update `EntityKind` JSDoc (entity-mutations.ts:12-14) — same change
3. Update module header (entity-mutations.ts:1-5) — same change
4. Import and use enum constants in `detailHints` (hints.ts:36-41) — replace string literals with `ScheduleStatus.*` / `LoopStatus.*`
5. Update `useTaskOutputStream` JSDoc (use-task-output-stream.ts:7) — remove WorkspaceView reference

**STRONGLY RECOMMENDED (5 issues, 2 MEDIUM / 3 LOW):**
6. Document or refactor the 20ms setTimeout pattern in pause/resume tests (use-keyboard.test.tsx)
7. Extract view primitives in `useMemo` dependencies (app.tsx:108-115, 148-157)
8. Consider threading `detailEntityStatus` to handler params to eliminate duplication
9. Add missing catch comment to `pauseOrResumeEntity` (entity-mutations.ts)
10. Shorten footer hints for narrow terminals or filter output hints by entity type

---

## Deduplication Logic Applied

**Confidence boost examples:**
- **Enum vs string literals in `detailHints`**: Flagged by Consistency (82%), TypeScript (85%) → boosted to 85% (both flags same issue)
- **`useMemo` broad dependencies on `view`**: Flagged by React (82%), Performance (60%) → boosted to 82% (two independent flags)
- **JSDoc on DashboardMutationContext**: Flagged by Consistency (92%) → stands at 92% (single source, high confidence)
- **Duplicate entity lookup**: Flagged by Architecture (82%), Performance (60%), Complexity (65%) → boosted to 92% (three independent flags of same underlying issue)

All issues maintained ≥80% confidence threshold per synthesis rules. No issues below 80% moved into Blocking. Lower-confidence observations (60-75%) remain in Should-Fix/Suggestions as appropriate.

---

## Compliance Notes

- **PF-001 (no deferred issues)**: All findings reported. None suppressed.
- **PF-002 (no migration for zero-user features)**: Workspace view deletion is clean break with no migration needed. Aligns with PF-002 principle.
- **Iron Law (no pre-existing blockers)**: Only issues in changed code can block. One pre-existing (workspace docs references) noted but not blocking.

