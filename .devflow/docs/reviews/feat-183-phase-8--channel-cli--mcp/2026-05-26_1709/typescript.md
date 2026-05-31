# TypeScript Review Report

**Branch**: feat/183-phase-8-channel-cli-mcp -> main
**Date**: 2026-05-26

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Channel-level `systemPrompt` accepted by Zod schema but silently dropped in handler** - `src/adapters/mcp-adapter.ts:603-607,4270-4281`
**Confidence**: 85%
- Problem: `CreateChannelSchema` defines an optional `systemPrompt` field at the channel level (line 603-607), but `handleCreateChannel` never maps it into the `ChannelCreateRequest` (line 4270-4281). If a caller sends `{ name: "ch", members: [...], systemPrompt: "custom" }`, Zod silently accepts it, but the field is discarded. The `ChannelCreateRequest` domain type has no top-level `systemPrompt` — it only exists on `ChannelMemberRequest`. This creates a silent data-loss path at the MCP boundary. (Applies ADR-001 — channel names validated correctly; the issue here is about prompt data, not naming.)
- Fix: Either remove the top-level `systemPrompt` from `CreateChannelSchema` (since the JSON schema listing at lines 1889-1940 does not include it and the MCP instructions only show per-member prompts), or map it into the first member's `systemPrompt` for single-member channels. Removing is simpler and consistent with the documented API:

```typescript
// In CreateChannelSchema — remove lines 602-607:
// systemPrompt: z.string().max(100_000).optional()...
```

If the intent is to support it for single-member channels (matching the CLI's `--system-prompt` behavior), map it explicitly:

```typescript
const request: ChannelCreateRequest = {
  name: data.name,
  members: data.members.map((m, i) => ({
    name: m.name,
    agent: m.agent as import('../core/agents.js').AgentProvider,
    // Channel-level systemPrompt applies to the single member in single-agent mode
    systemPrompt: m.systemPrompt ?? (data.members.length === 1 ? data.systemPrompt : undefined),
  })),
  // ...
};
```

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

### LOW

**`parseInt` without NaN guard on `--limit` flag (3 occurrences)** - `src/cli/commands/channel.ts:387`, `src/cli/commands/loop.ts:472`, `src/cli/commands/schedule.ts:558`
**Confidence**: 80%
- Problem: `limit = parseInt(next, 10)` can produce `NaN` when `next` is not numeric. `NaN` is then passed to the repository query. SQLite treats `NaN` as `NULL` in LIMIT clauses, which results in no limit being applied rather than an error. Not a crash risk, but the user gets no feedback that their input was invalid.
- Fix: Add a NaN guard after parsing:
```typescript
limit = parseInt(next, 10);
if (isNaN(limit) || limit < 1) {
  ui.error('--limit must be a positive integer');
  process.exit(1);
}
```

## Suggestions (Lower Confidence)

- **Duplicated channel name regex** - `src/adapters/mcp-adapter.ts:569` (Confidence: 70%) — `channelNamePattern` duplicates `CHANNEL_NAME_REGEX` from `domain.ts`. The DECISION comment explains the rationale (MCP layer validates without importing domain constants), but the two patterns can drift silently. Consider importing the domain constant or extracting a shared validation utility.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 1 |

**TypeScript Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Assessment

The TypeScript implementation is well-structured and follows project conventions consistently:

- **Type safety**: Uses branded `ChannelId` type throughout, Zod schemas for boundary validation, discriminated unions (`ParsedChannelCreateSingle | ParsedChannelCreateMulti`), and `Result<T>` return types. No `any` types found.
- **Import hygiene**: Proper `import type` usage for type-only imports across all new files (applies `devflow:typescript` checklist item).
- **Type assertions**: The `as` casts at Zod boundaries (e.g., `status as ChannelStatus`) follow the established codebase pattern where Zod has already validated the value. These are boundary casts, not arbitrary assertions.
- **Pure parsing functions**: `parseChannelCreateArgs` and `parseMsgArgs` are exported for testability with `Result<T, string>` return types — matches the existing `parseLoopCreateArgs` pattern.
- **Test coverage**: Schema validation tests, handler tests with mock service, and pure parsing function tests all present.

The single blocking issue is a silent data-loss path where the MCP schema accepts a field that is never consumed. The condition is `APPROVED_WITH_CONDITIONS` because the field should either be removed from the schema or mapped to the domain request to avoid silently accepting and discarding user input.
