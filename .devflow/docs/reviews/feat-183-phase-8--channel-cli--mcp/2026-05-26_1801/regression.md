# Regression Review Report

**Branch**: feat/183-phase-8--channel-cli--mcp -> main
**Date**: 2026-05-26T18:01:00Z

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

**sendMessage interface doc drift** - `src/core/interfaces.ts:1072`
**Confidence**: 85%
- Problem: The `ChannelService.sendMessage()` JSDoc says "Returns err(INVALID_INPUT) if channel is paused or target member unknown" but the implementation now also rejects COMPLETED channels (added in `src/services/channel-manager.ts:403`). The interface contract documentation is stale relative to the new guard.
- Fix: Update the JSDoc on the `sendMessage` method in the `ChannelService` interface to include COMPLETED:
  ```typescript
  /**
   * Deliver a message to the channel from an external caller.
   * targetMember -- if provided, deliver to that specific member only.
   * Returns err(INVALID_INPUT) if channel is paused, completed, or target member unknown.
   */
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**ReadOnlyContext interface extended with required field -- breaks downstream implementors** - `src/cli/read-only-context.ts:52`
**Confidence**: 82%
- Problem: Adding `channelRepository: ChannelRepository` as a required (non-optional) field on the `ReadOnlyContext` interface is a breaking change for any code that manually constructs a `ReadOnlyContext` literal. The PR updated the two known construction sites (`createReadOnlyContext()` in `read-only-context.ts` and the manual literal in `dashboard/index.tsx`), but any external or test code that creates a `ReadOnlyContext` literal will get a compile error.
- Mitigation: The codebase was searched and all construction sites are covered: `createReadOnlyContext()` and `dashboard/index.tsx`. Test files use `withReadOnlyContext()` which delegates to `createReadOnlyContext()`. TypeScript compilation catches any missed sites at build time. This is low risk in practice but worth noting as an intentional contract change.
- Fix: No code change required -- all construction sites are updated. The TypeScript compiler would surface any missed sites. If external consumers exist, consider making `channelRepository` optional with `?:` on the interface. For an internal-only interface, the current approach is correct.

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Async container.resolve for channelService in bootstrap recovery path** - `src/bootstrap.ts:780` (Confidence: 65%) -- The channel recovery block calls `container.resolve<ChannelService>('channelService')` inside a `.then()` chain, which was already present in the base branch. The PR adds a second pre-resolution at line 718 (for MCP adapter in server/run mode). Both resolve calls share the container singleton, so the second call returns the cached instance. However, if the first resolution (line 780 recovery) fails, the second (line 718 MCP adapter) will also encounter the same error. The ordering is correct (pre-resolve at 718 happens before recovery at 780 in the bootstrap flow), but the dual async resolution of the same service is a subtle coupling.

- **displayReason captured but unused by the service** - `src/cli/commands/channel.ts:528` (Confidence: 70%) -- The `handleChannelDestroy` function captures a free-form `displayReason` from CLI args but always passes the hardcoded `'user-requested'` enum value to `channelService.destroyChannel()`. The display reason is only shown via `ui.info()`. This is documented with an ARCHITECTURE comment explaining the typed enum constraint, so it is intentional, but the free-form reason text is discarded at the service boundary. If future requirements need user-provided reasons, the `ChannelDestroyReason` type would need extension.

- **Bootstrap pre-resolves channelService only in server/run modes** - `src/bootstrap.ts:716-726` (Confidence: 62%) -- The `mode !== 'cli'` guard correctly skips pre-resolution for CLI mode, matching the comment that CLI mode never uses the MCP adapter. However, the `mcpAdapter` factory at line 728 references `preResolvedChannelService` which is `undefined` in CLI mode. If a future CLI command ever resolves `mcpAdapter` from the container, channel tools would silently be unavailable. The existing guard in each MCP handler (`if (!this.channelService)`) handles this gracefully, so it is safe today.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Regression Score**: 9/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Regression Checklist Assessment

- [x] No exports removed without deprecation
- [x] Return types backward compatible (withServices adds field, all existing destructuring patterns work)
- [x] Default values unchanged
- [x] Side effects preserved (events, logging)
- [x] All consumers of changed code updated (ReadOnlyContext: 2 construction sites both updated)
- [x] Migration complete across codebase (no incomplete old API usage found)
- [x] CLI options preserved (new commands added, no existing commands changed)
- [x] API endpoints preserved (7 new MCP tools, no existing tools modified)
- [x] Commit messages match implementation (13 commits, all consistent with code changes)
- [ ] Interface documentation matches implementation (sendMessage JSDoc slightly stale -- applies ADR-001 for channel name validation consistency)

### Decisions Applied

- **applies ADR-001**: Channel name validation in CLI (`channel.ts:139`, `msg.ts:80`) and MCP adapter (`mcp-adapter.ts:567`) consistently uses `CHANNEL_NAME_REGEX`, maintaining tmux session name compatibility.
- **avoids PF-004**: The `createChannel` rollback in `channel-manager.ts:258-269` now correctly deletes the DB record on `ChannelCreated` emit failure, cleaning all three layers (DB, tmux sessions, in-memory state).

### Condition for Approval

Update the `sendMessage` JSDoc in `src/core/interfaces.ts:1069-1073` to document the COMPLETED rejection, aligning the contract with the implementation.
