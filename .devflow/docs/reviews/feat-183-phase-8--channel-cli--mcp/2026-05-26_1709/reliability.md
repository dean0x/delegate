# Reliability Review Report

**Branch**: feat/183-phase-8-channel-cli-mcp -> main
**Date**: 2026-05-26
**PR**: #195

## Issues in Your Changes (BLOCKING)

### MEDIUM

**CLI `--limit` parsed via `parseInt` with no NaN/range guard** - `src/cli/commands/channel.ts:387`
**Confidence**: 90%
- Problem: `parseInt(next, 10)` on an arbitrary user string produces `NaN` when the input is non-numeric (e.g. `--limit abc`). This `NaN` value is passed directly to `channelRepository.findAll(NaN)` or `findByStatus(status, NaN)`. SQLite may silently ignore the invalid LIMIT (implementation-dependent), but the contract is violated -- the caller expects a bounded result set. No validation checks for `NaN`, `<= 0`, or excessively large values.
- Fix:
```typescript
} else if (arg === '--limit' && next) {
  const parsed = parseInt(next, 10);
  if (isNaN(parsed) || parsed < 1 || parsed > 1000) {
    ui.error('--limit must be an integer between 1 and 1000');
    process.exit(1);
  }
  limit = parsed;
  i++;
}
```

**`handleChannelDestroy` ignores user-supplied `reason` -- always passes `'user-requested'` to service** - `src/cli/commands/channel.ts:510`
**Confidence**: 92%
- Problem: The CLI parses `reason` from `args.slice(1).join(' ')` at line 497 but then hardcodes `'user-requested'` in the `destroyChannel` call at line 510. The user-supplied reason is only displayed locally (`ui.info(...)` at line 514), never reaching the service layer or DB. This is not a reliability issue per se, but it silently discards data that the CLI advertises accepting (`beat channel destroy <id> [reason]`), which is a contract violation.
- Fix:
```typescript
const result = await channelService.destroyChannel(channelId, reason ?? 'user-requested');
```
Note: `ChannelDestroyReason` is typed as `string`, so user-supplied values are compatible. If it is a constrained union type, a mapping or validation step is needed.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`handleChannelDestroy` creates two separate bootstrap contexts -- `withServices` and `resolveChannelIdOrExit` each bootstrap independently** - `src/cli/commands/channel.ts:500-509`
**Confidence**: 85%
- Problem: `handleChannelDestroy` calls `withServices(s)` (which bootstraps a full container) and then calls `resolveChannelIdOrExit(idOrName)` which internally calls `withReadOnlyContext()` creating a second, independent database connection. This means two SQLite connections are open simultaneously for a single CLI command. While not a crash risk (SQLite WAL supports concurrent reads), it doubles resource allocation unnecessarily. The same pattern appears in `handleChannelPause` (line 529+537) and `handleChannelResume` (line 555+564).
- Fix: Resolve the channel ID using the context from `withServices` (which already has access to the channelRepository via its container), rather than opening a second context.

**`msg` command checks `channel.status` via read-only context then uses `channelService` via a separate bootstrap -- TOCTOU window** - `src/cli/commands/msg.ts:92-138`
**Confidence**: 82%
- Problem: `handleMsgCommand` opens a read-only context to look up the channel and check its status (lines 92-120), closes it, then opens a full bootstrap via `withServices` (line 124) and sends the message. Between the read-only status check and the service call, the channel status could change (e.g. another process destroys or completes it). The `channelService.sendMessage()` does re-validate status internally (line 392-405 of channel-manager.ts), so this is not exploitable in practice. However, the paused-status check at line 132 is performed against the stale read-only snapshot, and `sendMessage()` also checks paused state via `this.pausedChannels.has()` -- but only if the service's in-memory set is populated, which it is not in CLI mode (fresh bootstrap with no recovery). The service-level check (`channelRepository.findById`) inside `sendMessage` will catch it, but only in `channel.status === ChannelStatus.DESTROYED` and `COMPLETED` branches -- the paused check at line 392 uses an in-memory Set that will be empty in a CLI bootstrap. Net effect: CLI msg fast-fail for PAUSED relies on the stale read, but the service would succeed (sending to a paused channel) because the in-memory `pausedChannels` Set was not populated.
- Fix: Remove the client-side paused check (line 132-136) and let the service enforce it, or ensure the CLI bootstrap populates the in-memory paused set (e.g. by calling `recoverChannels()` or moving the check into the service).

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`sendMessage` drain timeout (10s) creates an invisible ceiling on message delivery latency** - `src/services/channel-manager.ts:453`
**Confidence**: 80%
- Problem: `await queue.drain(10_000)` waits at most 10 seconds for the SerialQueue to process all enqueued tasks. If a preceding queued task (e.g. a large broadcast from member output) is still executing when `sendMessage` is called, the external message may not be delivered within the 10-second window, and the `!delivered` guard at line 463 will return a timeout error. The timeout value is hardcoded and not configurable. The code comments at lines 458-462 acknowledge this is not testable without design changes. This is a bounded operation (good), but the bound may be too tight for production use with large channels or slow tmux sessions.
- Impact: Informational -- the bound exists and is documented. Could cause spurious delivery failures under load.

## Suggestions (Lower Confidence)

- **Double-bootstrap in `handleChannelPause` and `handleChannelResume`** - `src/cli/commands/channel.ts:529,555` (Confidence: 78%) -- Same pattern as `handleChannelDestroy`: both call `withServices` and `resolveChannelIdOrExit` which each open their own bootstrap context. Consider resolving channel ID from the `withServices` container's channelRepository instead.

- **Channel recovery fire-and-forget in bootstrap has no timeout** - `src/bootstrap.ts:778-788` (Confidence: 65%) -- `container.resolve('channelService').then(...)` followed by `recoverChannels().then(...)` is fire-and-forget with no timeout or upper bound on how long recovery can take. If `recoverChannels` blocks indefinitely (e.g. a hung tmux session), the promise chain never resolves. The existing `recoverChannels` implementation does iterate over channels sequentially (line 513: `for (const channel of channels)`) which is bounded by channel count, but individual tmux calls inside `classifyMemberLiveness` could hang.

- **`channelNamePattern` duplicated between MCP adapter and domain** - `src/adapters/mcp-adapter.ts:569,475` (Confidence: 70%) -- The channel name regex is defined inline in the MCP adapter Zod schema as well as in `domain.ts`. The DECISION comment explains the rationale (avoiding domain import in MCP layer), but if the regex changes in one place and not the other, validation will silently diverge. Not a reliability issue today, but a maintenance risk. The `avoids PF-004` rollback fix (line 260-268 in channel-manager.ts) confirms the codebase takes consistency seriously.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Reliability Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The core reliability posture is solid: all loops are bounded, assertions exist at critical validation points, the `SerialQueue` has explicit drain timeouts, and the `PF-004` rollback lesson is properly applied (3-layer rollback in `createChannel` at lines 245-269). The main concerns are around the CLI layer: missing `parseInt` validation for `--limit`, the ignored `reason` parameter in destroy, and the double-bootstrap pattern in several CLI handlers that opens unnecessary duplicate database connections. The TOCTOU gap in the `msg` command's paused-channel check is a real behavioral issue (the check will not match service-side behavior in CLI mode). These are addressable without architectural changes.
