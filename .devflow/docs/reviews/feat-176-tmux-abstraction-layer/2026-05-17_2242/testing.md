# Testing Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17
**Focus**: Testing quality, coverage gaps, behavior-focused assertions, test fragility

## Issues in Your Changes (BLOCKING)

### HIGH

**Missing test: duplicate taskId spawn rejection** - `src/implementations/tmux/tmux-connector.ts:137-139`
**Confidence**: 95%
- Problem: The `spawn()` method has an explicit guard at line 137 that rejects a duplicate taskId with an error result (`"session for taskId '${config.taskId}' already exists"`). This is a critical safety check to prevent orphaning watchers/timers, but no test verifies this behavior. A future refactor could accidentally remove this guard without detection.
- Fix: Add a test that spawns the same taskId twice and asserts the second spawn returns `err` with the appropriate error message:
```typescript
it('rejects duplicate taskId to prevent orphaning watchers/timers', () => {
  const { watch } = makeWatchMock();
  const connector = new TmuxConnector({
    validator: makeValidValidator(),
    sessionManager: makeValidSessionManager(),
    hooks: makeValidHooks(),
    logger: makeLogger(),
    watch,
  });

  const first = connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit: vi.fn() });
  expect(first.ok).toBe(true);

  const second = connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit: vi.fn() });
  expect(second.ok).toBe(false);
  if (!second.ok) {
    expect(second.error.message).toContain('already exists');
  }
  connector.dispose();
});
```

**Missing test: triggerExit logs warning when destroySession fails** - `src/implementations/tmux/tmux-connector.ts:648-655`
**Confidence**: 90%
- Problem: When `triggerExit` is invoked (e.g., via staleness detection or sentinel), it calls `destroySession`. If that call returns `err`, a warning is logged at line 650. This error path is tested for `dispose()` (line 1509 in test file) but NOT for the `triggerExit` path (sentinel or staleness). The `loggedCleanup` path in `triggerExit` IS tested (line 1680), but the `destroySession` failure within `triggerExit` itself is a distinct branch.
- Fix: Add a test where a sentinel fires but `destroySession` returns an error, and verify the specific "triggerExit: failed to destroy session" warning is logged:
```typescript
it('logs warning when destroySession fails during triggerExit (sentinel fires)', () => {
  const { watch, fireSentinel } = makeWatchMock();
  const logger = makeLogger();
  const sessionManager = makeValidSessionManager();
  (sessionManager.destroySession as ReturnType<typeof vi.fn>).mockReturnValue(
    err(new AutobeatError(ErrorCode.TMUX_SESSION_FAILED, 'tmux crashed'))
  );
  const readFileSync = vi.fn().mockReturnValue('0');

  const connector = new TmuxConnector({
    validator: makeValidValidator(),
    sessionManager,
    hooks: makeValidHooks(),
    logger,
    watch,
    readFileSync,
  });

  connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit: vi.fn() });
  fireSentinel('.done');

  expect(logger.warn).toHaveBeenCalledWith(
    'triggerExit: failed to destroy session',
    expect.objectContaining({ taskId: BASE_CONFIG.taskId }),
  );
});
```

### MEDIUM

**Missing test: invalid terminal dimensions rejection** - `src/implementations/tmux/tmux-session-manager.ts:90-91`
**Confidence**: 92%
- Problem: `createSession` validates width/height (must be positive integers) and returns an error for invalid dimensions. No test exercises this branch. Width of 0, negative numbers, or non-integers would silently pass if this check were removed.
- Fix: Add tests for dimension validation:
```typescript
it('rejects zero/negative dimensions', () => {
  const result = manager.createSession({ ...validConfig, width: 0, height: 50 });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.message).toContain('Invalid dimensions');
});

it('rejects non-integer dimensions', () => {
  const result = manager.createSession({ ...validConfig, width: 10.5, height: 50 });
  expect(result.ok).toBe(false);
});
```

**Missing test: injectEnvironment silently skips invalid POSIX env var keys** - `src/implementations/tmux/tmux-session-manager.ts:131`
**Confidence**: 88%
- Problem: `injectEnvironment` filters env var entries to valid POSIX key names (`/^[A-Za-z_][A-Za-z0-9_]*$/`). Keys like `123-BAD` or `my.key` are silently skipped. No test verifies this filtering. A caller expecting their invalid-key env var to be set would never know it was dropped.
- Fix: Add a test that passes invalid env keys alongside valid ones and asserts only valid keys appear in the exec call:
```typescript
it('silently skips env var keys that do not match POSIX naming rules', () => {
  manager.createSession({ ...validConfig, env: { VALID_KEY: 'ok', '123-bad': 'skip', 'my.key': 'skip' } });
  const calls: string[] = exec.mock.calls.map((c: [string]) => c[0]);
  const envCalls = calls.filter((c) => c.includes('set-environment'));
  const envCall = envCalls[0] ?? '';
  expect(envCall).toContain('VALID_KEY');
  expect(envCall).not.toContain('123-bad');
  expect(envCall).not.toContain('my.key');
});
```

