# TypeScript Review Report

**Branch**: feat/183-phase-8--channel-cli--mcp -> main
**Date**: 2026-05-26

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

### MEDIUM

**Missing `memberName` validation in `parseMsgArgs`** - `src/cli/commands/msg.ts:73`
**Confidence**: 82%
- Problem: `channelName` is validated against `CHANNEL_NAME_REGEX` (line 80), but `memberName` is passed through without any format validation. In the `parseChannelCreateArgs` function (`channel.ts:187-191`) and in `CreateChannelSchema` (`mcp-adapter.ts:574`), member names ARE validated against the same regex. This is an inconsistency at the CLI parse boundary. While the service layer catches invalid member names via the "not found" lookup (defense-in-depth), parse-at-boundaries principle says the CLI parser should reject obviously invalid names early with a clear message rather than deferring to a generic "not found" service error.
- Fix: Add `CHANNEL_NAME_REGEX` validation for `memberName` after the slash parsing:
```typescript
if (memberName && !CHANNEL_NAME_REGEX.test(memberName)) {
  return err(
    `Invalid member name "${memberName}": must be lowercase alphanumeric with interior hyphens, max 64 chars`,
  );
}
```

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **`targetMember` lacks regex validation in `SendChannelMessageSchema`** - `src/adapters/mcp-adapter.ts:623` (Confidence: 68%) -- `targetMember` is `z.string().optional()` with no regex constraint, unlike channel/member names in `CreateChannelSchema`. The service layer catches invalid targets, but boundary validation would improve early error messages. Consistent with the `parseMsgArgs` gap above.

- **Duplicate `members.length` conditional in `handleCreateChannel` systemPrompt fallback** - `src/adapters/mcp-adapter.ts:4282` (Confidence: 62%) -- The expression `data.members.length === 1 && idx === 0` is correct but could be simplified since the `map` only iterates once when `length === 1`, making `idx === 0` always true in that case. Minor readability concern only.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**TypeScript Score**: 9/10
**Recommendation**: APPROVED_WITH_CONDITIONS

## Analysis Notes

**What was reviewed**: 18 files changed (+2623 lines), focusing on TypeScript type safety across:
- `src/adapters/mcp-adapter.ts` (7 Zod schemas, 7 handler methods, `MCPAdapterDeps` extension)
- `src/cli/commands/channel.ts` (discriminated union `ParsedChannelCreate`, pure `parseChannelCreateArgs`, 7 subcommand handlers)
- `src/cli/commands/msg.ts` (pure `parseMsgArgs`, handler)
- `src/cli/services.ts` (lazy `resolveChannelService`)
- `src/cli/read-only-context.ts` (extended `ReadOnlyContext`)
- `src/cli/dashboard/index.tsx` (added `channelRepository` to dashboard)
- `src/bootstrap.ts` (channel service registration)
- `src/adapters/mcp-instructions.ts` (channel documentation)
- `src/cli/commands/help.ts` (channel CLI help text)
- Test files (MCP adapter channel tests, CLI parsing tests, msg tests)

**Positive findings** (applies ADR-001 throughout):
1. **No `any` types** -- zero instances across all new code. All parameters and returns are explicitly typed.
2. **Result types used consistently** -- all fallible operations return `Result<T, E>`. No thrown exceptions in business logic. Pure parsing functions (`parseChannelCreateArgs`, `parseMsgArgs`) return `Result<T, string>`.
3. **Discriminated union for create modes** -- `ParsedChannelCreate = ParsedChannelCreateSingle | ParsedChannelCreateMulti` with `mode: 'single' | 'multi'` discriminant. Tests correctly narrow via `result.value.mode !== 'single'` checks.
4. **Zod schemas at boundaries** -- all MCP tool inputs validated with Zod schemas before processing. Schemas are exported for independent testing.
5. **Branded types** -- `ChannelId` branded type used correctly via `ChannelId(channelId)` constructor at service call sites.
6. **`import type` usage** -- type-only imports correctly use `import type` or inline `type` keyword throughout.
7. **Type assertions follow established pattern** -- all `as AgentProvider`, `as CommunicationMode`, `as ChannelStatus` casts are post-Zod-validation, matching the existing convention used 15+ times in the same file.
8. **Optional chaining** -- `this.channelService?.` guard pattern in every handler prevents runtime errors when service is unavailable, with actionable error messages.
9. **`readonly` modifiers** -- all interface properties, function parameters (`readonly string[]`), and class fields use `readonly`.
10. **Channel name validation** (applies ADR-001) -- `CHANNEL_NAME_REGEX` is used at every boundary: Zod schemas, CLI parser, service layer. Ensures tmux session name compatibility without transformation.
