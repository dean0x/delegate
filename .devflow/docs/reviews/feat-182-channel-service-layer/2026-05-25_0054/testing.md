# Testing Review Report

**Branch**: feat-182-channel-service-layer -> main
**Date**: 2026-05-25

## Issues in Your Changes (BLOCKING)

### HIGH

**ChannelHandler cleanup test uses overly permissive assertion** - `tests/unit/services/handlers/channel-handler.test.ts:451`
**Confidence**: 85%
- Problem: The cleanup test (line 406-452) asserts `roundCalls <= 2` which is extremely permissive and would pass even with broken behavior. The test comments acknowledge uncertainty ("either is acceptable") about what should happen after destroy. This means the test does not actually verify that cleanup works -- it just verifies no infinite loop occurs. The assertion should be deterministic: either the handler skips messages for destroyed channels (updateRound called 0 times after destroy) or it processes them (called once). The current assertion would mask regressions.
- Fix: Determine the expected behavior (handler should skip DESTROYED channels based on the `channel.status !== 'active'` guard in `handleChannelMessageSent`), then assert deterministically:
```typescript
// After destroy, messages should be ignored (status check in handler)
const roundCallsBefore = (repo.updateRound as ReturnType<typeof vi.fn>).mock.calls.length;

// Emit messages after destroy
await eventBus.emit('ChannelMessageSent', { ... });
await eventBus.emit('ChannelMessageSent', { ... });
await flushEventLoop();

// No new round increments -- handler ignores destroyed channels
expect((repo.updateRound as ReturnType<typeof vi.fn>).mock.calls.length).toBe(roundCallsBefore);
```

### MEDIUM

**ChannelManager.sendMessage broadcast test does not verify message content** - `tests/unit/services/channel-manager.test.ts:408-430`
**Confidence**: 82%
- Problem: The broadcast sendMessage test asserts `pasteContent` was called 3 times but never verifies the message content delivered to each member. The test would pass even if the manager delivered garbled or empty content to members. The `pasteContent` mock tracks content via `_pastedContent` but the test ignores it.
- Fix: Add a content assertion after verifying call count:
```typescript
expect(tmuxConnector.pasteContent).toHaveBeenCalledTimes(3);
// Verify content delivered to each member
for (const entry of tmuxConnector._pastedContent) {
  expect(entry.content).toBe('hello everyone');
}
```

**Missing test for createChannel rollback on spawn failure** - `tests/unit/services/channel-manager.test.ts`
**Confidence**: 83%
- Problem: `ChannelManager.createChannel` has rollback logic (lines 191-195 in channel-manager.ts) that destroys already-spawned sessions if a later spawn fails. This error path is not tested. If the rollback logic broke, partially-created channels would leak tmux sessions.
- Fix: Add a test where the second member spawn fails:
```typescript
it('rolls back spawned sessions when a later member spawn fails', async () => {
  // First spawn succeeds, second fails
  tmuxConnector.spawn
    .mockImplementationOnce((config) => ok({ sessionName: config.name, taskId: config.taskId, sessionsDir: '/tmp' }))
    .mockImplementationOnce(() => err(new AutobeatError(ErrorCode.SYSTEM_ERROR, 'spawn failed')));

  const result = await manager.createChannel({
    name: 'rollback-ch',
    members: [
      { name: 'a', agent: 'claude' },
      { name: 'b', agent: 'claude' },
    ],
    communicationMode: 'broadcast',
    maxRounds: 5,
  });

  expect(result.ok).toBe(false);
  // First session should have been destroyed during rollback
  expect(tmuxConnector.destroy).toHaveBeenCalledOnce();
});
```

**Missing test for createChannel rollback on save failure** - `tests/unit/services/channel-manager.test.ts`
**Confidence**: 82%
- Problem: `ChannelManager.createChannel` has a second rollback path (lines 216-220) that destroys sessions and cleans up in-memory state when `channelRepository.save()` fails. This path is not tested.
- Fix: Similar to the spawn rollback test -- mock `channelRepo.save` to return an error and verify sessions are cleaned up.

