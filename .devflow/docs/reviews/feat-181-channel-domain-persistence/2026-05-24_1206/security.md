# Security Review Report

**Branch**: feat/181-channel-domain-persistence -> main
**Date**: 2026-05-24

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Missing length limit on channel/member names allows unbounded tmux session names** - `src/core/domain.ts:1049,1113`
**Confidence**: 85%
- Problem: `CHANNEL_NAME_REGEX` (`/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/`) validates the character set but imposes no maximum length. The tmux session name is derived as `beat-channel-${request.name}-${m.name}` (line 1113). A 10,000-character channel name produces a 10,020-character tmux session name. While `TmuxSessionManager.createSession()` validates against `SESSION_NAME_REGEX` (which also has no length cap), tmux itself has a 256-byte session name limit (`TMUX_NAME_MAX`). Excessively long names would fail at the tmux layer with an opaque error rather than being caught early with a clear validation message.
- Fix: Add a max-length guard to `CHANNEL_NAME_REGEX` or add an explicit length check in `createChannel`:
```typescript
// Option A: Constrained regex (e.g., max 64 chars)
export const CHANNEL_NAME_REGEX = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

// Option B: Explicit check
if (request.name.length > 64) {
  throw new AutobeatError(
    ErrorCode.INVALID_INPUT,
    `Channel name too long (${request.name.length} chars, max 64)`,
  );
}
```

**`createChannel` throws instead of returning Result** - `src/core/domain.ts:1093-1132`
**Confidence**: 82%
- Problem: The `createChannel` factory function throws `AutobeatError` on invalid input (lines 1095, 1104). The project's CLAUDE.md and engineering principles mandate "Never throw in business logic" and "Always use Result types." While factory functions sometimes get an exception for construction failures, this function performs input validation that could fail in normal operation. Callers that forget to wrap in try/catch get unhandled exceptions. This is a consistency issue with security implications -- unhandled exceptions in event handlers or request paths can crash the process.
- Fix: Return `Result<Channel>` instead of throwing:
```typescript
export const createChannel = (request: ChannelCreateRequest): Result<Channel> => {
  if (!CHANNEL_NAME_REGEX.test(request.name)) {
    return err(new AutobeatError(
      ErrorCode.INVALID_INPUT,
      `Invalid channel name "${request.name}": must match ${CHANNEL_NAME_REGEX}`,
    ));
  }
  // ... validation ...
  return ok(Object.freeze({ ... }));
};
```

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

_No issues found._

## Suggestions (Lower Confidence)

- **No `max_rounds` upper bound validation** - `src/core/domain.ts:1089` (Confidence: 65%) -- `maxRounds` accepts any number with no upper bound. A caller could set `maxRounds: Number.MAX_SAFE_INTEGER`, which while not a direct vulnerability, could lead to resource exhaustion if rounds are executed without further checks downstream. Consider adding a reasonable ceiling (e.g., 1000).

- **`updateChannel` allows overwriting `members` array without validation** - `src/core/domain.ts:1134` (Confidence: 70%) -- `updateChannel` accepts `Partial<Omit<Channel, 'id'>>` which includes `members`. A caller could pass unvalidated member objects (skipping `CHANNEL_NAME_REGEX` checks on member names) by going through `updateChannel` instead of `createChannel`. Currently no callers do this, but as the API surface expands, this bypass path could be exploited.

- **`systemPrompt` field stored without size limit** - `src/implementations/channel-repository.ts:49,111` (Confidence: 62%) -- The `system_prompt` column in `channel_members` is unbounded TEXT. While the DB migration has no size constraint and Zod schema only validates `z.string().nullable()`, an extremely large system prompt could cause memory pressure when loaded. This mirrors the existing pattern for `tasks.system_prompt`, so it is consistent with the codebase, but worth noting as the channel members are eagerly loaded in bulk via `findAll`.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Security Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Positive Security Observations

1. **Parameterized queries throughout** -- All SQL uses prepared statements with positional or named parameters. No string interpolation in any query. Fully protected against SQL injection.
2. **Zod boundary validation** -- Both `ChannelRowSchema` and `ChannelMemberRowSchema` validate data read from SQLite, enforcing parse-don't-validate at the DB boundary.
3. **CHECK constraints at DB level** -- Migration v31 adds CHECK constraints on `status`, `communication_mode`, and `agent` columns as defense-in-depth, consistent with the pattern established in earlier migrations.
4. **CASCADE delete** -- `channel_members` uses `ON DELETE CASCADE` referencing `channels(id)`, preventing orphan member rows.
5. **Immutable domain objects** -- `Object.freeze()` on all returned Channel and ChannelMember objects prevents mutation after construction.
6. **Input character validation** -- `CHANNEL_NAME_REGEX` restricts channel and member names to `[a-z0-9-]`, preventing shell injection via tmux session names (which are derived from these validated names).
7. **crypto.randomUUID()** -- Channel IDs use the cryptographically secure `crypto.randomUUID()`, not `Math.random()`.
8. **Transactional save** -- The `save()` method wraps channel + member inserts in a SQLite transaction, preventing partial writes.
9. **UNIQUE constraints** -- Both channel name (`UNIQUE` on `channels.name`) and member name within channel (`UNIQUE INDEX` on `(channel_id, name)`) prevent duplicates at the DB level.

### Conditions for Approval

1. Add a maximum length constraint to channel and member names (the missing length limit finding).
2. Consider converting `createChannel` to return `Result<Channel>` for consistency with the project's error handling patterns, or document the exception as an intentional design decision.
