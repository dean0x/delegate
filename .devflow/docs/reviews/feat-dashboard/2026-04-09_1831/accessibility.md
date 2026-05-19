# Accessibility Review Report

**Branch**: feat-dashboard -> main
**Date**: 2026-04-09
**PR**: #131

## Context

This PR adds a terminal dashboard (`beat dashboard`) built with Ink (React for CLIs). It renders to stderr using the alternate screen buffer. The UI is a 4-panel grid (Loops, Tasks, Schedules, Orchestrations) with keyboard navigation, detail drill-down views, and auto-refresh polling.

**Important framing note**: This is a terminal UI (TUI) rendered via Ink, not a browser-based web application. WCAG 2.2 AA criteria apply partially -- many web-specific concerns (ARIA roles, focus management for screen readers, touch targets, semantic HTML) are not applicable because terminal emulators do not expose a DOM or accessibility tree. The review focuses on the accessibility-relevant aspects that DO apply to TUIs: keyboard operability, color-only meaning, motion sensitivity, and cognitive clarity.

## Issues in Your Changes (BLOCKING)

### HIGH

**Status conveyed through color alone (7 occurrences)** -- Confidence: 85%
- `src/cli/dashboard/components/status-badge.tsx:12-30` (statusColor function)
- `src/cli/dashboard/views/loop-detail.tsx:46-52` (iteration status coloring)
- `src/cli/dashboard/views/schedule-detail.tsx:30-35` (execution status coloring)
- `src/cli/dashboard/components/header.tsx:41-43` (health summary with colored symbols only)
- `src/cli/dashboard/components/panel.tsx:25` (focused panel distinguished only by cyan vs no color)
- `src/cli/dashboard/views/main-view.tsx:85-88` (failed task error in dimColor only)
- `src/cli/dashboard/views/task-detail.tsx:82` (error message in red only)
- Problem: Color is the sole visual differentiator for status in several places. Users with color vision deficiencies or terminals with limited color support may not distinguish running/completed/failed states. WCAG SC 1.4.1 requires that color is not the sole means of conveying information.
- Mitigation already present: The `statusIcon()` function in `format.ts` maps statuses to distinct Unicode symbols (running=filled circle, completed=checkmark, failed=X, paused=pause icon). The `StatusBadge` component uses both icon AND color. The main list views use `TableRow` which includes the status text string as a cell column. So the core list rows are fine.
- Remaining gaps: (1) The `buildHealthSummary` in `header.tsx:41-43` uses symbols `●`, `○`, `✗` which are similar in monochrome terminals -- the text labels `run`, `queue`, `fail` mitigate this somewhat but the symbols alone could be confusing. (2) In `loop-detail.tsx:46-52`, iteration rows use color (green/red) on the status text without a separate icon prefix. (3) In `schedule-detail.tsx:30-35`, execution rows use color without an icon prefix.
- Fix: Add `statusIcon(status)` prefix to iteration and execution row status text in `loop-detail.tsx` and `schedule-detail.tsx`, matching the pattern already established by `StatusBadge`. For the header health summary, the text labels already provide non-color meaning, so this is acceptable.

**StatusBadge animation has no reduced-motion opt-out** -- `src/cli/dashboard/components/status-badge.tsx:48-55` -- Confidence: 82%
- Problem: The `StatusBadge` component animates a dot cycle every 250ms for running/active/planning statuses using `setInterval`. There is no way for users who are sensitive to motion to disable this. WCAG SC 2.3.3 recommends respecting user preferences for reduced motion.
- Context: In a web environment, `prefers-reduced-motion` media query handles this. Terminal environments lack this API, but the principle still applies -- constantly cycling characters can be distracting.
- Fix: Consider checking an environment variable (e.g., `AUTOBEAT_REDUCE_MOTION=1` or the de-facto standard `TERM_PROGRAM` hints) to disable animation, or provide a `--no-animate` CLI flag. Alternatively, slow the interval to 1000ms+ which is less disruptive.

### MEDIUM

**Dim text (`dimColor`) used extensively for secondary information** -- Confidence: 80%
- Locations (consolidated -- 25+ instances across all files, representative):
  - `src/cli/dashboard/components/footer.tsx:21` (keyboard help bar)
  - `src/cli/dashboard/components/header.tsx:68-69` (timestamp, quit hint)
  - `src/cli/dashboard/components/empty-state.tsx:19` (empty state messages)
  - `src/cli/dashboard/components/scrollable-list.tsx:36,46` (scroll indicators)
  - `src/cli/dashboard/views/loop-detail.tsx:59-65` (iteration data columns)
  - `src/cli/dashboard/views/schedule-detail.tsx:46-52` (execution data columns)
- Problem: Ink's `dimColor` reduces text brightness, which can create contrast issues on some terminal color schemes (particularly light-background terminals where dim gray text approaches the background color). The keyboard help bar in the footer is entirely dimColor, making it harder to read despite being critical guidance for navigation.
- Fix: Consider using regular color for the footer help text (it is primary UI guidance, not secondary decoration). For data columns in detail views, dimColor is a reasonable secondary emphasis and is acceptable.

## Issues in Code You Touched (Should Fix)

No issues identified in this category. All code in this PR is newly added.

## Pre-existing Issues (Not Blocking)

No pre-existing accessibility issues identified in changed files.

## Suggestions (Lower Confidence)

- **Panel focus indicator is color-only** -- `src/cli/dashboard/components/panel.tsx:21-25` (Confidence: 70%) -- The focused panel is distinguished by a cyan border color vs undefined (default). On monochrome terminals, there may be no visual difference. Consider also changing the border style (e.g., `double` for focused, `round` for unfocused) as a secondary indicator.

- **Selected row indicator could be more distinct** -- `src/cli/dashboard/components/table-row.tsx:24-27` (Confidence: 65%) -- Selected rows use `bold` + `inverse` + a `>` prefix, which is good multi-modal indication. The `inverse` attribute may render poorly on some terminal themes. No action needed -- this is already well-implemented with multiple cues.

- **Scroll indicators use arrow symbols only** -- `src/cli/dashboard/components/scrollable-list.tsx:36,46` (Confidence: 60%) -- The `more` scroll indicators use arrows and dimColor text. These are adequate but could include a count (e.g., "3 more") to give users a sense of how much content remains.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Accessibility Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Conditions
1. Add status icons to iteration rows in `loop-detail.tsx` and execution rows in `schedule-detail.tsx` to avoid color-only status indication (matches existing `StatusBadge` pattern).
2. Consider a reduced-motion opt-out for the `StatusBadge` animation (environment variable or CLI flag).

### Positive Observations
- Keyboard navigation is comprehensive: Tab/Shift+Tab cycling, 1-4 number keys for panel jump, j/k vim bindings, arrow keys, Enter for drill-down, Escape to return, f for filter cycling, r for refresh, q to quit. This is excellent for a TUI.
- The `useKeyboard` hook is well-structured with clear key routing.
- Status text is always included alongside colors in the main list views (via `TableRow` cells).
- The footer provides context-sensitive keyboard hints for both main and detail views.
- The `StatusBadge` component pairs icons with colored text (good dual-coding).
- TTY guard and terminal size guard prevent broken rendering in non-interactive contexts.
