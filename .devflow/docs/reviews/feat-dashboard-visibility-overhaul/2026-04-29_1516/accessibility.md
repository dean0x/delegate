# Accessibility Review Report

**Branch**: feat/dashboard-visibility-overhaul -> main
**Date**: 2026-04-29

## Context

This PR overhauls the dashboard layout: consolidates tiles (Cost+Throughput into StatsTile), adds ActivityTile as a non-interactive tile, makes the entity browser full-width, removes activity panel keyboard navigation (Tab cycling now wraps among entity browser panels only), expands tab labels to full names, adds agent column to entity browser, and adds `v` toggle from orchestration detail to scoped workspace.

**Important platform context**: This is a terminal UI (TUI) built with Ink (React for CLIs). It is not a web application rendered in a browser. WCAG standards like ARIA roles, `aria-live`, `role="alert"`, semantic HTML (`<nav>`, `<label>`, `<button>`), screen reader support, skip links, and focus indicators with CSS pixel dimensions do not apply. Ink renders to stdout using ANSI escape codes. The relevant accessibility concerns for a TUI are: keyboard navigation completeness, color-only meaning avoidance, and information architecture clarity.

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Activity feed information is no longer keyboard-accessible** - `src/cli/dashboard/components/activity-tile.tsx:27-59`, `src/cli/dashboard/keyboard/handle-main-keys.ts:8-9`
**Confidence**: 82%
- Problem: The activity feed was previously interactive (Tab to focus, arrow keys to navigate, Enter to drill into detail). It is now a non-interactive tile showing only the last 5 entries with no scroll and no keyboard access. Users who relied on the activity feed to navigate to recent entities via keyboard have lost that workflow entirely.
- Impact: This is a deliberate design decision documented in the code (`DECISION (Dashboard Layout Overhaul): Activity is now a non-interactive tile`). The entity browser panel still provides full keyboard access to all entities. However, the activity feed previously offered a temporal shortcut -- recent items across all entity types in one list. That quick-access path is gone.
- Fix: This is a conscious architectural trade-off (activity duplication was removed to simplify layout). No code fix required, but consider adding a "recent" or "all" filter option to the entity browser in a future iteration that would restore temporal navigation. The entity browser already has filter cycling (`f` key) -- a "recent" sort/filter would bridge the gap.
- Severity: MEDIUM -- the information is still accessible via entity browser panels; only the shortcut path was removed.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Status column uses color as the sole differentiator for some information** - `src/cli/dashboard/components/entity-browser-panel.tsx:134-135`
**Confidence**: 84%
- Problem: The status text column applies `statusColor()` as its text color (`<Text color={color}>{statusText}</Text>`). While the adjacent icon column also uses color, the status text itself relies solely on color to visually group status states (green for completed, red for failed, cyan for running). Users with color vision deficiency may find it harder to distinguish status at a glance in the text column.
- Impact: The status icon column (line 127) provides a redundant non-color cue (`✓` for completed, `✗` for failed, `●` for running, etc.), which is good. The status text itself also spells out the status word ("running", "completed", "failed"), which is a textual cue. So this is partially mitigated -- the information is conveyed through three channels: icon shape, color, and text label.
- Fix: No immediate code change required. The triple-channel approach (icon + color + text) already satisfies the principle of not relying on color alone. This is informational.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**ActivityPanel (still in codebase) retains `focused` prop and selection rendering but is no longer wired to keyboard navigation** - `src/cli/dashboard/components/activity-panel.tsx`
**Confidence**: 80%
- Problem: The `ActivityPanel` component still accepts `focused`, `selectedIndex`, `scrollOffset`, and `onSelect` props. It still renders selection highlighting (`isSelected` via `bold` and `inverse`). However, it is no longer used in the main metrics view (replaced by `ActivityTile`). If this component is used elsewhere (e.g., workspace view), the keyboard wiring for activity navigation was removed from `handle-main-keys.ts`. The component's interactive surface may be dead code.
- Impact: Potential confusion for future developers who see the interactive API surface but no keyboard integration. No user-facing accessibility impact since the component appears unused in the changed views.

## Suggestions (Lower Confidence)

- **`w` shortcut is silently a no-op when no orchestrations exist** - `src/cli/dashboard/use-keyboard.ts:101-103` (Confidence: 68%) -- When `w` is pressed with no orchestrations, nothing happens and there is no feedback. A brief status message or visual cue would help users understand the shortcut is conditional. TUI feedback for no-op keys improves discoverability.

- **Keyboard hint says "Tab: panel" which is less descriptive than the previous "Tab: activity"** - `src/cli/dashboard/keyboard/hints.ts:14` (Confidence: 65%) -- The hint changed from "Tab: activity" to "Tab: panel". The new text accurately describes cycling between entity browser panels, but "panel" is generic. Consider "Tab: next panel" or "Tab: switch panel" for clarity.

- **`v` key behavior varies by context without hint differentiation** - `src/cli/dashboard/use-keyboard.ts:67-85` (Confidence: 62%) -- The `v` key now has three behaviors: (1) main -> workspace, (2) workspace -> main, (3) orchestration detail -> scoped workspace. The footer hint only shows "v: workspace" universally. Context-sensitive hint text would improve discoverability of the orchestration-detail behavior.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Accessibility Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

**Rationale**: The dashboard is a terminal UI where the primary accessibility concern is keyboard navigation completeness. The changes improve keyboard navigation in several ways: Tab cycling now wraps cleanly (no dead-end at activity panel), panel jump keys expanded to 1-5, full tab labels improve readability. The main regression is loss of activity feed keyboard navigation, which was a deliberate design decision with the entity browser providing equivalent (if less convenient) access to all entities. Status information is conveyed through icon shape + color + text label, satisfying the color-independence principle. No blocking accessibility issues prevent merge.

**Conditions**: None blocking. The MEDIUM findings are informational -- the activity feed accessibility regression is an acknowledged design trade-off, and the status color concern is already mitigated by triple-channel encoding (icon + color + text).
