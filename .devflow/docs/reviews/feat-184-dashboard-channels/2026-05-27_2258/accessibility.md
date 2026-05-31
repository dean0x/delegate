# Accessibility Review Report

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-27
**Context**: Terminal UI (Ink/React for terminal) -- WCAG criteria are adapted for terminal context. ARIA roles, semantic HTML, and screen reader concerns do not apply. Focus areas: keyboard navigation completeness, color-only meaning, motion preferences, and discoverability.
**Prior Resolutions**: Cycle 1 found no accessibility-specific issues. This is cycle 2.

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Member status conveyed by color-only (icon shape is insufficient differentiation)** - `src/cli/dashboard/views/channel-detail.tsx:36-54,57-76`
**Confidence**: 82%
- Problem: `memberStatusColor()` returns green/yellow/gray for ACTIVE/IDLE/DESTROYED statuses. The icon shape provides partial differentiation (filled dot vs hollow dot), but ACTIVE and IDLE both use the same filled dot icon -- only the color (green vs yellow) distinguishes them. Users with color vision deficiency or terminals with limited color support cannot distinguish ACTIVE from IDLE members.
- Fix: Add a textual or shape indicator for IDLE status. For example, use a half-filled circle or append an explicit status suffix visible to all users:
```tsx
function memberStatusIcon(status: ChannelMemberStatus): string {
  switch (status) {
    case ChannelMemberStatus.ACTIVE:
      return '●';
    case ChannelMemberStatus.IDLE:
      return '◐'; // half-filled — visually distinct from ACTIVE's filled dot
    case ChannelMemberStatus.DESTROYED:
      return '○';
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}
```
This is consistent with the existing `StatusBadge` pattern which uses distinct icons per status (not just color). Note: the existing `statusLabel` text at line 73 (`— ${statusLabel}`) does display the text, which partially mitigates this; confidence reduced from 90% to 82% accordingly.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Stale JSDoc comment: "1-5" should be "1-6"** - `src/cli/dashboard/keyboard/hints.ts:14`
**Confidence**: 95%
- Problem: The JSDoc comment on `mainHints()` says "Includes panel-jump hint (1-5)" but the actual hint text was correctly updated to "1-6: panel" and `PANEL_JUMP_KEYS` now maps 6 digits. The stale comment creates a discoverability mismatch for developers maintaining keyboard navigation.
- Fix:
```typescript
// Line 14: change (1-5) to (1-6)
* Includes panel-jump hint (1-6) and optionally c/d/p mutation hints.
```

## Pre-existing Issues (Not Blocking)

No pre-existing accessibility issues identified in unchanged code within the reviewed files.

## Suggestions (Lower Confidence)

- **Channel detail hints do not mention Enter for member drill-through** - `src/cli/dashboard/keyboard/hints.ts:49-57` (Confidence: 65%) -- The channel detail hints show `↑↓ member` but unlike orchestration/loop detail views, there is no Enter drill-through from channel members. This is consistent with the implementation (no drill-through exists), but users accustomed to the orchestration pattern may try Enter on a selected member and get no feedback. Consider adding a subtle "(no drill-through)" note or documenting this distinction.

- **Live Preview section uses `dimColor` for all content including error states** - `src/cli/dashboard/views/channel-detail.tsx:163-169` (Confidence: 62%) -- Both the "(no member selected)" and "(session not responding)" messages use `dimColor`, making error/empty states visually identical to normal preview text. In the existing dashboard, error states typically use distinct styling (e.g., `color="red"` or `color="yellow"`). However, since these are informational messages (not actionable errors), the impact is low.

- **`AUTOBEAT_REDUCE_MOTION` env var not documented in channel context** - `src/cli/dashboard/components/status-badge.tsx:19-20` (Confidence: 60%) -- The StatusBadge component (pre-existing, used by channel detail) supports `AUTOBEAT_REDUCE_MOTION=1` to disable animation for motion-sensitive users. This is a good accessibility pattern. The channel detail view inherits this behavior through `StatusBadge`. No action needed, but the env var could benefit from documentation in the README or FEATURES.md for discoverability.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Accessibility Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Rationale

This is a terminal UI, which inherently limits the applicable WCAG criteria. The implementation handles the key accessibility concerns well:

1. **Keyboard navigation**: Excellent. Full Tab/Shift+Tab panel cycling, digit jump keys (1-6), arrow/j/k member navigation, Enter drill-through, Esc return, filter cycling, pause/resume/cancel/delete -- all keyboard-accessible. No mouse-only interactions.

2. **Focus management**: Proper. Panel focus state is tracked via `focusedPanel`, selection indices reset on view transitions, member selection resets on detail entry. Follows the existing orchestration/loop navigation patterns.

3. **Key hints/discoverability**: Footer hints correctly show context-sensitive shortcuts for channel detail (`↑↓ member · p pause/resume`). The `1-6: panel` range is updated throughout.

4. **Motion preferences**: Inherited. `StatusBadge` respects `AUTOBEAT_REDUCE_MOTION` / `NO_MOTION` environment variables.

5. **Color usage**: The one blocking finding (ACTIVE vs IDLE differentiation) is partially mitigated by the status text label rendered alongside each member row. The member status text (`— active`, `— idle`, `— destroyed`) ensures non-color-reliant users can identify status.

The single blocking issue (MEDIUM severity) is a minor icon differentiation gap that has a textual fallback already in place, making it low-impact. The stale JSDoc is a documentation hygiene item.
