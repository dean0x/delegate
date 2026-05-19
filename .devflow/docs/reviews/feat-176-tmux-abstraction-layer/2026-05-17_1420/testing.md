# Testing Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17
**Reviewer Focus**: Test coverage gaps, test quality, behavior vs implementation coupling, missing edge case tests

## Issues in Your Changes (BLOCKING)

### HIGH

**Missing test for sentinel + staleness simultaneous race condition** - `tests/unit/implementations/tmux/tmux-connector.test.ts`
**Confidence**: 90%
- Problem: The source code at `tmux-connector.ts:211-240` has a staleness timer and at `tmux-connector.ts:353-371` a sentinel handler. The `triggerExit` method at line 443 guards against double-fire via `session.exited`. The test at line 846 ("staleness timer stops after exit -- no double-fire") only tests sentinel-first-then-staleness. The reverse race (staleness fires, then sentinel arrives) is untested. This is explicitly called out as a gotcha in the KNOWLEDGE.md.
- Fix: Add a test that advances fake timers past the staleness threshold first, confirms `onExit(null, 'STALE')` is called, then fires the sentinel and asserts `onExit` was NOT called a second time:
```typescript
it('sentinel does not double-fire when staleness already triggered', async () => {
  vi.useFakeTimers();
  const { watch, fireSentinel } = makeWatchMock();
  const onExit = vi.fn();
  const readFileSync = vi.fn().mockReturnValue('0');

  const sessionManager = makeValidSessionManager();
  (sessionManager.isAlive as ReturnType<typeof vi.fn>).mockReturnValue(ok(false));

  const connector = new TmuxConnector({
    validator: makeValidValidator(),
    sessionManager,
    hooks: makeValidHooks(),
    logger: makeLogger(),
    watch,
    readFileSync,
  });

  await connector.spawn(
    { ...BASE_CONFIG, staleness: { checkIntervalMs: 1000, maxSilenceMs: 500 } },
    { onOutput: vi.fn(), onExit },
  );

  // Staleness fires first
  vi.advanceTimersByTime(2000);
  expect(onExit).toHaveBeenCalledWith(null, 'STALE');

  // Then sentinel arrives late
  fireSentinel('.done');
  expect(onExit).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});
```

**Missing test for flush with out-of-order messages on exit** - `tests/unit/implementations/tmux/tmux-connector.test.ts`
**Confidence**: 85%
- Problem: The `flushPendingFiles` method at `tmux-connector.ts:339-347` has special logic to force-deliver remaining out-of-order messages (when `pendingMessages.size > 0` after the initial drain, it resets `nextExpectedSeq` and re-delivers). No test exercises this specific path -- the existing flush tests only have sequential messages (seq 1, 2) or a single message. A gap scenario where seq 3 is on disk but seq 2 was never written should be tested.
- Fix: Add a test with a gap in the sequence during flush:
```typescript
it('flush force-delivers out-of-order messages when gap will never fill', async () => {
  const msgs = {
    '00001-stdout.json': buildOutputMsg(1),
    '00003-stdout.json': buildOutputMsg(3), // seq 2 never written
  };
  const readFileSync = makeFlushReadFileSync(msgs);
  const readdirSync = vi.fn().mockReturnValue(['00001-stdout.json', '00003-stdout.json']);
  const { watch, fireSentinel } = makeWatchMock();
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

  expect(onOutput).toHaveBeenCalledTimes(2);
  expect(onOutput.mock.calls[0]![0].sequence).toBe(1);
  expect(onOutput.mock.calls[1]![0].sequence).toBe(3);
});
```

**Missing test for `handleMessageFile` with structurally-invalid JSON (valid JSON but wrong shape)** - `tests/unit/implementations/tmux/tmux-connector.test.ts`
**Confidence**: 82%
- Problem: `tmux-connector.ts:385-396` validates that parsed JSON has `sequence`, `timestamp`, `type`, and `content` fields of the correct types. The test at line 411 covers malformed JSON (parse failure), but no test covers valid JSON with missing/wrong-typed fields (e.g., `{"foo": "bar"}`). The source logs a warning with `'Output message missing required fields'` at line 393, but this log message is never asserted in any test.
- Fix: Add a test with valid JSON that lacks required fields:
```typescript
it('logs warning and skips callback for JSON missing required fields', async () => {
  const readFileSync = vi.fn().mockReturnValue('{"foo": "bar"}');
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
  expect(logger.warn).toHaveBeenCalledWith(
    'Output message missing required fields',
    expect.any(Object),
  );
  connector.dispose();
});
```

### MEDIUM

**Real `setTimeout` delays in tests create flakiness risk** - `tests/unit/implementations/tmux/tmux-connector.test.ts:406,427-429,468-472,497,549`
**Confidence**: 88%
- Problem: Multiple tests use `await new Promise((r) => setTimeout(r, 200))` or similar real-timer waits (lines 406, 427, 468-472, 497, 549). The debounce constant `DEBOUNCE_MS = 50` is hard-coded in the source but the tests use 80ms, 100ms, 200ms, and 300ms real delays to "wait for debounce." These rely on timing assumptions that can fail under CI load (slow machines, resource contention). The staleness tests correctly use `vi.useFakeTimers()` but the output/debounce tests do not.
- Fix: Use `vi.useFakeTimers()` and `vi.advanceTimersByTime(DEBOUNCE_MS + 1)` in the output handling tests instead of real sleeps. This eliminates timing sensitivity entirely and makes the tests deterministic. For the test at line 386 that already uses `vi.waitFor()`, that approach works but is still timing-dependent -- fake timers are strictly better.

