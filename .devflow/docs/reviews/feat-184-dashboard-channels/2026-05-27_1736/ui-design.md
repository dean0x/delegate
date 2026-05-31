# UI Design Review Report

**Branch**: feat-184-dashboard-channels -> main
**Date**: 2026-05-27
**PR**: #196

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Unused `scrollOffset` prop in ChannelDetail defeats future scrollability** - `src/cli/dashboard/views/channel-detail.tsx:78`
**Confidence**: 85%
- Problem: The `scrollOffset` prop is accepted but immediately aliased to `_scrollOffset` and never used. Every other detail view (loop-detail, pipeline-detail, orchestration-detail, schedule-detail) uses `scrollOffset` to implement content scrolling. The channel detail view renders an unbounded list of members and messages with no scroll mechanism. When a channel has many members or messages, the content will overflow the terminal viewport.
- Fix: Either implement scroll support using the existing `ScrollableList` component pattern from `loop-detail.tsx` (which uses `resolveIterationIndex` + viewport slicing), or at minimum apply a `height` constraint and slice the messages array by offset. If scrolling is intentionally deferred to a later phase, replace the unused prop with a JSDoc comment explaining the deferral (e.g., `/** @todo Phase 10: wire scrollOffset for long message lists */`) and remove the dead prop binding.

**Message list renders all messages without viewport bounds** - `src/cli/dashboard/views/channel-detail.tsx:143-149`
**Confidence**: 82%
- Problem: The messages section maps over the entire `messages` array (up to 50 per `DEFAULT_MESSAGE_LIMIT`) without any viewport slicing or height constraint. In a terminal TUI, rendering 50 message rows plus the header fields, member list, and live preview will push content well beyond the visible terminal area. The loop-detail view solves this with `ScrollableList` which applies viewport slicing. The pipeline-detail view similarly constrains its step list. This is the only detail view that renders an unbounded list directly.
- Fix: Use the `ScrollableList` component or manually slice messages based on available viewport height:
  ```tsx
  const visibleMessages = messages.slice(0, maxVisibleMessages);
  ```
  Where `maxVisibleMessages` is derived from terminal rows minus the fixed header/member/preview sections. Alternatively, apply a fixed `height` prop on the messages `Box` container to let Ink handle truncation.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Channel activity feed uses full channel list instead of recent-only** - `src/cli/dashboard/use-dashboard-data.ts:368`
**Confidence**: 82%
- Problem: For the activity feed, all other entity types (tasks, loops, orchestrations, schedules, pipelines) call `findUpdatedSince(since1h, 50)` to get only recently-updated entities. Channels are passed from the main fetch result (all channels up to `FETCH_LIMIT`), not filtered to the last hour. The JSDoc comment explains this is because `ChannelRepository has no findUpdatedSince`, but the effect is that old, stale channels will appear in the activity feed alongside genuinely recent activity from other entities. This creates a visual inconsistency where the activity feed shows "channel-foo: active" from 3 days ago next to "task-bar: completed 2 minutes ago".
- Fix: Filter the channels array by `updatedAt` timestamp before passing to `buildActivityFeed`:
  ```typescript
  const recentChannels = channels.filter(c => (c.updatedAt ?? c.createdAt ?? 0) >= since1h);
  ```
  This applies the same temporal filter client-side without requiring a new repository method.

**Hint text overloads `up/down` semantics in channel detail** - `src/cli/dashboard/keyboard/hints.ts:49-57`
**Confidence**: 80%
- Problem: The channel detail hints show `up/down member` alongside `Esc back` and `up/down select`. The same `up/down` keys serve two roles depending on context (member navigation in channel detail vs. generic scroll in other detail views). The hint string `baseNoOutput` already includes `up/down select` and `Enter detail`, but channel detail does not support `Enter` drill-through into a member (unlike orchestration and loop detail which drill into child tasks/iterations). Showing `Enter detail` in the hint when Enter does nothing is misleading.
- Fix: Use a channel-specific base hint that omits `Enter detail`:
  ```typescript
  const baseChannelDetail = 'Esc back . up/down member . r refresh . q quit';
  ```
  This accurately reflects the available interactions. The `p pause`/`p resume` suffix can be appended conditionally as currently implemented.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**N+1 query pattern on channel findAll** - `src/implementations/channel-repository.ts:420-424`
**Confidence**: 85%
- Problem: Each `rowToChannel` call issues a separate `findMembersByChannelIdStmt` query. The dashboard polls at 1Hz calling `findAll(FETCH_LIMIT)` which means 101 queries per second (1 for channels + up to 100 for member loads). This is documented in the code comment and acknowledged as "acceptable for Phase 6 baseline", but with the dashboard now actively polling channels every second, the query volume has increased from theoretical to actual.
- Note: This is pre-existing from Phase 6 and documented. Not blocking.

## Suggestions (Lower Confidence)

- **Live preview section competes with member list for vertical space** - `src/cli/dashboard/views/channel-detail.tsx:152-167` (Confidence: 70%) -- The live preview and member list both grow unbounded vertically. In a typical 40-row terminal with the header fields, members section, messages section, and live preview section all rendered, content will overflow. Consider allocating fixed proportions (e.g., members: 30%, messages: 40%, preview: 30% of available space) or making sections collapsible.

- **Member row selection highlight uses solid blue background** - `src/cli/dashboard/views/channel-detail.tsx:52` (Confidence: 65%) -- The `backgroundColor='blue'` for selected member rows is consistent with terminal TUI conventions but may have low contrast on some terminal color schemes where blue is dark. The orchestration detail view uses inverse/bold styling instead of background color. Minor visual inconsistency but acceptable for terminal-based UIs.

- **`ChannelService` is optional in mutation context but `channelRepo` is not** - `src/cli/dashboard/types.ts:59-62` (Confidence: 72%) -- `channelService` is declared optional (`ChannelService | undefined`) while `channelRepo` is not optional despite both being channel-related. If the channel service fails to resolve, mutations degrade for pause/resume/destroy, but `channelRepo` is always required. The asymmetry could be intentional (repo is always present after Phase 6) but the optionality pattern is inconsistent with the pipeline precedent where `pipelineRepo` is also optional.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**UI Design Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The channel detail view is well-structured, follows existing component patterns (Field, StatusBadge, StatusField), and correctly reuses the established layout conventions (paddingLeft/Right=1, marginBottom=1 header). The member status icons and color mapping are intentional and follow a consistent semantic scheme. However, the unbounded rendering of messages and the unused scroll mechanism represent a real usability gap in terminal environments where viewport space is constrained. The activity feed temporal inconsistency for channels will produce noisy feed entries once channels are in active use.
