# Consistency Review Report

**Branch**: feat/181-channel-domain-persistence -> main
**Date**: 2026-05-24

## Issues in Your Changes (BLOCKING)

### HIGH

**`createChannel` factory throws instead of returning Result -- unique among all domain factories** - `src/core/domain.ts:1095,1104`
**Confidence**: 90%
- Problem: Every other domain factory function (`createTask`, `createSchedule`, `createLoop`, `createOrchestration`, `createPipeline`) returns the domain object directly without throwing. `createChannel` is the only factory that throws `AutobeatError` on validation failure. This violates the codebase's global engineering principle "Never throw in business logic" (CLAUDE.md) and the established pattern across 5 other factory functions. The project's convention from `~/.claude/CLAUDE.md` states "Always use Result types -- Never throw errors in business logic."
- Fix: Either (a) make `createChannel` return `Result<Channel>` wrapping validation errors, or (b) perform validation upstream (in a service layer) and keep the factory pure like the others. Option (b) is more consistent with the existing pattern where factories assume valid input and validation is done at the boundary (MCP adapter / CLI).

```typescript
// Option B — match existing pattern: no validation in factory, validate at boundary
export const createChannel = (request: ChannelCreateRequest): Channel => {
  const now = Date.now();
  const members: readonly ChannelMember[] = request.members.map((m) =>
    Object.freeze({
      name: m.name,
      agent: m.agent,
      systemPrompt: m.systemPrompt,
      tmuxSession: `beat-channel-${request.name}-${m.name}`,
      status: 'active' as const,
      joinedAt: now,
    }),
  );
  return Object.freeze({
    id: ChannelId(`ch-${crypto.randomUUID()}`),
    name: request.name,
    members,
    communicationMode: request.communicationMode,
    topic: request.topic,
    status: 'active' as const,
    maxRounds: request.maxRounds,
    currentRound: 0,
    createdBy: request.createdBy,
    createdAt: now,
    updatedAt: now,
  });
};
// Then add a validateChannelName() function or Zod schema at the service/adapter boundary
```

### MEDIUM

**`ChannelStatus` and `ChannelMemberStatus` use type aliases instead of enums** - `src/core/domain.ts:1051-1052`
**Confidence**: 82%
- Problem: The codebase uses `enum` for status types in 5 out of 6 entities: `TaskStatus`, `ScheduleStatus`, `LoopStatus`, `OrchestratorStatus`, `PipelineStatus`. The new `ChannelStatus` and `ChannelMemberStatus` use `type` aliases instead. `IterationStatus` is the only pre-existing type alias status, and it models a different concept (per-iteration outcomes, not entity lifecycle). Channel status is an entity lifecycle concept and should follow the enum pattern for consistency. Enum members enable usage like `ChannelStatus.ACTIVE` rather than string literals scattered across the codebase.
- Fix: Convert to enums matching the existing pattern:

```typescript
export enum ChannelStatus {
  ACTIVE = 'active',
  PAUSED = 'paused',
  COMPLETED = 'completed',
  DESTROYED = 'destroyed',
}

export enum ChannelMemberStatus {
  ACTIVE = 'active',
  IDLE = 'idle',
  DESTROYED = 'destroyed',
}
```

**Duplicate prepared statements: `saveMemberStmt` and `addMemberStmt` have identical SQL** - `src/implementations/channel-repository.ts:109-112,132-135`
**Confidence**: 95%
- Problem: Two separate prepared statement fields (`saveMemberStmt` and `addMemberStmt`) are initialized with the exact same SQL: `INSERT INTO channel_members (channel_id, name, agent, system_prompt, tmux_session, status, joined_at) VALUES (...)`. This is unnecessary duplication. The `save()` method uses `saveMemberStmt`, and `addMember()` uses `addMemberStmt`, but they do the same thing.
- Fix: Remove `addMemberStmt` and reuse `saveMemberStmt` in the `addMember()` method:

