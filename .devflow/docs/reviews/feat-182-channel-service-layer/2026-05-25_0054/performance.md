# Performance Review Report

**Branch**: feat-182-channel-service-layer -> main
**Date**: 2026-05-25
**PR**: #193

## Issues in Your Changes (BLOCKING)

### HIGH

**Sequential broadcast delivery blocks event loop with synchronous exec calls** - `src/services/channel-manager.ts:648-656`
**Confidence**: 90%
- Problem: `broadcastToActiveMembers()` iterates active members sequentially, calling `deliverMessage()` for each. Each `deliverMessage()` call invokes `pasteContent()` which executes 3 synchronous `spawnSync` calls (load-buffer, paste-buffer, delete-buffer) plus 1 more for `sendControlKeys('Enter')`. With 10 members (max), this serializes 40 synchronous exec calls, blocking the Node.js event loop for approximately 400-1600ms (10-40ms each per FEATURE_KNOWLEDGE). This is the hot path for every broadcast/directed message routing.
- Fix: The SerialQueue already serializes per-channel ordering, so the blocking concern is not about concurrency safety -- it is about event loop starvation. Since `pasteContent` uses synchronous `spawnSync` under the hood, the only mitigation within the current tmux architecture is to ensure broadcast messages are delivered through the queue (which they are, via `handleMemberOutputAsync`). However, the `sendMessage()` public API (lines 348-411) calls `broadcastToActiveMembers` directly on the caller's async context without going through the SerialQueue. Consider routing external `sendMessage` calls through the queue as well, or document that external broadcast to 10 members will block the event loop for up to ~1.6 seconds.
```typescript
// Current: blocks caller context directly
await this.broadcastToActiveMembers(channel, message);

// Suggested: route through the serial queue like internal messages
const queue = this.messageQueues.get(channelId);
if (queue) {
  queue.enqueue(async () => {
    await this.broadcastToActiveMembers(channel, message);
  });
}
```

**Database read on every message in hot path** - `src/services/channel-manager.ts:675`
**Confidence**: 85%
- Problem: `handleMemberOutputAsync()` calls `this.channelRepository.findById(channelId)` inside the SerialQueue task for every single output message from every member. This is the hot message routing path. In an active 10-member broadcast channel with frequent output, this produces a DB read per message even though channel metadata (members, communicationMode, currentRound) changes infrequently (only on round increment or crash). Combined with the ChannelHandler also calling `findById` on the subsequent `ChannelMessageSent` event (line 128), each message triggers at least 2 DB reads.
- Fix: Cache the channel metadata in memory (keyed by channelId) and invalidate on round increment, member crash, or status change. The in-memory state already tracks handles, paused status, and current turn -- extending it to cache the Channel object is consistent with the existing pattern.
```typescript
// Add to class fields:
private readonly channelCache = new Map<string, Channel>();

// In handleMemberOutputAsync, replace findById with cache lookup:
let channel = this.channelCache.get(channelId);
if (!channel) {
  const channelResult = await this.channelRepository.findById(channelId as ChannelId);
  if (!channelResult.ok || !channelResult.value) return;
  channel = channelResult.value;
  this.channelCache.set(channelId, channel);
}

// Invalidate in cleanupInMemory(), on round increment, on member crash
```

### MEDIUM

**O(N) linear scan for session-to-channel lookup on every output** - `src/services/channel-manager.ts:747-756`
**Confidence**: 85%
- Problem: `findChannelIdBySession()` iterates the entire `memberHandles` map to find the channelId for a given session name. This is called on every output message (`handleMemberOutputAsync`) and every exit event (`handleMemberExitAsync`). With 10 channels of 10 members each (100 entries), this is 100 iterations per message. The comment acknowledges "O(N) but N is bounded by max 10 members * channels" -- however, there is no bound on the number of channels, so N grows linearly with system scale.
- Fix: Add a reverse-lookup map (`sessionName -> channelId`) maintained alongside `memberHandles`. O(1) lookup instead of O(N) scan.
```typescript
// Add to class fields:
private readonly sessionToChannel = new Map<string, string>();

// Populate in createChannel (alongside memberHandles.set):
this.sessionToChannel.set(handle.sessionName, channel.id);

// In findChannelIdBySession:
private findChannelIdBySession(sessionName: string): string | undefined {
  return this.sessionToChannel.get(sessionName);
}

// Clean up in cleanupInMemory:
for (const [session, chId] of this.sessionToChannel) {
  if (chId === channelId) this.sessionToChannel.delete(session);
}
```

