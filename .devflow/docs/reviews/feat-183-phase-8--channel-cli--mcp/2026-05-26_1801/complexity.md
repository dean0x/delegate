# Complexity Review Report

**Branch**: feat/183-phase-8--channel-cli--mcp -> main
**Date**: 2026-05-26

## Issues in Your Changes (BLOCKING)

### HIGH

**`parseChannelCreateArgs` is 137 lines with high cyclomatic complexity** - `src/cli/commands/channel.ts:74`
**Confidence**: 90%
- Problem: This function spans lines 74-210 (137 lines) and contains a for-loop with 10 `if/else if` branches for flag parsing, followed by 7 sequential validation checks with early returns. Cyclomatic complexity is approximately 18-20 (each branch, each early return, each conditional contributes). This exceeds the warning threshold (50 lines) and approaches critical cyclomatic complexity (>20). The function handles two concerns: argument tokenization/extraction AND multi-mode semantic validation.
- Fix: Split into two functions: (1) a tokenizer that extracts raw flag values into a `RawChannelCreateFlags` struct, and (2) a validator that applies semantic rules (mutual exclusion, mode-specific constraints). This halves each function's complexity and makes the validation logic independently testable.

```typescript
// Step 1: Extract raw flags (pure tokenizer, ~50 lines)
function tokenizeChannelCreateFlags(args: readonly string[]): Result<RawChannelCreateFlags, string> { ... }

// Step 2: Validate semantics (pure validator, ~60 lines)  
function validateChannelCreateFlags(flags: RawChannelCreateFlags): Result<ParsedChannelCreate, string> { ... }

// Compose
export function parseChannelCreateArgs(args: readonly string[]): Result<ParsedChannelCreate, string> {
  const flags = tokenizeChannelCreateFlags(args);
  if (!flags.ok) return flags;
  return validateChannelCreateFlags(flags.value);
}
```

### MEDIUM

**`handleCreateChannel` MCP handler is 82 lines with 4-level nesting** - `src/adapters/mcp-adapter.ts:4238`
**Confidence**: 82%
- Problem: The `handleCreateChannel` handler (lines 4238-4319) is 82 lines with nesting reaching 4 levels inside the `match(result, { ok: ... })` callback. It handles Zod parse, channelService guard, path validation, request construction with conditional systemPrompt mapping, and result matching. The `systemPrompt` ternary on line 4282 (`m.systemPrompt ?? (data.members.length === 1 && idx === 0 ? data.systemPrompt : undefined)`) packs significant business logic into a single expression.
- Fix: Extract the `ChannelCreateRequest` construction into a helper function (e.g. `buildChannelCreateRequest(data)`) to reduce the handler to parse-guard-delegate-respond, matching the simpler channel handlers. The systemPrompt mapping logic would be clearer as a named function.

**`handleChannelStatus` MCP handler is 70 lines with deep nesting in success path** - `src/adapters/mcp-adapter.ts:4364`
**Confidence**: 80%
- Problem: The `ChannelStatus` handler (lines 4364-4433) nests a null check inside the `ok` callback of `match()`, producing a 5-level deep path: method > if > match > ok callback > if null > return. The success path constructs a large inline JSON object (15+ fields across members). This is the most complex of the 7 channel handlers. Applies ADR-001 -- channel name validated at boundary.
- Fix: Extract the channel-to-JSON serialization into a `serializeChannelStatus(channel: Channel)` helper. The null check can use an early-return guard before `match()` by switching to manual `result.ok` checking.

**`handleMsgCommand` has 3 sequential status checks with identical error patterns** - `src/cli/commands/msg.ts:131-148`
**Confidence**: 85%
- Problem: Lines 131-148 contain three sequential `if (channel.status === ...)` blocks, each with the same structure: stop spinner, print error, exit. This is 18 lines of near-identical code differing only in the status constant and error message. The pattern increases cognitive load without adding distinct logic.
- Fix: Use a status rejection map:

