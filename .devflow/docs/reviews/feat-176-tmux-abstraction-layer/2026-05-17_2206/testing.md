# Testing Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-17

## Issues in Your Changes (BLOCKING)

### HIGH

**handleSentinel: unreadable sentinel file produces wrong exit code for .exit** - `src/implementations/tmux/tmux-connector.ts:538`
**Confidence**: 90%
- Problem: When readFileSyncFn throws (line 533 catch), `code` stays `null`. For `.exit` sentinel, `code ?? 1` returns 1 -- which happens to be correct for the default case. But when the sentinel contains non-numeric content (e.g. "error"), `parseInt` returns `NaN`, `isNaN(code)` resets to `null`, and `code ?? 1` again defaults to 1. This path has no test coverage at all. Additionally, for `.done` with an unreadable file, `code ?? 0` returns 0 which silently succeeds -- this is correct but also untested.
- The test at line 378 (`tmux-connector.test.ts`) tests `.done` with `readFileSync('0')` and `.exit` with `readFileSync('1')`, but never tests: (a) readFileSync throwing, (b) sentinel containing non-numeric text, (c) `.exit` sentinel with code 0 (which would report exit code 0 for a failure sentinel).
- Fix: Add tests for these edge cases:
```typescript
it('.exit sentinel with unreadable file defaults to exit code 1', () => {
  const readFileSync = vi.fn().mockImplementation(() => { throw new Error('ENOENT'); });
  // ... spawn, fireSentinel('.exit')
  expect(onExit).toHaveBeenCalledWith(1, undefined);
});

it('.exit sentinel with non-numeric content defaults to exit code 1', () => {
  const readFileSync = vi.fn().mockReturnValue('error text');
  // ... spawn, fireSentinel('.exit')
  expect(onExit).toHaveBeenCalledWith(1, undefined);
});

it('.done sentinel with unreadable file defaults to exit code 0', () => {
  const readFileSync = vi.fn().mockImplementation(() => { throw new Error('ENOENT'); });
  // ... spawn, fireSentinel('.done')
  expect(onExit).toHaveBeenCalledWith(0, undefined);
});
```

**handleMessageFile: session-exited-during-async-read path untested** - `src/implementations/tmux/tmux-connector.ts:549-550`
**Confidence**: 85%
- Problem: After the async `readFileFn` call at line 549, there is a re-check `if (session.exited) return;` at line 550. This is a critical race condition guard -- the session may exit during the async gap. However, no test covers this path. The only `session.exited` check tested is the one at line 543 (pre-read guard). The post-async-gap guard could be removed without any test failing, which means a real race condition bug could be introduced silently.
- Fix: Add a test that triggers exit during the async read:
```typescript
it('drops message if session exits during async read', async () => {
  const { watch, fireMessage, fireSentinel } = makeWatchMock();
  const readFileSync = vi.fn().mockReturnValue('0');
  let resolveRead: (value: string) => void;
  const readFile = vi.fn().mockImplementation(() => new Promise<string>((resolve) => {
    resolveRead = resolve;
  }));
  const onOutput = vi.fn();
  const connector = new TmuxConnector({ /* deps */ });
  await connector.spawn(BASE_CONFIG, { onOutput, onExit: vi.fn() });
  fireMessage('00001-stdout.json');
  await sleep(60); // past debounce
  // readFile is pending; trigger exit
  fireSentinel('.done');
  // Now resolve the read
  resolveRead!(JSON.stringify(buildOutputMsg(1)));
  await sleep(50);
  // The message should NOT have been delivered since session exited
  expect(onOutput).not.toHaveBeenCalled();
});
```

**listSessions parse error: malformed lines with fewer than 5 colon-separated parts are silently skipped** - `src/implementations/tmux/tmux-session-manager.ts:214`
**Confidence**: 82%
- Problem: `listSessions()` skips lines with `parts.length < 5`. This is correct defensive behavior, but there is no test that verifies malformed lines are actually skipped rather than causing an error. A future refactor could accidentally change the `< 5` guard or the destructuring at line 216 and introduce a crash on malformed input, with no test catching it.
- Fix: Add a test with malformed tmux output:
```typescript
it('listSessions skips malformed lines with fewer than 5 parts', () => {
  exec.mockReturnValue({
    stdout: 'beat-task-abc:1700000000:0:220:50\ngarbage-line\nbeat-task-def:1700000001:1:200:40\n',
    stderr: '', status: 0,
  });
  const result = manager.listSessions();
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value).toHaveLength(2);
});
```

### MEDIUM

