# UI Design Review Report

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-28
**PR**: #196

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Member list uses inline rendering instead of ScrollableList for large member counts** - `src/cli/dashboard/views/channel-detail.tsx:142-146`
**Confidence**: 82%
- Problem: The member list renders all members via `channel.members.map(...)` without using the `ScrollableList` component that every other detail view uses for its scrollable section (loop iterations at line 344, pipeline stages at line 157, and the messages section at line 160 of this same file). With many channel members, this could overflow the terminal viewport without scroll indicators, breaking the visual hierarchy and making the up/down keyboard navigation feel inconsistent (members at the bottom disappear off-screen with no visual cue).
- Fix: Replace the raw `.map()` rendering with `ScrollableList`, mirroring the pattern used for messages and loop iterations:
```tsx
<ScrollableList
  items={channel.members}
  selectedIndex={selectedMember !== null ? channel.members.findIndex(m => m.name === selectedMember.name) : -1}
  scrollOffset={/* needs a dedicated member scroll offset in NavState */}
  viewportHeight={MEMBER_VIEWPORT_HEIGHT}
  renderItem={(member, _idx, isSelected) => renderMemberRow(member, isSelected)}
  keyExtractor={(member) => member.name}
/>
```
Note: This requires adding a member scroll offset to `NavState` (similar to how `scrollOffsets` track per-panel offsets) and wiring the keyboard handler to update it. For a small number of members (2-5 typical in channels), the current implementation works fine -- this becomes a concern only at scale. Severity is MEDIUM because the typical use case has few members.

**Live Preview section ternary chain has incorrect priority order** - `src/cli/dashboard/views/channel-detail.tsx:177-187`
**Confidence**: 85%
- Problem: The rendering priority is: `selectedMember === null` -> `panePreview !== null` (show content) -> `panePreviewError !== null` (show error) -> fallback `(loading...)`. This means when a member IS selected but the capture fails, the user sees `(loading...)` briefly followed by `(session not responding)`. However, if the capture succeeds and then the session dies, the stale preview text persists (from the last successful capture) rather than showing the error, because the error state only wins when `panePreview` is null. The hook (`useChannelPanePreview.ts:56-61`) does set `setPreview(null)` on error, so the actual runtime behavior is correct. However, the ternary reads as if a non-null preview would mask a non-null error. The code is functionally correct because the hook enforces mutual exclusivity between preview and error, but the rendering logic does not communicate that invariant.
- Fix: Add a brief comment documenting the mutual exclusivity invariant at the rendering site:
```tsx
{/* Invariant: useChannelPanePreview sets preview and error as mutually exclusive —
   preview !== null implies error === null, and vice versa. */}
{selectedMember === null ? (
  <Text dimColor>(no member selected)</Text>
) : panePreview !== null ? (
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Health summary does not include channel failure/destroyed counts in the "failed" total** - `src/cli/dashboard/components/header.tsx:59-65`
**Confidence**: 88%
- Problem: The `buildHealthSummary` function adds `channelCounts.byStatus['active']` to the running total and `channelCounts.byStatus['paused']` to the queued total, but does not add destroyed or failed channels to the `failed` total. Other entity types consistently include their terminal-failure statuses: tasks include `failed`, orchestrations include `failed`, pipelines include both `failed` and `cancelled`. Channels with `destroyed` status (the terminal failure equivalent) are invisible in the health summary, creating an inconsistent information hierarchy.
- Fix: Add destroyed channels to the failed count:
```typescript
const failed =
  (data.taskCounts.byStatus['failed'] ?? 0) +
  (data.loopCounts.byStatus['failed'] ?? 0) +
  (data.scheduleCounts.byStatus['cancelled'] ?? 0) +
  (data.orchestrationCounts.byStatus['failed'] ?? 0) +
  (data.pipelineCounts.byStatus['failed'] ?? 0) +
  (data.pipelineCounts.byStatus['cancelled'] ?? 0) +
  (data.channelCounts.byStatus['destroyed'] ?? 0);
```

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Member row agent/status text could use consistent column alignment** - `src/cli/dashboard/views/channel-detail.tsx:80-84` (Confidence: 65%) -- Loop detail and pipeline detail use fixed-width padding (`.padEnd()`) for column alignment in their list rows. The member row uses free-form inline text (name, agent in parens, status after dash). For 2-3 members this is fine; at scale the ragged layout reduces scannability. Low priority given typical member counts.

- **Channel detail "Live Preview" header uses `bold dimColor` combination unlike other section headers** - `src/cli/dashboard/views/channel-detail.tsx:172` (Confidence: 70%) -- The "Members" and "Recent Activity" section headers use `<Text bold>` without dimColor. The "Live Preview" header uses `<Text bold dimColor>`, creating a visual weight inconsistency between sections within the same view. This appears intentional (preview is a secondary/ambient section), but deviates from the component's own internal hierarchy pattern.

- **`detailHints` for channels shows "Enter detail" which has no action** - `src/cli/dashboard/keyboard/hints.ts:51-58` (Confidence: 72%) -- The channel detail hints include `baseNoOutput` which contains "Enter detail", but channel members have no Enter drill-through (unlike orchestration children or loop iterations that drill into task detail). Showing an inactive action hint may confuse users. Consider a dedicated base string for channels that omits "Enter detail".

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**UI Design Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The channel detail view follows established dashboard patterns well: it reuses shared components (`Field`, `StatusField`, `StatusBadge`, `ScrollableList`), maintains consistent spacing (`paddingLeft/Right={1}`, `marginTop={1}`), and uses the same color vocabulary (`green`/`yellow`/`gray` for active/idle/destroyed maps cleanly to the existing status color system). The icon vocabulary (filled/half-filled/hollow dots) is intentional and documented. The keyboard navigation mirrors the loop iteration and orchestration child patterns. The `destroyed` status correctly maps to red/cancel-icon in `format.ts`, maintaining the 4px/8px-equivalent spacing grid (Ink Box margin units).

The three conditions are: (1) add destroyed channels to the health summary failed count for information consistency, (2) consider adding a comment documenting the preview/error mutual exclusivity invariant, and (3) acknowledge the member list scaling limitation (acceptable for current use case, worth tracking if channel sizes grow). applies ADR-003 for pre-existing scope boundaries.