```typescript
const REJECTED_STATUSES: Record<string, string> = {
  [ChannelStatus.DESTROYED]: `Channel "${channelName}" is destroyed. Create a new channel with: beat channel create ${channelName} ...`,
  [ChannelStatus.COMPLETED]: `Channel "${channelName}" has completed and no longer accepts messages.`,
  [ChannelStatus.PAUSED]: `Channel "${channelName}" is paused. Resume with: beat channel resume ${channelName}`,
};
const rejection = REJECTED_STATUSES[channel.status];
if (rejection) {
  s.stop('Failed');
  ui.error(rejection);
  process.exit(1);
}
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**MCP adapter file is 4,622 lines -- channel additions push it further** - `src/adapters/mcp-adapter.ts`
**Confidence**: 85%
- Problem: The MCP adapter was already well past the critical file length threshold (>500 lines) before this PR. This PR adds 643 lines (7 Zod schemas, 7 inline JSON tool schemas, 7 handler methods, constructor/switch wiring). The file now has 39 registered tools and 41 switch cases. While each individual handler follows the established pattern, the file's aggregate complexity makes navigation, testing, and modification increasingly costly. This is a pre-existing structural issue that this PR exacerbates.
- Fix: Not blocking for this PR (pre-existing architecture). For future consideration: extract channel handlers into a `ChannelToolHandlers` class or module that the adapter delegates to. The pattern of "Zod schema + inline JSON schema + handler method" repeated 7 times is a natural extraction boundary.

**Dual schema definitions -- Zod schemas AND inline JSON schemas for every channel tool** - `src/adapters/mcp-adapter.ts:562-632, 1886-2032`
**Confidence**: 82%
- Problem: Each channel tool has its schema defined twice: once as a Zod schema (used for runtime validation in handlers, lines 562-632) and once as an inline JSON schema object (used for MCP `list_tools`, lines 1886-2032). These must be kept in sync manually. For example, `CreateChannelSchema` defines `maxRounds` with `.max(10_000)` and the JSON schema defines `maximum: 10000` -- a divergence between either copy would cause silent validation mismatches. This is a pre-existing pattern across all MCP tools (not introduced by this PR).
- Fix: Not blocking for this PR (pre-existing pattern). Future improvement: use `zodToJsonSchema()` to generate the `list_tools` entries from the Zod schemas, eliminating the duplication.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`callTool` switch statement has 41 cases** - `src/adapters/mcp-adapter.ts:710-795`
**Confidence**: 90%
- Problem: The tool dispatch switch now has 41 case branches. While each branch is trivially simple (single delegation call), the sheer count makes it difficult to scan and easy to miss a tool. Cyclomatic complexity of the switch alone is 41. Pre-existing -- this PR added 7 of 41.
- Fix: Replace the switch with a `Map<string, (args: unknown) => Promise<MCPToolResponse>>` dispatch table, populated at construction time.

## Suggestions (Lower Confidence)

- **Repeated `channelService` guard pattern (7 occurrences)** - `src/adapters/mcp-adapter.ts:4247,4333,4373,4448,4506,4555,4595` (Confidence: 70%) -- Each of the 7 channel handlers repeats the same 6-line channelService availability check with identical error response. A `requireChannelService()` helper returning `ChannelService | MCPToolResponse` could eliminate the repetition, but this matches the existing pattern for other optional services.

- **`handleChannelList` inline arg parsing** - `src/cli/commands/channel.ts:362-393` (Confidence: 65%) -- The list handler has its own inline arg loop (lines 366-381) rather than using a pure parsing function like `parseChannelCreateArgs`. Extracting it would improve testability, but the function is short enough (60 lines) that this is a minor style concern.

- **`handleChannelStatus` outputs "Members:" label unconditionally then conditionally lists them** - `src/cli/commands/channel.ts:456,466` (Confidence: 62%) -- Line 456 always prints `Members: N` and line 466 conditionally prints the "Members:" header again with the detailed list. The double "Members" label may confuse output readers.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 3 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Complexity Score**: 6/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The new code follows established patterns consistently (applies ADR-001 for channel name validation). The `parseChannelCreateArgs` function at 137 lines with ~18 cyclomatic complexity is the primary concern and should be split before merge. The MCP handler complexity is moderate but follows the existing file's patterns. The msg command status checks are a minor readability improvement. File-level complexity (4,622 lines) is a pre-existing concern that this PR exacerbates but does not need to solve -- avoids PF-001 (not deferring without asking, but noting explicitly as a should-fix).
