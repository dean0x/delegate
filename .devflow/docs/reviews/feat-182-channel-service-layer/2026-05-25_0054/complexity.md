# Complexity Review Report

**Branch**: feat-182-channel-service-layer -> main
**Date**: 2026-05-25
**PR**: #193

## Issues in Your Changes (BLOCKING)

### HIGH

**`createChannel` exceeds 50-line function limit (119 lines)** - `src/services/channel-manager.ts:126`
**Confidence**: 95%
- Problem: `createChannel()` spans 119 lines with 11 sequentially numbered steps (validation, uniqueness check, member validation, domain object creation, session spawning with rollback, in-memory state registration, persistence, event emission, topic delivery). The function has an estimated cyclomatic complexity of ~12 (multiple early returns, a for-loop with conditional rollback, conditional topic delivery, conditional round-robin initialization). While each step is individually simple, the aggregate length and decision count make the function difficult to reason about as a unit.
- Fix: Extract validation into a private `validateCreateRequest(request)` method (steps 1-5, ~55 lines), and extract session spawning with rollback into a private `spawnMembersWithRollback(channelName, members)` method (step 7, ~15 lines). This reduces `createChannel` to orchestration of 3-4 method calls at ~30 lines.

```typescript
// Validation extraction example:
private validateCreateRequest(request: ChannelCreateRequest): Result<void> {
  if (!CHANNEL_NAME_REGEX.test(request.name)) { ... }
  // steps 3-5 validation
  return ok(undefined);
}

async createChannel(request: ChannelCreateRequest): Promise<Result<Channel>> {
  const validResult = this.validateCreateRequest(request);
  if (!validResult.ok) return validResult;

  const existingResult = await this.channelRepository.findByName(request.name);
  if (!existingResult.ok) return existingResult;
  if (existingResult.value !== null) { ... }

  const channel = createChannel(request);
  const spawnResult = await this.spawnMembersWithRollback(channel.name, request.members);
  if (!spawnResult.ok) return spawnResult;
  // ... register state, persist, emit, deliver topic
}
```

**`recoverChannels` exceeds 50-line function limit (75 lines) with 4 nesting levels** - `src/services/channel-manager.ts:432`
**Confidence**: 90%
- Problem: `recoverChannels()` spans 75 lines with nested `for (channel) → for (member) → if/else` reaching 4 levels of indentation. The outer for-loop body contains member classification (alive vs dead), all-dead detection with a complex filter expression (line 469), dead member status updates, and conditional round-robin state rebuild. The two branches of the `if (aliveMembers.length === 0 && ...)` / `else` block each perform materially different operations, making the loop body cognitively heavy.
- Fix: Extract the per-channel recovery logic into a `recoverSingleChannel(channel)` method. The alive/dead classification loop and the all-dead vs partial-alive branching become top-level logic in the extracted method, reducing nesting by one level.

```typescript
private async recoverSingleChannel(channel: Channel): Promise<void> {
  const { alive, dead } = this.classifyMembers(channel);
  if (alive.length === 0 && dead.length > 0) {
    await this.markChannelDestroyed(channel.id);
    return;
  }
  await this.rebuildChannelState(channel, alive, dead);
}
```

**`handleChannelMessageSent` exceeds 50-line function limit (77 lines) with nested mode branching** - `src/services/handlers/channel-handler.ts:121`
**Confidence**: 85%
- Problem: `handleChannelMessageSent()` spans 77 lines (including the wrapping `handleEvent` callback) and contains two distinct code paths for round tracking: round-robin (lines 138-160) and broadcast/directed (lines 161-175), plus shared round-increment logic (lines 177-196). The round-robin path has 4 nesting levels (`handleEvent → if round-robin → if !has → if first`). The mutable `roundComplete` flag is a code smell for conditional logic that should be expressed as a return value.
- Fix: Extract `checkRoundComplete(channel, from)` as a private helper returning `boolean`. Each communication mode becomes a separate focused method.

```typescript
private checkRoundComplete(channel: Channel, from: string): boolean {
  if (channel.communicationMode === 'round-robin') {
    return this.checkRoundRobinComplete(channel.id, from, channel.members);
  }
  return this.checkBroadcastRoundComplete(channel.id, from, channel.members);
}
```

**`sendMessage` exceeds 50-line function limit (64 lines) with 3 routing branches** - `src/services/channel-manager.ts:348`
**Confidence**: 82%
- Problem: `sendMessage()` spans 64 lines with three distinct routing paths: (1) targeted delivery to a specific member (lines 362-385), (2) round-robin delivery (lines 388-398), and (3) broadcast delivery (lines 399-402). Each path duplicates the event emission. The method handles both input validation and routing dispatch, mixing concerns.
- Fix: Extract the routing dispatch into a private `routeExternalMessage(channel, message, targetMember?)` method. The `sendMessage` method validates state, dispatches, and emits the event.

### MEDIUM

**`handleMemberOutputAsync` callback complexity (57 lines, 4 nesting levels)** - `src/services/channel-manager.ts:663`
**Confidence**: 80%
- Problem: The `handleMemberOutputAsync` method at line 663 is 57 lines long. The inner `queue.enqueue(async () => { ... })` callback at line 671 contains the actual logic (~48 lines) with 4 nesting levels (method → enqueue → if paused → for targets). The callback performs directed-target parsing, routing, delivery, turn updates, and event emission -- a full message-routing pipeline inlined as a closure.
- Fix: Extract the queued callback body into a private `routeAndDeliverMessage(channelId, memberName, content)` method and call it from the queue.

