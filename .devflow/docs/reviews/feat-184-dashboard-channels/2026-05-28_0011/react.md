# React Review Report

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-28

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

### MEDIUM

**ChannelDetail: pane preview priority renders "loading" over error when both null** - `src/cli/dashboard/views/channel-detail.tsx:177-187`
**Confidence**: 82%
- Problem: The conditional rendering chain checks `panePreview !== null` first, then `panePreviewError !== null`, then falls through to "(loading...)". The `panePreviewError` default parameter is `null`, meaning when the error prop is omitted entirely (e.g. from callers that don't pass it), the user sees "(loading...)" indefinitely if the hook never produces a non-null preview. This is technically correct given the hook always sets error on failure, but the default prop value of `null` means any caller that forgets `panePreviewError` will see perpetual loading. The ternary ordering is correct (preview > error > loading) but the priority between panePreview and panePreviewError depends on the hook always clearing one when setting the other -- which it does, so this is a minor defensive concern rather than a bug.
- Fix: No code change required. The hook (use-channel-pane-preview.ts:55-61) always sets exactly one of preview/error to non-null on each capture, so the rendering chain is safe. This is a design observation, not a defect.

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **channelDetailSessionName useMemo uses `data?.channels` as dep** - `src/cli/dashboard/app.tsx:162-168` (Confidence: 65%) -- The `data?.channels` reference in useMemo deps means the memo re-runs on every data refresh even if the channel list is unchanged. The prior resolution cycle confirmed this pattern (extracting primitives where feasible), and the `data?.channels.find()` call inside the memo inherently requires the array reference. This follows the established pattern in `detailEntityStatus` useMemo nearby. No action needed.

- **buildBreadcrumb receives full `data` for a single channel name lookup** - `src/cli/dashboard/components/header.tsx:102-127` (Confidence: 62%) -- The `buildBreadcrumb` function now receives the full `DashboardData` object just to do a `data?.channels.find()` for the AC-11 channel name display. This is a minor composition concern -- an alternative would be to pass the resolved channel name as a prop. However, Header is already wrapped in `React.memo` and the function is called once per render, so the performance impact is negligible. This follows the same pattern as how `detailEntityStatus` is resolved in app.tsx.

- **`useChannelPanePreview` closing ref pattern for synchronous function** - `src/cli/dashboard/use-channel-pane-preview.ts:41-53` (Confidence: 70%) -- The `fetching` and `closing` refs guard against overlapping polls and post-unmount setState, mirroring the pattern in `use-resource-metrics.ts`. However, `capturePaneFn` is synchronous (returns `Result<string, Error>`, not a Promise), so the `fetching` guard can never actually prevent an overlap -- `setInterval` fires after the current tick completes. The guards are harmless and defensive, and the comment documents the rationale ("same pattern as useResourceMetrics"). If `capturePaneFn` ever becomes async, these guards become essential. No action needed now.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**React Score**: 9/10
**Recommendation**: APPROVED

## Analysis Notes

### What was reviewed

All React/TSX changes in this PR:
- **New component**: `channel-detail.tsx` -- full-screen channel detail view with header fields, member list, message log, and live pane preview
- **New hook**: `use-channel-pane-preview.ts` -- polling hook for tmux capture-pane content
- **Modified components**: `app.tsx` (root shell), `detail-view.tsx` (dispatch), `entity-browser-panel.tsx` (channel columns), `header.tsx` (breadcrumb + health summary), `metrics-view.tsx` (channel counts)
- **Modified hooks/state**: `use-dashboard-data.ts` (channel data fetching), `types.ts` (NavState/ViewState/DashboardData), keyboard handlers (navigation, mutations, hints)
- **Test coverage**: 597-line test file for channel-detail, 221-line test file for the pane preview hook, plus updates to existing test files

### Strengths

1. **Consistent architecture** -- ChannelDetail follows the exact same pure-component pattern as TaskDetail, LoopDetail, OrchestrationDetail, PipelineDetail, and ScheduleDetail. Props in, JSX out, no side effects. Applies ADR-003 (pre-existing issues tracked separately).

2. **Exhaustive switch handling** -- Every switch statement on `PanelId` and `ChannelMemberStatus` includes exhaustive `never` checks (`const _exhaustive: never = ...`), preventing silent failures when new variants are added.

3. **useMemo deps extracted to primitives** -- `viewKind`, `viewEntityType`, `viewEntityId` are extracted from the `view` discriminated union and used as primitive deps in useMemo, avoiding spurious recomputations from object reference changes. This was explicitly confirmed in prior resolution cycle 2.

4. **Stable domain-key selection** -- `channelMemberSelectedName` tracks by member name (stable domain key) rather than array index, mirroring the proven `orchestrationChildSelectedTaskId` and `loopIterationSelectedNumber` patterns. This prevents selection drift when members join/leave.

5. **Hook cleanup** -- `useChannelPanePreview` returns a cleanup function that sets `closing.current = true` and calls `clearInterval`, preventing post-unmount setState. The pattern mirrors `useResourceMetrics` exactly.

6. **React.memo on all components** -- ChannelDetail, DetailView, Header, EntityBrowserPanel, MetricsView, and App are all wrapped in `React.memo` with `displayName` set, preventing unnecessary re-renders in the Ink terminal rendering pipeline.

7. **Graceful degradation** -- `capturePaneContent` prop is optional (undefined when tmux unavailable); the hook handles this gracefully by short-circuiting polling. Channel service/repo in mutations are optional. Error states are always handled.

8. **Test quality** -- Tests verify behavior (visible content in rendered frames), not implementation details. Test fixtures use factory functions with overrides. Coverage includes: header fields, round progress, member list rendering, message formatting, pane preview states (loading/error/content/no-member), and the DetailView dispatch path.
