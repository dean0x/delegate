# TypeScript Review Report

**Branch**: feat/181-channel-domain-persistence -> main
**Date**: 2026-05-24

## Issues in Your Changes (BLOCKING)

### HIGH

**Null-to-undefined type lie via `as` cast in `rowToChannel`** - `src/implementations/channel-repository.ts:318`
**Confidence**: 95%
- Problem: `validated.communication_mode` is typed as `'broadcast' | 'directed' | 'round-robin' | null` after Zod parsing. The cast `as CommunicationMode | undefined` tells TypeScript the value is `CommunicationMode | undefined`, but when the DB column is `NULL`, the runtime value is `null` -- not `undefined`. The domain type `Channel.communicationMode?: CommunicationMode` expects `undefined`, never `null`. This creates a type-system lie: downstream code checking `channel.communicationMode === undefined` will fail to match when the value is actually `null`. Lines 319 (`topic`), 321 (`maxRounds`), and 323 (`createdBy`) correctly use `?? undefined` to convert null.
- Fix: Replace the `as` cast with nullish coalescing, matching the pattern used on adjacent lines:
```typescript
communicationMode: validated.communication_mode ?? undefined,
```

### MEDIUM

**Mutable array type in event interface** - `src/core/events/events.ts:317`
**Confidence**: 85%
- Problem: `ChannelCreatedEvent.members` is typed as `string[]` (mutable). Every other property on domain types and events in this codebase uses `readonly` arrays. This is the only `[]` array type across all event interfaces. It allows mutation of the event payload after emission, violating immutability by default.
- Fix: Use `readonly string[]`:
```typescript
export interface ChannelCreatedEvent extends BaseEvent {
  type: 'ChannelCreated';
  channelId: ChannelId;
  name: string;
  members: readonly string[];
  communicationMode?: CommunicationMode;
}
```

**`createChannel` throws instead of returning Result** - `src/core/domain.ts:1093-1108`
**Confidence**: 82%
- Problem: `createChannel` introduces `throw new AutobeatError(...)` for name validation (lines 1095, 1104). This is the only factory function in domain.ts that throws -- `createTask`, `createSchedule`, `createLoop`, `createOrchestration`, and `createPipeline` all return their type directly without throwing. The project's engineering principles state "Never throw errors in business logic" and "Always use Result types." While input validation at boundaries can justify throws, this factory is called from business logic (repository tests, future handlers), so callers must wrap in try/catch rather than matching on Result.
- Fix: Return `Result<Channel>` and use `err()` for validation failures:
```typescript
export const createChannel = (request: ChannelCreateRequest): Result<Channel> => {
  if (!CHANNEL_NAME_REGEX.test(request.name)) {
    return err(new AutobeatError(
      ErrorCode.INVALID_INPUT,
      `Invalid channel name "${request.name}": must match ${CHANNEL_NAME_REGEX}`,
    ));
  }
  // ... member validation similarly returns err(...)
  return ok(Object.freeze({ ... }));
};
```
Note: This requires updating tests from `expect(() => createChannel(...)).toThrow()` to `expect(createChannel(...).ok).toBe(false)`. (avoids PF-001 -- surfacing now rather than deferring)

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Redundant `as` casts after Zod validation** - `src/implementations/channel-repository.ts:320,333` (Confidence: 70%) -- After Zod `.parse()`, the validated output already has the correct literal union type (e.g., `'active' | 'paused' | 'completed' | 'destroyed'`). The `as ChannelStatus` and `as AgentProvider` casts are redundant and suppress future type errors if the Zod schema and domain types diverge. Consider removing the casts and relying on Zod's inferred types.

- **`updateChannel` accepts `Partial<Omit<Channel, 'id'>>` allowing `createdAt` override** - `src/core/domain.ts:1134` (Confidence: 65%) -- The update function allows overriding `createdAt`, which is an immutable creation timestamp. Other update functions (`updateLoop`, `updateOrchestration`) use `Partial<Loop>` / `Partial<Orchestration>` which have the same pattern, so this is consistent with the codebase. However, a stricter `Pick` or dedicated `ChannelUpdate` interface would prevent accidental mutation of creation-time fields.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**TypeScript Score**: 8/10
**Recommendation**: CHANGES_REQUESTED