**Connector: no test for handleMessageFile catch-path (readFile rejection)** - `src/implementations/tmux/tmux-connector.ts:344-350`
**Confidence**: 85%
- Problem: When `handleMessageFile` itself throws (not the readFile inside it, but the outer catch at line 344-350 in the `startMessagesWatcher` callback), a `.catch()` logs a warning. The test for malformed JSON at line 567 of the test file covers the inner `readFileFn` parse failure. But the outer `.catch()` at line 344 catches exceptions thrown by `handleMessageFile` itself (e.g., if `session.pendingMessages.set` throws due to an invalid key). No test verifies this outer error handler fires a warning log.
- Fix: Add a test where `readFile` rejects with an error (not returns bad content, but actually throws/rejects):
```typescript
it('logs warning when readFile rejects (file disappeared)', async () => {
  const readFile = vi.fn().mockRejectedValue(new Error('ENOENT'));
  // ... spawn, fireMessage
  await sleep(200);
  expect(logger.warn).toHaveBeenCalledWith(
    expect.stringContaining('Failed to parse output message file'), expect.any(Object)
  );
});
```

**TmuxHooks.cleanup: error return path untested** - `src/implementations/tmux/tmux-hooks.ts:183-187`
**Confidence**: 82%
- Problem: The `cleanup` method catches exceptions from `rmSync` and returns an `err(tmuxHookFailed(...))`. No test covers the case where `rmSync` throws. Only the happy path (`rmSync` succeeds) is tested. A regression in the error wrapping could go undetected.
- Fix:
```typescript
it('returns TMUX_HOOK_FAILED when rmSync throws', () => {
  rmSync.mockImplementation(() => { throw new Error('EPERM'); });
  const result = hooks.cleanup('task-abc', '/tmp/sessions');
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe(ErrorCode.TMUX_HOOK_FAILED);
});
```

**Connector: multiple concurrent sessions with different staleness configs -- minimum interval selection untested** - `src/implementations/tmux/tmux-connector.ts:384-390`
**Confidence**: 80%
- Problem: The `restartSharedStalenessTimer` method computes the minimum `checkIntervalMs` across all active sessions. There is no test that spawns two sessions with different `checkIntervalMs` values and verifies the timer uses the minimum. The single-session staleness tests exist, but the multi-session minimum-selection logic is not exercised.
- Fix: Spawn two sessions: one with `checkIntervalMs: 5000` and one with `checkIntervalMs: 2000`. Advance fake timers by 2000ms and verify only the session with `maxSilenceMs: 0` triggers STALE, confirming the timer fires at the 2000ms interval, not 5000ms.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**destroySession: error path when exec fails with non-"not found" message is weakly tested** - `src/implementations/tmux/tmux-session-manager.ts:141-152`
**Confidence**: 80%
- Problem: The `destroySession` method has a branch where `result.status !== 0` and the output does NOT match `isSessionNotFound()` patterns. This returns an error result. No unit test covers this specific error path -- the only test for destroySession failure covers the idempotent "session not found" case (line 156-164 of test file). A real tmux error (e.g., "server exited unexpectedly") would hit the untested branch.
- Fix:
```typescript
it('returns TMUX_SESSION_FAILED when destroy fails with non-"not found" error', () => {
  exec.mockReturnValue({ stdout: '', stderr: 'server exited unexpectedly', status: 1 });
  const result = manager.destroySession('beat-task-123');
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe(ErrorCode.TMUX_SESSION_FAILED);
});
```

## Pre-existing Issues (Not Blocking)

No pre-existing issues found.

## Suggestions (Lower Confidence)

- **Real-sleep usage in unit tests** - `tests/unit/implementations/tmux/tmux-connector.test.ts:512,533,588,631,708` (Confidence: 70%) -- Multiple unit tests use `await sleep(80-300)` with real delays for debounce timing. While these work, they make the test suite slower than necessary and are fragile under CI load. Consider using `vi.useFakeTimers()` with `vi.advanceTimersByTime()` for debounce tests, as already done for staleness tests.

- **env var injection failure is silently ignored** - `src/implementations/tmux/tmux-session-manager.ts:125` (Confidence: 65%) -- The exec call for env var injection at line 125 has its result discarded ("best-effort"). No test verifies behavior when this call fails. While the comment documents the intent, the silent-failure behavior should be explicitly tested to prevent a future developer from adding error propagation that changes semantics.

- **getSessionEnvironment with value containing = sign** - `src/implementations/tmux/tmux-session-manager.ts:256-259` (Confidence: 65%) -- The `getSessionEnvironment` method uses `line.indexOf('=')` and `line.slice(eqIdx + 1)` to parse values. If a value itself contains `=` (e.g., `KEY=val=ue`), only the first `=` is used as the split point, which is correct. But no test verifies this behavior with a value containing `=`, meaning a regression to `split('=')` would go undetected.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 3 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Testing Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The test suite is solid for happy paths and covers the most important behavioral contracts (sentinel detection, message ordering, flush-on-exit, staleness, debounce, validation). The 4th-review-pass focus reveals gaps in error/edge-case paths that could hide real bugs: the sentinel file read failure path, the post-async-gap session-exited guard, and the cleanup error wrapping. These are exactly the paths where behavioral bugs lurk undetected until production.
