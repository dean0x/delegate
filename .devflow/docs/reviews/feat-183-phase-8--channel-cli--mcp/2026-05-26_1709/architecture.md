# Architecture Review Report

**Branch**: feat/183-phase-8-channel-cli-mcp -> main
**Date**: 2026-05-26T17:09:00Z
**PR**: #195

## Issues in Your Changes (BLOCKING)

### HIGH

**Duplicated channel name regex between MCP adapter and domain layer** - `src/adapters/mcp-adapter.ts:569`
**Confidence**: 92%
- Problem: `channelNamePattern` at line 569 duplicates `CHANNEL_NAME_REGEX` from `src/core/domain.ts:1054`. The inline DECISION comment states this is intentional ("so the MCP layer validates without importing domain constants"), but this violates DIP and creates a drift risk. The domain already exports this constant and the MCP adapter already imports from `domain.ts` (ChannelId, ChannelStatus, CommunicationMode). There is no technical reason to avoid importing `CHANNEL_NAME_REGEX` as well. If the regex changes in domain.ts (e.g., expanding allowed characters for a future requirement), the MCP adapter's copy silently diverges, causing validation inconsistency between CLI and MCP entry points. Applies ADR-001 -- the regex must be a single source of truth since it encodes the tmux session name constraint.
- Fix: Import `CHANNEL_NAME_REGEX` from domain.ts and use it in the Zod schema:
```typescript
import { CHANNEL_NAME_REGEX } from '../core/domain.js';

// Remove: const channelNamePattern = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;
// Use CHANNEL_NAME_REGEX directly in schema:
name: z.string().regex(CHANNEL_NAME_REGEX, '...')
```

**Top-level systemPrompt in CreateChannelSchema accepted but silently dropped** - `src/adapters/mcp-adapter.ts:603-607,4270-4281`
**Confidence**: 95%
- Problem: `CreateChannelSchema` defines a top-level `systemPrompt` field (line 603-607) with description "System prompt for single-member channels (overrides per-member systemPrompt)". However, `handleCreateChannel()` constructs the `ChannelCreateRequest` (lines 4270-4281) without including `data.systemPrompt`. The field is validated by Zod, accepted without error, and then silently discarded. MCP callers who set `systemPrompt` at the top level will believe it was applied to the single member, but it was not. The CLI correctly handles this scenario by placing `systemPrompt` on the member object for single-agent channels (channel.ts:340-341).
- Fix: Wire the top-level systemPrompt into the member's systemPrompt for single-member channels:
```typescript
const request: ChannelCreateRequest = {
  name: data.name,
  members: data.members.map((m) => ({
    name: m.name,
    agent: m.agent as import('../core/agents.js').AgentProvider,
    // Top-level systemPrompt overrides per-member for single-member channels
    systemPrompt: data.systemPrompt ?? m.systemPrompt,
  })),
  // ...
};
```

### MEDIUM

**Channel MCP tool handlers repeat the unavailability guard inline instead of using a shared constant** - `src/adapters/mcp-adapter.ts:4242-4249,4326-4333,4366-4373,4441-4448,4499-4505,4548-4554,4588-4594`
**Confidence**: 85%
- Problem: All 7 channel tool handlers contain identical inline `if (!this.channelService)` blocks that construct a JSON error response. The existing orchestration tools use a pattern with a shared `ORCHESTRATION_UNAVAILABLE` constant (line 3380-3383) to avoid this repetition. The channel tools deviate from this established codebase convention.
- Fix: Add a shared constant and use it in all 7 handlers:
```typescript
private readonly CHANNEL_UNAVAILABLE: MCPToolResponse = {
  content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Channel service unavailable' }, null, 2) }],
  isError: true,
};

// In each handler:
if (!this.channelService) return this.CHANNEL_UNAVAILABLE;
```

