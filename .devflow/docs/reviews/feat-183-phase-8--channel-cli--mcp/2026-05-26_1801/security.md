# Security Review Report

**Branch**: feat/183-phase-8--channel-cli--mcp -> main
**Date**: 2026-05-26

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Missing length limit on `topic` field in CreateChannelSchema** - `src/adapters/mcp-adapter.ts:594`
**Confidence**: 85%
- Problem: The `topic` field in `CreateChannelSchema` is `z.string().optional()` with no `.max()` constraint. While the downstream `pasteContent()` enforces a 256KB byte limit (causing a delivery failure), the topic is first persisted to the `channels` table in SQLite with no size guard at the MCP boundary. An attacker could submit a multi-megabyte topic string that consumes database storage and memory during parsing. The `message` field in `SendChannelMessageSchema` correctly limits to 262,144 chars; `systemPrompt` correctly limits to 100,000 chars. `topic` is the only unbounded text field among the new schemas.
- Fix: Add `.max(262_144)` to align with the existing `SendChannelMessage` message cap and the `MAX_PASTE_CONTENT_LENGTH` downstream limit:
  ```typescript
  topic: z.string().max(262_144).optional().describe('Initial topic delivered to members on creation'),
  ```
  Also add the same limit in the CLI parser (`channel.ts:110-112`) where `--topic` is accepted without any length check.

**Missing length limit on `topic` in CLI `--topic` flag** - `src/cli/commands/channel.ts:110-112`
**Confidence**: 85%
- Problem: The `--topic` flag value is accepted with no length validation. Unlike `--system-prompt` which enforces a 100,000 char limit (line 121), `--topic` passes the value through unchecked. The same reasoning as above applies.
- Fix: Add a length check consistent with the MCP schema:
  ```typescript
  } else if (arg === '--topic' && next !== undefined) {
    if (next.length > 262_144) {
      return err('--topic must be at most 262,144 characters');
    }
    topic = next;
  ```

### LOW

**`workingDirectory` validation in MCP handler is overly restrictive (path traversal false positive)** - `src/adapters/mcp-adapter.ts:4259-4273`
**Confidence**: 82%
- Problem: The handler requires an absolute path (line 4260) then calls `validatePath(data.workingDirectory)` without a `baseDir` argument (line 4266). `validatePath` defaults `baseDir` to `process.cwd()` and rejects any resolved path not under that base as "path traversal." For an MCP server whose cwd may be `/` or `/home/user`, any working directory outside cwd (e.g., `/tmp/project` when cwd is `/home/user`) will be rejected. This is not a vulnerability (it over-restricts, not under-restricts), but it silently breaks valid use cases. The CLI `channel.ts:114` has the same behavior (defaulting to cwd), which is correct for CLI tools where the user's shell cwd is the expected base. The MCP server is different -- its cwd is typically the autobeat install directory, not the user's project.
- Fix: For MCP context, skip the `validatePath` traversal check since `path.isAbsolute()` already rejects relative paths. Or call `validatePath(data.workingDirectory, '/')` to use filesystem root as base:
  ```typescript
  const pathValidation = validatePath(data.workingDirectory, '/');
  ```

## Issues in Code You Touched (Should Fix)

No issues found.

## Pre-existing Issues (Not Blocking)

No CRITICAL pre-existing issues found in reviewed files.

## Suggestions (Lower Confidence)

- **No validation of `agent` field at MCP boundary** - `src/adapters/mcp-adapter.ts:576` (Confidence: 65%) -- The `agent` field in member objects uses `z.string().min(1)` rather than `z.enum(AGENT_PROVIDERS)`. The CLI (`channel.ts:152,182`) validates against `isAgentProvider()`, and the service layer (`channel-manager.ts:802`) also validates, providing defense in depth. The MCP schema could be tighter to fail fast, but the service layer catch is sufficient.

- **`memberName` not validated in `parseMsgArgs`** - `src/cli/commands/msg.ts:73` (Confidence: 60%) -- The `memberName` extracted from `channel-name/member-name` is not validated against `CHANNEL_NAME_REGEX`. Since `channelService.sendMessage()` validates membership server-side (line 408-417 of channel-manager.ts) and the value is used only in parameterized queries, the risk is limited to confusing error messages rather than injection.

- **`channelId` field accepts any string in MCP schemas** - `src/adapters/mcp-adapter.ts:604` (Confidence: 62%) -- `DestroyChannelSchema`, `ChannelStatusSchema`, `PauseChannelSchema`, `ResumeChannelSchema` all accept `channelId: z.string().min(1)` without format validation (e.g., regex for `ch-` prefix + UUID pattern). Since the value feeds into parameterized SQLite queries, injection is impossible. The worst case is a "not found" error for invalid IDs.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 1 |
| Should Fix | - | 0 | 0 | 0 |
| Pre-existing | - | - | 0 | 0 |

**Security Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Positive Security Observations

1. **Input validation at boundaries** -- Channel name and member name validation uses `CHANNEL_NAME_REGEX` consistently across CLI and MCP boundaries (applies ADR-001). Zod schemas parse all MCP inputs before processing.
2. **Parameterized queries throughout** -- All database access in `channel-repository.ts` uses prepared statements with `?` placeholders. No string interpolation in SQL.
3. **Shell injection prevention** -- `pasteContent()` writes message content to a temp file and uses `tmux load-buffer` (file redirect), avoiding shell expansion of user content. Session names and paths use `escapeForSingleQuotes()`.
4. **Path traversal defense** -- `validatePath()` resolves symlinks and checks containment. The MCP handler adds an explicit `path.isAbsolute()` guard.
5. **Graceful degradation** -- All 7 channel tool handlers guard against `channelService === undefined` with an actionable error, preventing null-reference crashes.
6. **Rollback completeness** -- `createChannel` rollback covers all three layers (DB + tmux + in-memory) in LIFO order (avoids PF-004).
7. **MAX_PASTE_CONTENT_LENGTH** -- Downstream enforcement at 256KB prevents oversized content from reaching tmux, regardless of upstream validation gaps.
8. **Message length enforcement** -- `SendChannelMessageSchema` and `parseMsgArgs` both enforce 262,144 char limit aligned with tmux buffer limits.

### Conditions for Approval

- Add `.max(262_144)` to `topic` in `CreateChannelSchema` (MCP) and length validation to `--topic` in CLI. These are MEDIUM severity -- the downstream `pasteContent` guard prevents exploitation, but boundary validation should not rely on implementation-layer limits.
