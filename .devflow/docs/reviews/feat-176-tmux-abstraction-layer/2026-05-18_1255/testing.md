# Testing Review Report

**Branch**: feat/176-tmux-abstraction-layer -> main
**Date**: 2026-05-18
**Test Results**: 168 passed, 6 skipped (tmux unavailable), 0 failed

## Issues in Your Changes (BLOCKING)

### HIGH

**Missing test: TmuxConnector.isAlive() delegation** - `tests/unit/implementations/tmux/tmux-connector.test.ts:1683`
**Confidence**: 90%
- Problem: The `describe('TmuxConnector.sendKeys() / isAlive()')` block at line 1683 only contains a test for `sendKeys`. The `isAlive()` method on TmuxConnector (source line 262) is never directly tested. While the method is a simple delegation to `sessionManager.isAlive()`, the sendKeys equivalent is tested, so isAlive should be too for parity and to guard against future signature changes.
- Fix: Add a matching test:
```typescript
it('isAlive delegates to sessionManager.isAlive', () => {
  const { watch } = makeWatchMock();
  const sessionManager = makeValidSessionManager();

  const connector = new TmuxConnector({
    validator: makeValidValidator(),
    sessionManager,
    hooks: makeValidHooks(),
    logger: makeLogger(),
    watch,
  });

  const spawnResult = connector.spawn(BASE_CONFIG, { onOutput: vi.fn(), onExit: vi.fn() });
  if (!spawnResult.ok) return;

  connector.isAlive(spawnResult.value);
  expect(sessionManager.isAlive).toHaveBeenCalledWith(spawnResult.value.sessionName);
});
```

**Missing test: dispose() error resilience across multiple sessions** - `src/implementations/tmux/tmux-connector.ts:296`
**Confidence**: 88%
- Problem: The `dispose()` method has a per-session try/catch (lines 280-301) with a design decision comment: "one failing teardown does not prevent the remaining sessions from being cleaned up." There is also a logger.error call for "Dispose: unhandled error during session teardown." Neither the error resilience behavior nor the logger.error call is tested. The existing dispose tests only cover `destroySession` returning `err()` (which is caught by the `if (!result.ok)` check), not the outer try/catch that catches thrown exceptions.
- Fix: Add a test with two sessions where the first session's teardown throws, then verify the second session is still cleaned up and the error is logged:
```typescript
it('dispose continues cleaning up remaining sessions when one teardown throws', () => {
  // Build a connector with 2 sessions where flushPendingFiles throws on the first
  // Verify both sessions are removed and logger.error is called
});
```

**Missing test: TmuxValidator failure-not-cached behavior** - `src/implementations/tmux/tmux-validator.ts:54-62`
**Confidence**: 85%
- Problem: The validator has an explicit design decision: "Only success results are cached for the process lifetime -- failures are returned immediately so a transient startup error does not permanently poison the validator." The caching test (line 123 of tmux-validator.test.ts) only verifies that successful validation is cached. There is no test verifying that a failed validation is NOT cached and allows a subsequent call to succeed. This is a critical behavior for robustness.
- Fix:
```typescript
it('does not cache failures — a retry after a transient error can succeed', () => {
  let callCount = 0;
  const exec = vi.fn().mockImplementation((cmd: string) => {
    callCount++;
    if (callCount <= 1) {
      // First call (tmux -V) fails
      return { stdout: '', stderr: 'tmux: command not found', status: 127 };
    }
    // Subsequent calls succeed
    if (cmd.includes('jq')) return { stdout: '/usr/bin/jq', stderr: '', status: 0 };
    if (cmd === 'command -v tmux') return { stdout: '/usr/bin/tmux', stderr: '', status: 0 };
    return { stdout: 'tmux 3.4', stderr: '', status: 0 };
  });

  const validator = new DefaultTmuxValidator({ exec });
  const first = validator.validate();
  expect(first.ok).toBe(false);

  const second = validator.validate();
  expect(second.ok).toBe(true);
});
```

