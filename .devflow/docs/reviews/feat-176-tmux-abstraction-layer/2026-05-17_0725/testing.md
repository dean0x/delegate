# Testing Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17

## Issues in Your Changes (BLOCKING)

### HIGH

**dispose() does not test that destroySession failures are logged (warning path uncovered)** - `src/implementations/tmux/tmux-connector.ts:229-234`
**Confidence**: 85%
- Problem: The `dispose()` method now catches `destroySession` errors and calls `this.deps.logger.warn(...)`. This error-handling path has NO test. The existing `dispose cleans up all active handles` test uses a session manager that always succeeds. If the warn log format or error extraction changes, no test would catch a regression.
- Fix: Add a test where `destroySession` returns `err(...)` and assert `logger.warn` is called with the expected session name and error message:
```typescript
it('dispose logs warning when destroySession fails', async () => {
  const { watch } = makeWatchMock();
  const logger = makeLogger();
  const sessionManager = {
    ...makeValidSessionManager(),
    destroySession: vi.fn().mockReturnValue(err(new AutobeatError(ErrorCode.TMUX_SESSION_FAILED, 'session gone'))),
  } as unknown as TmuxSessionManager;

  const connector = new TmuxConnector({
    validator: makeValidValidator(),
    sessionManager,
    hooks: makeValidHooks(),
    logger,
    watch,
  });

  await connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit: vi.fn() });
  connector.dispose();

  expect(logger.warn).toHaveBeenCalledWith('dispose: failed to destroy session', expect.objectContaining({
    sessionName: expect.any(String),
    error: 'session gone',
  }));
});
```

---

**Watcher graceful degradation not tested for messages watcher failure** - `src/implementations/tmux/tmux-connector.ts:287-289`
**Confidence**: 82%
- Problem: The code has a try/catch around starting the messages watcher (line 267-289) that logs a warning and degrades gracefully. There is NO test that verifies spawn still succeeds when the messages watcher throws. The sentinel watcher failure is implicitly tested only in `flush handles missing messagesDir gracefully` (which tests the flush path, not the watcher startup path). A bug in the catch block or a change to the error-handling strategy would go undetected.
- Fix: Add a test where `watch` throws on the second call (messages watcher) and verify spawn still returns `ok`:
```typescript
it('spawn succeeds even when messages watcher fails to start', async () => {
  let callCount = 0;
  const sentinelWatcher = { close: vi.fn() };
  const watch = vi.fn().mockImplementation(() => {
    callCount++;
    if (callCount === 1) return sentinelWatcher;
    throw new Error('ENOENT');
  }) as unknown as TmuxConnectorDeps['watch'];

  const logger = makeLogger();
  const connector = new TmuxConnector({
    validator: makeValidValidator(),
    sessionManager: makeValidSessionManager(),
    hooks: makeValidHooks(),
    logger,
    watch,
  });

  const result = await connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit: vi.fn() });
  expect(result.ok).toBe(true);
  expect(logger.warn).toHaveBeenCalledWith(
    'Failed to start messages watcher',
    expect.any(Object),
  );
  connector.dispose();
});
```

---

**isOutputMessage type guard rejects invalid `type` values but this is NOT tested** - `src/implementations/tmux/tmux-connector.ts:48-58`
**Confidence**: 83%
- Problem: The new `isOutputMessage` function validates that `type` is one of `'stdout' | 'stderr' | 'result'`. The existing test `logs warning and skips callback for malformed JSON` tests invalid JSON parsing, but no test verifies that a structurally-valid JSON object with an invalid `type` field (e.g. `"type": "info"`) is rejected. The old code did NOT validate the type literal union, so this is new behavior that could silently drop messages with unexpected type values. If a future agent writes a message with `type: "debug"`, it would be silently discarded with no diagnostic.
- Fix: Add a test:
```typescript
it('rejects output messages with invalid type field (not stdout/stderr/result)', async () => {
  const invalidMsg = { sequence: 1, timestamp: 'ts', type: 'debug', content: 'x' };
  const readFileSync = vi.fn().mockReturnValue(JSON.stringify(invalidMsg));
  const { watch, fireMessage } = makeWatchMock();
  const onOutput = vi.fn();
  const logger = makeLogger();

  const connector = new TmuxConnector({
    validator: makeValidValidator(),
    sessionManager: makeValidSessionManager(),
    hooks: makeValidHooks(),
    logger,
    watch,
    readFileSync,
  });

  await connector.spawn(BASE_CONFIG, { onOutput, onExit: vi.fn() });
  fireMessage('00001-stdout.json');
  await new Promise((r) => setTimeout(r, 200));

  expect(onOutput).not.toHaveBeenCalled();
  expect(logger.warn).toHaveBeenCalledWith('Output message missing required fields', expect.any(Object));
  connector.dispose();
});
```

---

