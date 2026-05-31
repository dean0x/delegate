# Testing Review Report

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-27

## Issues in Your Changes (BLOCKING)

### CRITICAL

**New test file `channel-message-persistence-handler.test.ts` is not included in any test group** - `package.json`
**Confidence**: 95%
- Problem: The file `tests/unit/services/handlers/channel-message-persistence-handler.test.ts` (183 lines, 8 test cases) was added but is not listed in the `test:handlers` script in `package.json`. The `test:handlers` group explicitly enumerates 7 handler test files and does not include this one. The `test:all` script chains the named groups, so this test file will not execute in CI or via any `npm run test:*` command.
- Impact: The ChannelMessagePersistenceHandler has zero automated test coverage in CI. Regressions in event-to-DB message persistence will not be caught by any pipeline.
- Fix: Add the file to the `test:handlers` script in `package.json`:
```json
"test:handlers": "NODE_OPTIONS='--max-old-space-size=2048' vitest run tests/unit/services/handlers/dependency-handler.test.ts tests/unit/services/handlers/schedule-handler.test.ts tests/unit/services/handlers/checkpoint-handler.test.ts tests/unit/services/handlers/persistence-handler.test.ts tests/unit/services/handlers/queue-handler.test.ts tests/unit/services/handlers/loop-handler.test.ts tests/unit/services/handlers/channel-handler.test.ts tests/unit/services/handlers/channel-message-persistence-handler.test.ts --no-file-parallelism"
```

### HIGH

(none)

### MEDIUM

**`useChannelPanePreview` hook test does not verify successful result state** - `tests/unit/cli/dashboard/use-channel-pane-preview.test.ts:96-117`
**Confidence**: 82%
- Problem: The "capture invocation" tests verify that `captureFn` was called with the correct arguments, but never assert that `resultRef.current?.preview` equals the returned value. The test confirms the function was called but not that the hook propagated the result into its state. The error-handling tests similarly only check that captureFn was called or didn't throw, without verifying `resultRef.current?.error`.
- Impact: A bug where the hook calls `captureFn` correctly but fails to `setPreview(result.value)` would pass all existing tests.
- Fix: Add assertions on the hook's output state:
```typescript
it('sets preview to captureFn return value on success', () => {
  const captureFn = vi.fn().mockReturnValue(okResult('output content'));
  const { resultRef, unmount } = renderHookWith(captureFn, 'beat-channel-x-a', true);
  expect(resultRef.current?.preview).toBe('output content');
  expect(resultRef.current?.error).toBeNull();
  unmount();
});

it('sets error when captureFn returns err result', () => {
  const captureFn = vi.fn().mockReturnValue(errResult('session not found'));
  const { resultRef, unmount } = renderHookWith(captureFn, 'beat-channel-x-a', true);
  expect(resultRef.current?.preview).toBeNull();
  expect(resultRef.current?.error).toBe('(session not responding)');
  unmount();
});
```

## Issues in Code You Touched (Should Fix)

### HIGH

(none)

### MEDIUM

**Missing error path test for `cancelEntity` channel when `channelService.destroyChannel` rejects** - `tests/unit/cli/dashboard/entity-mutations.test.ts:176-209`
**Confidence**: 80%
- Problem: The entity-mutations tests cover the cancel-channel happy path (active -> destroy) and no-op cases (terminal, absent service), but do not test the error-swallowing behavior when `channelService.destroyChannel` throws. The source code `cancelEntity` wraps all dispatches in `try/catch` for best-effort behavior. Schedules have a dedicated error-swallowing test (`it('swallows service errors without crashing')`), but channels do not.
- Impact: If the `try/catch` in `cancelEntity` were accidentally removed or the channel branch moved outside the try block, no test would catch the regression.
- Fix: Add an error-swallowing test for channel cancel, mirroring the existing schedule pattern:
```typescript
it('swallows service errors when destroyChannel rejects', async () => {
  const channelService = makeChannelService({
    destroyChannel: vi.fn().mockRejectedValue(new Error('DB error')),
  });
  const mutations = makeMutations({ channelService });
  const refreshNow = vi.fn();
  await expect(
    cancelEntity('channel', 'chan-err', ChannelStatus.ACTIVE, mutations, refreshNow),
  ).resolves.toBeUndefined();
  expect(refreshNow).not.toHaveBeenCalled();
});
```

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Multiple handler test files missing from `test:handlers` group (pre-existing)** - `package.json`
**Confidence**: 90%
- Problem: Beyond the new `channel-message-persistence-handler.test.ts`, these pre-existing handler test files are also not in any test group: `usage-capture-handler.test.ts`, `attributed-task-cancellation-handler.test.ts`, `pipeline-handler.test.ts`. The `test:handlers` group only lists 7 of the 13 handler test files in `tests/unit/services/handlers/`. The `test:all` script chains named groups, so these files never run.
- Impact: Four handler implementations have zero CI coverage. This is a systemic issue predating this PR. (applies ADR-003 -- track pre-existing gaps separately)

## Suggestions (Lower Confidence)

- **Missing `pruneMessagesStmt` test in channel-repository message tests** - `tests/unit/implementations/channel-repository.test.ts` (Confidence: 70%) -- The `saveMessage` implementation calls `pruneMessagesStmt` after every insert to cap messages at `MAX_MESSAGES_PER_CHANNEL`, but no test verifies this pruning behavior (e.g., inserting MAX+1 messages and asserting only MAX remain).

- **`handleChannelNavigation` keyboard handler has no direct unit tests** - `src/cli/dashboard/keyboard/handle-detail-keys.ts:292-320` (Confidence: 65%) -- The channel member up/down navigation function is tested indirectly through the `use-keyboard.test.tsx` integration tests, but there are no direct unit tests for the navigation logic (empty members, boundary clamping). Other entity navigations (loop, orchestration) also lack direct unit tests, so this follows existing convention.

- **Activity feed channel tests do not cover `currentRound=0` edge case** - `tests/unit/cli/dashboard/activity-feed.test.ts:483-617` (Confidence: 62%) -- When `currentRound=0` and `maxRounds` is set, the action maps to `"round 0/5"`. No test verifies this initial-state case, which could display confusingly as "round 0/5" on a just-created channel.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 1 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Testing Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The test suite is thorough in its behavioral coverage: 579 lines of channel-detail component tests, 197 lines of hook tests, 183 lines of persistence handler tests, and comprehensive entity-mutation coverage for channel CRUD. Tests follow the project's established patterns (behavior-driven, AAA structure, ink-testing-library for React components, real in-memory SQLite for repositories). The critical blocker is that the new handler test file is orphaned from all test groups and will never run in CI. Fixing the `test:handlers` group registration unblocks merge.

**Prior resolution acknowledgment**: The Cycle 1 resolution added 13 entity mutation tests (commit d3fd6a1), which are verified present and passing in this review. The channel-specific mutation tests (pause/resume/cancel/delete for channels) are comprehensive and well-structured.
