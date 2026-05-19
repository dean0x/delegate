# Accessibility Review Report

**Branch**: feat/166-167-dashboard-cleanup -> main
**Date**: 2026-05-14

## Context

This PR covers two changes to a terminal TUI dashboard built with Ink (React for terminals):
- **#166**: Remove workspace view, grid mode, and all supporting infrastructure (~2,800 lines deleted)
- **#167**: Add keyboard-driven `p` key for pause/resume of schedules and loops with contextual footer hints

**Important framing**: WCAG and web accessibility patterns (ARIA roles, screen reader support, semantic HTML, focus indicators, color contrast ratios) do not directly apply to terminal TUI applications rendered via Ink. Ink renders to a terminal emulator using ANSI escape sequences, not to a browser DOM. There is no ARIA tree, no screen reader API, no focus ring CSS, and no mouse interaction model. Accessibility in a terminal TUI context means: keyboard-only operability, discoverable key bindings, consistent navigation patterns, and clear textual feedback.

## Issues in Your Changes (BLOCKING)

### HIGH

(none)

### MEDIUM

(none)

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Detail view hint string shows output controls for all entity types** - `keyboard/hints.ts:34` (Confidence: 65%) -- The detail hint base string includes "o output / [/] scroll / G tail" for all entity types, but these controls only function for tasks and orchestrations (`handleOutputControls` guards on `view.entityType`). Showing non-functional hints for schedules, pipelines, and loops could mislead users. Consider conditionally including output-related hints only when entityType is 'tasks' or 'orchestrations'.

- **No feedback on pause/resume no-op states** - `keyboard/entity-mutations.ts:100-127` (Confidence: 62%) -- When a user presses `p` on a schedule or loop in a status that is neither active/running nor paused (e.g., completed, cancelled, failed), the keypress is silently consumed with no visual feedback. In a terminal TUI, a brief status bar flash or bell could communicate "action not applicable" rather than silent absorption. This is a polish concern, not a bug.

- **Footer hint string length may overflow narrow terminals** - `keyboard/hints.ts:18,34` (Confidence: 60%) -- The main hint string with mutations and pause/resume is approximately 100+ characters. Combined with the detail hint string, narrow terminals (< 80 columns) may cause the hint text to wrap or be truncated by Ink's Box layout. The Footer uses `<Text dimColor>` inside a bordered `<Box>` with `paddingX={1}`, which consumes additional columns. Consider a responsive hint strategy that abbreviates or omits lower-priority hints at narrow widths.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Accessibility Score**: 8/10
**Recommendation**: APPROVED

## Rationale

This PR is strong from a terminal accessibility perspective:

1. **Keyboard-only operability** -- All interactions are keyboard-driven. The new `p` key for pause/resume follows the established pattern of single-key actions (`c` cancel, `d` delete). No mouse interaction is required or expected.

2. **Discoverable key bindings** -- The footer hint bar dynamically updates to show available actions based on context. The `p pause/resume` hint appears conditionally: in main view only when the focused panel is schedules or loops; in detail view with contextual "p pause" vs "p resume" text based on entity status. This is good contextual discoverability.

3. **Consistent navigation patterns** -- Tab/Shift+Tab panel cycling, arrow key selection, Enter to drill down, Esc to return -- all preserved. The workspace view removal simplifies the navigation model from three views (main/workspace/detail) to two (main/detail), reducing cognitive load.

4. **Vi-style alternatives** -- All arrow key operations have j/k alternatives (and PgUp/PgDn for pagination), supporting users who prefer vi-style navigation.

5. **No regression in keyboard reachability** -- The removed workspace view (`v`/`w` keys) was an additional view with its own complex key handling. Its removal does not reduce functionality that remains; orchestration details are still accessible via Enter from the main view.

6. **Error resilience** -- The `pauseOrResumeEntity` function swallows service errors to prevent dashboard crashes, with best-effort semantics documented in JSDoc. This maintains TUI stability.

The three suggestions above are all below the 80% confidence threshold and are polish items rather than accessibility barriers. The PR maintains full keyboard operability and improves discoverability through contextual hints.