**Batched env var injection in createSession has inconsistent escaping with sendKeys** - `src/implementations/tmux/tmux-session-manager.ts:119-127`
**Confidence**: 80%
- Problem: The env var value escaping in `createSession` uses `value.replace(/\\/g, '\\\\').replace(/'/g, "'\\''")` (double backslashes + single-quote escape), but `escapeSingleQuoted` (used for sendKeys and the command itself) only does `value.replace(/'/g, "'\\''")` without doubling backslashes. There is no test that verifies env vars containing backslashes are injected correctly. The doubled backslash escaping in `createSession` is arguably correct because the value passes through a shell layer (the `&&`-joined command string), but this inconsistency with the command-embedding approach is untested. If backslash doubling is wrong, values like file paths on Windows or regex patterns would be mangled.
- Fix: Add a test case that verifies backslash handling in env var values:
```typescript
it('escapes backslashes in environment variable values', () => {
  manager.createSession({
    ...validConfig,
    env: { PATH_VAR: 'C:\\Users\\test' },
  });
  const calls: string[] = exec.mock.calls.map((c: [string]) => c[0]);
  const envCall = calls.find((c) => c.includes('set-environment') && c.includes('PATH_VAR'));
  expect(envCall).toContain("'C:\\\\Users\\\\test'");
});
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**No test verifies staleness timer transient-error path (isAlive returns err)** - `src/implementations/tmux/tmux-connector.ts:306-313`
**Confidence**: 82%
- Problem: The staleness timer has a code path for when `isAlive` returns an error result (transient exec error). This path logs a warning and does NOT advance the timer or trigger exit. No test exercises this path. A bug here (e.g., accidentally triggering stale exit on transient errors) would kill sessions prematurely.
- Fix: Add a test with fake timers where `isAlive` returns `err(...)` and verify that `onExit` is NOT called:
```typescript
it('staleness timer tolerates transient isAlive errors without triggering exit', async () => {
  vi.useFakeTimers();
  const { watch } = makeWatchMock();
  const onExit = vi.fn();
  const logger = makeLogger();
  const sessionManager = makeValidSessionManager();
  (sessionManager.isAlive as ReturnType<typeof vi.fn>)
    .mockReturnValue(err(new AutobeatError(ErrorCode.TMUX_SESSION_FAILED, 'exec failed')));

  const connector = new TmuxConnector({
    validator: makeValidValidator(),
    sessionManager,
    hooks: makeValidHooks(),
    logger,
    watch,
  });

  await connector.spawn(
    { ...BASE_CONFIG, staleness: { checkIntervalMs: 1000, maxSilenceMs: 500 } },
    { onOutput: vi.fn(), onExit },
  );

  vi.advanceTimersByTime(10000);
  expect(onExit).not.toHaveBeenCalled();
  expect(logger.warn).toHaveBeenCalledWith(
    expect.stringContaining('isAlive check failed'),
    expect.any(Object),
  );
  connector.dispose();
  vi.useRealTimers();
});
```

---

**No test verifies the session.exited guard in handleMessageFile** - `src/implementations/tmux/tmux-connector.ts:418`
**Confidence**: 80%
- Problem: `handleMessageFile` has an early-return guard `if (session.exited) return;` (line 418). No test verifies that messages arriving after exit are silently dropped. This is a race-condition defense — in production, a debounced message callback could fire after exit. Without a test, the guard could be accidentally removed.
- Fix: Fire a message after sentinel has already triggered exit, verify `onOutput` is not called a second time:
```typescript
it('messages arriving after exit are silently dropped', async () => {
  const msg = { sequence: 1, timestamp: 'ts', type: 'stdout', content: 'hello' };
  const readFileSync = vi.fn().mockReturnValue(JSON.stringify(msg));
  const readdirSync = vi.fn().mockReturnValue([]);
  const { watch, fireMessage, fireSentinel } = makeWatchMock();
  const onOutput = vi.fn();
  const onExit = vi.fn();

  const connector = new TmuxConnector({
    validator: makeValidValidator(),
    sessionManager: makeValidSessionManager(),
    hooks: makeValidHooks(),
    logger: makeLogger(),
    watch,
    readFileSync,
    readdirSync,
  });

  await connector.spawn(BASE_CONFIG, { onOutput, onExit });
  fireSentinel('.done');
  expect(onExit).toHaveBeenCalled();

  // Message arrives after exit (simulates delayed debounce)
  fireMessage('00001-stdout.json');
  await new Promise((r) => setTimeout(r, 200));

  // onOutput was only called during flush (0 times since readdirSync returns [])
  expect(onOutput).not.toHaveBeenCalled();
});
```

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Test mock `makeWatchMock` uses call-count based dispatch (fragile)** - `tests/unit/implementations/tmux/tmux-connector.test.ts:76-91`
**Confidence**: 85%
- Problem: The `makeWatchMock` helper dispatches sentinel vs. messages watcher based on `callCount` (1st call = sentinel, 2nd = messages). If the implementation ever changes the watch creation order, all tests silently break by delivering events to the wrong handler. A path-based dispatch (checking `watchPath` for `/messages` suffix) would be more robust.

## Suggestions (Lower Confidence)

- **Flush force-delivery does not update `nextExpectedSeq`** - `src/implementations/tmux/tmux-connector.ts:382-391` (Confidence: 70%) -- After the force-delivery loop in flush, `nextExpectedSeq` is left at its previous value (before the gap). While this is benign because flush only runs on exit/destroy, it means the internal state is inconsistent. If flush were ever called in a non-terminal context, this could cause duplicate delivery.

- **No test for `escapeSingleQuoted` with empty string** - `src/implementations/tmux/tmux-session-manager.ts:45-47` (Confidence: 65%) -- The `escapeSingleQuoted` function is simple, but passing an empty string to `sendKeys` is not tested. This is likely fine but represents a boundary case.

- **dispose() clears activeSessions before iterating** - `src/implementations/tmux/tmux-connector.ts:222` (Confidence: 62%) -- `activeSessions.clear()` is called before the loop. If `flushPendingFiles` or `closeSession` within the loop were to somehow trigger code that checks `activeSessions` (e.g., a re-entrant sentinel callback), the session would not be found. The test for dispose does not verify this subtle ordering interaction.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 4 | 0 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Testing Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The existing test suite is solid — it covers flush-before-exit, re-entrancy, sequence gaps, and debounce behavior well. The gaps are in error/degradation paths: the messages watcher startup failure, dispose warning on destroySession failure, staleness timer transient errors, and the new `isOutputMessage` type guard's stricter validation. These paths are precisely where production bugs tend to hide (unusual error conditions that tests skip over).
