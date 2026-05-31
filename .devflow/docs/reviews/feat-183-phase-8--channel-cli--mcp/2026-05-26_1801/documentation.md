# Documentation Review Report

**Branch**: feat/183-phase-8--channel-cli--mcp -> main
**Date**: 2026-05-26

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

**systemPrompt description contradicts code behavior** - `src/adapters/mcp-adapter.ts:600`, `src/adapters/mcp-adapter.ts:1936`
**Confidence**: 92%
- Problem: The Zod schema description at line 600 says `"System prompt for single-member channels (overrides per-member systemPrompt)"`. The tool listing description at line 1936 repeats this: `"System prompt for single-member channels (overrides per-member systemPrompt, max 100KB)"`. However, the actual code at line 4282 implements the opposite: `m.systemPrompt ?? (data.members.length === 1 && idx === 0 ? data.systemPrompt : undefined)` — using the nullish coalescing operator, per-member systemPrompt takes precedence over top-level systemPrompt. The inline code comment at line 4281 correctly says "per-member wins", but the two descriptions presented to API consumers are wrong. This is a code-documentation drift that will mislead MCP tool callers into expecting the wrong override behavior. Applies ADR-001 (channel name validation is correct throughout).
- Fix: Change both descriptions from "overrides per-member systemPrompt" to "fallback when per-member systemPrompt is not set" or similar:
  ```typescript
  // Line 600 (Zod schema):
  .describe('System prompt for single-member channels (used when per-member systemPrompt is not set)')

  // Line 1936 (tool listing):
  'System prompt for single-member channels (used when per-member systemPrompt is not set, max 100KB)'
  ```

### MEDIUM

**Exported `handleChannelCommand` lacks JSDoc** - `src/cli/commands/channel.ts:252`
**Confidence**: 82%
- Problem: `handleChannelCommand` is the primary exported entry point for the channel CLI module, invoked from `src/cli.ts`. It has no JSDoc — only a section comment (`// --- Subcommand router ---`). Other exported functions in the same file (`parseChannelCreateArgs`, `parseMemberFlag`) have proper JSDoc. This is inconsistent with the project convention where public API functions are documented.
- Fix: Add JSDoc describing the subcommand routing behavior:
  ```typescript
  /**
   * Route channel subcommands to their handlers.
   * Subcommands: create, list, status, destroy, pause, resume.
   * Default (no subcommand): treat first arg as channel name for create.
   */
  export async function handleChannelCommand(subCmd: string | undefined, channelArgs: string[]): Promise<void> {
  ```

**Exported `handleMsgCommand` lacks JSDoc** - `src/cli/commands/msg.ts:91`
**Confidence**: 82%
- Problem: `handleMsgCommand` is the primary exported handler for the `beat msg` command, invoked from `src/cli.ts`. It has no JSDoc despite being a public export. The module-level docstring describes the command, and `parseMsgArgs` has JSDoc, but the handler itself does not.
- Fix: Add JSDoc:
  ```typescript
  /**
   * Handle `beat msg <target> <message...>` — send a message to a channel or specific member.
   * Resolves channel by name, validates status, then delegates to channelService.sendMessage().
   */
  export async function handleMsgCommand(args: string[]): Promise<void> {
  ```

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **`channel destroy` reason argument is display-only** - `src/cli/commands/channel.ts:522-535` (Confidence: 65%) — The help text says `beat channel destroy <id|name> [reason]` and the code accepts a free-form reason string, but it is only displayed in the success output and never passed to the service (which always uses `'user-requested'`). The inline comment at line 525-527 explains this design, but a user reading only the help text may expect the reason to be recorded. Consider adding "(display-only)" to the help text or noting it in the usage string.

- **CLAUDE.md File Locations table has channel-related entries inserted mid-table** - `CLAUDE.md:325-327` (Confidence: 62%) — The three new entries (`Channel service`, `Channel CLI command`, `Msg CLI command`) are added between `Channel repository` and `Pipeline handler`. While the table is not strictly alphabetically sorted, similar components (pipeline handler, interactive orchestrator) are grouped at the end. The channel entries could be grouped more consistently with the existing Channel repository entry. Minor organizational concern.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Documentation Score**: 8/10
**Recommendation**: CHANGES_REQUESTED

The documentation quality is strong overall. Module-level docstrings, architectural annotations (ARCHITECTURE:, DECISION:, ADR-001 citations), pure function JSDoc, and inline code comments are thorough and well-placed. The CLAUDE.md updates (MCP tools list, File Locations, Database migrations) are complete. The MCP instructions section provides clear examples for both single-agent and multi-agent channel creation. The CLI help text accurately covers all new subcommands with realistic examples.

The one blocking issue is the systemPrompt description in both the Zod schema and the MCP tool listing that contradicts the actual code behavior (descriptions say "overrides" but code implements "fallback"). This directly misleads API consumers and should be fixed before merge. Avoids PF-004 (rollback completeness is properly documented in the code).
