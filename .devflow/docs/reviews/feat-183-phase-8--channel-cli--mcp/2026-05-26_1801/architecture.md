# Architecture Review Report

**Branch**: feat/183-phase-8--channel-cli--mcp -> main
**Date**: 2026-05-26

## Issues in Your Changes (BLOCKING)

### HIGH

**Repetitive channel service unavailability guard in MCP handlers (7 occurrences)** -- Confidence: 85%
- `src/adapters/mcp-adapter.ts:4247`, `src/adapters/mcp-adapter.ts:4333`, `src/adapters/mcp-adapter.ts:4373`, `src/adapters/mcp-adapter.ts:4448`, `src/adapters/mcp-adapter.ts:4506`, `src/adapters/mcp-adapter.ts:4555`, `src/adapters/mcp-adapter.ts:4595`
- Problem: Every channel handler repeats an identical 7-line `if (!this.channelService)` guard block. This is a Shallow Module anti-pattern (Ousterhout) -- the guard logic is duplicated rather than encapsulated, inflating the handler section by ~50 lines of pure repetition. When the error format changes (e.g. adding an error code or changing the JSON shape), all 7 sites must be updated in lockstep. The existing handlers for schedule/loop/orchestration services do not need this pattern because those services are non-optional, but the channel service optionality is a structural difference that warrants a dedicated helper.
- Fix: Extract a private `requireChannelService(): ChannelService | MCPToolResponse` guard method that returns either the service or the error response. Each handler calls it once:
```typescript
private requireChannelService(): ChannelService | MCPToolResponse {
  if (this.channelService) return this.channelService;
  return {
    content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Channel service unavailable' }, null, 2) }],
    isError: true,
  };
}

// In each handler:
const svc = this.requireChannelService();
if ('isError' in svc) return svc as MCPToolResponse;
```

### MEDIUM

**Unsafe `as` cast for agent provider in MCP CreateChannel handler** -- `src/adapters/mcp-adapter.ts:4279` -- Confidence: 82%
- Problem: `m.agent as import('../core/agents.js').AgentProvider` performs an unchecked type assertion on user input that has only been validated as `z.string().min(1)` by the Zod schema. The `CreateChannelSchema` member agent field accepts any non-empty string. If an invalid agent string reaches `channelService.createChannel()`, the error depends entirely on the service layer's internal validation -- the adapter boundary has not parsed the input. This violates the "parse at boundaries" principle from CLAUDE.md and is inconsistent with the MCP `DelegateTask` handler (line ~2075) which also uses a loose schema but benefits from `AgentRegistry` validation downstream. The CLI `parseChannelCreateArgs` correctly validates with `isAgentProvider()` (line 152), making this inconsistency more visible.
- Fix: Add agent validation against `AGENT_PROVIDERS_TUPLE` in the Zod schema, matching the existing pattern for `DelegateTask.agent`:
```typescript
// In CreateChannelSchema, members item:
agent: z.enum(AGENT_PROVIDERS_TUPLE).describe('Agent provider for this member'),
```
This eliminates the unsafe cast entirely; `data.members[i].agent` would be typed as `AgentProvider` by Zod.

