# Security Review Report

**Branch**: feat/183-phase-8-channel-cli-mcp -> main
**Date**: 2026-05-26T17:09:00Z

## Issues in Your Changes (BLOCKING)

### MEDIUM

**CLI `channel list --limit` accepts unbounded integer** - `src/cli/commands/channel.ts:387`
**Confidence**: 90%
- Problem: The `--limit` flag is parsed via `parseInt(next, 10)` but never validated for range. A user can pass `--limit 999999999` or `--limit -1` or even `--limit NaN`. The MCP schema properly constrains `limit` to 1-100 via Zod, but the CLI path bypasses schema validation and passes the raw integer directly to `ctx.channelRepository.findByStatus(statusValue, limit)`. While SQLite can handle large LIMIT values without crashing, this is an inconsistency between the two entry points (MCP vs CLI) and could cause excessive memory consumption if the channel table grows large.
- Fix: Add bounds validation after parseInt, matching the MCP schema:
```typescript
} else if (arg === '--limit' && next) {
  const parsed = parseInt(next, 10);
  if (isNaN(parsed) || parsed < 1 || parsed > 100) {
    ui.error('--limit must be an integer between 1 and 100');
    process.exit(1);
  }
  limit = parsed;
  i++;
}
```

**CLI `msg` command has no message length limit** - `src/cli/commands/msg.ts:50`
**Confidence**: 85%
- Problem: The `parseMsgArgs` function joins all remaining args into a message string with no upper bound. The MCP `SendChannelMessageSchema` properly limits messages to 262,144 characters (256KB), but the CLI path has no equivalent guard. An extremely large message passed via CLI could cause memory pressure when the tmux `pasteContent` call buffers the entire string. The MCP boundary validation is correct; the CLI boundary is missing.
- Fix: Add a length check after joining the message:
```typescript
const message = messageWords.join(' ');
if (message.length > 262_144) {
  return err('Message too long. Maximum length is 256KB (262,144 characters).');
}
```

**CLI `--system-prompt` flag has no length limit** - `src/cli/commands/channel.ts:121`
**Confidence**: 82%
- Problem: The `--system-prompt` flag for `beat channel create` accepts an arbitrary-length string. The MCP `CreateChannelSchema` limits `systemPrompt` to 100,000 characters, but the CLI has no equivalent guard. Per-member prompts via `--member name:agent:prompt` also have no length limit (line 237). While this is a local CLI tool (not a remote attack surface), the inconsistency means the CLI can create channels with prompts that exceed what the MCP layer would allow.
- Fix: Add a length check consistent with the MCP schema:
```typescript
} else if (arg === '--system-prompt' && next !== undefined) {
  if (next.length > 100_000) {
    return err('--system-prompt exceeds maximum length of 100,000 characters');
  }
  systemPrompt = next;
  i++;
}
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**MCP `DestroyChannel` handler ignores user-provided `reason` field** - `src/adapters/mcp-adapter.ts:4336`
**Confidence**: 92%
- Problem: The `DestroyChannelSchema` defines an optional `reason` field that is parsed successfully, but `handleDestroyChannel` hardcodes `'user-requested'` instead of forwarding `parseResult.data.reason`. Similarly, the CLI `handleChannelDestroy` (channel.ts:510) hardcodes `'user-requested'` and only displays the CLI-provided reason in a `ui.info()` line. While not a vulnerability per se, the reason field is a trust boundary: user-provided data that is logged and stored. The current code is safe because it ignores the value entirely, but it's a functional gap that could lead to confusion when the reason field is eventually passed through.
- Fix: Forward the reason but note that it is safe since `destroyChannel()` accepts it as a typed string literal union (`ChannelDestroyReason`). If the type allows arbitrary strings, consider sanitizing or truncating.

## Pre-existing Issues (Not Blocking)

No CRITICAL pre-existing security issues found in the reviewed files.

## Suggestions (Lower Confidence)

- **Member name validation not applied in `msg` command** - `src/cli/commands/msg.ts:65` (Confidence: 65%) -- The `memberName` extracted from the target `channel/member` is not validated against `CHANNEL_NAME_REGEX`. While the service layer will reject invalid member names, validating at the CLI boundary would be more consistent with the parse-at-boundaries principle.

- **`channelId` input in MCP handlers is minimally validated** - `src/adapters/mcp-adapter.ts:4335` (Confidence: 62%) -- The Zod schema validates `channelId` as `.string().min(1)` but does not enforce a format (e.g., the `ch-` prefix). The `ChannelId()` branded type constructor performs no runtime validation. Any non-empty string is accepted and passed to the repository layer. This is consistent with other ID parameters in the codebase (TaskId, LoopId), so it is a codebase-wide pattern rather than a regression.

- **`workingDirectory` validation uses `cwd()` as base** - `src/adapters/mcp-adapter.ts:4261` (Confidence: 70%) -- The `validatePath()` call for `workingDirectory` defaults to `process.cwd()` as the base directory. On a server that runs as a daemon, `cwd()` may be `/` or another root-level directory, making the path traversal guard weaker (any absolute path is within `/`). However, the preceding `path.isAbsolute()` check (line 4255) ensures only absolute paths are accepted, and the MCP server is designed to execute tasks in arbitrary directories. This is consistent with the existing `DelegateTask` handler's path validation behavior.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 3 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Security Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The security posture of this PR is solid overall. Input validation is properly applied at the MCP boundary layer via Zod schemas (applies ADR-001 for channel name regex). Path traversal protection is in place for `workingDirectory`. The main findings are consistency gaps between the MCP and CLI entry points: the MCP layer has Zod-enforced limits for message length, system prompt length, and list pagination, but the CLI entry points lack equivalent guards. These are MEDIUM severity because the CLI is a local tool (not a remote attack surface), but the parse-at-boundaries principle calls for consistent validation at all trust boundaries.

The rollback logic in `ChannelManager.createChannel()` now correctly cleans all three layers (DB, tmux sessions, in-memory state) on `ChannelCreated` emit failure (avoids PF-004), including the previously-missing `channelRepository.delete()` call. No hardcoded secrets, no injection vectors, and no authentication/authorization gaps were found.
