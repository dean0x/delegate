# TypeScript Review Report

**Branch**: feat/181-channel-domain-persistence -> main
**Date**: 2026-05-24T15:21

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

**Unsafe type assertions in `rowToChannel` / `rowToMember` bypass Zod validation** -- `channel-repository.ts:317,330,333`
**Confidence**: 82%
- Problem: After Zod validates the row, the code casts `validated.status as ChannelStatus` (line 317), `validated.agent as AgentProvider` (line 330), and `validated.status as ChannelMemberStatus` (line 333). While the Zod schemas enumerate the exact same string literals as the enums/types, the `as` casts silently suppress any type error if someone later adds a value to the Zod schema without updating the enum, or vice versa. This is the standard pattern across all other repositories (`as TaskStatus`, `as PipelineStatus`), so it is consistent -- but it remains a type-safety gap introduced in new code.
- Fix: This is a codebase-wide pattern. A proper fix would use a type-safe mapping function (e.g., `const toChannelStatus = (s: z.infer<typeof ChannelRowSchema>['status']): ChannelStatus => ChannelStatus[s.toUpperCase() as keyof typeof ChannelStatus]`), but that would diverge from every other repository. Acceptable as-is for consistency; consider a follow-up refactor across all repos if desired.

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **`CommunicationMode` remains a union literal while `ChannelStatus`/`ChannelMemberStatus` were upgraded to enums** -- `domain.ts:1077` (Confidence: 65%) -- Other status types in the codebase (`TaskStatus`, `ScheduleStatus`, `LoopStatus`, `PipelineStatus`) all use enums. `CommunicationMode` is still a union literal type. This is not blocking because `IterationStatus` and `OrchestratorMode` also use union literals, so the codebase has both conventions. If the intent is to standardize on enums for all domain types that map to database columns, `CommunicationMode` should follow.

- **`updateChannel` accepts `Partial<Omit<Channel, 'id'>>` which allows overriding `members` and `createdAt` via spread** -- `domain.ts:1155` (Confidence: 62%) -- The `Partial<Omit<Channel, 'id'>>` type permits callers to override `members`, `createdAt`, and other fields that should arguably be immutable after construction. A narrower update type (e.g., `Pick<Channel, 'status' | 'currentRound' | ...>`) would prevent accidental misuse. However, this follows the same pattern as `updateTask` / `updateLoop` elsewhere in the codebase.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 0 | 0 |

**TypeScript Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Positive Observations

1. **Enum migration is correct and consistent** -- `ChannelStatus` and `ChannelMemberStatus` were properly converted from union literal types to string enums, matching the pattern of `TaskStatus`, `ScheduleStatus`, `LoopStatus`, and `PipelineStatus` throughout the codebase.

2. **Branded type usage is exemplary** -- `ChannelId` uses the established branded type pattern (line 1141), preventing accidental ID type mixing. Applies ADR-001 (channel name validation constrained to tmux SESSION_NAME_REGEX compatibility).

3. **Zod boundary validation is properly structured** -- Schemas are hoisted to module level (lines 30-52), avoiding recreation per row. The `ChannelRowSchema` and `ChannelMemberRowSchema` validate all fields with appropriate constraints.

4. **Immutability is thorough** -- Both `createChannel` and `rowToChannel` freeze returned objects and member arrays with `Object.freeze()`. The `readonly` modifier is used consistently on interfaces and arrays.

5. **`readonly` added to `ChannelCreatedEvent.members`** -- The `members: readonly string[]` change in events.ts (line 317) properly prevents mutation of the event payload.

6. **Validation removal from `createChannel` is architecturally sound** -- Moving validation to the service/MCP boundary follows the documented convention of `createTask`/`createSchedule`/`createLoop`. The JSDoc comment explicitly documents this assumption.

7. **`updateRound` precondition check** -- The `Number.isInteger(round) || round < 0` guard (lines 216-218) inside the Result boundary correctly prevents invalid data from reaching the database.

8. **Duplicate prepared statement removed** -- The `addMemberStmt` duplicate was eliminated in favor of reusing `saveMemberStmt`, reducing the number of prepared statements.

### Conditions for Approval

The single HIGH finding (type assertions in row conversion) is consistent with the established codebase pattern and does not represent a regression. No changes are required before merge.

### Decisions Applied

- **applies ADR-001**: `CHANNEL_NAME_REGEX` is constrained to be a subset of tmux `SESSION_NAME_REGEX`, validated by the regex pattern `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$` with the 64-char max documented in JSDoc as leaving room within tmux's 256-byte TMUX_NAME_MAX.