**Missing error path coverage for ChannelRouter.route with only-self-active scenario** - `tests/unit/services/channel-router.test.ts`
**Confidence**: 80%
- Problem: The `nextRoundRobinMember` method (channel-router.ts:171) returns `undefined` when `nextIdx === currentIdx` (only one active member left, which is the current speaker). This edge case is exercised indirectly through `route()` but is not explicitly tested via `nextRoundRobinMember()` directly. The test at line 299 tests "all others destroyed" but not "only self remains active."
- Fix: Add:
```typescript
it('returns undefined when only the current speaker is active', () => {
  const members = [
    { ...makeMember('a'), joinedAt: 1 },
    { ...makeMember('b', ChannelMemberStatus.DESTROYED), joinedAt: 2 },
    { ...makeMember('c', ChannelMemberStatus.DESTROYED), joinedAt: 3 },
  ];
  const next = ChannelRouter.nextRoundRobinMember(members, 'a');
  expect(next).toBeUndefined();
});
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**ChannelManager.dispose() is not tested for session cleanup behavior** - `src/services/channel-manager.ts:512-530`
**Confidence**: 82%
- Problem: The `dispose()` method closes all message queues and destroys all member sessions. The test `afterEach` calls `manager.dispose()` for cleanup but never asserts its behavior. If dispose silently stopped destroying sessions, no test would catch it.
- Fix: Add a dedicated test that creates a channel, then calls dispose, and verifies `tmuxConnector.destroy` was called for all spawned sessions.

**ChannelHandler round-robin round tracking lacks multi-round progression test** - `tests/unit/services/handlers/channel-handler.test.ts:207-225`
**Confidence**: 80%
- Problem: The round-robin test only covers a single round increment (A->B->C->A triggers round 1). It does not verify that the round-robin tracking resets properly for subsequent rounds. The `rrFirstMemberSeen` flag management could have bugs that only manifest on the second full cycle.
- Fix: Extend the test to verify two consecutive round completions:
```typescript
it('tracks multiple consecutive round-robin rounds', async () => {
  // ... setup ...
  // Round 0 -> 1: A->B->C->A
  for (const speaker of ['a', 'b', 'c', 'a']) { await eventBus.emit(...); }
  await flushEventLoop();
  expect(repo.updateRound).toHaveBeenCalledWith('ch-rr', 1);

  // Round 1 -> 2: B->C->A (continuing from where we left off)
  for (const speaker of ['b', 'c', 'a']) { await eventBus.emit(...); }
  await flushEventLoop();
  expect(repo.updateRound).toHaveBeenCalledWith('ch-rr', 2);
});
```

## Pre-existing Issues (Not Blocking)

No pre-existing CRITICAL issues found.

## Suggestions (Lower Confidence)

- **Missing test for ChannelManager.recoverChannels with mixed alive/dead members** - `tests/unit/services/channel-manager.test.ts` (Confidence: 70%) -- The recovery tests cover all-dead and all-alive scenarios but not a channel with some alive and some dead members, where dead members should be marked DESTROYED while the channel stays ACTIVE.

- **SerialQueue error swallowing not observable in tests** - `src/services/channel-manager.ts:66-68` (Confidence: 65%) -- The SerialQueue catches and silently drops errors (`.catch(() => {})`). While the comment says "errors already logged by caller," tests never verify that a failed enqueued task does not prevent subsequent tasks from running.

- **ChannelManager mock connector uses `as` type cast** - `tests/unit/services/channel-manager.test.ts:161` (Confidence: 62%) -- The `tmuxConnector: tmuxConnector as ReturnType<typeof createMockTmuxConnector>` cast could mask type mismatches between the mock and the real TmuxConnectorPort interface if the interface evolves.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 4 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Testing Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The test suite covers 75 tests across 4 new test files with good behavioral coverage of the happy paths. Test architecture follows project conventions well: MockTmuxConnector, real EventBus, factory-injected dependencies, AAA structure, and Result-type assertions. ADR-001 (channel name = tmux session name) is properly reflected in the routing and session naming tests (applies ADR-001).

Key gaps to address: (1) the non-deterministic cleanup assertion in ChannelHandler that could mask regressions, (2) missing rollback path coverage in ChannelManager.createChannel, and (3) missing message content verification in sendMessage broadcast tests. These represent real behavioral gaps rather than stylistic preferences.
