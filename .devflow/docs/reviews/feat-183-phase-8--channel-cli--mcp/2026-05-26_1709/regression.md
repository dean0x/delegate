# Regression Review Report

**Branch**: feat-183-phase-8--channel-cli--mcp -> main
**Date**: 2026-05-26

## Issues in Your Changes (BLOCKING)

### HIGH

**MCP CreateChannel handler silently drops top-level `systemPrompt` field** - `src/adapters/mcp-adapter.ts:4270-4281`
**Confidence**: 92%
- Problem: The `CreateChannelSchema` Zod schema defines a top-level `systemPrompt` field (line 603-607) described as "System prompt for single-member channels (overrides per-member systemPrompt)". However, `handleCreateChannel` builds the `ChannelCreateRequest` (line 4270-4281) without mapping `data.systemPrompt` to anything. Users who pass `systemPrompt` at the top level alongside a single member will have their system prompt silently accepted by validation but never applied to the member.
- Impact: A user creating a single-member channel via MCP with `{ name: "ch", members: [{ name: "ch", agent: "claude" }], systemPrompt: "Be helpful" }` would believe the prompt was applied (no error returned) but the member would be spawned without it. This is an intent vs. reality mismatch (Regression Category 3). The CLI handles this correctly via its `single` mode path (line 340-343 of `channel.ts`).
- Fix: Either (a) map the top-level `systemPrompt` to the single member in the handler when only 1 member is present:
  ```typescript
  const request: ChannelCreateRequest = {
    name: data.name,
    members: data.members.map((m, i) => ({
      name: m.name,
      agent: m.agent as import('../core/agents.js').AgentProvider,
      systemPrompt: m.systemPrompt ?? (data.members.length === 1 ? data.systemPrompt : undefined),
    })),
    // ...
  };
  ```
  Or (b) remove the top-level `systemPrompt` from `CreateChannelSchema` since per-member `systemPrompt` already covers the use case.

### MEDIUM

**MCP `listTools` JSON Schema missing top-level `systemPrompt` property for CreateChannel** - `src/adapters/mcp-adapter.ts:1889-1940`
**Confidence**: 90%
- Problem: The `CreateChannelSchema` Zod schema includes a top-level `systemPrompt` field, but the `listTools` JSON Schema definition for `CreateChannel` (lines 1889-1940) does not list `systemPrompt` in its `properties`. This means MCP clients will not discover or auto-complete this field. Combined with the handler drop issue above, the schema layer and tool listing are inconsistent.
- Impact: MCP clients relying on tool discovery will not know the field exists. If the top-level `systemPrompt` is kept in the Zod schema and the handler is fixed, this JSON Schema must be updated to match. If the Zod field is removed, no change is needed here.
- Fix: Add `systemPrompt` to the `listTools` JSON Schema `properties` if the Zod field is kept:
  ```typescript
  systemPrompt: {
    type: 'string',
    description: 'System prompt for single-member channels (max 100KB)',
  },
  ```

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **MCP DestroyChannel ignores user-provided `reason` field** - `src/adapters/mcp-adapter.ts:4335` (Confidence: 65%) -- The `DestroyChannelSchema` accepts an informational `reason` string from the user, but `handleDestroyChannel` passes hardcoded `'user-requested'` to the service and does not log the user's reason. The typed `ChannelDestroyReason` enum only allows `'user-requested' | 'max-rounds-reached' | 'all-members-crashed'`, so the free-text reason cannot be passed as-is. However, the user's informational reason could be logged for observability.

- **CLI `handleChannelDestroy` also ignores user reason in service call** - `src/cli/commands/channel.ts:510` (Confidence: 60%) -- Same pattern as the MCP handler: the user's free-text reason is parsed (line 497) but not passed to the service; only displayed via `ui.info()`. The service's typed `ChannelDestroyReason` prevents passing it, but logging it at the service layer would improve traceability.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Regression Score**: 8/10
**Recommendation**: CHANGES_REQUESTED

The PR is well-structured with no deleted exports, no removed files, no broken function signatures, and all existing consumers (withServices, bootstrap, dashboard) are backward-compatible with the new optional `channelService` field. The mcpAdapter factory change from sync to async is safe because its only consumer already uses `container.resolve()`. The blocking issue is the MCP `CreateChannel` handler dropping the top-level `systemPrompt` field that the Zod schema accepts -- this creates a silent data loss path for single-member channel users. The listTools/Zod schema inconsistency compounds it. Both are straightforward fixes.
