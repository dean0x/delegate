# Testing Review Report

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-28

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Missing error-path test for `deleteEntity` channel branch** - `tests/unit/cli/dashboard/entity-mutations.test.ts`
**Confidence**: 85%
- Problem: `cancelEntity` (channel) and `pauseOrResumeEntity` (schedule) both have explicit "swallows service errors without crashing" tests, but `deleteEntity` (channel) does not. The implementation at `src/cli/dashboard/keyboard/entity-mutations.ts:208` has a catch block that swallows repo errors. All three functions share the same try/catch swallowing pattern, yet only two of the three have the corresponding test. This is an asymmetry in the test suite that leaves the deleteEntity error path uncovered for channels.
- Fix: Add a test analogous to lines 211-222:
```typescript
it('swallows repo errors without crashing', async () => {
  const mutations = makeMutations({
    channelRepo: makeChannelRepo({
      delete: vi.fn().mockRejectedValue(new Error('repo unavailable')),
    }),
  });
  const refreshNow = vi.fn();
  await expect(
    deleteEntity('channel', 'chan-err', ChannelStatus.DESTROYED, mutations, refreshNow),
  ).resolves.toBeUndefined();
  expect(refreshNow).not.toHaveBeenCalled();
});
```

**Missing save-failure error path test for `ChannelMessagePersistenceHandler`** - `tests/unit/services/handlers/channel-message-persistence-handler.test.ts`
**Confidence**: 82%
- Problem: The handler's `persistMessage` method at `src/services/handlers/channel-message-persistence-handler.ts:100-106` has an explicit error-handling branch: when `saveResult.ok` is false, it logs a warning and returns `ok(undefined)` (best-effort). No test exercises this path. The handler uses a real in-memory SQLite repo, so triggering a save failure requires either emitting an event with a non-existent channelId (FK violation) or closing the DB before emit. This is the only untested branch in the handler and matches the project's pattern of testing error resilience (avoids PF-001 -- surface and fix issues while here rather than deferring).
- Fix: Add a test in the "ChannelMessageSent" describe block:
```typescript
it('logs warning and does not throw when saveMessage fails (FK violation)', async () => {
  const nonExistentChannelId = ChannelId('ch-nonexistent');
  await eventBus.emit('ChannelMessageSent', {
    channelId: nonExistentChannelId,
    from: 'architect',
    to: 'all',
    round: 1,
    summary: 'This should fail FK check',
  });
  await flushEventLoop();

  // No throw, no crash -- handler is best-effort
  // Verify warning was logged
  expect(logger.warnings.length).toBeGreaterThan(0);
});
```

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

_No CRITICAL pre-existing issues in reviewed files._

## Suggestions (Lower Confidence)

- **Hook state update assertion gap** - `tests/unit/cli/dashboard/use-channel-pane-preview.test.ts` (Confidence: 65%) -- Tests document that Ink's test renderer cannot observe useEffect-triggered state updates synchronously. The tests correctly verify captureFn invocation args and return values, but cannot assert the resulting `preview`/`error` state values. The existing comments (lines 8-11, 96-98, 122-124) document this limitation clearly. If Ink gains synchronous flush support in the future, these tests should be upgraded to assert state directly.

- **`pauseOrResumeEntity` channel error-swallowing test missing** - `tests/unit/cli/dashboard/entity-mutations.test.ts` (Confidence: 70%) -- There is a "swallows service errors" test for `pauseOrResumeEntity` on the schedule branch (line 119) and for `cancelEntity` on the channel branch (line 211), but not for `pauseOrResumeEntity` on the channel branch. Lower confidence because the shared catch block at line 148 is already exercised by the schedule error test, reducing but not eliminating the gap.

- **Activity feed channel tests lack `channels: [...]` in non-channel tests** - `tests/unit/cli/dashboard/activity-feed.test.ts` (Confidence: 62%) -- All existing non-channel tests were updated to pass `channels: []`. This is correct for type compliance. However, no existing test verifies that a non-empty channels array interleaves correctly with ALL other entity types simultaneously (the `sorts channels with other entity kinds` test at line 608 only uses tasks + channels). This is a minor combinatorial gap.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Testing Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Rationale

The test suite for this PR is comprehensive and well-structured. 15 test files changed, with 4 entirely new test files (channel-detail.test.tsx, use-channel-pane-preview.test.ts, channel-message-persistence-handler.test.ts, tmux-session-manager additions). Test patterns follow project conventions: behavior-focused assertions, real in-memory SQLite for repository tests, ink-testing-library for React components, fake timers for polling, and proper AAA structure.

Strengths:
- Channel detail view tests cover all 5 sections (header, rounds, members, messages, live preview) with edge cases (undefined fields, empty arrays, null states)
- Entity mutations tests cover all three operations (cancel, pause/resume, delete) for channels with terminal-status guards, absent-service guards, and error swallowing
- Repository tests added 11 new test cases for saveMessage/getMessages including ordering, limit clamping, CASCADE delete, MAX_MESSAGES pruning, and null toMember mapping
- Hook tests properly handle Ink renderer limitations with documented workarounds
- Activity feed tests exercise all channel status verb mappings and integration with existing entity types
- Applies ADR-001 (channel name regex tests validate tmux session name compatibility)
- Avoids PF-001 (surfaces issues rather than deferring)

The two MEDIUM findings are narrow gaps (missing error-path tests for two branches) that should be addressed before merge but do not represent behavioral risk.
