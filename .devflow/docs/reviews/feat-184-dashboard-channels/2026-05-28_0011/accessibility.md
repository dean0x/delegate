# Accessibility Review Report

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-28

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Selected member row dimColor text has insufficient contrast on blue background** - `src/cli/dashboard/views/channel-detail.tsx:83-84`
**Confidence**: 85%
- Problem: When a member row is selected (`backgroundColor='blue'`), the agent and status segments still use `dimColor` unconditionally. On a blue terminal background, dimmed text (typically dark gray) produces a very low contrast ratio, making these segments nearly invisible to users with low vision. The member name and icon correctly switch to `color='white'` and `bold` when selected, but the adjacent `(agent)` and `-- status` text does not.
- Fix: Conditionally disable `dimColor` when the row is selected, matching the approach used for the icon and name:
```tsx
// Before (lines 83-84):
<Text dimColor>{` (${member.agent})`}</Text>
<Text dimColor>{` — ${member.status}`}</Text>

// After:
<Text dimColor={!isSelected} color={isSelected ? 'white' : undefined}>
  {` (${member.agent})`}
</Text>
<Text dimColor={!isSelected} color={isSelected ? 'white' : undefined}>
  {` — ${member.status}`}
</Text>
```

**Channel detail hints include misleading "Enter detail" for channel view** - `src/cli/dashboard/keyboard/hints.ts:53-58`
**Confidence**: 82%
- Problem: The channel detail footer hints include `Enter detail` from `baseNoOutput`, but there is no Enter drill-through action defined for channel detail (unlike orchestrations and loops where Enter drills into child tasks/iterations). The `handleChannelNavigation` function in `handle-detail-keys.ts` does not handle `key.return`. This misleads users into pressing Enter expecting an action that does nothing, which is confusing for keyboard-only navigation.
- Fix: Use a channel-specific base hint string that omits "Enter detail":
```tsx
// In detailHints(), before the channel block:
const baseChannelDetail = 'Esc back · r refresh · q quit';

if (entityType === 'channels') {
  if (hasMutations && entityStatus === ChannelStatus.ACTIVE) {
    return `${baseChannelDetail} · ↑↓ member · p pause`;
  }
  if (hasMutations && entityStatus === ChannelStatus.PAUSED) {
    return `${baseChannelDetail} · ↑↓ member · p resume`;
  }
  return `${baseChannelDetail} · ↑↓ member`;
}
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Member status communicated only through color and icon shape without text label in member list** - `src/cli/dashboard/views/channel-detail.tsx:70-87`
**Confidence**: 80%
- Problem: Member status is conveyed through both a shaped icon (filled dot, half-dot, hollow dot) and color (green, yellow, gray). The shaped icons are a good accessibility practice (avoids color-only meaning per WCAG 1.4.1). The status text IS present via `member.status` on line 84. However, the status text segment uses `dimColor` which reduces its visibility. The icons themselves (especially the half-filled circle for idle) may not render distinctly on all terminal fonts and configurations. The prior resolution already addressed using the accessible idle icon, which is good.
- Note: This is a borderline finding. The status text IS present alongside the icon (line 84), which satisfies WCAG 1.4.1 (not color-only). The main concern is that the text uses `dimColor`, reducing its effectiveness as a fallback. The fix for the BLOCKING dimColor issue above would also address this.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Loop detail iteration rows use dimColor on blue selected background (same pattern)** - `src/cli/dashboard/views/loop-detail.tsx:84-91`
**Confidence**: 85%
- Problem: The same dimColor-on-blue-background contrast issue exists in the loop detail view. The channel detail view correctly followed this established pattern, but the pattern itself has low contrast for selected rows. This is a pre-existing issue and should not block this PR. (applies ADR-003)

## Suggestions (Lower Confidence)

- **No vi-style member navigation hint** - `src/cli/dashboard/keyboard/hints.ts:53-58` (Confidence: 65%) -- The channel detail hints show "up/down member" but do not mention the `j`/`k` keyboard shortcuts that are also supported by `handleChannelNavigation`. Other detail views similarly omit vi hints, so this is consistent, but it reduces discoverability for keyboard power users.

- **No keyboard shortcut to jump directly to channel panel from detail** - `src/cli/dashboard/keyboard/handle-detail-keys.ts` (Confidence: 62%) -- In detail view, there is no digit-key shortcut to jump to another panel (digit jumps only work in main view). This is consistent with how all other detail views work, so it is not a regression. Noting for completeness.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Accessibility Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The channel panel integration demonstrates solid keyboard navigation fundamentals: Tab cycling includes the 6th panel, digit-key jump (6) works, arrow/j/k member navigation is consistent with orchestration and loop patterns, Esc returns to main, and the footer hints adapt contextually for channels (showing "c destroy" instead of "c cancel", adding "p pause/resume" when appropriate). The member status icons use distinct shapes (filled, half-filled, hollow) alongside text labels, satisfying WCAG 1.4.1 color-not-sole-indicator. The two blocking findings are: (1) dimColor on blue selected background causing low contrast for part of the member row, and (2) misleading "Enter detail" hint in channel detail view where Enter has no action. Both are straightforward fixes.
