# UI Design Review Report

**Branch**: feat/166-167-dashboard-cleanup -> main
**Date**: 2026-05-14T22:08

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Footer hint string length may exceed terminal width on narrow terminals** - `src/cli/dashboard/keyboard/hints.ts:18-21`
**Confidence**: 82%
- Problem: The main view hint string is approximately 95 characters before mutation hints are appended. With mutations enabled and a pauseable panel focused, the full string reaches ~130 characters (`Tab: panel ... c cancel ... p pause/resume`). In terminals narrower than this width, the Ink `<Text>` element will wrap or be truncated, causing the footer to consume multiple rows and push content off-screen. The pre-existing `v: workspace` hint was shorter (5 chars), so the net delta from this PR adds the `p pause/resume` suffix while removing a shorter prefix — a modest increase. The old workspace hints line was comparably long, so this is not strictly a regression for wide terminals, but the new main-view line is longer than the old main-view line.
- Fix: Consider abbreviating hints when terminal width is tight. A lightweight approach: pass `columns` into `getHints` and drop low-priority hints (e.g., `1-5: panel`, `f: filter`) when columns < 100. Alternatively, shorten the pause hint to `p p/r` to match the terse style of `c cancel · d delete`.

**Detail-view pause/resume hint shows generic keybindings that do not apply** - `src/cli/dashboard/keyboard/hints.ts:34`
**Confidence**: 80%
- Problem: When viewing a schedule or loop detail in a non-pauseable status (e.g., `completed`, `cancelled`, `failed`), the footer still shows the base hint string including `Enter detail` and `o output`, which are not meaningful for schedule/loop detail views (schedules and loops have no output stream, and `Enter` does nothing in schedule detail). The `p` hint is correctly suppressed for terminal statuses, but the surrounding hints remain misleading. This is a UX consistency issue — showing inapplicable keybinding hints trains users to ignore the footer.
- Fix: Consider adding entity-type awareness to the base hint string in `detailHints()`. For schedule detail, omit `o output · [/] scroll · G tail` since those only apply to tasks/orchestrations. This could be a follow-up refinement rather than blocking.

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

_No issues found._

## Suggestions (Lower Confidence)

- **Contextual hint density could be reduced for main view** - `src/cli/dashboard/keyboard/hints.ts:18` (Confidence: 65%) — The main view footer packs 9 distinct hint groups into one line. Terminal UI best practice (per Ink/blessed conventions) is to show only the most relevant 4-5 hints and use a `?` key to show the full set. This is a stylistic consideration for future iteration.

- **Footer prop drilling depth is growing** - `src/cli/dashboard/app.tsx:212-218` (Confidence: 62%) — The Footer component now receives 5 props (viewKind, hasMutations, entityType, entityStatus, focusedPanel) where it previously received 2. All are used for hint text selection. While this is clean and each prop has clear purpose, if more context-sensitive hints are added in the future, extracting a `FooterHintContext` or computing the hint string at the App level and passing a single `helpText` prop would reduce coupling. Not actionable now but worth noting for the trend.

- **`detailEntityStatus` useMemo has broad `view` dependency** - `src/cli/dashboard/app.tsx:148-157` (Confidence: 70%) — The `useMemo` for `detailEntityStatus` lists `view` as a dependency. Since `view` is a discriminated union object that changes on every navigation, this memo recomputes on every view transition even when the result will be `undefined` (e.g., switching between main and detail views for non-pauseable entities). A more precise dependency like `view.kind === 'detail' ? view.entityType + view.entityId : ''` as a custom key would reduce recomputations, though the impact is negligible given the function body is trivial (two `.find()` calls on small arrays).

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**UI Design Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Rationale

This PR is a well-executed cleanup that removes ~2,800 lines of workspace/grid infrastructure while adding a focused, contextual `p` key for pause/resume. From a UI design perspective:

**Strengths:**
- The workspace removal simplifies the view hierarchy from 3 views (main/workspace/detail) to 2 (main/detail), reducing cognitive load for users navigating the TUI.
- The `ViewState` union type is now tighter — removing `'workspace'` from the discriminated union eliminates an entire class of invalid states at compile time.
- Footer hints are context-sensitive: `p pause` vs `p resume` adapts based on entity status, and the hint is suppressed entirely for non-pauseable panels/entities. This follows the terminal UI principle of showing only actionable keybindings.
- The `pauseOrResumeEntity` function follows the established `cancelEntity`/`deleteEntity` pattern (same error handling, same refreshNow flow), maintaining internal consistency.
- All deleted components (EmptyWorkspace, OrchestratorNav, TaskPanel, workspace-types) are fully removed with no orphaned imports or dead references.

**Conditions:**
- The two MEDIUM findings are minor UX refinements (hint string length on narrow terminals, inapplicable base hints in detail view). Neither blocks merge but both would improve the footer's signal-to-noise ratio.