**Missing test: getSessionEnvironment with values containing `=` characters** - `src/implementations/tmux/tmux-session-manager.ts:274-277`
**Confidence**: 85%
- Problem: The `getSessionEnvironment` method uses `indexOf('=')` and `slice(eqIdx + 1)` to parse the value. This correctly handles values containing `=` (e.g., `MY_VAR=base64=encoded==`). However, this edge case has no explicit test. If someone refactored to use `split('=')`, the bug would not be caught.
- Fix:
```typescript
it('getSessionEnvironment handles values containing = characters', () => {
  exec.mockReturnValue({ stdout: 'MY_VAR=abc=def==', stderr: '', status: 0 });
  const result = manager.getSessionEnvironment('beat-task-123', 'MY_VAR');
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value).toBe('abc=def==');
});
```

**Timing-dependent test relies on `sleep()` instead of deterministic control** - `tests/unit/implementations/tmux/tmux-connector.test.ts:543-556`
**Confidence**: 82%
- Problem: The "session-exited-during-async-read" test (line 511-557) uses `await sleep(100)` to wait for the debounce timer to fire. The DEBOUNCE_MS constant is 50ms, so 100ms is 2x the debounce window. In slow CI environments, this could be marginal. While 2x margin is likely sufficient in practice, the test pattern is fragile compared to using `vi.useFakeTimers()` with `vi.advanceTimersByTime()` for deterministic control.
- Fix: Refactor to use fake timers for the debounce window, only keeping real async for the Promise resolution:
```typescript
// Advance fake timers past debounce
vi.advanceTimersByTime(60);
// Then let microtask queue drain for async readFile
await vi.waitFor(() => expect(readFile).toHaveBeenCalled());
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Missing test: multiple concurrent sessions with different staleness intervals** - `src/implementations/tmux/tmux-connector.ts:396-402`
**Confidence**: 80%
- Problem: The `restartSharedStalenessTimer` method computes the minimum `checkIntervalMs` across all active sessions and uses that as the shared timer interval. No test verifies that when multiple sessions with different intervals are spawned, the timer uses the minimum value. This is a key behavior of the shared-timer design decision.
- Fix: Spawn two sessions with different `checkIntervalMs` values (e.g., 2000 and 5000) and verify that the staleness check fires at the minimum interval (2000ms), not the maximum.

**No test for null filename guard in watcher callbacks** - `src/implementations/tmux/tmux-connector.ts:313,346`
**Confidence**: 80%
- Problem: Both the sentinel and messages watcher callbacks have an early return for `null` filename (line 313: `if (!filename) return`; line 346: `if (!filename) return`). This handles a real platform edge case (macOS fs.watch can emit null filenames). No test fires the callback with a null filename.
- Fix: Use the `makeWatchMock` helper but fire `fireSentinel` with an approach that passes null through. Alternatively, directly invoke the captured callback with null and verify no crash or callback invocation occurs.

## Pre-existing Issues (Not Blocking)

### LOW

**Integration tests skip in CI without tmux — no behavior assertion on skip path** - `tests/integration/tmux/session-lifecycle.test.ts:61`
**Confidence**: 85%
- Problem: The `if (SKIP) return;` pattern inside each test body means tests pass as no-ops in CI environments without tmux. While `describe.skipIf` is used in `sentinel-detection.test.ts`, the `session-lifecycle.test.ts` file uses a manual `if (SKIP) return;` pattern inside individual tests, which means they report as "passed" rather than "skipped" in CI. This is a minor reporting issue but makes it harder to track which tests actually ran.
- Fix: Use `it.skipIf(SKIP)(...)` or `describe.skipIf(!tmuxAvailable)` consistently across all integration test files.

## Suggestions (Lower Confidence)

- **Missing edge case: `onOutput` callback throws** - `tmux-connector.ts:601-605` (Confidence: 72%) — If the user-provided `onOutput` callback throws, the `deliverSingle` method will propagate the exception up through `deliverPendingMessages` and `flushPendingFiles`, potentially leaving the session in an inconsistent state (partially flushed). Consider whether this should be caught, or at minimum document that callbacks must not throw.

- **Missing edge case: extremely large message files** - `tmux-connector.ts:558` (Confidence: 65%) — The `handleMessageFile` reads the entire file into memory via `readFile`. If a message file is unusually large (e.g., agent dumps a huge JSON blob), this could cause memory pressure. No test exercises this path to verify behavior under memory constraints.

- **No test verifies `forceDeliverRemaining` delivers in sequence order** - `tmux-connector.ts:525-532` (Confidence: 70%) — The "flush delivers all messages with sequence gaps" test (line 1032) implicitly exercises `forceDeliverRemaining`, but it does not verify the sort order independently. If the sort were removed, the test might still pass by coincidence since `readdirSync` returns files in alphabetical order.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 3 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 1 |

**Testing Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The test suite is well-structured with strong coverage of the happy path, sentinel detection, staleness detection, flush-before-exit, and message ordering. Test helpers are clean and reusable. However, there are notable gaps around the duplicate-taskId guard (a safety-critical path), dimension validation, env var filtering, and the triggerExit destroy-failure branch. The real `sleep()`-based timing in 2-3 tests introduces minor fragility. Overall the test quality is good but these gaps in explicit behavior coverage should be addressed before merge.
