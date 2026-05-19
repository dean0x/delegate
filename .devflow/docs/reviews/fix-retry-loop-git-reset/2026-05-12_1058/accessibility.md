# Accessibility Review Report

**Branch**: fix-retry-loop-git-reset -> main
**Date**: 2026-05-12

## Issues in Your Changes (BLOCKING)

### MEDIUM

**`progress` status missing from `statusColor()` in format.ts — falls through to gray** - `src/cli/dashboard/format.ts:60-79`
**Confidence**: 90%
- Problem: The new `progress` status is added to `STATUS_ICONS` (line 94) and `iterationStatusColor()` in loop-detail.tsx (line 32, mapped to cyan), and to `colorStatus()` in ui.ts (line 126, mapped to cyan). However, `statusColor()` in format.ts (lines 60-79) does not include a `progress` case. It falls through to the `default` which returns `'gray'`. The `StatusBadge` component (status-badge.tsx:49) uses `statusColor()` to render the badge color. If a loop's overall status were ever `progress`, the StatusBadge would render it in gray while all other status rendering paths show it in cyan. This creates an inconsistent color mapping across the three color functions, which is an accessibility concern: users relying on color consistency to distinguish states would see conflicting signals depending on which view they are in.
- Fix: Add `case 'progress':` alongside the existing `case 'running':` block in `statusColor()`:
  ```typescript
  case 'running':
  case 'planning':
  case 'progress':
    return 'cyan';
  ```

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Color is the sole differentiator for iteration status in loop-detail.tsx** - `src/cli/dashboard/views/loop-detail.tsx:28-33`, `src/cli/dashboard/format.ts:82-95`
**Confidence**: 82%
- Problem: Iteration statuses (pass, fail, crash, progress, keep, discard) are differentiated primarily by color (green, red, cyan, or default). While `statusIcon()` provides distinct Unicode icons for some statuses (e.g., completed -> checkmark, failed -> cross), the iteration status column in loop-detail.tsx renders both the icon AND the text label (`statusText` at line 54), which provides a text-based differentiator alongside color. This is acceptable for most statuses since the text label is always present. However, users with color vision deficiencies may struggle to distinguish `progress` (cyan) from `running` (cyan) visually when both use the same color -- the text labels differ ("progress" vs "running") and icons differ (circle-dot vs filled-circle), which provides adequate non-color differentiation. This is a pre-existing pattern, not introduced by this PR.
- Note: The text labels and distinct icons already provide non-color differentiation, so this meets WCAG 1.4.1 (Use of Color) at a basic level. The existing `AUTOBEAT_REDUCE_MOTION` env var in StatusBadge shows good awareness of motion preferences.

## Suggestions (Lower Confidence)

- **`progress` icon (`U+25C9`) may not render on all terminal emulators** - `src/cli/dashboard/format.ts:94` (Confidence: 65%) -- The `U+25C9` (fisheye / circle-dot) character chosen for `progress` may not render correctly in all terminal environments or with all fonts. Most modern terminals handle it well, but older terminals or minimal fonts may show a box or question mark. The fallback in `statusIcon()` (line 102) returns a basic circle for unknown statuses, but `progress` is known so the fallback does not apply.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Accessibility Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The PR's accessibility impact is limited -- it adds a new `progress` status with appropriate text labels, icons, and color coding across three rendering paths. The one blocking issue is an inconsistency where `statusColor()` in format.ts was not updated to include the new `progress` status (while the other two color functions were), causing it to fall through to gray instead of cyan. This is a straightforward one-line fix. The terminal dashboard already has good accessibility practices including reduced-motion support and text-based status differentiation alongside colors.
