# UI Design Review Report

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-28T14:09

## Issues in Your Changes (BLOCKING)

### HIGH

**Channel detail hint text omits arrow-key scroll for messages** - `src/cli/dashboard/keyboard/hints.ts:42`
**Confidence**: 85%
- Problem: The `baseChannel` hint string (`'Esc back · r refresh · q quit'`) omits `[/] scroll` and `G tail` even though the channel detail view contains a `ScrollableList` for the message activity log (channel-detail.tsx:160-167). When the message list exceeds `MESSAGE_VIEWPORT_HEIGHT` (10 rows), keyboard-only users have no discoverable affordance for scrolling through messages. Other detail views with scrollable lists (tasks, orchestrations) include `[/] scroll · G tail` in their hint strings. This breaks the UI pattern of surfacing all available keyboard actions in the footer.
- Fix: Add scroll hints for the message list to the channel-specific hint strings:
```ts
const baseChannel = 'Esc back · [/] scroll · G tail · r refresh · q quit';
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Destroyed channels counted as "failed" in health summary may confuse users** - `src/cli/dashboard/components/header.tsx:66`
**Confidence**: 82%
- Problem: The health summary groups `destroyed` channels under the `failed` bucket alongside genuinely failed tasks, cancelled pipelines, and failed orchestrations. Destroyed channels are a normal terminal state initiated by the user ("User cancelled via dashboard" / "user-requested") — not an error condition. Counting them as failures inflates the `fail` number in the header bar, which can mislead operators scanning the summary for actual problems. The `failed` icon is `X` — a negative signal for a user-initiated action.
- Fix: Either omit destroyed channels from the failed count (they are terminal but not failures), or add a fourth summary bucket for "done" terminal entities. The simplest fix is to remove the destroyed channel line:
```ts
// Remove this line from the `failed` calculation:
// (data.channelCounts.byStatus['destroyed'] ?? 0);
```

## Pre-existing Issues (Not Blocking)

No pre-existing UI design issues detected at CRITICAL or HIGH severity in the reviewed files.

## Suggestions (Lower Confidence)

- **Selected member row color contrast** - `src/cli/dashboard/views/channel-detail.tsx:75` (Confidence: 70%) — The selected member row uses `backgroundColor='blue'` with `color='white'` text. On some terminal emulators the blue background renders quite dark, and the white-on-blue combination may not meet the 4.5:1 WCAG contrast ratio. Most terminals handle this fine, but it depends on the color scheme. Consider using a lighter highlight or testing with popular dark/light terminal themes.

- **Message viewport height is a fixed constant (10 rows)** - `src/cli/dashboard/views/channel-detail.tsx:24` (Confidence: 65%) — `MESSAGE_VIEWPORT_HEIGHT = 10` is hardcoded. Other detail views (loop-detail.tsx uses `ITERATION_VIEWPORT_HEIGHT = 12`, task-detail.tsx uses adaptive sizing via `useElementHeight()`) adapt to terminal dimensions. For channels with many messages, 10 rows may underutilize available space on tall terminals. This is a minor consistency gap with the adaptive pattern used elsewhere.

- **`dimColor` on live preview content reduces readability** - `src/cli/dashboard/views/channel-detail.tsx:183` (Confidence: 62%) — The pane preview output is rendered with `dimColor`, which on some terminals reduces text to ~50% brightness. Task output in `DetailOutputPanel` does not use dimColor for its content lines. If the preview is the primary reason users drill into channel detail, rendering it dimmed may reduce its utility.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**UI Design Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The channel detail view is well-structured and follows established patterns (pure component, Field/StatusField/ScrollableList reuse, memo wrapping). The hint text fix for missing scroll affordance (BLOCKING) and the destroyed-as-failed health summary semantics (SHOULD-FIX) are concrete improvements. The `dimColor` fix from the prior cycle (batch-4) correctly addresses selected-row contrast on channel members — that resolution is confirmed applied. Overall the UI design is consistent with the existing dashboard views, with the two actionable items above being the main gaps.
