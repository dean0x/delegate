# React Review Report

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-27T22:58

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Unused `error` return from `useChannelPanePreview` obscures error state** - `src/cli/dashboard/app.tsx:166`
**Confidence**: 82%
- Problem: The `error` field from `useChannelPanePreview` is destructured away and never propagated. While the `ChannelDetail` component handles the null-preview case with "(session not responding)" text, there is no way to distinguish between "not yet loaded" (initial null) and "capture failed" (error null). A user who switches members sees a brief "(session not responding)" flash before the first successful poll returns, because both the reset state and the error state render identically.
- Fix: Either (a) pass the `error` field to `ChannelDetail` as a separate prop so it can show distinct text for loading vs error, or (b) document this as intentional degradation in the hook's JSDoc. Given the 3s poll interval, option (a) would provide better UX:
  ```tsx
  const { preview: channelPanePreview, error: channelPaneError } = useChannelPanePreview(...);
  // then in DetailView/ChannelDetail: show a "Loading..." state when preview===null && error===null
  ```

**`useEffect` dep array in `useChannelPanePreview` includes unstable references** - `src/cli/dashboard/use-channel-pane-preview.ts:86`
**Confidence**: 80%
- Problem: The `useEffect` at line 64 includes `doCapture` in its dependency array. `doCapture` is a `useCallback` that depends on `[capturePaneFn, sessionName, enabled, lines]`. The effect also independently lists `enabled`, `sessionName`, and `capturePaneFn` — which are already captured inside `doCapture`. This means the effect teardown/setup runs identically whether `doCapture` changes or one of the redundant deps changes, creating duplicate cleanup cycles. While functionally correct (the effect body handles all cases), the redundant deps list is misleading and deviates from the pattern in `use-resource-metrics.ts` (line 66), which lists only `[doFetch]` in its effect deps.
- Fix: Remove the redundant deps from the `useEffect` array to match the existing `useResourceMetrics` pattern:
  ```ts
  // Before
  }, [doCapture, enabled, sessionName, capturePaneFn]);
  // After — doCapture already captures all three
  }, [doCapture]);
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`useMemo` deps reference entire `view` object instead of primitives** - `src/cli/dashboard/app.tsx:163`
**Confidence**: 83%
- Problem: The `channelDetailSessionName` useMemo at line 157 lists `view` as a dependency. Since `view` is a discriminated union object (created fresh on each state transition), this means the memo recalculates on every view change even when the relevant fields (`kind`, `entityType`, `entityId`) haven't changed. The `detailEntityStatus` memo at line 198 has the same pattern. Both memos contain early-return guards so performance impact is minimal, but this is an anti-pattern per React Patterns skill [3]: "Extract primitives for `useEffect`/`useMemo` deps — avoid object/array literals."
- Fix: Extract the relevant primitives from `view` before passing to `useMemo`:
  ```tsx
  const viewKind = view.kind;
  const viewEntityType = view.kind === 'detail' ? view.entityType : null;
  const viewEntityId = view.kind === 'detail' ? view.entityId : null;

  const channelDetailSessionName = useMemo((): string | null => {
    if (viewKind !== 'detail' || viewEntityType !== 'channels') return null;
    const channel = data?.channels.find((c) => c.id === viewEntityId);
    if (channel === undefined) return null;
    const member = resolveSelectedMember(nav.channelMemberSelectedName, channel.members);
    return member?.tmuxSession ?? null;
  }, [viewKind, viewEntityType, viewEntityId, data?.channels, nav.channelMemberSelectedName]);
  ```

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Member list uses `.find()` on every render for selection comparison** - `src/cli/dashboard/views/channel-detail.tsx:130` (Confidence: 65%) — The `channel.members.map(...)` call inside the render body calls `renderMemberRow(member, member.name === (selectedMember?.name ?? ''))`. Since member lists are typically small (2-10 members), this is not a real performance concern, but if channels scale to many members, a `Set`-based lookup via `useMemo` would be more efficient.

- **`buildBreadcrumb` now accepts optional `data` parameter increasing function signature complexity** - `src/cli/dashboard/components/header.tsx:100-104` (Confidence: 62%) — The function grew from 3 to 4 parameters, with the 4th being optional and only used for one branch (`channels`). A channel-specific display name lookup could be extracted to the caller to keep the function signature stable.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**React Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The channel dashboard feature follows established patterns well — the `useChannelPanePreview` hook mirrors `useResourceMetrics`, `ChannelDetail` is a pure view component with `React.memo`, keyboard navigation uses the same handler composition pattern as orchestrations and loops, and the exhaustive switch coverage on `ChannelMemberStatus` is correct. The conditions are: (1) align `useEffect` deps in `useChannelPanePreview` with the existing `useResourceMetrics` pattern, and (2) consider surfacing the error/loading distinction in the preview panel. The `view` object in `useMemo` deps is a lower-priority cleanup.

Cross-cycle note: The Cycle 1 FP on double state-update in `useChannelPanePreview` (necessary for stale preview reset at lines 68-69) is confirmed correct — the `setPreview(null); setError(null)` pair inside the `useEffect` body is the standard React pattern for resetting derived state on dependency change. Not re-flagged.
