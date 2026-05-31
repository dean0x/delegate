# Performance Review Report

**Branch**: feat/183-phase-8-channel-cli-mcp -> main
**Date**: 2026-05-26

## Issues in Your Changes (BLOCKING)

### HIGH

**Sequential bootstrap resolution of channelService adds latency to every CLI command** - `src/cli/services.ts:107`
**Confidence**: 85%
- Problem: `withServices()` now awaits `container.resolve<ChannelService>('channelService')` on every CLI invocation, including commands that never use channels (e.g., `beat run`, `beat schedule create`, `beat loop`). `ChannelManager.create()` is async and involves event subscription and repository resolution. This adds measurable latency (DB access, event bus subscription) to the bootstrap path of all CLI commands.
- Fix: Resolve `channelService` lazily — only when a channel command actually needs it. Either use a getter pattern or move the resolution into the channel command handlers themselves:
  ```typescript
  // In withServices(), remove eager channelService resolution.
  // Instead, expose a lazy resolver:
  return {
    container,
    taskManager,
    scheduleService,
    loopService,
    orchestrationService,
    resolveChannelService: async () => {
      const result = await container.resolve<ChannelService>('channelService');
      return result.ok ? result.value : undefined;
    },
  };
  ```

**Async mcpAdapter factory forces await on every MCP adapter resolution** - `src/bootstrap.ts:714`
**Confidence**: 82%
- Problem: The `mcpAdapter` registration was changed from a synchronous factory to an `async` factory because `channelService` requires `container.resolve()` (async). This means every `container.resolve('mcpAdapter')` now requires an `await`, even though the MCP adapter was previously synchronously constructable. On the MCP server hot path (every tool call that resolves the adapter), this adds an unnecessary async hop. The channelService resolution inside the factory also runs `ChannelManager.create()` which subscribes to events — this work is done every time the singleton is first resolved.
- Fix: Since the container supports lazy singletons, and the `channelService` is only needed by a subset of tools, consider pre-resolving channelService outside the mcpAdapter factory and passing it as a captured value (similar to `proxyPort`):
  ```typescript
  // Resolve channelService once before mcpAdapter registration
  let channelService: ChannelService | undefined;
  const csResult = await container.resolve<ChannelService>('channelService');
  if (csResult.ok) channelService = csResult.value;
  else logger.warn('channelService unavailable', { error: csResult.error.message });

  container.registerSingleton('mcpAdapter', () => {
    // synchronous factory again
    return new MCPAdapter({ ..., channelService });
  });
  ```

### MEDIUM

**`resolveChannelIdOrExit` creates and closes a full database connection for name resolution** - `src/cli/commands/channel.ts:300-312`
**Confidence**: 85%
- Problem: `resolveChannelIdOrExit()` calls `withReadOnlyContext()` which constructs a fresh `Database` instance (SQLite open), instantiates 9 repository objects, then immediately closes the database after a single `findByName()` query. This function is called before `withServices()` in `handleChannelDestroy`, `handleChannelPause`, and `handleChannelResume` — meaning each of these commands opens and closes the database twice (once for name resolution, once for the service bootstrap).
- Fix: Defer name resolution to after `withServices()` is called, using the already-open channelService or channelRepository from the bootstrapped container:
  ```typescript
  async function handleChannelDestroy(args: string[]): Promise<void> {
    // ...
    const s = ui.createSpinner();
    s.start('Destroying channel...');
    const { channelService, container } = await withServices(s);
    // Resolve channel ID using already-open repository
    const channelRepo = getFromContainer<ChannelRepository>(container, 'channelRepository');
    const channelId = await resolveChannelId(idOrName, channelRepo);
    // ...
  }
  ```