**Missing test: cleanup() input validation guards** - `src/implementations/tmux/tmux-hooks.ts:246-256`
**Confidence**: 85%
- Problem: `cleanup()` validates `taskId` against `TASK_ID_REGEX` (line 246) and `sessionsDir` against `SAFE_PATH_REGEX` (line 249) before calling `rmSync`. These security-critical guards are untested. The `generateWrapper()` tests cover the same validation patterns, but `cleanup()` is a public interface and deserves its own validation tests.
- Fix: Add two tests to the `TmuxHooks.cleanup()` describe block:
```typescript
it('returns TMUX_HOOK_FAILED for invalid taskId in cleanup', () => {
  const result = hooks.cleanup('$(evil)', '/tmp/sessions');
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe(ErrorCode.TMUX_HOOK_FAILED);
});

it('returns TMUX_HOOK_FAILED for unsafe sessionsDir in cleanup', () => {
  const result = hooks.cleanup('task-abc', "/tmp/ses'sions");
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe(ErrorCode.TMUX_HOOK_FAILED);
});
```

### MEDIUM

**Missing test: wrapper script creates .exit sentinel on non-zero agent exit** - `tests/integration/tmux/hook-script-generation.test.ts`
**Confidence**: 85%
- Problem: The integration test suite has `wrapper creates .done sentinel when agent exits 0` (line 67) but no test verifying `.exit` sentinel creation when the agent exits non-zero. This is the failure path, which is arguably more important to integration-test than the success path. The unit test (tmux-hooks.test.ts:160) only verifies the script *contains* `.exit` as a string, not that the sentinel file is actually written.
- Fix:
```typescript
it('wrapper creates .exit sentinel when agent exits non-zero', () => {
  const hooks = makeRealHooks();
  const sessionsDir = path.join(tmpDir, 'exit-agent');

  const config: WrapperConfig = {
    taskId: 'task-exit',
    agent: 'claude',
    sessionsDir,
    agentCommand: '/bin/false',
    agentArgs: [],
  };

  const result = hooks.generateWrapper(config);
  expect(result.ok).toBe(true);
  if (!result.ok) return;

  spawnSync('bash', [result.value.wrapperPath], { encoding: 'utf8', timeout: 10000 });

  expect(fs.existsSync(path.join(result.value.sessionDir, '.exit'))).toBe(true);
  expect(fs.existsSync(path.join(result.value.sessionDir, '.done'))).toBe(false);
});
```

