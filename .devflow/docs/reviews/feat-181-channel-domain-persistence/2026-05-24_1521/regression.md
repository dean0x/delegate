# Regression Review Report

**Branch**: feat/181-channel-domain-persistence -> main
**Date**: 2026-05-24
**Commits**: 5 (676a57a...a6dc7d6)

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

### MEDIUM

**Removed validation tests without boundary-layer replacement tests** - `tests/unit/implementations/channel-repository.test.ts` (removed T19, T20)
**Confidence**: 82%
- Problem: The old T19 (channel name validation) and T20 (member name validation) tests verified that `createChannel` threw on invalid names. These tests were removed because `createChannel` no longer validates internally (validation moved to the service/MCP boundary per the established factory pattern). However, no boundary-layer validation tests were added in this PR to replace them. The `CHANNEL_NAME_REGEX` is still tested (the CHANNEL_NAME_REGEX describe block), but the enforcement point is undocumented and untested.
- Impact: Until the service/MCP boundary layer is implemented (presumably in a later PR), there is no test proving that invalid channel names are rejected at runtime. The JSDoc comment on `createChannel` says "callers must validate name against CHANNEL_NAME_REGEX", but no caller does this yet.
- Fix: This is acceptable as an incremental PR (Phase 6 persistence layer only), but the boundary validation tests should be added when the channel handler/MCP tool is implemented. Consider adding a tracking comment or TODO. Applies ADR-001 (channel name validation constrained to tmux SESSION_NAME_REGEX compatibility).

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **CHANNEL_NAME_REGEX test does not cover the 64-char limit** - `tests/unit/implementations/channel-repository.test.ts:638` (Confidence: 72%) -- The regex was changed from unbounded `[a-z0-9-]*` to `{0,62}` (max 64 chars total), but the CHANNEL_NAME_REGEX test block does not include a test case for a 64-char valid name or a 65-char rejected name. The limit is correct and documented in the JSDoc, but the test coverage is incomplete for this specific behavior change.

- **Zod boundary schemas use string literals instead of enum values** - `src/implementations/channel-repository.ts:35,50` (Confidence: 65%) -- The Zod schemas (`z.enum(['active', 'paused', ...]`) use hardcoded string arrays rather than deriving from the `ChannelStatus` / `ChannelMemberStatus` enums. If enum values were to change in the future, the Zod schemas would silently fall out of sync. This is the same pattern used by other repositories in the codebase, so it is consistent, but it introduces a maintenance risk.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Regression Score**: 9/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Conditions
1. Boundary-layer validation tests for `CHANNEL_NAME_REGEX` enforcement should be added when the channel handler/MCP tool is implemented.

### Regression Checklist
- [x] No exports removed without deprecation -- `ChannelStatus` and `ChannelMemberStatus` changed from type aliases to enums (backward compatible; string values are identical)
- [x] Return types backward compatible -- `createChannel` no longer throws, now consistent with `createTask`/`createSchedule`/`createLoop` pattern
- [x] Default values unchanged
- [x] Side effects preserved -- validation moved to boundary, not removed
- [x] All consumers of changed code updated -- `ChannelCreatedEvent.members` changed to `readonly string[]` (no consumers yet, safe)
- [x] Migration complete across codebase -- `addMemberStmt` consolidated into `saveMemberStmt` (identical SQL, verified)
- [x] Commit messages match implementation -- all 5 commits accurately describe their changes
- [x] Breaking changes documented -- JSDoc on `createChannel` clearly documents the precondition contract

### Key Observations
- The type change from `type ChannelStatus = 'active' | ...` to `enum ChannelStatus { ACTIVE = 'active', ... }` is backward compatible because TypeScript enums with string values are assignable to their string literal types.
- The `addMemberStmt` removal is a safe deduplication: the SQL was identical to `saveMemberStmt`, and the `addMember` method now reuses it.
- The `ChannelCreatedEvent.members` type narrowing from `string[]` to `readonly string[]` is a safe variance change (readonly is a subtype of mutable array for read operations) and there are currently zero consumers of this event.
- The `CHANNEL_NAME_REGEX` change from unbounded to max-64-chars is a safe restriction (applies ADR-001) with a clear rationale documented in the JSDoc.
- All 267 repository tests pass, all 378 core tests pass, all 445 implementation tests pass, and typecheck is clean.
