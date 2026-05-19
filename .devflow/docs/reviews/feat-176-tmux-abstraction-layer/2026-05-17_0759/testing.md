# Testing Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17
**Diff**: `git diff 1bec153be5..40f9537` (6 commits)

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Watch mock missing `.on()` method causes silent no-ops for watcher error handlers** - `tests/unit/implementations/tmux/tmux-connector.test.ts:74-75`
**Confidence**: 90%
- Problem: The `makeWatchMock()` helper returns watcher objects with only `{ close: vi.fn() }` but the production code (tmux-connector.ts:282,316) now calls `.on('error', handler)` on both watchers to register error handlers for graceful degradation. Because the mock objects lack an `on` method, calling `.on(...)` silently returns `undefined` (via the `as unknown` cast), meaning the error handler is never registered. This makes the new watcher error degradation path (a key behavioral addition in this diff) untestable through the default mock. The one test that does cover graceful degradation (line 288-321) creates its own custom mock with `{ close: vi.fn(), on: vi.fn() }`, but all other tests silently skip registering the error handler.
- Fix: Add `on: vi.fn()` to both `sentinelWatcher` and `messageWatcher` in `makeWatchMock()`:
  ```typescript
  const sentinelWatcher = { close: vi.fn(), on: vi.fn() };
  const messageWatcher = { close: vi.fn(), on: vi.fn() };
  ```
  And add a test that verifies the watcher error handler fires the degradation logging:
  ```typescript
  it('logs warning when sentinel watcher emits error event', async () => {
    const { watch, sentinelWatcher } = makeWatchMock();
    const logger = makeLogger();
    const connector = new TmuxConnector({ ... });
    await connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit: vi.fn() });
    // Fire the error handler registered via sentinelWatcher.on('error', ...)
    const errorHandler = (sentinelWatcher.on as ReturnType<typeof vi.fn>).mock.calls
      .find(([event]) => event === 'error')?.[1];
    errorHandler?.(new Error('watch EACCES'));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Sentinel watcher error'),
      expect.any(Object),
    );
    connector.dispose();
  });
  ```

### MEDIUM