**Missing test: listSessions non-idempotent error path** - `src/implementations/tmux/tmux-session-manager.ts:239-243`
**Confidence**: 82%
- Problem: `listSessions()` has a branch where `exec` fails with a non-"session not found" error (e.g., tmux server crashed with an unrecognized message). This returns `err(tmuxSessionFailed('list', ...))`. The existing tests cover `status !== 0` with "no server running" (returns `ok([])`) but not the generic error path.
- Fix:
```typescript
it('listSessions returns TMUX_SESSION_FAILED for unrecognized exec errors', () => {
  exec.mockReturnValue({
    stdout: '',
    stderr: 'server exited unexpectedly',
    status: 1,
  });
  const result = manager.listSessions();
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe(ErrorCode.TMUX_SESSION_FAILED);
});
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Real `sleep()` in timing-sensitive assertions risks CI flakiness** - `tests/unit/implementations/tmux/tmux-connector.test.ts:875-880`
**Confidence**: 82%
- Problem: The "delivers messages in sequence order even if files arrive out of order" test (line 840) uses real `sleep(80)` calls between message fires and asserts ordering. On slow CI runners, 80ms may not be enough for debounce (50ms) + async readFile resolution. Several other tests also use `sleep(100)` or `sleep(200)` patterns. While the debounce double-fire test (line 884) correctly uses fake timers, these ordering tests do not.
- Fix: Refactor timing-sensitive output ordering tests to use `vi.useFakeTimers()` + `vi.advanceTimersByTime()` + `await Promise.resolve()` flushes, consistent with the debounce double-fire test pattern. Alternatively, use `vi.waitFor()` with a reasonable timeout (already used in some tests at line 760).

**Non-JSON files not filtered in message watcher** - `tests/unit/implementations/tmux/tmux-connector.test.ts`
**Confidence**: 80%
- Problem: The test at line 765 ("ignores .tmp files") verifies `.tmp` filtering, but there is no test for non-JSON files (e.g., `.log`, `.txt`, or files without extensions). The source code at connector line 407 has `if (!filename.endsWith('.json')) return;` which would filter these, but this guard is untested.
- Fix: Add a test:
```typescript
it('ignores non-JSON files in message watcher (e.g. .log, .txt)', async () => {
  const { watch, fireMessage } = makeWatchMock();
  const onOutput = vi.fn();
  const readFile = vi.fn();

  const connector = new TmuxConnector({
    validator: makeValidValidator(),
    sessionManager: makeValidSessionManager(),
    hooks: makeValidHooks(),
    logger: makeLogger(),
    watch,
    readFile,
  });

  connector.spawn(BASE_CONFIG, { onOutput, onExit: vi.fn() });
  fireMessage('debug.log');
  fireMessage('notes.txt');
  fireMessage('.seq');

  await sleep(100);
  expect(readFile).not.toHaveBeenCalled();
  expect(onOutput).not.toHaveBeenCalled();
  connector.dispose();
});
```

## Pre-existing Issues (Not Blocking)

_None identified._

## Suggestions (Lower Confidence)

- **getSessionEnvironment: no-equals-sign edge case** - `src/implementations/tmux/tmux-session-manager.ts:305` (Confidence: 72%) -- The path where `tmux show-environment` returns output without an `=` character (returns `ok(undefined)`) has no test. While unlikely in practice, this is a defensive code path worth testing.

- **listSessions: NaN in numeric fields** - `src/implementations/tmux/tmux-session-manager.ts:266-267` (Confidence: 68%) -- The `parseInt` calls for `created`, `width`, `height` with `isNaN` guards at line 267 are only tested for malformed lines with fewer than 5 parts. Lines with 5 parts but non-numeric values (e.g. `beat-task:abc:0:xyz:50`) would exercise the NaN branch but are not tested.

- **Integration test: sentinel_guard trap coverage** - `src/implementations/tmux/tmux-hooks.ts:130-136` (Confidence: 65%) -- The `_sentinel_guard` EXIT trap in the wrapper script is a safety net for when jq crashes or mv fails mid-run. No integration test exercises this path (e.g., by killing jq mid-pipeline or corrupting the SEQ_FILE). The defense-in-depth jq-missing test (line 247) exits before the pipeline starts, so the trap fires but for a different reason.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 4 | 1 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Testing Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

## Assessment

**Strengths**:
- Excellent test structure: tests validate behavior not implementation, with clean AAA patterns throughout
- Strong use of dependency injection: all external deps (fs, exec, timers) are injected, making tests hermetic
- Good edge case coverage: null filename guards, double-fire debounce, re-entrancy safety, out-of-order delivery, MAX_PENDING_MESSAGES overflow
- Proper use of fake timers for staleness detection tests -- no real delays
- Security validation tests are thorough for generateWrapper() (taskId, sessionsDir, agentCommand injection)
- Integration tests are properly gated with `skipIf(!tmuxAvailable)` and use real filesystem/bash
- Flush-before-exit behavior is well-tested with multiple scenarios (sentinel during debounce, dispose flush, destroy flush, sequence gaps)

**Gaps**:
- The four HIGH findings represent untested behavioral contracts that are documented in design decisions but lack test coverage (validator failure-not-cached, cleanup validation guards, isAlive delegation, dispose error resilience)
- The missing non-zero exit integration test is notable because the success path is tested but the failure path (arguably more important) is not
- Some tests use real `sleep()` which creates CI timing fragility; the pattern of using fake timers is applied inconsistently
