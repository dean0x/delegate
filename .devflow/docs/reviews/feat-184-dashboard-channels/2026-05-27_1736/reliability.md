# Reliability Review Report

**Branch**: feat-184-dashboard-channels -> main
**Date**: 2026-05-27
**PR**: #196

## Issues in Your Changes (BLOCKING)

### HIGH

**capturePaneContent `lines` parameter has no upper bound** - `src/implementations/tmux/tmux-session-manager.ts:439`
**Confidence**: 90%
- Problem: The `lines` parameter in `capturePaneContent(name, lines = 10)` is passed directly into the shell command `tmux capture-pane -t '${name}' -p -S -${lines}` without any validation or clamping. A caller could pass `Number.MAX_SAFE_INTEGER`, `NaN`, `-1`, `0`, or a non-integer value, all of which would produce malformed or resource-intensive tmux commands. While the immediate callers (dashboard hook) use the default, the method is on a public port interface (`TmuxSessionManagerCorePort`) and can be called by any consumer.
- Fix: Add input validation consistent with the `validateDimensions` pattern used in `createSession`:
```typescript
capturePaneContent(name: string, lines = 10): Result<string, AutobeatError> {
  const nameCheck = validateSessionName(name, 'capturePaneContent');
  if (!nameCheck.ok) return nameCheck;

  // Bound lines to a safe range — 0 is meaningless, >10000 is excessive for display
  const MAX_CAPTURE_LINES = 10_000;
  if (!Number.isInteger(lines) || lines < 1 || lines > MAX_CAPTURE_LINES) {
    return err(
      tmuxSessionFailed('capturePaneContent', `lines must be an integer between 1 and ${MAX_CAPTURE_LINES}, got ${lines}`, {
        sessionName: name,
        lines,
      }),
    );
  }

  const result = this.deps.exec(`tmux capture-pane -t '${name}' -p -S -${lines}`);
  // ...rest unchanged
}
```

### MEDIUM

**channel_messages table grows unboundedly -- no TTL, no pruning** - `src/implementations/database.ts:1267`, `src/implementations/channel-repository.ts:165-168`
**Confidence**: 85%
- Problem: The `channel_messages` table has `ON DELETE CASCADE` on `channel_id` (so messages are cleaned when a channel row is deleted), but while a channel is active, messages accumulate without limit. A long-running channel with high message volume will grow this table indefinitely. The `getMessages` query uses `LIMIT 50` for reads, but writes are unbounded. Other entities in this codebase (task output, loop iterations) have similar patterns, but those are bounded by `max_iterations` or process lifecycle. Channel messages have no such natural ceiling.
- Fix: Consider one of:
  1. Add a `MAX_MESSAGES_PER_CHANNEL` constant and a periodic cleanup (e.g., prune to N newest on each `saveMessage` call using a DELETE subquery), or
  2. Document this as an accepted trade-off with an inline comment explaining that channel lifecycles are expected to be short enough to make this safe, and add a TODO for production monitoring.

```typescript
// Option 1: Inline prune on save (cheap — one extra DELETE per insert)
async saveMessage(msg: ChannelMessage): Promise<Result<void>> {
  return tryCatchAsync(
    async () => {
      this.saveMessageStmt.run({ ... });
      // Prune: keep only the newest 500 messages per channel
      this.db.prepare(`
        DELETE FROM channel_messages
        WHERE channel_id = ? AND id NOT IN (
          SELECT id FROM channel_messages WHERE channel_id = ? ORDER BY created_at DESC LIMIT 500
        )
      `).run(msg.channelId, msg.channelId);
    },
    operationErrorHandler('save channel message', { messageId: msg.id, channelId: msg.channelId }),
  );
}
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`codePointSlice` allocates a full Array.from() copy for every message** - `src/services/channel-manager.ts:107-108`
**Confidence**: 82%
- Problem: `Array.from(str).slice(0, maxCodePoints).join('')` converts the entire string to an array of code points before slicing. For a 10KB message, this creates a ~10K-element array just to take the first 200 elements. This runs on every `ChannelMessageSent` event in the message delivery hot path.
- Fix: Use an iterator-based approach that stops after `maxCodePoints` without allocating the full array:
```typescript
function codePointSlice(str: string, maxCodePoints: number): string {
  let count = 0;
  let endIndex = 0;
  for (const char of str) {
    if (count >= maxCodePoints) break;
    endIndex += char.length; // char.length is 1 for BMP, 2 for surrogate pairs
    count++;
  }
  return str.slice(0, endIndex);
}
```

## Pre-existing Issues (Not Blocking)

_No CRITICAL pre-existing reliability issues found in the reviewed files._

## Suggestions (Lower Confidence)

- **Polling interval not configurable** - `src/cli/dashboard/use-channel-pane-preview.ts:15` (Confidence: 65%) -- The 3-second poll interval (`POLL_INTERVAL_MS = 3_000`) is hardcoded. For channels with many members where the user is actively switching between them, this could be either too frequent (wasting tmux exec cycles when dashboard is backgrounded) or too infrequent. A minor concern since the hook guards with `enabled` and the interval is reasonable for a TUI.

- **Messages table query uses unbounded getMessages at startup** - `src/cli/dashboard/use-dashboard-data.ts:438` (Confidence: 62%) -- `ctx.channelRepository.getMessages(detail.entityId, 50)` has a hardcoded limit of 50, which is bounded. However, the `getMessages` interface default is also 50, creating implicit coupling -- if either default changes independently, behavior silently diverges. Minor concern; the explicit `50` here is fine.

- **Channel entity in activity feed uses full channel list rather than findUpdatedSince** - `src/cli/dashboard/use-dashboard-data.ts:368` (Confidence: 70%) -- The activity feed passes the full `channels` array (up to FETCH_LIMIT=100) rather than using a `findUpdatedSince` method like all other entities. The comment explains that `ChannelRepository` has no `findUpdatedSince`. This means 100 channels are passed to `buildActivityFeed` even if none changed recently. Acceptable for now since FETCH_LIMIT bounds it, but worth noting for future optimization.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Reliability Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The code follows the project's established defensive patterns well -- `Result` types throughout, best-effort error handling in event handlers, `closing`/`fetching` refs to prevent post-unmount state updates, and proper cascade deletes. The primary blocking concern is the unbounded `lines` parameter on `capturePaneContent` which sits on a public port interface. The unbounded `channel_messages` table growth is a medium-severity design concern that should be addressed or explicitly documented as accepted risk. The `codePointSlice` allocation pattern is a minor hot-path optimization opportunity. Overall, the reliability posture of this PR is solid -- bounded iteration patterns are followed, resource cleanup is handled, and assertions/guards are present at boundaries.
