# Performance Review Report

**Branch**: feat/183-phase-8--channel-cli--mcp -> main
**Date**: 2026-05-26

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

### MEDIUM

**N+1 query in channel repository `rowToChannel()` (documented, bounded)** - `src/implementations/channel-repository.ts:351-354`
**Confidence**: 85%
- Problem: Each `rowToChannel()` call issues a separate `findMembersByChannelIdStmt` query. For `findAll(100)` this means 101 queries total. This N+1 pattern is explicitly documented in a comment at line 345-349 as a known trade-off for Phase 6 baseline.
- Impact: Low at current scale (channels bounded by `DEFAULT_LIMIT=100`, member counts small). Could become a bottleneck if `ListChannels` is polled frequently (e.g., dashboard) or channel counts grow.
- Fix: Already documented in the codebase comment: "Optimize to a single batch IN-clause fetch if findAll/findByStatus become hot paths under production load." No action needed now, but the new CLI `beat channel list` and MCP `ListChannels` tool both exercise this path.

## Suggestions (Lower Confidence)

- **`handleChannelList` creates a read-only context that instantiates 9 repositories** - `src/cli/commands/channel.ts:396` (Confidence: 65%) -- `withReadOnlyContext()` allocates `SQLiteTaskRepository`, `SQLiteOutputRepository`, and 7 other repos just for `channelRepository.findAll()`. The lightweight context is ~200-500ms faster than full bootstrap per the module comment, but it still instantiates repositories that `channel list` never touches. A targeted context (DB + channelRepository only) would be faster for this single-entity query. However, this follows the established codebase pattern for all read-only CLI commands, so changing it would be a cross-cutting refactor.

- **`ChannelManager.create()` async factory in withServices lazy resolver is invoked per-CLI-invocation** - `src/cli/services.ts:110-115` (Confidence: 70%) -- Every `beat channel create`, `beat channel destroy`, `beat channel pause`, `beat channel resume`, and `beat msg` command calls `resolveChannelService()` which triggers `ChannelManager.create()` including event subscription setup. This is a one-shot CLI command so the cost is paid once per invocation (no accumulation), but it adds ~50-200ms to channel mutation commands compared to read-only commands. The lazy resolution pattern (non-channel commands pay zero cost) is a correct design trade-off (applies the PR description's "lazy channelService resolution" intent). No action needed.

- **`sendMessage` drains the SerialQueue with a 10-second timeout** - `src/services/channel-manager.ts:453` (Confidence: 60%) -- The `queue.drain(10_000)` call in `sendMessage()` blocks the caller for up to 10 seconds if a prior queued task is slow (e.g., a tmux paste hangs). This is an intentional safety bound, and the comment at lines 458-462 documents that a shorter timeout would require making `drainTimeoutMs` injectable. Not a defect, but worth noting as a latency cliff for the `beat msg` and MCP `SendChannelMessage` tools.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 1 | 0 |

**Performance Score**: 8/10
**Recommendation**: APPROVED

## Analysis Notes

### Positive Performance Patterns Found

1. **Lazy channelService resolution** (`src/cli/services.ts:107-115`): Non-channel CLI commands (cancel, retry, resume, etc.) never resolve `ChannelManager.create()` and pay zero startup cost. This is a well-designed performance optimization.

2. **Pre-resolution in server/run modes** (`src/bootstrap.ts:715-726`): `channelService` is pre-resolved once before `mcpAdapter` registration so the factory remains synchronous. The container's singleton caching ensures the recovery path at line 780 returns the cached instance without re-executing the factory.

3. **Parallel member spawning** (`src/services/channel-manager.ts:766`): `Promise.allSettled` parallelizes tmux session spawns so channel creation latency is `max(spawn_i)` rather than `sum(spawn_i)`.

4. **In-memory channel cache** (`src/services/channel-manager.ts:1004-1011`): The `channelCache` map eliminates DB reads inside `routeAndDeliverMessage` on the hot path (every agent output). Cache invalidation is correctly handled via `ChannelMemberCrashed` and `ChannelDestroyed` event subscriptions.

5. **Batch liveness check during recovery** (`src/services/channel-manager.ts:500-511`): Uses a single `listSessions()` call and `Set` membership for O(1) liveness checks instead of N individual tmux exec calls.

6. **SerialQueue per channel** (`src/services/channel-manager.ts:420-424`): Message ordering is maintained without a global lock. Each channel has an independent queue, so unrelated channels do not contend.

7. **Read-only context for query commands** (`src/cli/commands/channel.ts:396` and `src/cli/commands/channel.ts:435`): `handleChannelList` and `handleChannelStatus` use `withReadOnlyContext()` instead of full bootstrap, saving ~200-500ms per query by skipping EventBus, handlers, WorkerPool, etc.

### Decisions Applied

- **applies ADR-001**: Channel name validation uses `CHANNEL_NAME_REGEX` constrained to tmux `SESSION_NAME_REGEX` compatibility, avoiding runtime sanitization/transformation overhead.
- **avoids PF-004**: The `createChannel` rollback path correctly cleans all three layers (DB record via `channelRepository.delete()`, tmux sessions via `destroyHandles()`, and in-memory state via `cleanupInMemory()`), preventing orphaned resources that would require process restart to reclaim.