**CLI destroy command accepts [reason] argument but ignores it in the service call** - `src/cli/commands/channel.ts:497,510`
**Confidence**: 82%
- Problem: `handleChannelDestroy` parses a `reason` from args (line 497) and displays it in the output (line 514), but always passes `'user-requested'` to `channelService.destroyChannel()` (line 510). The `ChannelDestroyReason` type is a union (`'user-requested' | 'max-rounds-reached' | 'all-members-crashed'`), so the free-text reason cannot be used as the destroy reason type. This is technically correct, but the usage string `beat channel destroy <channel-id|name> [reason]` misleads users into thinking the reason is recorded. The reason is only echoed locally and is not persisted or logged anywhere.
- Fix: Either remove `[reason]` from the usage string since it has no effect beyond local echo, or log it in the service layer. The simplest fix is to drop the misleading optional argument:
```typescript
ui.error('Usage: beat channel destroy <channel-id|name>');
// Remove: const reason = args.slice(1).join(' ') || undefined;
// Remove: if (reason) ui.info(`Reason: ${reason}`);
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Bootstrap async factory for mcpAdapter uses async registerSingleton but Container.get() is documented as synchronous** - `src/bootstrap.ts:714`
**Confidence**: 80%
- Problem: The `mcpAdapter` factory is registered via `container.registerSingleton('mcpAdapter', async () => { ... })` (line 714). This is a deviation from the existing pattern where most singletons use synchronous factories and only async operations use `container.resolve()`. The comment at line 710-713 acknowledges this and correctly notes that `container.resolve()` must be used. However, the container's type system does not enforce this at compile time -- a caller using `container.get<MCPAdapter>('mcpAdapter')` will receive a Promise instead of the MCPAdapter instance, with no type error. This is the same pattern used by `channelService` (line 375), which is also async. The pattern is defensible given the constraint (ChannelManager.create is async), but each async factory adds a footgun for future callers. The DECISION comment documents the constraint well.
- Fix: No code change required, but consider adding a compile-time guard or documentation note that `mcpAdapter` and `channelService` must use `container.resolve()`, not `container.get()`.

## Pre-existing Issues (Not Blocking)

_No CRITICAL pre-existing issues found._

## Suggestions (Lower Confidence)

- **MCP adapter tool listing duplicates JSON Schema with Zod schemas** - `src/adapters/mcp-adapter.ts:1889-2027` (Confidence: 70%) -- The CreateChannel tool's `inputSchema` JSON (lines 1889-1940) duplicates the Zod schema defined in `CreateChannelSchema` (lines 571-608). If one changes without the other, validation behavior diverges. Consider generating the JSON Schema from Zod (`.zodToJsonSchema()`) or deriving the tool listing programmatically. This is a pre-existing pattern across all MCP tools, not specific to channels.

- **CLI msg command opens two database connections sequentially** - `src/cli/commands/msg.ts:92,124` (Confidence: 65%) -- `handleMsgCommand` opens a `withReadOnlyContext()` at line 92 to resolve the channel name, closes it, then opens `withServices()` at line 124 for the full bootstrap. Two separate DB connections for a single command. This is consistent with the existing CLI pattern (read-only for queries, full bootstrap for mutations), but could be simplified to a single `withServices()` call.

- **Channel list uses raw repository queries instead of channelService** - `src/cli/commands/channel.ts:409-411` (Confidence: 62%) -- `handleChannelList` bypasses `channelService.listChannels()` and queries `channelRepository.findByStatus()` / `findAll()` directly via the read-only context. This is consistent with the existing CLI pattern for query commands (scheduleList, loopList all use read-only contexts), so it follows the established convention. Not a violation, but noted for completeness.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Architecture Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

### Assessment

The Phase 8 channel CLI and MCP integration follows the established codebase architecture well overall. The layering is correct: CLI commands parse arguments and delegate to the service layer, MCP tools validate with Zod and delegate to the same service interface, and the optional `channelService` pattern with graceful degradation is well-documented and consistent with how `orchestrationService` is handled. The read-only context for query commands and full bootstrap for mutations follows the existing convention precisely. ADR-001 is consistently cited in JSDoc comments across all boundary files.

The two HIGH findings are the most important: (1) the duplicated regex creates a drift risk that directly undermines ADR-001's single-source-of-truth intent, and (2) the silently dropped `systemPrompt` is a data loss bug that will confuse MCP callers. The MEDIUM findings are consistency improvements that align the new code with established patterns. Avoids PF-004 -- the createChannel rollback in channel-manager.ts correctly cleans all three layers (DB record via `channelRepository.delete`, tmux sessions via `destroyHandles`, in-memory state via `cleanupInMemory`).
