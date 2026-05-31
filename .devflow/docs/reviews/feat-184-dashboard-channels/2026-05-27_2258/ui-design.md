# UI Design Review Report

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-27
**PR**: #196

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Missing `destroyed` status in global STATUS_ICONS and statusColor** - `src/cli/dashboard/format.ts`
**Confidence**: 85%
- Problem: The channel domain introduces a `destroyed` status (ChannelStatus.DESTROYED, ChannelMemberStatus.DESTROYED), but `statusColor()` and `STATUS_ICONS` in `format.ts` have no explicit `destroyed` mapping. The entity browser panel renders channels via `statusIcon(item.status)` and `statusColor(item.status)`, so destroyed channels fall through to the gray default and the generic `○` icon. While this is _functional_, it breaks the visual semantics established by other terminal statuses (`cancelled` gets `⊘` and red, `completed` gets `✓` and green). A destroyed channel gets the same icon as a `pending` or `queued` entity, which is misleading -- `○` implies "not started yet," not "terminated."
- Fix: Add explicit entries for `destroyed` in both `statusColor` and `STATUS_ICONS`. A sensible mapping that matches the semantic of "irreversibly ended":
  ```typescript
  // statusColor — add case alongside 'cancelled':
  case 'destroyed':
    return 'red';

  // STATUS_ICONS — add entry:
  destroyed: '⊘', // or '✕' — same visual weight as cancelled
  ```

**Health summary omits active channels** - `src/cli/dashboard/components/header.tsx:42-71`
**Confidence**: 82%
- Problem: `buildHealthSummary()` aggregates running/queued/failed counts from tasks, loops, schedules, orchestrations, and pipelines -- but omits `channelCounts`. Active channels (`status === 'active'`) are not reflected in the `running` total. A user with 3 active channels and no other running entities would see "idle" in the header, which is incorrect.
- Fix: Include channel active count in the `running` sum and optionally paused in `queued`:
  ```typescript
  const running =
    ... existing lines ... +
    (data.channelCounts.byStatus['active'] ?? 0);

  const queued =
    ... existing lines ... +
    (data.channelCounts.byStatus['paused'] ?? 0);
  ```
  The JSDoc comment for `buildHealthSummary` should also be updated to mention channels.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Channel detail "Recent Activity" section uses dimColor for all messages** - `src/cli/dashboard/views/channel-detail.tsx:150`
**Confidence**: 82%
- Problem: Every message row in the Recent Activity section is rendered with `<Text dimColor>`, making the activity log uniformly dim. In contrast, the loop detail view uses full-color iteration rows with status-specific coloring (green for best, cyan for running), and only _secondary_ metadata (git diff summaries, elapsed) is dimColor. The activity log is a primary data section -- rendering it entirely dim reduces its visual weight below that of the "No messages yet" empty state text, which is also dimColor. There is no visual distinction between the primary data and the absence of data.
- Fix: Use default color for the message content and only dim the round prefix or metadata:
  ```tsx
  renderItem={(msg) => (
    <Text>
      <Text dimColor>{`[R${msg.round}]`}</Text>
      {` ${msg.fromMember} → ${msg.toMember ?? '(broadcast)'}: `}
      <Text dimColor>{`"${truncateCell(msg.summary, 60)}"`}</Text>
    </Text>
  )}
  ```
  This follows the loop detail pattern where the row itself is readable and metadata is subdued.

## Pre-existing Issues (Not Blocking)

_None identified._

## Suggestions (Lower Confidence)

- **Live Preview section label uses box-drawing chars inconsistently** - `src/cli/dashboard/views/channel-detail.tsx:99` (Confidence: 65%) -- The label `"─── Live Preview (name) ───"` uses Unicode box-drawing characters directly in a string. No other detail view in the codebase uses this pattern for section headers -- they all use `<Text bold>` with optional dimColor. This creates a visual inconsistency across detail views, though it works fine functionally.

- **Channel breadcrumb lookup scans entire channels array** - `src/cli/dashboard/components/header.tsx:114` (Confidence: 62%) -- `data?.channels.find(...)` in `buildBreadcrumb` performs a linear scan on every render. For most deployments with few channels this is negligible, but it differs from other entity breadcrumbs which use `shortId()` without a data lookup. Minor concern for large channel counts.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**UI Design Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Assessment

The channel dashboard integration is well-executed from a UI design perspective. The PR follows established patterns consistently: the channel detail view mirrors the structure of loop-detail and pipeline-detail (pure component, `React.memo`, `displayName`, `Field`/`StatusField`/`StatusBadge`/`ScrollableList` composition). The member status icons (`●`/`○`) and colors (green/yellow/gray) form a coherent mini-palette with clear semantics. The entity browser panel correctly adapts its "agent" column to show member count for multi-member channels and "---" for single-agent channels. Keyboard navigation for member selection follows the D3 drill-through pattern established by orchestration children and loop iterations.

The two blocking MEDIUM issues (missing `destroyed` status mapping and health summary omission) are both straightforward consistency gaps that should be addressed before merge. The dimColor suggestion for the activity log is a softer concern about visual hierarchy that would improve readability. Overall the design choices are intentional and well-documented (AC comments, JSDoc decision records, exhaustive never guards) -- this is a clean integration into an existing design system.