**Dual schema definitions for channel tools: Zod schemas vs JSON Schema tool definitions** -- Confidence: 80%
- `src/adapters/mcp-adapter.ts:564-632` (Zod schemas), `src/adapters/mcp-adapter.ts:1886-2032` (JSON Schema tool definitions)
- Problem: Each channel tool has its constraints defined twice -- once as a Zod schema (used by handler validation) and once as a JSON Schema object (used by MCP tool listing). If a constraint changes (e.g. maxRounds upper bound, message max length), both definitions must be updated in lockstep. This is a pre-existing pattern across all MCP tools (not introduced by this PR), but this PR adds 7 more instances, widening the surface area. The Zod schemas are the authoritative validation; the JSON Schema definitions are informational for MCP clients.
- Impact: A constraint mismatch between Zod and JSON Schema would cause confusing behavior -- the MCP client sees one set of constraints, but the server enforces different ones.
- Fix: This is a known pre-existing pattern. For this PR: no change required. For a future improvement, consider generating JSON Schema from Zod using `zodToJsonSchema` or similar.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`displayReason` captured but unused in channel destroy logic** -- `src/cli/commands/channel.ts:528` -- Confidence: 85%
- Problem: The `handleChannelDestroy` function captures `args.slice(1).join(' ')` as `displayReason`, prints it to the user after destroy, but always passes the hardcoded `'user-requested'` enum value to `channelService.destroyChannel()`. The architecture comment (line 525-527) explains this is intentional because `destroyChannel()` takes a typed enum. However, the free-form CLI reason text is captured and displayed but has no path to persistence or structured use. The `DestroyChannel` MCP tool has a proper `reason` enum field, creating an asymmetry between the CLI and MCP paths.
- Fix: Either (a) accept the enum values as CLI input (`--reason user-requested`) and validate against the enum, or (b) remove the display-only reason parameter since it adds no value beyond the UI message and may confuse users who expect it to be persisted.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**MCPAdapter accumulating responsibilities** -- `src/adapters/mcp-adapter.ts` -- Confidence: 80%
- Problem: MCPAdapter is now 4,622 lines with 34+ tool handlers, each following the same parse-guard-call-match pattern. Adding 7 channel handlers expanded it by ~390 lines. The class has one reason to change per tool family (tasks, schedules, loops, orchestrations, pipelines, channels), which is 6 distinct reasons -- a clear SRP violation. The file size and handler count are approaching the "god class" threshold (1000+ lines) identified in the architecture patterns.
- Impact: Navigating, testing, and reviewing changes becomes increasingly difficult. A change to channel handler formatting requires reviewing a 4600-line file diff.
- Fix: Future refactor -- extract tool handler families into dedicated handler modules (e.g. `ChannelToolHandlers`, `ScheduleToolHandlers`) that the MCPAdapter delegates to. This is a structural improvement, not a PR-blocking issue.

## Suggestions (Lower Confidence)

- **Lazy channelService resolver could be a shared utility** -- `src/cli/services.ts:110-115` (Confidence: 65%) -- The `resolveChannelService` closure pattern (try resolve, log warning on failure, return undefined) could become a generic `lazyResolve<T>` utility if other optional services are added in the future. Currently channel is the only optional service, so the inline closure is adequate.

- **ReadOnlyContext growing with each new repository** -- `src/cli/read-only-context.ts:43-53` (Confidence: 70%) -- Every new repository (now 9 fields) expands the ReadOnlyContext interface and its factory. Consider whether a container-based approach (passing the Container itself or a subset view) would be more maintainable than explicit field enumeration.

- **Channel handler tests use `simulateToolCall` bypassing MCP protocol layer** -- `tests/unit/adapters/mcp-adapter.test.ts` (Confidence: 62%) -- The channel handler tests test schema validation and mock service delegation, but skip the MCP Server dispatch path. This is consistent with how other tool tests work in this file, but means the `case 'CreateChannel':` dispatch in the switch statement is only covered by integration tests (if any).

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Architecture Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The PR follows the established architecture patterns well. The channel service is properly integrated via dependency injection through the Container, with correct optional handling in both bootstrap paths (server: pre-resolved, cli: lazy). The layering is clean: CLI commands -> services -> repository, with pure parsing functions separated from side-effecting handlers (applies ADR-001 for channel name validation). The `resolveChannelOp` extraction eliminates duplication across mutation commands. The rollback in `ChannelManager.createChannel` correctly handles all three layers -- DB, tmux sessions, and in-memory state (avoids PF-004).

Conditions for merge:
1. Extract the repeated `channelService` unavailability guard in MCP handlers into a shared private method
2. Add agent validation to `CreateChannelSchema` member schema to match CLI parsing behavior and eliminate unsafe `as` cast
