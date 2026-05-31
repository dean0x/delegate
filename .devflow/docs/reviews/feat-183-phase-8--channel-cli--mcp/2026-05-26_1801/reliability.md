# Reliability Review Report

**Branch**: feat/183-phase-8--channel-cli--mcp -> main
**Date**: 2026-05-26

## Issues in Your Changes (BLOCKING)

### HIGH

**SerialQueue.drain() timeout silently drops undelivered messages in sendMessage** - `src/services/channel-manager.ts:453`
**Confidence**: 85%
- Problem: `sendMessage` calls `queue.drain(10_000)` and then checks a `delivered` boolean. If the drain timeout expires before the enqueued closure executes, the method returns `err("Message delivery timed out")` — but the enqueued task remains in the chain and may still execute later, after the caller has already been told delivery failed. This creates a TOCTOU window: the caller retries or reports failure while the original message is still in-flight and may be delivered to the tmux session. The `delivered` boolean and `dispatchError` variables are mutated from inside the enqueued closure after `drain()` has already resolved, meaning the `sendMessage` method races the queue task.
- Fix: Either (a) make the enqueued task cancellable when the drain times out (e.g., set a `cancelled` flag that the closure checks before dispatching), or (b) document this race explicitly as a known limitation and ensure idempotent message delivery at the tmux layer. A cancellation token pattern would prevent the stale-delivery race:
```typescript
let cancelled = false;
queue.enqueue(async () => {
  if (cancelled) return;
  // ... dispatch logic
});
await queue.drain(10_000);
if (!delivered) {
  cancelled = true;
  return err(...);
}
```

**No resource cleanup (DB connection) on early process.exit() in CLI mutation commands** - `src/cli/commands/channel.ts:314-317`, `src/cli/commands/msg.ts:104-108`
**Confidence**: 82%
- Problem: When `channelService` is `undefined` (unavailable), the handlers call `process.exit(1)` immediately after `withServices()` has bootstrapped the full container (DB, event bus, etc.). The container is never disposed. While this is a CLI (short-lived process), SQLite WAL mode can leave `-wal` and `-shm` files that are not properly checkpointed on hard exit, and any pending async operations (e.g., recovery tasks started by bootstrap) are abruptly terminated. The `handleChannelCreate` path is the most visible: it bootstraps, gets `undefined`, and exits without cleanup.
- Fix: Store the container reference and call `container.dispose()` before `process.exit()`, or use a `finally` block:
```typescript
const { container, resolveChannelService } = await withServices(s);
const channelService = await resolveChannelService();
if (!channelService) {
  s.stop('Failed');
  ui.error('Channel service unavailable.');
  await container.dispose();
  process.exit(1);
}
```

### MEDIUM

**resolveChannelId silently swallows repository errors** - `src/cli/commands/channel.ts:289-297`
**Confidence**: 88%
- Problem: `resolveChannelId` returns `null` for both "not found" and "repository error" cases (`if (!result.ok) return null`). A database connection failure, corrupt index, or query timeout would be reported as "Channel not found" rather than the actual error. This masks transient failures as permanent-not-found conditions, which could mislead operators.
- Fix: Return the error or propagate it so the caller can distinguish "not found" from "failed to look up":
```typescript
async function resolveChannelId(
  idOrName: string,
  channelRepository: ChannelRepository,
): Promise<Result<ChannelId | null>> {
  if (idOrName.startsWith('ch-')) return ok(ChannelId(idOrName));
  const result = await channelRepository.findByName(idOrName);
  if (!result.ok) return result; // propagate error
  if (!result.value) return ok(null);
  return ok(result.value.id);
}
```

