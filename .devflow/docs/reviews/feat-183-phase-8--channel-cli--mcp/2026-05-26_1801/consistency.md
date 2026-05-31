# Consistency Review Report

**Branch**: feat/183-phase-8--channel-cli--mcp -> main
**Date**: 2026-05-26T18:01:00Z

## Issues in Your Changes (BLOCKING)

### HIGH

**Channel CLI subcommand routing style diverges from schedule CLI** - `src/cli/commands/channel.ts:252-281`
**Confidence**: 85%
- Problem: The `handleChannelCommand` router uses a chain of `if/return` blocks then falls through to `handleChannelCreate` as the default. The schedule CLI (`schedule.ts:402-452`) uses an explicit error for unrecognized subcommands: `ui.error('Unknown schedule subcommand: ...'); process.exit(1)`. The loop CLI (`loop.ts:365-401`) also falls through to create as default but still has an explicit `ui.error` for known-invalid aliases like `get`. The channel router does not print an error for truly unknown subcommands (e.g., `beat channel foobar` silently tries to create a channel named `foobar`). This is intentional per the design (channel name is positional), but the schedule pattern provides a better UX precedent: unknown subcommands should error clearly.
- Fix: This is a documented intentional design choice (channel name is positional like loop prompt), and the loop command has the same fall-through pattern. The two CLI families are consistent with each other. **Downgrading from HIGH to MEDIUM on closer inspection** -- this mirrors the loop pattern exactly.

### MEDIUM

**MCP channel handlers include `channelService` guard boilerplate, but schedule/loop/orchestration handlers do not guard their services** - `src/adapters/mcp-adapter.ts:4247-4254` (7 occurrences)
**Confidence**: 82%
- Problem: Every channel MCP handler has an explicit `if (!this.channelService)` guard returning a JSON error. No other service handlers (schedule, loop, orchestration, pipeline) have equivalent guards -- they assume their services are always available. This creates an inconsistency in the handler pattern: channel handlers are 5-10 lines longer due to the guard block. The guard is architecturally justified (channelService is optional, unlike the other services), but the response format (`JSON.stringify({ success: false, error: 'Channel service unavailable' })`) differs from the validation error format (plain string `Validation error: ...`).
- Fix: The guard is architecturally correct (applies ADR-003 -- channelService may be unavailable). The inconsistency is inherent in the optional dependency design. Consider extracting a `requireChannelService()` helper that returns `MCPToolResponse | ChannelService` to reduce boilerplate, but this is cosmetic.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`handleChannelList` validates `--limit` range inline, inconsistent with `parseChannelCreateArgs` which uses Result** - `src/cli/commands/channel.ts:373-379`
**Confidence**: 83%
- Problem: The `handleChannelList` function validates `--limit` inline with `ui.error` + `process.exit(1)`, while `handleChannelCreate` delegates all validation to the pure `parseChannelCreateArgs` function which returns a Result. The loop list (`loop.ts:460-475`) also validates inline, so the channel list is consistent with the loop list pattern. However, the PR's own stated architecture ("Pure argument parsing functions are exported for testability") only applies to create, not to list/status/destroy. The schedule CLI similarly validates inline. This is a pre-existing pattern inconsistency across the CLI family, not introduced by this PR.
- Fix: No action needed -- matches the established loop/schedule list patterns. The pure-function-for-create pattern is the intentional distinction.

**`handleChannelStatus` and `handleChannelList` use `withReadOnlyContext` while mutations use `withServices` + `resolveChannelService`** - `src/cli/commands/channel.ts:396,435`
**Confidence**: 90%
- Problem: This is actually consistent with the established pattern (loop/schedule use `withReadOnlyContext` for list/status and `withServices` for mutations). The channel CLI follows this convention correctly. Not a real issue upon closer analysis. Withdrawing.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Section comment styles differ between channel and existing code** - `src/cli/commands/channel.ts` vs `src/cli/commands/loop.ts`
**Confidence**: 80%
- Problem: Channel CLI uses Unicode box-drawing section headers (`// --- Types ---`, `// --- Pure parsing functions ---`). Loop CLI uses `// ============` banner-style section comments. Schedule CLI also uses the `// ============` style. The channel CLI is internally consistent (all sections use the `---` style) but differs from the dominant convention in the CLI commands directory.
- Fix: Minor stylistic difference. Both styles are readable. The channel file at least uses one style consistently.

## Suggestions (Lower Confidence)

- **MCP tool response shape inconsistency** - `src/adapters/mcp-adapter.ts:4568-4573` (Confidence: 70%) -- The PauseChannel/ResumeChannel success responses include `status: 'paused'` / `status: 'active'` in the JSON payload, which other lifecycle handlers (PauseSchedule, ResumeSchedule at line 2671-2691) do not include. The extra field is useful but deviates from the minimal response pattern.

- **`displayReason` in handleChannelDestroy is captured but only used for display** - `src/cli/commands/channel.ts:528` (Confidence: 65%) -- The destroy handler captures free-form CLI text as `displayReason` but passes the fixed `'user-requested'` enum to the service. This is documented with an ARCHITECTURE comment, which is good. The loop cancel handler (`loop.ts:637`) passes the free-form reason directly to `cancelLoop()`. The asymmetry is inherent (destroy has an enum, cancel has a string), but the display-only use of the CLI argument could confuse users who expect it to be recorded.

- **`resolveChannelOp` extracts `channelRepository` from the container directly** - `src/cli/commands/channel.ts:505` (Confidence: 62%) -- The function reaches into `container.get<ChannelRepository>('channelRepository')` after `withServices()`, while the msg command does the same at line 114. The schedule/loop commands never reach into the container for repositories -- they either use `withReadOnlyContext` or pass services directly. The channel's need to resolve names-to-IDs requires the repository, which is a new pattern. Consistent within the channel code but differs from other CLI commands.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Consistency Score**: 8/10
**Recommendation**: APPROVED

## Rationale

The new channel CLI and MCP adapter code is well-structured and follows the established project patterns closely. Key consistency observations:

1. **CLI patterns**: The channel command correctly follows the read-only/mutation split (withReadOnlyContext for list/status, withServices for mutations), matching the loop and schedule patterns.
2. **MCP patterns**: Zod schema validation, `match(result, ...)` response handling, and JSON response format all match existing tool handlers. The optional channelService guard is a justified addition (applies ADR-003).
3. **Result types**: Used consistently throughout -- `parseChannelCreateArgs`, `parseMsgArgs`, and `parseMemberFlag` all return Result types. Service calls use match/exitOnError consistently.
4. **Naming**: PascalCase for MCP tools, camelCase for functions, `handleX` for CLI handlers, `parseXArgs` for pure parsers -- all consistent.
5. **ADR-001 compliance**: Channel name validation uses `CHANNEL_NAME_REGEX` in CLI, MCP, and service layers consistently (applies ADR-001).
6. **PF-004 compliance**: The `handleCreateChannel` MCP handler and ChannelManager.createChannel both perform multi-layer rollback (avoids PF-004).

The minor inconsistencies (section comment style, MCP guard boilerplate, container access pattern) are well-documented and architecturally motivated. No blocking issues.
