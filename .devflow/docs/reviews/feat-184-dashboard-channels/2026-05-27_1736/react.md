# React Review Report

**Branch**: feat-184-dashboard-channels -> main
**Date**: 2026-05-27

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Duplicated member-lookup logic across app.tsx and channel-detail.tsx** - `app.tsx:156-165`, `channel-detail.tsx:80-86`
**Confidence**: 85%
- Problem: The "resolve selected channel member from name with fallback to first member" logic is duplicated verbatim in two locations: the `channelDetailSessionName` useMemo in `app.tsx` (lines 156-165) and the `selectedMember` useMemo in `channel-detail.tsx` (lines 80-86). Both implement the same pattern: if `selectedMemberName !== null`, find by name with fallback to `members[0]`, else use `members[0]`. This duplication risks divergence if the selection/fallback logic is updated in one place but not the other.
- Fix: Extract a shared pure function (e.g., `resolveSelectedMember(members, selectedName)`) into a utility module and call it from both locations. This keeps the fallback semantics in one place.

**`useChannelPanePreview` has a `doCapture` in the dependency array of the polling effect that will re-create the interval on every relevant prop change** - `use-channel-pane-preview.ts:76-96`
**Confidence**: 82%
- Problem: The second `useEffect` (line 76) includes `doCapture` in its dependency array. `doCapture` is wrapped in `useCallback` with deps `[capturePaneFn, sessionName, enabled, lines]`. When `sessionName` changes, the callback identity changes, which tears down the interval and creates a new one. This is functionally correct, but the first `useEffect` (lines 68-74) also fires on `sessionName` change and resets `preview`/`error`. These two effects fire in declaration order on the same render, meaning the reset in effect 1 and the immediate `doCapture()` call in effect 2 both run. This is benign but creates a redundant `setPreview(null)` / `setError(null)` cycle followed immediately by the capture result. Consider consolidating the session-change reset into the second effect's setup to eliminate the double-update.
- Fix: Remove the first `useEffect` (lines 68-74) and move the reset logic into the second `useEffect`'s body before calling `doCapture()`:
  ```tsx
  useEffect(() => {
    closing.current = false;
    // Reset on session change
    if (prevSessionName.current !== sessionName) {
      prevSessionName.current = sessionName;
      setPreview(null);
      setError(null);
    }
    if (!enabled || sessionName === null || capturePaneFn === undefined) {
      return () => { closing.current = true; };
    }
    doCapture();
    const intervalId = setInterval(() => { doCapture(); }, POLL_INTERVAL_MS);
    return () => { closing.current = true; clearInterval(intervalId); };
  }, [doCapture, enabled, sessionName, capturePaneFn]);
  ```

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`Array.find` in multiple render-path useMemo hooks without Map/Set optimization** - `app.tsx:158,163,198`, `header.tsx:114`, `detail-view.tsx:172`
**Confidence**: 80%
- Problem: Several `useMemo` hooks and the `buildBreadcrumb` function use `Array.find()` to locate a channel by ID or a member by name within arrays. Per the React performance skill, these should use `Map`/`Set` via `useMemo` for O(1) lookups when the arrays could grow. However, channels and members are bounded by design (DEFAULT_LIMIT=100 for channels, small member counts), so the linear scan is acceptable for this entity. This is informational only.
- Impact: Negligible at current scale. Would become relevant if channel counts or member lists grew significantly.

## Suggestions (Lower Confidence)

- **`scrollOffset` prop unused in ChannelDetail** - `channel-detail.tsx:78` (Confidence: 75%) -- The `scrollOffset` prop is destructured as `_scrollOffset` and never used. If scroll behavior will be implemented later, this is fine as a placeholder. If not planned, consider removing it to keep the prop interface minimal.

- **Activity feed passes all channels (not just recent) when `channelRepository` lacks `findUpdatedSince`** - `use-dashboard-data.ts:304,368` (Confidence: 70%) -- The `fetchMetricsExtras` function receives the full `channels` array rather than a time-windowed subset (other entities use `findUpdatedSince(since1h, 50)`). This means all channels up to FETCH_LIMIT appear in the activity feed regardless of how recently they were updated. The `buildActivityFeed` sorts by timestamp and limits to 50, so stale channels will be pushed out, but they still participate in the sort. Documented in the code comment as intentional.

- **`channelService` and `channelRepo` are optional on `DashboardMutationContext` unlike other services** - `types.ts:59-62` (Confidence: 65%) -- Making these optional while `orchestrationService`, `loopService`, etc. are required creates an asymmetry. Every call site must nil-check `mutations.channelService` before use (e.g., `entity-mutations.ts:89,140-143`). This is safe but increases cognitive load; if the bootstrap always provides channelService, consider making it required.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**React Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The PR follows established project patterns well. The new `ChannelDetail` component is a clean, pure view component using `React.memo` and `displayName`. The `useChannelPanePreview` hook follows the existing `useResourceMetrics` pattern with proper cleanup, overlap guards, and unmount protection. The keyboard navigation, entity mutations, type definitions, and test coverage all extend the existing 5-entity pattern to 6 entities consistently (applies ADR-001 for channel name constraints). Hooks are called at the top level, all effects have cleanup functions, `useMemo` dependency arrays are complete, and list keys use stable domain identifiers (`member.name`, `msg.id`). The two MEDIUM blocking items are a logic duplication that risks future divergence and a minor double-state-update in the preview hook. Neither blocks merge, but both should be addressed for maintainability.