```typescript
// In constructor: remove addMemberStmt declaration and initialization

// In addMember():
async addMember(channelId: ChannelId, member: ChannelMember): Promise<Result<void>> {
  return tryCatchAsync(
    async () => {
      this.saveMemberStmt.run(this.memberToDbFormat(channelId, member));
    },
    operationErrorHandler('add channel member', { channelId, memberName: member.name }),
  );
}
```

**`effectiveLimit` pattern not followed for pagination defaults** - `src/implementations/channel-repository.ts:191,199-201`
**Confidence**: 80%
- Problem: All 7 existing repositories extract the limit default into a local variable (`const effectiveLimit = limit ?? SQLiteXxxRepository.DEFAULT_LIMIT`) before passing it to the prepared statement. The channel repository inlines the default directly in the `.all()` call: `this.findAllStmt.all(limit ?? SQLiteChannelRepository.DEFAULT_LIMIT, offset ?? 0)`. This is functionally equivalent but deviates from the established micro-pattern.
- Fix: Extract to a local variable for consistency:

```typescript
async findAll(limit?: number, offset?: number): Promise<Result<readonly Channel[]>> {
  return tryCatchAsync(async () => {
    const effectiveLimit = limit ?? SQLiteChannelRepository.DEFAULT_LIMIT;
    const effectiveOffset = offset ?? 0;
    const rows = this.findAllStmt.all(effectiveLimit, effectiveOffset) as ChannelRow[];
    return rows.map((row) => this.rowToChannel(row));
  }, operationErrorHandler('find all channels'));
}
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`ChannelCreatedEvent` uses individual fields while majority of "Created" events carry the full domain object** - `src/core/events/events.ts:313-319`
**Confidence**: 80%
- Problem: 3 out of 5 "Created" events carry the full domain object (`ScheduleCreated.schedule`, `LoopCreated.loop`, `OrchestrationCreated.orchestration`). `PipelineCreatedEvent` is a pre-existing deviation using individual fields. `ChannelCreatedEvent` follows `PipelineCreatedEvent`'s approach with `channelId`, `name`, `members`, `communicationMode` as separate fields. This creates a 3-vs-2 split in the codebase. Carrying the full `Channel` object would be more consistent with the majority pattern, and would mean event consumers don't need to reconstruct the object.
- Fix: Consider carrying the full domain object:

```typescript
export interface ChannelCreatedEvent extends BaseEvent {
  type: 'ChannelCreated';
  channel: Channel;
}
```

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Event file header comment says "34 event types" but actual count is 46** - `src/core/events/events.ts:5`
**Confidence**: 95%
- Problem: The file header reads "34 event types after adding orchestration events (v0.9.0)" but the file now defines 46 event interfaces. This comment has been stale since multiple feature additions (pipeline events, channel events, etc.).
- Fix: Update the comment or remove the count entirely (it will drift again).

## Suggestions (Lower Confidence)

- **`CommunicationMode` could be an enum** - `src/core/domain.ts:1053` (Confidence: 65%) -- Other mode/type concepts in the codebase use enums (`ScheduleType`, `MissedRunPolicy`). However, type aliases are also used for some union-type fields, so this is more ambiguous.

- **`ChannelRepository` omits a full `update()` method unlike all other repositories** - `src/core/interfaces.ts:1017-1030` (Confidence: 70%) -- Every other repository interface (`TaskRepository`, `ScheduleRepository`, `LoopRepository`, `OrchestrationRepository`, `PipelineRepository`) has a general `update()` method. `ChannelRepository` only has field-specific update methods (`updateStatus`, `updateRound`, `updateMemberStatus`). This may be an intentional design choice for more granular operations, but it deviates from the established pattern.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 3 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Consistency Score**: 6/10
**Recommendation**: CHANGES_REQUESTED

The new code generally follows established patterns well (header comments, Zod boundary validation, `tryCatchAsync` + `operationErrorHandler`, prepared statements, `Object.freeze` immutability, bootstrap registration). The primary deviation is `createChannel` throwing instead of matching the no-throw factory pattern used by all other domain factories -- this is a HIGH finding because it contradicts the project's explicit engineering principle against throwing in business logic. The status type alias vs enum inconsistency and duplicate prepared statements are MEDIUM issues that should be addressed before merge.
