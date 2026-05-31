# Reliability Review Report

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-27

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Activity feed receives all channels instead of recent ones** - `src/cli/dashboard/use-dashboard-data.ts:368`
**Confidence**: 85%
- Problem: All other entity types in the activity feed are fetched via `findUpdatedSince(since1h, 50)`, but the channels array passed to `buildActivityFeed` is the *full* `channels` list from the main parallel batch (up to FETCH_LIMIT=200). The comment at line 332 acknowledges this: "ChannelRepository has no findUpdatedSince; the main fetch result is reused." This means `buildActivityFeed` receives up to 200 channel entries while all other entity types are capped at 50 recent items. The final `entries.slice(0, limit)` mitigates the output size, but the sort step operates on a larger array than necessary and channels with old `updatedAt` can displace recent entries from other entity types before the sort-then-truncate narrows it down.
- Impact: In a deployment with many channels, the activity feed sort array grows to ~450 entries (5*50 + 200 channels) instead of ~300 (6*50). Not a correctness bug -- the final slice(0, 50) caps output -- but violates the bounded-input principle: every other entity type is already time-filtered before entering the feed. This is a minor reliability concern, not a blocking issue, but worth noting as a gap.
- Fix: Add a client-side time filter before passing channels to the feed builder:
```typescript
const recentChannels = channels.filter(c => (c.updatedAt ?? c.createdAt) >= since1h);
// ...
channels: recentChannels,
```
Or, implement `findUpdatedSince` on ChannelRepository for parity with other entities.

**`codePointSlice` allocates full code-point array for every message** - `src/services/channel-manager.ts:108`
**Confidence**: 82%
- Problem: `Array.from(str).slice(0, maxCodePoints).join('')` converts the entire input string into an array of individual code points before slicing to the first 200. If an agent produces a very large output (the message content is the full agent output from `routeAndDeliverMessage`), this creates a temporary array proportional to the input length. Agent outputs can be 10-100KB of text, meaning arrays of 10K-100K elements get allocated on every message just to extract 200 characters. This runs on every `ChannelMessageSent` event emission in the hot path.
- Impact: Short-lived GC pressure on every channel message. Not a crash risk, but unnecessary allocation in a method called frequently. Violates allocation discipline (minimize allocation in hot paths, per reliability pattern 3).
- Fix: Use an iterator-based approach that stops after `maxCodePoints`:
```typescript
function codePointSlice(str: string, maxCodePoints: number): string {
  let result = '';
  let count = 0;
  for (const cp of str) {
    if (count >= maxCodePoints) break;
    result += cp;
    count++;
  }
  return result;
}
```
This is O(maxCodePoints) allocation regardless of input length.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`getMessages` limit parameter has no upper bound** - `src/implementations/channel-repository.ts:395`
**Confidence**: 80%
- Problem: The `getMessages` method accepts an optional `limit` parameter that defaults to 50, but there is no upper-bound clamp. A caller could pass `getMessages(channelId, Infinity)` or an extremely large number, and the SQL `LIMIT ?` clause would attempt to fetch all rows. Currently the only call site passes `50`, but the interface accepts any number. Other repository methods (e.g., `findAll`) have the same pattern but are bounded by `DEFAULT_LIMIT=100`. The `MAX_MESSAGES_PER_CHANNEL=500` pruning in `saveMessage` provides an implicit ceiling, but the API contract does not enforce it.
- Impact: Defensive gap -- any future caller passing an unbounded limit would fetch all rows. Low practical risk today because the only call site is `fetchDetailExtra` with a hardcoded `50`, and pruning caps storage at 500.
- Fix: Clamp the limit:
```typescript
const effectiveLimit = Math.min(
  limit ?? SQLiteChannelRepository.DEFAULT_MESSAGE_LIMIT,
  SQLiteChannelRepository.MAX_MESSAGES_PER_CHANNEL,
);
```

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Polling interval not configurable** - `src/cli/dashboard/use-channel-pane-preview.ts:15` (Confidence: 65%) -- The `POLL_INTERVAL_MS = 3_000` constant is hardcoded. If a user has many channels open or the tmux server is under load, there is no way to reduce polling frequency. Consider making it a parameter or at least documenting the fixed interval as a conscious choice.

- **Pruning inside saveMessage is coupled to write** - `src/implementations/channel-repository.ts:384` (Confidence: 70%) -- The inline `pruneMessagesStmt.run()` inside `saveMessage` means every INSERT triggers a DELETE subquery. The DELETE uses a correlated NOT IN subquery which scans the index. Under high message throughput (many members, fast rounds), this could become a measurable overhead. The pruning could be batched (e.g., prune every 10th insert via a counter) to reduce write amplification.

- **No assertion on `event.summary` length** - `src/services/handlers/channel-message-persistence-handler.ts:95` (Confidence: 60%) -- The handler trusts that `event.summary` was already truncated by the emitter (ChannelManager's `codePointSlice`). If a future code path emits a ChannelMessageSent with a summary longer than 200 code points, the handler would persist it without bounds. A defensive length check or truncation at the persistence boundary would add defense-in-depth.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Reliability Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Conditions

1. Consider fixing the `codePointSlice` allocation pattern -- straightforward iterator replacement, no risk.
2. The activity feed asymmetry (full channel list vs. time-filtered others) is a minor gap; can be deferred if `findUpdatedSince` is planned.

### What Was Done Well

- **Bounded iteration confirmed**: `capturePaneContent` validates `lines` parameter with `MAX_CAPTURE_LINES=10_000` upper bound and integer/positive checks (applies ADR-001 -- session name validated via `SESSION_NAME_REGEX`). This directly addresses the cycle 1 finding about unvalidated `lines` parameter shell interpolation.
- **Message growth bounded**: `MAX_MESSAGES_PER_CHANNEL=500` with inline pruning prevents unbounded `channel_messages` table growth. This directly addresses the cycle 1 finding about unbounded channel_messages growth (avoids PF-004 -- three-layer rollback pattern is consistently applied in ChannelManager).
- **Polling guard**: `useChannelPanePreview` uses `fetching` ref to prevent overlapping polls and `closing` ref to prevent post-unmount setState -- matches the established `useResourceMetrics` pattern.
- **Best-effort handler**: `ChannelMessagePersistenceHandler` logs and swallows errors, never throws, never propagates -- correct pattern for non-critical display-only persistence.
- **ScrollableList for messages**: Uses the bounded `ScrollableList` component with `MESSAGE_VIEWPORT_HEIGHT=10` rather than unbounded rendering.
- **Session-not-found as ok('')**: `capturePaneContent` treats vanished sessions as empty string rather than error, avoiding error storms when sessions exit between liveness checks.
