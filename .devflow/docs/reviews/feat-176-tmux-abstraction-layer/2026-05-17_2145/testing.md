# Testing Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17

## Issues in Your Changes (BLOCKING)

### HIGH

**No test for MIN_CHECK_INTERVAL_MS clamping behavior** - `tests/unit/implementations/tmux/tmux-connector.test.ts`
**Confidence**: 92%
- Problem: The production code at `tmux-connector.ts:44-45,394` introduces a `MIN_CHECK_INTERVAL_MS = 1000` constant and clamps the staleness timer interval with `Math.max(Math.min(...intervals), MIN_CHECK_INTERVAL_MS)`. This is a new reliability guard preventing tight-loop setInterval, but no test verifies the clamping behavior. If a caller passes `checkIntervalMs: 100` (below the floor), the test suite would not catch a regression if the clamp were accidentally removed.
- Fix: Add a staleness detection test that spawns with `checkIntervalMs: 100` (below the 1000ms floor) and verifies the timer does not fire at 100ms but does fire at 1000ms:
```typescript
it('clamps checkIntervalMs to MIN_CHECK_INTERVAL_MS (1000ms) floor', async () => {
  vi.useFakeTimers();
  const { watch } = makeWatchMock();
  const onExit = vi.fn();
  const sessionManager = makeValidSessionManager();

  const connector = new TmuxConnector({
    validator: makeValidValidator(),
    sessionManager,
    hooks: makeValidHooks(),
    logger: makeLogger(),
    watch,
  });

  await connector.spawn(
    { ...BASE_CONFIG, staleness: { checkIntervalMs: 100, maxSilenceMs: 50 } },
    { onOutput: vi.fn(), onExit },
  );

  // At 500ms no tick has fired yet (clamped to 1000ms floor)
  vi.advanceTimersByTime(500);
  expect(onExit).not.toHaveBeenCalled();

  // At 1000ms the clamped interval fires
  vi.advanceTimersByTime(500);
  expect(onExit).toHaveBeenCalledWith(null, 'STALE');
  vi.useRealTimers();
});
```

---

**No test for hooks.cleanup failure logging in spawn() error path** - `tests/unit/implementations/tmux/tmux-connector.test.ts`
**Confidence**: 88%
- Problem: At `tmux-connector.ts:165-171`, when `createSession` fails, `hooks.cleanup` is called and its error result is logged. At `tmux-connector.ts:629-635`, the same pattern exists in `triggerExit`. Neither of these cleanup-failure-logging paths has a test. The tests for `hooks.cleanup` on destroy/dispose (lines 1232-1249, 1320-1336) only verify cleanup is called with the right arguments -- they do not verify the warn-on-failure behavior. The three new `cleanupResult` error-handling blocks in spawn, destroy, and triggerExit are a significant change in this diff but only the happy-path (cleanup succeeds) is tested.
- Fix: Add tests for each cleanup failure path. For example, for the spawn error path:
```typescript
it('logs warning when hooks.cleanup fails during spawn rollback', async () => {
  const { watch } = makeWatchMock();
  const logger = makeLogger();
  const hooks = makeValidHooks();
  // cleanup returns an error
  (hooks.cleanup as ReturnType<typeof vi.fn>).mockReturnValue(
    err(new AutobeatError(ErrorCode.TMUX_HOOK_FAILED, 'cleanup failed')),
  );

  const connector = new TmuxConnector({
    validator: makeValidValidator(),
    sessionManager: makeFailingSessionManager(),
    hooks,
    logger,
    watch,
  });

  const result = await connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit: vi.fn() });
  expect(result.ok).toBe(false);
  expect(logger.warn).toHaveBeenCalledWith(
    expect.stringContaining('spawn: hooks.cleanup failed'),
    expect.objectContaining({ taskId: BASE_CONFIG.taskId }),
  );
});
```

Similarly add tests for `destroy: hooks.cleanup failed` and `triggerExit: hooks.cleanup failed`.

---

**No test for messages watcher error handler** - `tests/unit/implementations/tmux/tmux-connector.test.ts`
**Confidence**: 90%
- Problem: The new test at line 403-451 verifies that the **sentinel** watcher's `.on('error')` handler logs a warning. However, the source code at `tmux-connector.ts:365-371` also registers a `.on('error')` handler on the **messages** watcher with a different log message ("Messages watcher error"). This error path has no test coverage. Both watcher error handlers are symmetric in structure but were introduced in this diff as a new behavior.
- Fix: Add a parallel test that captures the messages watcher's `.on('error')` handler and triggers it:
```typescript
it('logs a warning when the messages watcher emits an error event', async () => {
  const logger = makeLogger();
  let messagesErrorHandler: ((err: Error) => void) | null = null;
  let callCount = 0;
  const watch = vi.fn().mockImplementation(
    (_watchPath: string, _opts: unknown, _callback: (event: string, f: string | null) => void) => {
      callCount++;
      if (callCount === 1) {
        return { close: vi.fn(), on: vi.fn() };
      }
      return {
        close: vi.fn(),
        on: vi.fn().mockImplementation((event: string, handler: (err: Error) => void) => {
          if (event === 'error') messagesErrorHandler = handler;
        }),
      };
    },
  ) as unknown as TmuxConnectorDeps['watch'];

  const connector = new TmuxConnector({
    validator: makeValidValidator(),
    sessionManager: makeValidSessionManager(),
    hooks: makeValidHooks(),
    logger,
    watch,
  });

  await connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit: vi.fn() });
  expect(messagesErrorHandler).not.toBeNull();
  messagesErrorHandler!(new Error('ENOSPC'));

  expect(logger.warn).toHaveBeenCalledWith(
    expect.stringContaining('Messages watcher error'),
    expect.objectContaining({ taskId: BASE_CONFIG.taskId }),
  );
  connector.dispose();
});
```

