# Accessibility Review Report

**Branch**: feat-184-dashboard-channels -> main
**Date**: 2026-05-27
**Context**: Ink-based terminal UI (TUI) — WCAG web criteria (ARIA, HTML semantics, CSS contrast ratios) do not directly apply. Review focuses on keyboard navigation completeness, color-only meaning, cognitive load, and interaction parity.

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Channel member status relies on icon shape distinction (filled vs hollow dot) that may be indistinguishable in some terminal fonts/sizes** - `src/cli/dashboard/views/channel-detail.tsx:32-46`
**Confidence**: 82%
- Problem: `memberStatusIcon` returns `'●'` for ACTIVE/IDLE and `'○'` for DESTROYED. At small terminal font sizes or with certain terminal emulators, the visual difference between filled and hollow dot can be hard to perceive. The status text label is appended ("destroyed", "active", "idle") but only in a `dimColor` style that reduces its visibility. Color is also used (green/yellow/gray) but this doubles down on visual-only differentiation.
- Context: The existing loop detail view uses a similar icon+color pattern via `statusIcon()` from `format.ts`, so this follows the established project convention. The text label ("destroyed"/"active"/"idle") IS present, which mitigates the concern.
- Fix: This is consistent with existing patterns. The text label provides a non-color, non-icon fallback. If the team wants to improve accessibility further, consider making the status label text non-dim for the selected member row (where the user's attention is focused). No blocking change required.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Channel detail hints include "Enter detail" text but channel members have no drill-through (Enter does nothing)** - `src/cli/dashboard/keyboard/hints.ts:49-57`
**Confidence**: 85%
- Problem: The `detailHints` function for channels returns a string containing `"Enter detail"` (inherited from `baseNoOutput`). However, `handleChannelNavigation` in `handle-detail-keys.ts:292-319` does NOT handle `key.return` -- it falls through to the generic scroll handler, which swallows the key. This means the "Enter detail" hint in the footer is misleading for channel detail view users.
- Impact: Users see a keyboard hint that suggests Enter does something, but pressing Enter has no effect. This is a cognitive accessibility issue (WCAG 2.2 principle: clear, predictable behavior).
- Fix: Create a channel-specific base hint that omits "Enter detail":
```typescript
// In detailHints(), before the existing channel block:
if (entityType === 'channels') {
  const baseChannelHints = 'Esc back · ↑↓ member · r refresh · q quit';
  if (hasMutations && entityStatus === ChannelStatus.ACTIVE) {
    return `${baseChannelHints} · p pause`;
  }
  if (hasMutations && entityStatus === ChannelStatus.PAUSED) {
    return `${baseChannelHints} · p resume`;
  }
  return baseChannelHints;
}
```

## Pre-existing Issues (Not Blocking)

### LOW

**No "skip to content" or section heading navigation in detail views** - `src/cli/dashboard/views/channel-detail.tsx` (all detail views)
**Confidence**: 65% (below threshold -- moved to Suggestions)
- This is a pre-existing pattern across all detail views (loop, task, orchestration, pipeline, schedule). The channel detail follows the same convention.

## Suggestions (Lower Confidence)

- **Health summary omits channel counts** - `src/cli/dashboard/components/header.tsx:42-71` (Confidence: 70%) -- `buildHealthSummary()` does not include `channelCounts` in its running/queued tallies, meaning active channels are invisible in the global health indicator. A screen reader user or keyboard-only user relying on the header summary would not know channels exist. However, this may be an intentional design choice since channels are a different entity type.

- **Selected member row in channel detail uses blue background + white text, which depends on terminal color scheme** - `src/cli/dashboard/views/channel-detail.tsx:52-56` (Confidence: 65%) -- The blue background selection indicator follows the exact same pattern as loop detail (`loop-detail.tsx:67`), so this is a pre-existing design decision. In terminals with light blue or custom themes, the contrast may be insufficient. The `bold` attribute on selected text provides a secondary visual cue.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Accessibility Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

**Conditions**: Fix the misleading "Enter detail" hint in the channel detail footer (Should-Fix MEDIUM). The rest of the channel dashboard implementation follows established accessibility patterns well: keyboard navigation is complete (Tab, arrow keys, j/k, p, c, d, Esc all work for channels), status indicators use both icon shape AND color, text labels provide non-visual fallback, and the hint bar correctly advertises channel-specific controls.

**What works well**:
- Full keyboard parity: channels are reachable via Tab/Shift-Tab, digit key 6, arrow/j/k navigation, Enter to drill, Esc to return, p to pause/resume, c to cancel/destroy, d to delete, f to filter
- Member row selection via arrow/j/k follows the established loop iteration selection pattern
- Status indicators pair icon + color + text label (triple redundancy)
- Footer hints dynamically update for channel-specific controls (pause/resume based on status)
- Filter cycles include all channel statuses (active, paused, completed, destroyed)