**handleChannelCreate does not dispose container on success or failure paths** - `src/cli/commands/channel.ts:301-358`
**Confidence**: 83%
- Problem: `handleChannelCreate` calls `withServices()` which bootstraps the full container, but never disposes it. On success, it calls `process.exit(0)` — the container (including DB connection, event bus, channel manager with tmux subscriptions) is abandoned. While `process.exit()` triggers OS cleanup for file descriptors, SQLite WAL checkpoint and any pending event handler async work may not complete. This pattern is consistent across `handleChannelDestroy`, `handleChannelPause`, `handleChannelResume`, and `handleMsgCommand` — all 5 mutation handlers share this issue.
- Fix: Call `container.dispose()` before `process.exit()` on all paths, or wrap the handler body in a try/finally that disposes the container. Consolidating this into `withServices` as a cleanup callback would avoid repetition.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Bootstrap channel recovery uses fire-and-forget async with no upper bound on concurrent work** - `src/bootstrap.ts:780-791`
**Confidence**: 80%
- Problem: The channel recovery block at bootstrap resolves the channel service and then calls `recoverChannels()` in a fire-and-forget `.then()` chain. While `recoverChannels()` itself iterates channels sequentially with `for...of` + `await`, the outer `.then()` chain means any unhandled rejection inside `resolve()` that isn't caught by the `.then()` error handler could crash the process in Node.js strict mode. The error is logged but the `.then()` error path only handles `channelServiceResult` failure — it does not wrap the `recoverChannels()` call in a catch. If `recoverChannels()` throws synchronously (unlikely but not impossible given it calls into tmux exec), the promise would reject unhandled.
- Fix: Chain the error handler to cover both resolution and recovery:
```typescript
container.resolve<ChannelService>('channelService').then(async (result) => {
  if (!result.ok) {
    logger.error('Failed to resolve ChannelService for recovery', result.error);
    return;
  }
  const recoveryResult = await result.value.recoverChannels();
  if (!recoveryResult.ok) {
    logger.error('Channel recovery failed', recoveryResult.error);
  }
}).catch((e) => {
  logger.error('Unexpected error in channel recovery', e instanceof Error ? e : new Error(String(e)));
});
```

## Pre-existing Issues (Not Blocking)

### MEDIUM

**SerialQueue has no backpressure or bounded capacity** - `src/services/channel-manager.ts:55-94`
**Confidence**: 82%
- Problem: The `SerialQueue` class used for per-channel message ordering has no limit on queue depth. In a scenario where a channel has many members producing output faster than tmux paste+enter can consume it, the promise chain grows unboundedly. Each `enqueue()` appends to the chain without checking whether the queue is at capacity. For channels with high-throughput agents or rapid round-robin cycles, this could accumulate an arbitrarily large number of pending closures in memory. (avoids PF-004 — rollback is now three-layer)
- Fix: Add a bounded capacity check to `enqueue()` that either drops messages when at capacity (with a logged warning) or rejects them with backpressure. A simple approach:
```typescript
private pending = 0;
private static MAX_PENDING = 1000;

enqueue(task: () => Promise<void>, onError?: (e: unknown) => void): void {
  if (this.closed) return;
  if (this.pending >= SerialQueue.MAX_PENDING) {
    onError?.(new Error('Queue capacity exceeded'));
    return;
  }
  this.pending++;
  this.chain = this.chain.then(/* ... */).finally(() => { this.pending--; });
}
```

## Suggestions (Lower Confidence)

- **drain() timer leak on early chain resolution** - `src/services/channel-manager.ts:86-93` (Confidence: 65%) — When `this.chain` resolves before the timeout, `clearTimeout(timer)` runs, but if `drain()` is called multiple times concurrently (e.g., from overlapping external sends), the `Promise.race` may resolve from a prior drain's timer. The current usage appears single-caller per channel, but this fragility could surface under concurrent `sendMessage` calls.

- **channelService pre-resolve await at bootstrap may delay MCP server startup** - `src/bootstrap.ts:716-726` (Confidence: 70%) — In server/run modes, `await container.resolve<ChannelService>('channelService')` blocks bootstrap completion on `ChannelManager.create()`, which subscribes to events and potentially runs async initialization. If tmux validation or the channel repository is slow, this delays MCP server availability. A lazy resolution at first tool call (like the CLI path) would avoid blocking startup.

- **msg command TOCTOU between channel status check and sendMessage** - `src/cli/commands/msg.ts:131-152` (Confidence: 62%) — The CLI reads channel status from the repository, checks for DESTROYED/COMPLETED/PAUSED, then calls `channelService.sendMessage()`. The channel status could change between the read and the service call. The service layer has its own guards, so this is defense-in-depth, but the intermediate reads add latency without providing atomicity guarantees.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Reliability Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The core channel CLI and MCP tooling is well-structured with consistent validation at boundaries (applies ADR-001), proper Result type propagation, and graceful degradation when the channel service is unavailable. The three-layer rollback in createChannel correctly handles the PF-004 pitfall (avoids PF-004). However, the SerialQueue drain race in sendMessage creates a real window where a timed-out message can still be delivered after the caller is told it failed, and the CLI mutation handlers consistently skip container disposal before `process.exit()`. These two patterns are the primary reliability gaps. The HIGH-severity items should be addressed before merge; the MEDIUM items are quality improvements that would strengthen the codebase but are not blocking.
