# Accessibility Review Report

**Branch**: feat/166-167-dashboard-cleanup -> main
**Date**: 2026-05-14

## Issues in Your Changes (BLOCKING)

### MEDIUM

**No feedback announcement for pause/resume actions** - `src/cli/dashboard/keyboard/entity-mutations.ts:93-127`, `src/cli/dashboard/keyboard/handle-detail-keys.ts:106-123`, `src/cli/dashboard/keyboard/handle-main-keys.ts:167-180`
**Confidence**: 82%
- Problem: When the user presses `p` to pause or resume a schedule/loop, the action fires asynchronously (`void pauseOrResumeEntity(...)`) and the only feedback is the next poll cycle updating the entity status. If the service call is slow or errors out (the catch block silently swallows), the user receives no immediate acknowledgement that their keypress was recognized. For sighted users relying on the dashboard TUI, the next 1-2 second poll refresh may be adequate, but for users navigating via screen reader or assistive technology, silent key consumption with no status feedback can be disorienting. The same pattern exists for cancel/delete (pre-existing), but the newly introduced `p` key inherits this gap.
- Fix: This is a TUI (terminal UI rendered via Ink), not a web browser, so ARIA live regions do not apply. However, a brief status message (e.g., "Pausing schedule..." / "Resumed loop") rendered in the footer or as a transient overlay for 1-2 seconds would provide immediate feedback. This could be addressed as a follow-up enhancement for all mutation actions (cancel, delete, pause/resume) rather than blocking this PR, since the pattern is consistent with existing mutations.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Main view "p pause/resume" hint shown for non-pauseable panels** - `src/cli/dashboard/keyboard/hints.ts:13-17`
**Confidence**: 85%
- Problem: In the main view with mutations enabled, the footer always shows `p pause/resume` regardless of which panel is focused. When the user is focused on the Tasks, Orchestrations, or Pipelines panel, pressing `p` is silently ignored (entity-mutations.ts default branch is a no-op). The hint suggests an action is available when it is not, which violates the principle that UI affordances should match available actions. By contrast, the detail view correctly conditionalizes the `p` hint based on entity type and status (hints.ts:28-36).
- Fix: Make the main view hint context-aware similar to the detail view. Pass the focused panel ID to `mainHints()` and only append the `p pause/resume` segment when the focused panel is `schedules` or `loops`:
  ```ts
  export function mainHints(hasMutations: boolean, focusedPanel?: string): string {
    const base = 'Tab: panel · ... · r refresh · q quit';
    if (hasMutations) {
      const pauseHint = focusedPanel === 'schedules' || focusedPanel === 'loops'
        ? ' · p pause/resume'
        : '';
      return `${base} · c cancel · d delete (terminal)${pauseHint}`;
    }
    return base;
  }
  ```

## Pre-existing Issues (Not Blocking)

_No CRITICAL pre-existing accessibility issues identified in the changed files._

## Suggestions (Lower Confidence)

- **Footer hint string length may exceed terminal width** - `src/cli/dashboard/keyboard/hints.ts:14,27` (Confidence: 65%) -- The main view hint string is now 92 characters with mutations (`... · c cancel · d delete (terminal) · p pause/resume`), and the detail view hint can reach ~95 characters. On narrow terminals (< 100 columns), the hint will be truncated by Ink's Box without any wrapping or overflow indicator, potentially hiding the `p pause/resume` hint that is appended at the end. Consider placing the most commonly needed hints first or implementing a truncation-aware approach.

- **Keyboard shortcuts not discoverable beyond footer text** - multiple files (Confidence: 62%) -- The `p` key for pause/resume joins a growing set of single-letter shortcuts (c, d, f, m, o, p, q, r, v removed, w removed). There is no `?` or `h` key to show a full help overlay with all available shortcuts. As the shortcut count grows, the compact footer becomes insufficient as the sole discoverability mechanism. A help overlay triggered by `?` would improve discoverability.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Accessibility Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The PR primarily removes the workspace view (~2,800 lines deleted), which is a net positive for accessibility -- it eliminates a complex multi-focus-area grid UI (nav/grid focus toggling, fullscreen panels, nested orchestrator navigation) that had significant cognitive overhead. The remaining two-mode navigation (main/detail) is simpler and easier to operate via keyboard.

The new `p` key for pause/resume follows the existing keyboard-first pattern (all interactions keyboard-accessible, no mouse required) and is properly documented in contextual footer hints in detail view. The two MEDIUM issues identified are: (1) the lack of immediate action feedback is consistent with the existing pattern for cancel/delete (not a regression, but worth addressing holistically), and (2) the main view hint showing `p pause/resume` on non-pauseable panels is a minor usability mislead that should be fixed.

Neither issue blocks merge.
