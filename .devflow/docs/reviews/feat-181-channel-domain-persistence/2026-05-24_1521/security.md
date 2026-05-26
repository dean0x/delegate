# Security Review Report

**Branch**: feat/181-channel-domain-persistence -> main
**Date**: 2026-05-24T15:21

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

### MEDIUM

**Validation removed from `createChannel` without guaranteed boundary enforcement** - `src/core/domain.ts:1127`
**Confidence**: 82%
- Problem: The refactor removed name validation (CHANNEL_NAME_REGEX check) from `createChannel` and member name validation from the member mapping loop. The JSDoc states "callers must validate name against CHANNEL_NAME_REGEX and maxRounds range (1-10000) before calling" and cites the convention of other factory functions (`createTask`, `createSchedule`, `createLoop`). However, there is no service/MCP boundary layer in this PR that enforces these checks. If a future caller invokes `createChannel` with an unsanitized name, that name flows directly into `tmuxSession: beat-channel-${request.name}-${m.name}` (line 1134). Since tmux session names pass through shell commands in `TmuxSessionManager`, a malformed name could bypass the `SESSION_NAME_REGEX` guard depending on the path taken. The existing regex (`CHANNEL_NAME_REGEX`) is constrained to `[a-z0-9-]` which is safe for shell embedding (applies ADR-001), but only if the regex is actually applied before the name reaches the shell layer.
- Fix: This is mitigated by two factors: (1) ADR-001 ensures `CHANNEL_NAME_REGEX` is a subset of `SESSION_NAME_REGEX`, so validated names are inherently shell-safe; (2) `TmuxSessionManager` validates session names against `SESSION_NAME_REGEX` before every operation, providing defense-in-depth. The risk is that an unvalidated name bypasses both checks. Ensure the service layer (Phase 6 follow-up) validates names before calling `createChannel`. Consider adding a precondition assertion (`assert(CHANNEL_NAME_REGEX.test(request.name))`) inside `createChannel` as a safety net, consistent with the project's reliability principles.

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **`updateChannel` accepts arbitrary partial updates without validation** - `src/core/domain.ts:1155` (Confidence: 65%) -- `updateChannel` spreads `updates` directly over the channel object. A caller could pass `{ status: 'arbitrary-string' as ChannelStatus }` and bypass the enum. This is a TypeScript-level concern only (not exploitable at runtime given the enum), but the same pattern of no runtime assertion applies.

- **`memberName` parameter in `updateMemberStatus` is unvalidated user-controlled string** - `src/implementations/channel-repository.ts:236` (Confidence: 62%) -- `memberName` is passed directly to a parameterized query (safe from SQL injection), but the interface accepts any string. If this flows from MCP tool input, the boundary validation should constrain it to `CHANNEL_NAME_REGEX`. Currently no MCP tool exposes this in the PR, so risk is future-only.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Security Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Conditions

1. The service/MCP boundary layer (expected in a follow-up PR) must validate channel and member names against `CHANNEL_NAME_REGEX` and `maxRounds` range before calling `createChannel`. The current PR is a pure domain/persistence layer with no external-facing surface, so the risk is deferred but real.

### Security Strengths

- All SQL queries use parameterized prepared statements -- no string interpolation (OWASP A03 injection prevention).
- Zod schemas (`ChannelRowSchema`, `ChannelMemberRowSchema`) validate all data at the database boundary (parse, don't validate).
- Database CHECK constraints enforce valid `status`, `communication_mode`, and `agent` values at the storage level -- defense-in-depth.
- `Object.freeze` on all returned domain objects prevents mutation.
- Transactional `save` ensures atomicity -- no partial member inserts on failure.
- `tmuxSession` derivation uses `CHANNEL_NAME_REGEX`-validated names, which are a subset of `SESSION_NAME_REGEX` (applies ADR-001), preventing shell injection in tmux session operations.
- The `CHANNEL_NAME_REGEX` update adds a 64-char max length bound (`{0,62}`), preventing unbounded name lengths that could cause issues in tmux session name composition.