**No test for `TmuxHooks.cleanup()` when `rmSync` throws** - `tests/unit/implementations/tmux/tmux-hooks.test.ts:258-269`
**Confidence**: 85%
- Problem: `tmux-hooks.ts:158-160` wraps `rmSync` in try/catch and converts to `TMUX_HOOK_FAILED` error. The cleanup test at line 259 only tests the happy path. The error path (disk permission denied, directory locked) is untested.
- Fix:
```typescript
it('returns TMUX_HOOK_FAILED when rmSync throws', () => {
  const { deps, rmSync } = makeDeps();
  rmSync.mockImplementation(() => { throw new Error('EACCES: permission denied'); });
  const hooks = new TmuxHooks(deps);
  const result = hooks.cleanup('task-abc', '/tmp/sessions');
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe(ErrorCode.TMUX_HOOK_FAILED);
});
```

**Missing test for `isAlive` transient error path in staleness timer** - `tests/unit/implementations/tmux/tmux-connector.test.ts`
**Confidence**: 82%
- Problem: `tmux-connector.ts:215-223` handles the case where `isAlive` returns an `err()` result (transient exec error). The code explicitly does NOT advance staleness when this happens -- it logs and returns. This behavior is documented in the KNOWLEDGE.md as a design decision, but no unit test verifies it. A transient error followed by recovery (session goes alive again) could reset the staleness clock incorrectly if this path has a bug.
- Fix: Add a test where `isAlive` returns `err()` for several ticks, then returns `ok(false)`, and verify staleness does NOT fire prematurely (the silence window should only start counting from the last confirmed-alive check, not from the error tick).

**No test for `escapeSendKeys` backslash ordering** - `tests/unit/implementations/tmux/tmux-session-manager.test.ts:186-196`
**Confidence**: 80%
- Problem: `tmux-session-manager.ts:44-56` documents that "Backslash must come first" in the escaping chain. The test at line 186 sends `"say $USER \`whoami\` it's"` and checks that `$USER` is escaped, but does not verify that the backslash-first ordering produces correct output for strings like `\$` (literal backslash-dollar) vs `$` (just a dollar sign). The comment in the source code is a reliability invariant that deserves a dedicated test.
- Fix: Add a test with a string containing `\$` (backslash-dollar) to verify it becomes `\\$` (escaped backslash then escaped dollar), not `\\\$` (double-escaped backslash then literal dollar).

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Integration tests silently pass when `jq` is not available (hook-script-generation)** - `tests/integration/tmux/hook-script-generation.test.ts`
**Confidence**: 85%
- Problem: The integration tests at lines 46-314 run wrapper scripts via `spawnSync('bash', ...)` but do not check for `jq` availability before running. The wrapper script's first executable line is `command -v jq || exit 127`, so if `jq` is missing, the test at line 67 ("wrapper creates .done sentinel when agent exits 0") will fail cryptically. The sentinel-detection tests (`sentinel-detection.test.ts:55`) skip gracefully when tmux is unavailable, but hook-script-generation tests have no `jq` availability check.
- Fix: Add a `beforeAll` check similar to `isTmuxAvailable()` that verifies `jq` is installed, and conditionally skip the tests that execute the wrapper scripts (lines 67-314). The bash syntax check test (line 46) does not need `jq` and can remain unconditional.

**Test uses `if (SKIP) return` pattern instead of `.skipIf`** - `tests/integration/tmux/session-lifecycle.test.ts:61,91,106,125,143`
**Confidence**: 82%
- Problem: The session-lifecycle integration tests use `if (SKIP) return` at the start of each test case rather than using Vitest's `.skipIf(!SKIP)` on the `describe` block. This means the tests appear as "passed" in CI environments without tmux, which is misleading -- they should appear as "skipped." The sentinel-detection tests correctly use `describe.skipIf(!tmuxAvailable)` at line 55.
- Fix: Change `describe('TmuxSessionManager integration -- session lifecycle'` to `describe.skipIf(!isTmuxAvailable())('TmuxSessionManager integration -- session lifecycle'` and remove the `if (SKIP) return` guards from each test.

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Missing test for wrapper script behavior on agent emitting no output** - `tests/integration/tmux/hook-script-generation.test.ts` (Confidence: 70%) -- No test exercises the case where the agent produces zero stdout lines. The wrapper should still write the `.done` sentinel. This exercises the empty-pipe path in the bash `while IFS= read` loop.

- **No test for `buildCommunicationBlock` with `communicationMode: 'unicast'`** - `tests/unit/implementations/tmux/tmux-hooks.test.ts` (Confidence: 65%) -- The `CommunicationMode` type includes `'unicast'` but no test verifies unicast behavior. Currently `buildCommunicationBlock` ignores the mode entirely (treats everything as broadcast). If unicast is expected to send to only the first target, this is an untested behavioral gap.

- **No property-based test for session name regex** - `tests/unit/implementations/tmux/tmux-session-manager.test.ts` (Confidence: 62%) -- The `SESSION_NAME_REGEX` is a security boundary. A property-based test using `fast-check` could generate random strings and verify that accepted names are safe for shell embedding while rejected names include all known injection patterns.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 3 | 1 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Testing Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The test suite demonstrates strong fundamentals: proper dependency injection for testability, behavior-focused assertions, comprehensive happy-path coverage, and correct use of fake timers for time-dependent logic. The DI pattern (injectable `readFileSync`, `readdirSync`, `ExecFn`, `watch`) makes every layer independently testable without real infrastructure.

The main gaps are: (1) the reverse race condition (staleness-first-then-sentinel) is untested despite being called out as a gotcha, (2) the flush-with-gaps forced delivery path is untested, (3) several output-handling tests use real `setTimeout` delays creating flakiness risk, and (4) the structurally-invalid-JSON error path is uncovered. None of these are critical, but the first two represent real concurrency edge cases in production code that warrant test coverage before merge.