**Sequential member session spawning** - `src/services/channel-manager.ts:189-197`
**Confidence**: 80%
- Problem: `createChannel()` spawns member sessions sequentially in a loop. Each `spawnMemberSession` call involves `tmuxConnector.spawn()` which includes synchronous exec calls for session creation and environment injection. With 10 members, the creation latency is the sum of all spawn times rather than the maximum. This is a one-time cost (not hot path), but it adds noticeable latency to channel creation.
- Fix: Use `Promise.all` with rollback on first failure. The sequential approach appears to be for clean rollback -- but the same rollback logic works with parallel spawning by tracking successful handles and destroying them all on any failure.
```typescript
// Parallel spawn with rollback:
const spawnPromises = request.members.map(async (member) => {
  const result = await this.spawnMemberSession(channel.name, member);
  return { memberName: member.name, result };
});
const results = await Promise.all(spawnPromises);
const failed = results.find((r) => !r.result.ok);
if (failed) {
  const successHandles = results
    .filter((r) => r.result.ok)
    .map((r) => (r.result as { ok: true; value: TmuxHandle }).value);
  await this.destroyHandles(successHandles);
  return failed.result;
}
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Recovery does sequential isAlive checks per member** - `src/services/channel-manager.ts:445-465`
**Confidence**: 82%
- Problem: `recoverChannels()` calls `this.tmuxConnector.isAlive(fakeHandle)` in a loop for every non-DESTROYED member of every active/paused channel. Each `isAlive` call is a synchronous `tmux has-session` exec (~5-10ms). The existing `TmuxSessionManagerCorePort.listSessions()` method returns all active sessions in a single exec call. Using a batch approach (one `listSessions()` call, then in-memory Set lookup) would reduce N exec calls to 1 -- the same pattern RecoveryManager already uses (per CLAUDE.md: "batch liveness checks at startup").
- Fix: Call `listSessions()` once, build a Set of alive session names, then check membership in O(1).
```typescript
async recoverChannels(): Promise<Result<void>> {
  // ... existing channel fetch code ...

  // Batch: one exec call for all sessions
  // Note: tmuxConnector doesn't expose listSessions directly,
  // but the TmuxSessionManagerCorePort does. Consider injecting it
  // or adding a listAlive() method to TmuxConnectorPort.
  const aliveSessions = new Set<string>();
  // ... populate from single listSessions() call ...

  for (const channel of channels) {
    for (const member of channel.members) {
      if (member.status === ChannelMemberStatus.DESTROYED) continue;
      if (aliveSessions.has(member.tmuxSession)) {
        aliveMembers.push(member);
      } else {
        deadMembers.push(member);
      }
    }
  }
}
```

**Sequential dead member status updates in recovery** - `src/services/channel-manager.ts:480-482`
**Confidence**: 80%
- Problem: Dead members are updated one-by-one with individual `updateMemberStatus` calls inside a loop. Each call is a separate DB write. With many dead members across channels, this serializes N individual UPDATE statements. A batch update (single SQL UPDATE with WHERE clause) would be more efficient.
- Fix: Consider adding a batch `updateMemberStatuses(channelId, memberNames[], status)` method to ChannelRepository, or use a transaction to batch the updates.

## Pre-existing Issues (Not Blocking)

No critical pre-existing performance issues found in the reviewed files.

## Suggestions (Lower Confidence)

- **Redundant sorted copy in deliverTopic and createChannel** - `src/services/channel-manager.ts:607,209` (Confidence: 65%) -- Members are sorted by `joinedAt` in multiple places (`createChannel`, `deliverTopic`, `recoverChannels`). With max 10 members, the cost is negligible, but the repeated `[...members].sort()` pattern could be consolidated into a helper if it becomes a pattern in more methods.

- **ChannelHandler DB read duplicates ChannelManager DB read** - `src/services/handlers/channel-handler.ts:128` (Confidence: 70%) -- Every `ChannelMessageSent` event triggers `findById` in the handler after the manager already read the same channel to route the message. If the channel metadata were passed in the event payload (or cached), this second read could be eliminated.

- **Named buffer contention across concurrent channels** - `src/implementations/tmux/tmux-session-manager.ts:59` (Confidence: 65%) -- `CHANNEL_BUFFER_NAME = 'beat-channel'` is a single global tmux buffer name shared across all channels. The SerialQueue serializes within a channel, but two different channels pasting content simultaneously could race on the same buffer name. Since pasteContent uses synchronous exec, the race window is narrow but theoretically possible if two threads/processes use the same tmux server.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Performance Score**: 6/10
**Recommendation**: CHANGES_REQUESTED

The main performance concern is the hot message routing path: each member output triggers an O(N) session-to-channel lookup, a database read for channel metadata, 3-4 synchronous exec calls per delivery target, and then a second database read in the ChannelHandler event listener. For a 10-member broadcast channel with active agents, this compounds to significant event loop blocking and I/O overhead per message. The reverse-lookup map and channel metadata cache are straightforward improvements that would meaningfully reduce latency on the most frequently executed code path. The sequential spawn and recovery patterns are lower priority since they execute infrequently.

Applies ADR-001 -- channel name regex ensures valid tmux session names without transformation, which avoids any sanitization overhead in the spawn/lookup path.