**Missing test for staleness reset when session IS alive (positive path)** - `tests/unit/implementations/tmux/tmux-connector.test.ts:936`
**Confidence**: 85%
- Problem: The staleness detection tests cover: (1) session absent -> STALE fires, (2) listSessions returns err -> warning logged, no STALE, (3) no double-fire after sentinel exit. But there is no test for the positive case where `listSessions` returns the session name (confirming the session is alive), which should reset `lastAliveCheck` and prevent STALE from firing. This is the core correctness path of the shared staleness timer refactor — if `lastAliveCheck` is not updated when the session is confirmed alive, sessions would be incorrectly marked stale even when they are running.
- Fix: Add a test that mocks `listSessions` to return the session, advances time past `maxSilenceMs`, and asserts `onExit` is NOT called:
  ```typescript
  it('does not fire STALE when session appears in listSessions (alive)', async () => {
    vi.useFakeTimers();
    const { watch } = makeWatchMock();
    const onExit = vi.fn();
    const sessionManager = makeValidSessionManager();
    // Session appears in listSessions — confirmed alive
    (sessionManager.listSessions as ReturnType<typeof vi.fn>).mockReturnValue(
      ok([{ name: 'beat-task-abc', created: 0, attached: false, width: 80, height: 24 }]),
    );
    const connector = new TmuxConnector({
      validator: makeValidValidator(),
      sessionManager,
      hooks: makeValidHooks(),
      logger: makeLogger(),
      watch,
    });
    await connector.spawn(
      { ...BASE_CONFIG, staleness: { checkIntervalMs: 1000, maxSilenceMs: 500 } },
      { onOutput: vi.fn(), onExit },
    );
    // Advance well past maxSilenceMs — but session is alive so no STALE
    vi.advanceTimersByTime(10000);
    expect(onExit).not.toHaveBeenCalled();
    connector.dispose();
    vi.useRealTimers();
  });
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`sleep()`-based tests use real timers and are timing-sensitive (potential flakiness)** - `tests/unit/implementations/tmux/tmux-connector.test.ts:448,478,502,542-546,572,624,724,862`
**Confidence**: 82%
- Problem: Nine tests use `await sleep(80)`, `await sleep(100)`, `await sleep(200)`, or `await sleep(300)` with real timers to wait for debounce+async read completion. The `handleMessageFile` method now uses `await this.readFileFn(...)` (async), and the debounce is `setTimeout(50ms)`. These tests rely on wall-clock timing: they assume the debounce fires AND the async read completes within the sleep window. Under CI load or slow I/O, these could flake. The pattern is consistent with how the tests were written pre-diff, but the async change adds another timing variable. Consider using `vi.waitFor()` (already used in the `output JSON file fires onOutput` test at line 428) as a non-flaky alternative for all these tests.
- Fix: Replace `await sleep(N)` with `await vi.waitFor(() => expect(...), { timeout: 1000 })` in tests that assert after the sleep. Example for the debounce test:
  ```typescript
  // Before:
  await sleep(200);
  expect(onOutput).toHaveBeenCalledTimes(1);
  // After:
  await vi.waitFor(() => expect(onOutput).toHaveBeenCalledTimes(1), { timeout: 1000 });
  ```

### MEDIUM

**No test verifies `hooks.cleanup()` is called on destroy/dispose/triggerExit** - `tests/unit/implementations/tmux/tmux-connector.test.ts:1066-1171,1194-1267`
**Confidence**: 85%
- Problem: The production code now calls `this.deps.hooks.cleanup(taskId, sessionsDir)` in three exit paths: `destroy()` (line 218), `dispose()` (line 255), and `triggerExit()` (line 576). This is a new behavioral contract added in this diff. However, no test asserts that `hooks.cleanup` is called in any of these paths. The `cleanup` mock is set up (`vi.fn().mockReturnValue(ok(undefined))`) but never asserted upon.
- Fix: Add assertions to existing tests. For example in `'calls sessionManager.destroySession with the session name'`:
  ```typescript
  const hooks = makeValidHooks();
  // ... after connector.destroy(spawnResult.value):
  expect(hooks.cleanup).toHaveBeenCalledWith('task-abc', '/tmp/sessions');
  ```
  And similarly for `dispose` and the sentinel-triggered exit path.

## Pre-existing Issues (Not Blocking)

### LOW

**"silently drops messages with an invalid type field" test uses `sleep(200)` to prove a negative** - `tests/unit/implementations/tmux/tmux-connector.test.ts:453-481`
**Confidence**: 80%
- Problem: This test fires a message with type `'unknown-type'`, waits 200ms, then asserts `onOutput` was not called. Proving a negative with a fixed-duration sleep is inherently weak — if the code had a bug that delivered after 250ms, the test would still pass. This pattern is pre-existing (used in the `.tmp` file test too), but the new test follows the same pattern. Consider also asserting that `logger.warn` was called with the "missing required fields" message, which would provide a positive assertion that the validation path was exercised.

## Suggestions (Lower Confidence)

- **Missing test for `readFile` rejection in `handleMessageFile`** - `tests/unit/implementations/tmux/tmux-connector.test.ts` (Confidence: 70%) -- The `handleMessageFile` hot path now uses async `readFileFn`. The "malformed JSON" test covers parsing failures but there is no dedicated test for when `readFile` itself rejects (e.g., ENOENT, EACCES). The existing malformed-JSON test happens to reach the same `catch` block, but an explicit `readFile.mockRejectedValue(new Error('ENOENT'))` test would better document the contract.

- **No test for multi-session shared staleness timer interval calculation** - `tests/unit/implementations/tmux/tmux-connector.test.ts` (Confidence: 65%) -- The `restartSharedStalenessTimer` picks the minimum `checkIntervalMs` across all active sessions. There is no test that spawns two sessions with different `checkIntervalMs` values and verifies the timer ticks at the minimum interval. The dispose-cleans-all test spawns two sessions but does not exercise the shared timer interval logic.

- **`beforeEach`/`afterEach` missing in staleness tests** - `tests/unit/implementations/tmux/tmux-connector.test.ts:936-1063` (Confidence: 62%) -- Some staleness tests call `vi.useFakeTimers()` and `vi.useRealTimers()` within the test body. If a test fails between these calls, subsequent tests may run with fake timers. Using `beforeEach`/`afterEach` hooks for timer management would prevent cascading failures.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 1 |

**Testing Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The test suite is solid overall: 41 unit tests + 16 integration tests provide strong coverage of the connector, hooks, and session manager. Tests correctly validate behavior (not implementation), use dependency injection throughout, and the mock structure is clean. The main gaps are: (1) the watcher error degradation path is not fully testable through the default mock, (2) the positive staleness-alive path lacks coverage, and (3) the new `hooks.cleanup()` calls have no assertions. None of these are blocking, but fixing them would complete the behavioral contract coverage for the new shared-timer and cleanup changes. Applies PF-001 — all findings reported, none deferred.