---

### MEDIUM

**No test for handleMessageFile async rejection logging** - `tests/unit/implementations/tmux/tmux-connector.test.ts`
**Confidence**: 85%
- Problem: At `tmux-connector.ts:353-359`, the `.catch()` handler on `handleMessageFile` was added in this diff. It logs via `this.deps.logger.warn('handleMessageFile threw unexpectedly', ...)`. This is a new error-handling path with no test. While the existing malformed JSON test (line 533) covers the case where `handleMessageFile` handles its own error gracefully, there is no test for the case where it throws an unexpected error that the `.catch()` handler must capture.
- Fix: Add a test where `readFile` rejects with a truly unexpected error (not a parse error) after the debounce fires, and verify the logger warning is emitted. Note: this may be difficult to trigger since the current `handleMessageFile` catches all errors internally. The `.catch()` is a defense-in-depth guard for future code changes -- consider adding a comment documenting this as a safety net pattern.

---

**No test for `restartSharedStalenessTimer` replacing `stopSharedStalenessTimerIfEmpty` in destroy/triggerExit** - `tests/unit/implementations/tmux/tmux-connector.test.ts`
**Confidence**: 82%
- Problem: The diff replaces `this.stopSharedStalenessTimerIfEmpty()` with `this.restartSharedStalenessTimer()` in both `destroy()` (line 203) and `triggerExit()` (line 628). This is a behavioral change: previously the timer was simply stopped when no sessions remained, now it is restarted (which recalculates the minimum interval from remaining sessions). With multiple sessions where one exits, the remaining session's interval should be used. The existing multi-session dispose test (line 1338) does not cover the case of one session exiting while others remain.
- Fix: Add a test that spawns two sessions with different `checkIntervalMs` values, exits one, and verifies the staleness timer still fires at the remaining session's interval.

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Real `sleep()` used instead of fake timers in debounce tests** - `tests/unit/implementations/tmux/tmux-connector.test.ts:498,529,553,674,774`
**Confidence**: 85%
- Problem: Several output-handling tests use `await sleep(100/200/300)` with real timers instead of `vi.useFakeTimers()`. This introduces non-determinism. While these are pre-existing (not changed in this diff), they represent a flaky test risk. The DEBOUNCE_MS constant is 50ms and these tests use 80-300ms real sleeps, which works on fast machines but could fail under load.
- Impact: Tests may become flaky under CI load or on slower machines.

## Suggestions (Lower Confidence)

- **Sentinel watcher test uses `await` on `spawn()` unnecessarily** - `tmux-connector.test.ts:438` (Confidence: 65%) -- `spawn()` returns `Result`, not `Promise`. The `await` is a no-op but misleading. This pattern is consistent across the file so it may be intentional for future-proofing, but worth noting.

- **makeWatchMock return type annotation does not include `on`** - `tmux-connector.test.ts:69-70` (Confidence: 70%) -- The return type declares `sentinelWatcher: { close: ReturnType<typeof vi.fn> }` but the implementation now includes `on: vi.fn()`. The type narrowing is inconsistent and could cause confusion, though TypeScript's structural typing makes it functional.

- **No test for `forceDeliverRemaining` empty-map early return** - `tmux-connector.test.ts` (Confidence: 62%) -- The extracted `forceDeliverRemaining` method at `tmux-connector.ts:514-515` has an early return when `pendingMessages.size === 0`. This is implicitly tested by the flush-with-no-messages test but not explicitly asserted as a behavior.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 3 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Testing Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The existing test suite is well-structured with good behavioral coverage of the happy path, sentinel detection, flush ordering, staleness detection, and graceful degradation. The new tests for watcher error handling, alive-session reset, hooks.cleanup verification, and dispose cleanup are valuable additions. However, the diff introduces four new code paths (MIN_CHECK_INTERVAL_MS clamping, cleanup failure logging in 3 sites, messages watcher error handler, handleMessageFile catch handler) that lack corresponding test coverage. The most impactful gap is the MIN_CHECK_INTERVAL_MS clamp, which is a reliability guard that would silently regress without a test.