**`spawnMemberSession` exceeds 50-line function limit (55 lines)** - `src/services/channel-manager.ts:538`
**Confidence**: 80%
- Problem: `spawnMemberSession()` spans 55 lines, slightly above the 50-line threshold. It performs agent registry lookup, session name construction, tmux command building, spawn config override, and tmux connector spawning with async callbacks. The method is sequential with low branching, so it is readable despite the length -- but the inlined `onOutput` and `onExit` callbacks (lines 575-589) add visual noise.
- Fix: Consider extracting the callback construction into a separate method if the function grows further. At 55 lines this is borderline; the numbered comment structure aids readability.

**`handleChannelMemberCrashed` nearing 50-line threshold (54 lines)** - `src/services/handlers/channel-handler.ts:202`
**Confidence**: 80%
- Problem: `handleChannelMemberCrashed()` spans 54 lines with responsibilities for status updates, participation tracking cleanup, round-robin state adjustment, channel re-fetch, and all-dead detection. While each step is individually simple, the method handles too many concerns for a single event handler.
- Fix: Extract the round-robin leader adjustment (lines 227-237) into `adjustRoundRobinAfterCrash(channelId, memberName, channel)`.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`setupEventHandlers` is 315 lines (258-572) with linear handler creation pattern** - `src/services/handler-setup.ts:258`
**Confidence**: 85%
- Problem: `setupEventHandlers()` grew from ~230 lines to ~315 lines with the addition of handler #12 (ChannelHandler). The function follows a repetitive pattern: create handler via factory, check result, log warning or assign. Each optional handler block is ~15 lines of near-identical boilerplate. With 12 handlers, the function exceeds the 300-line file-level warning and approaches critical for a single function. This is pre-existing growth (not introduced by this PR), but the PR adds to it.
- Fix: Create a generic `createOptionalHandler<T>(name, factory, deps)` helper that encapsulates the try/warn/assign pattern. Each optional handler becomes a single call. This is a pre-existing pattern that should be addressed holistically.

**`extractHandlerDependencies` has 18 sequential container.get calls (94 lines)** - `src/services/handler-setup.ts:148`
**Confidence**: 82%
- Problem: `extractHandlerDependencies()` spans 94 lines consisting of 18 sequential `getDependency()` calls with identical `if (!result.ok) return result` guards. This is highly repetitive. The PR added one more call (channelRepository, line 216). The linear fail-fast pattern is correct but creates visual noise proportional to the number of dependencies.
- Fix: Consider a batch extraction helper (e.g., `extractMultiple(container, ['config', 'logger', ...])`). This is a pre-existing design choice that scales linearly with handler count.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`handler-setup.ts` file is 572 lines** - `src/services/handler-setup.ts`
**Confidence**: 85%
- Problem: The file exceeds the 500-line warning threshold. With each new handler type (12 so far), it grows by ~15-25 lines. The PR added ~35 lines (ChannelHandler creation + ChannelRepository extraction). At current trajectory, the next 2-3 handlers push it past the 600-line critical mark.
- Fix: Split into `handler-setup.ts` (core required handlers) and `optional-handler-setup.ts` (optional factory handlers), or introduce the generic optional-handler factory mentioned above.

**`tmux-session-manager.ts` is 499 lines** - `src/implementations/tmux/tmux-session-manager.ts`
**Confidence**: 80%
- Problem: The file is at 499 lines, just under the 500-line warning threshold. The PR added `pasteContent()` (60 lines) which pushed it near the boundary. The file manages session creation, destruction, key sending, environment injection, session listing, and now content pasting -- many distinct responsibilities.
- Fix: If more operations are added, consider splitting paste/buffer operations into a separate helper or composing via a `TmuxBufferManager` class.

## Suggestions (Lower Confidence)

- **Duplicated round-robin first-member sorting pattern** - `src/services/channel-manager.ts:209`, `src/services/channel-manager.ts:492`, `src/services/channel-manager.ts:607`, `src/services/handlers/channel-handler.ts:141` (Confidence: 70%) -- The `[...members].sort((a, b) => a.joinedAt - b.joinedAt)` + take-first pattern appears in 4 locations. Consider a shared `firstActiveMember(members)` utility.

- **`ChannelManager` class has 794 lines with 17 methods** - `src/services/channel-manager.ts` (Confidence: 65%) -- The class manages session spawning, message routing, recovery, and resource cleanup. This is arguably two classes: a lifecycle manager (create/destroy/pause/resume) and a message router (sendMessage, handleMemberOutputAsync, routeAndDeliverMessage). However, the tight coupling via in-memory state (memberHandles, messageQueues) makes splitting non-trivial.

- **4 in-memory Map/Set fields on ChannelManager** - `src/services/channel-manager.ts:106-112` (Confidence: 60%) -- `memberHandles`, `pausedChannels`, `currentTurn`, and `messageQueues` are all mutable state coordinated across multiple methods. A dedicated `ChannelState` value object could encapsulate the per-channel state (handle, queue, turn, paused flag) and reduce the field count.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 4 | 3 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 2 | 0 |

**Complexity Score**: 5/10
**Recommendation**: CHANGES_REQUESTED

The PR introduces a well-structured service layer (ChannelManager, ChannelRouter, ChannelHandler) with clear separation of concerns at the module level. ChannelRouter is commendably stateless and compact (193 lines). However, several methods in ChannelManager and ChannelHandler exceed the 50-line function threshold with elevated cyclomatic complexity. The `createChannel` method at 119 lines is the most significant concern -- it should be decomposed into validation, spawning, and orchestration phases. The `recoverChannels` and `handleChannelMessageSent` methods also warrant extraction to reduce nesting depth. The `handler-setup.ts` growth (572 lines) is a pre-existing trajectory concern amplified by each new handler type. Applies ADR-001 -- channel name validation correctly constrains to tmux-compatible patterns, which simplifies routing logic and avoids complexity from name transformation.