**`handleChannelList` opens a second read-only context separate from the spinner bootstrap** - `src/cli/commands/channel.ts:403-430`
**Confidence**: 82%
- Problem: `handleChannelList` calls `withReadOnlyContext(s)` which creates a fresh Database+repositories instance. Other channel commands use `withServices()` (full bootstrap). This inconsistency is fine for read-only queries but creates a separate DB connection per invocation. For the `list` command specifically this is acceptable, but the pattern should be consistent — if `withReadOnlyContext` is the right pattern for read-only commands, then `handleChannelStatus` (line 435) should also be sufficient (and it already uses it). The performance concern is minor but worth noting for consistency.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Double channel lookup in `handleMsgCommand`: read-only context then full bootstrap** - `src/cli/commands/msg.ts:91-124`
**Confidence**: 88%
- Problem: `handleMsgCommand` opens a `withReadOnlyContext()` to resolve the channel name to an ID (including status checks), closes it, then calls `withServices(s)` which opens a full bootstrap (new DB connection, all repositories, event handlers). This is two separate database opens and closes for a single `msg` command. The read-only context lookup at lines 92-120 does a `findByName()` query, then the full service bootstrap at line 124 opens everything again.
- Fix: Either resolve the channel name inside the `withServices()` path (using the already-bootstrapped container's channelRepository), or pass the resolved channelId into the service call without the intermediate close:
  ```typescript
  export async function handleMsgCommand(args: string[]): Promise<void> {
    const parsed = parseMsgArgs(args);
    if (!parsed.ok) { ui.error(parsed.error); process.exit(1); }
    const { channelName, memberName, message } = parsed.value;

    const s = ui.createSpinner();
    s.start('Sending message...');
    const { channelService, container } = await withServices(s);
    if (!channelService) { s.stop('Failed'); ui.error('Channel service unavailable.'); process.exit(1); }

    // Resolve name using already-open repo
    const channelRepo = getFromContainer<ChannelRepository>(container, 'channelRepository');
    const channelResult = await channelRepo.findByName(channelName);
    // ... status checks, then sendMessage
  }
  ```

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`sendMessage` blocks on 10-second drain timeout for every external message** - `src/services/channel-manager.ts:453`
**Confidence**: 82%
- Problem: Every `sendMessage()` call awaits `queue.drain(10_000)` — a 10-second timeout. While the drain is documented as best-effort and typically completes instantly (mock tmuxConnector resolves synchronously), in production with a slow tmux session the caller blocks for up to 10 seconds. This timeout is not injectable, making it impossible to tune for different deployment profiles. The code comments acknowledge this limitation.
- Impact: For MCP tool calls, this means `SendChannelMessage` blocks the MCP request for up to 10 seconds if tmux is slow. Not a regression (this pattern was introduced in Phase 7), but worth noting as a performance ceiling.

## Suggestions (Lower Confidence)

- **Regex compilation on every MCP call** - `src/adapters/mcp-adapter.ts:476` (Confidence: 65%) — `channelNamePattern` is a module-level constant regex, which is correct. However, the Zod schema `.regex(channelNamePattern, ...)` re-validates the regex on every `safeParse()` call. This is negligible cost but could be cached via `z.string().refine()` with a pre-compiled test if throughput matters.

- **`cleanupInMemory` iterates all memberHandles entries** - `src/services/channel-manager.ts:1147-1160` (Confidence: 62%) — Uses `key.startsWith(prefix)` scan over all handles across all channels. With many concurrent channels this becomes O(total_members) per destroy. A nested Map (`Map<channelId, Map<memberName, TmuxHandle>>`) would make cleanup O(members_in_channel). Unlikely to matter at current scale (max 10 members per channel, few concurrent channels).

- **JSON.stringify with pretty-printing in MCP responses** - multiple locations in `src/adapters/mcp-adapter.ts` (Confidence: 60%) — All channel tool responses use `JSON.stringify(obj, null, 2)` for pretty-printing. For high-throughput MCP usage, `JSON.stringify(obj)` without indentation would reduce serialization overhead. Current usage is unlikely to be a bottleneck.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Performance Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The two HIGH findings in the blocking category both relate to the async bootstrap path: the `withServices()` function now eagerly resolves `channelService` on every CLI command (including non-channel commands), and the `mcpAdapter` factory was changed from synchronous to async to accommodate channelService. Both add unnecessary latency to hot paths. The MEDIUM finding about double database opens in `msg` and `destroy`/`pause`/`resume` commands is a clear waste of resources that compounds the bootstrap cost. The code is functionally correct and well-structured (applies ADR-003 — pre-existing issues tracked separately), and the `channelCache` in `ChannelManager` correctly avoids N+1 DB reads in the message routing hot path. The `SerialQueue` implementation is efficient (promise-chaining, no locks). Recovery uses batch `listSessions()` for O(1) liveness checks (avoids PF-004 by implementing proper 3-layer rollback). The primary improvements are about deferring work until actually needed.
