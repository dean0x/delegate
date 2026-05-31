# Consistency Review Report

**Branch**: feat/183-phase-8--channel-cli--mcp -> main
**Date**: 2026-05-26T17:09:00Z

## Issues in Your Changes (BLOCKING)

### HIGH

**MCP JSON schema missing `systemPrompt` property for `CreateChannel` tool** - `src/adapters/mcp-adapter.ts:1889-1940`
**Confidence**: 95%
- Problem: The Zod validation schema `CreateChannelSchema` (line 603) includes a top-level `systemPrompt` field for single-member channels, but the JSON schema exposed to MCP clients in the tool listing (lines 1889-1940) omits it entirely. MCP clients see the tool description without `systemPrompt` and will not know to send it. The Zod schema will still accept it if a client guesses, but the tool is not self-documenting on this field.
- Impact: MCP clients cannot discover the `systemPrompt` parameter for single-member channels. This is inconsistent with the Zod schema (which validates it) and the CLI (which supports `--system-prompt`).
- Fix: Add the `systemPrompt` property to the `CreateChannel` JSON schema:
```typescript
workingDirectory: {
  type: 'string',
  description: 'Working directory for member agent sessions (absolute path)',
},
systemPrompt: {
  type: 'string',
  description: 'System prompt for single-member channels (max 100KB)',
  maxLength: 100000,
},
```

**`DestroyChannel` reason parameter accepted but silently ignored in both CLI and MCP handlers (2 occurrences)** - Confidence: 90%
- `src/cli/commands/channel.ts:510`, `src/adapters/mcp-adapter.ts:4336`
- Problem: The `DestroyChannelSchema` accepts a `reason` field (line 612), the CLI parses `reason` from args (line 497) and displays it (line 514), but both handlers hardcode `'user-requested'` as the destroy reason passed to `channelService.destroyChannel()`. The user-provided reason is discarded. The `ChannelDestroyReason` type only allows `'user-requested' | 'max-rounds-reached' | 'all-members-crashed'`, so free-text reasons cannot be passed through — but then the schema and CLI should not accept them, or the field should be documented as informational-only in the schema description.
- Impact: User provides a reason expecting it to be recorded, but it is silently dropped. This is misleading. Contrast with `CancelTask` and `CancelLoop` where the CLI-provided reason is passed to the service layer.
- Fix: Either (a) remove the `reason` field from `DestroyChannelSchema` and the CLI arg parsing since `ChannelDestroyReason` is a typed enum not accepting free text, or (b) update the schema description to explicitly state the reason is informational and not persisted (matching current behavior), and pass it as metadata for logging. Option (a) is cleanest.

### MEDIUM

**`DestroyChannel` naming deviates from established `Cancel*` pattern** - `src/adapters/mcp-adapter.ts:783`
**Confidence**: 82%
- Problem: All other MCP lifecycle-ending operations use the `Cancel` prefix: `CancelTask`, `CancelSchedule`, `CancelLoop`, `CancelOrchestrator`, `CancelPipeline`. Channels use `DestroyChannel` instead. The CLI also uses `beat channel destroy` vs. `beat loop cancel`, `beat schedule cancel`. While "destroy" may be semantically more accurate for channels (which kill tmux sessions rather than just marking a status), the inconsistency creates a steeper learning curve for users who know the existing conventions.
- Impact: Users and LLM agents must remember a different verb for channels. The `Cancel*` pattern is used 5 times across the codebase; `Destroy*` is used only here.
- Fix: Consider renaming to `CancelChannel` for consistency. If "destroy" is intentionally chosen (because channels truly destroy tmux sessions unlike other entities), add a brief JSDoc explaining the naming deviation.

**Help text missing channel examples in Examples section** - `src/cli/commands/help.ts:147-181`
**Confidence**: 85%
- Problem: The help text Examples section at the bottom includes examples for scheduling, orchestration, pipelines, and task resume, but no channel or msg examples. The Channel Commands section (lines 115-135) documents the flags well but the Examples section is where users look for quick-start patterns.
- Impact: Channel is the newest feature and would benefit most from discoverable examples. Other features all have examples in this section.
- Fix: Add channel examples to the Examples section:
```typescript
  # Channels (multi-agent communication)
  beat channel advisor --agent claude --topic "Review auth module"
  beat channel code-review --member author:claude --member reviewer:claude --mode round-robin --max-rounds 10
  beat msg advisor "What are the security concerns?"
  beat channel list --status active
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Channel CLI commands bootstrap full service for read-only operations** - `src/cli/commands/channel.ts:376-431`
**Confidence**: 83%
- Problem: The `handleChannelList` and `handleChannelStatus` commands use `withReadOnlyContext()` for data fetching (which is correct and matches the established pattern from schedule list/status). However, the channel `list` command creates a spinner with `s.start('Fetching channels...')`, then immediately does `s.stop('Ready')` on line 406, then runs the query. This is cosmetically fine. But more importantly, the pattern differs from how schedule handles the same flow: schedule's `handleScheduleCommand` creates the read-only context *once* for both `list` and `status` subcommands in a shared block (lines 409-424), while channel creates separate `withReadOnlyContext()` calls in each handler. This works but the pattern fragmentation means future maintainers may not realize the shared-context pattern exists.
- Impact: Minor — no functional difference, but the schedule pattern is slightly more efficient (one bootstrap for read-only commands).
- Fix: No code change required if the current pattern works. Consider adding a comment noting the schedule pattern as an alternative for when channel commands grow more read-only subcommands.

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Duplicated `channelNamePattern` regex between MCP adapter and domain** - `src/adapters/mcp-adapter.ts:569` (Confidence: 70%) — The inline regex duplicates `CHANNEL_NAME_REGEX` from domain.ts. A comment documents this (line 564-568, applies ADR-001), but importing the constant would eliminate the risk of drift. The current approach is a conscious design choice per the DECISION comment, so this is informational.

- **`handleChannelCommand` router uses if-chain while schedule uses switch** - `src/cli/commands/channel.ts:249-278` (Confidence: 65%) — Channel uses `if/return` chain; schedule uses `switch/case`. Both work. The if-chain is also used by `handleLoopCommand`, so this is actually consistent with the loop pattern. No action needed.

- **MCP instructions channel section mentions `systemPrompt` in CreateChannel examples but schema omits it** - `src/adapters/mcp-instructions.ts:87-88` (Confidence: 75%) — The instructions show `systemPrompt` in the multi-agent example member objects, which is correct (per-member systemPrompt exists in the JSON schema). But the top-level `systemPrompt` for single-agent channels is not mentioned in examples either, which aligns with the JSON schema gap noted in the blocking section above.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Consistency Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The PR follows existing patterns well overall — Result types, pure parsing functions, withServices/withReadOnlyContext, spinner patterns, MCP tool structure, and CLAUDE.md updates are all consistent with prior art. The channel feature correctly applies ADR-001 (channel name validation constrained to tmux SESSION_NAME_REGEX) and the rollback logic in channel-manager.ts correctly avoids PF-004 (multi-step create rollback covers all three layers). The two HIGH issues (MCP schema/Zod mismatch on `systemPrompt`, and the silently-ignored `reason` parameter) should be addressed before merge. The naming deviation (`Destroy` vs `Cancel`) is a medium-severity design choice that should at minimum be documented.
