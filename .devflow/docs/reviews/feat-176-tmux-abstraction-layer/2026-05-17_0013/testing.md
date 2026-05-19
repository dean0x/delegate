# Testing Review Report

**Branch**: feat-176-tmux-abstraction-layer -> main
**Date**: 2026-05-17

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Real timer delays in unit tests (3 occurrences)** - Confidence: 85%
- `tests/unit/implementations/tmux/tmux-connector.test.ts:407`, `:430`, `:498`
- Problem: Several tests use `await new Promise((r) => setTimeout(r, 100))` and similar real-time delays (100ms, 200ms) to wait for debounce timers instead of using fake timers. This introduces non-deterministic timing and makes tests slower than necessary. The staleness detection tests (lines 504-595) correctly use `vi.useFakeTimers()`, but the output handling tests do not.
- Fix: Use `vi.useFakeTimers()` + `vi.advanceTimersByTime(DEBOUNCE_MS)` in the output handling tests to eliminate real-time delays:
```typescript
// Before
fireMessage('00001-stdout.json.tmp');
await new Promise((r) => setTimeout(r, 100));
expect(onOutput).not.toHaveBeenCalled();

// After
vi.useFakeTimers();
fireMessage('00001-stdout.json.tmp');
vi.advanceTimersByTime(DEBOUNCE_MS + 1);
expect(onOutput).not.toHaveBeenCalled();
vi.useRealTimers();
```

**Weak assertion: sentinel timing test relies on wall-clock `Date.now()`** - Confidence: 82%
- `tests/unit/implementations/tmux/tmux-connector.test.ts:338-360`
- Problem: The test "sentinel fires onExit within 100ms (timing test)" measures real elapsed time with `Date.now()` before and after a synchronous function call. This assertion (`expect(elapsed).toBeLessThan(100)`) is inherently flaky under CPU pressure (CI environments, swap storms). The test proves something trivially true (synchronous call is fast) while risking spurious failures.
- Fix: Remove the timing assertion entirely since the behavior ("onExit is called synchronously when sentinel fires") is already validated by the preceding test at line 298. Alternatively, if latency guarantees matter, increase the threshold to 1000ms or use a different validation strategy.

**Integration test `if (SKIP) return` pattern suppresses failures silently** - Confidence: 80%
- `tests/integration/tmux/sentinel-detection.test.ts:57`, `:77`, `:103`, `:132`, `:152`, `:187`
- `tests/integration/tmux/session-lifecycle.test.ts:62`, `:92`, `:107`, `:126`, `:144`
- Problem: Tests that cannot run due to missing tmux use an early `if (SKIP) return` inside each `it()` block. Vitest reports these as "passed" rather than "skipped", making it impossible to distinguish environments where tmux tests actually ran from environments where they silently did not. This masks coverage gaps in CI.
- Fix: Use vitest's `it.skipIf(SKIP)` or move the skip logic into a `describe.skipIf` block so the test runner reports them as skipped:
```typescript
describe.skipIf(!isTmuxAvailable())('Sentinel detection integration', () => {
  it('.done sentinel is created when a script exits 0', () => {
    // test body without SKIP guard
  });
});
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**No test for MAX_PENDING_MESSAGES overflow path** - Confidence: 85%
- `src/implementations/tmux/tmux-connector.ts:317-335`
- Problem: The `handleMessageFile` method has a safety-cap branch that fires when `pendingMessages.size > MAX_PENDING_MESSAGES` (100). This branch skips ahead in the sequence, logs a warning, and delivers buffered messages. None of the 28 connector unit tests exercise this code path — it has zero test coverage.
- Fix: Add a test that fires 102+ messages with a gap at sequence 1 (e.g., deliver sequences 2 through 102), which triggers the overflow behavior and verifies:
  1. The logger warns about the buffer overflow
  2. Messages are delivered starting from the lowest available sequence
  3. No crash or infinite loop occurs

**Integration test lacks cleanup for `stale-test` session on failure** - Confidence: 80%
- `tests/integration/tmux/sentinel-detection.test.ts:186-215`
- Problem: The test "staleness: session appears dead after external kill" creates a tmux session `beat-stale-test` and cleans up only via `realExec(kill)` within the test body. If the test errors/throws between session creation and the kill call, the session leaks into the host environment. Unlike the `session-lifecycle.test.ts` file which has a global `afterAll` cleanup, this test file has no session-level cleanup.
- Fix: Add an `afterAll` or `afterEach` block that kills `beat-stale-test`:
```typescript
afterAll(() => {
  realExec('tmux kill-session -t beat-stale-test 2>/dev/null || true');
});
```

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Sequence monotonicity test has a silent bail-out** - `tests/integration/tmux/hook-script-generation.test.ts:172-175` (Confidence: 70%) — If `printf` produces fewer than 2 files, the test returns early without any assertion. On platforms where this happens, the test provides no value but reports as passed.

- **TmuxConnector.dispose() test uses two separate watch mocks that add complexity** - `tests/unit/implementations/tmux/tmux-connector.test.ts:728-773` (Confidence: 65%) — The multi-session dispose test builds a complex `combinedWatch` mock with a call counter to route calls. This could be simplified with a factory pattern or by testing dispose with a single session (the correctness of `closeSession` per-session is already covered elsewhere).

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 3 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Testing Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The test suite is strong overall — 77 unit tests and 16 integration tests with full dependency injection for mockability. All tests pass. The testing patterns are well-structured with clear Arrange-Act-Assert flow, appropriate use of fakes over mocks, and good coverage of error paths. The main conditions are: (1) replace real-time delays with fake timers in the output handling tests to prevent future CI flakiness, (2) use `describe.skipIf` instead of `if (SKIP) return` so CI visibility of skipped tests is preserved, and (3) add a test for the MAX_PENDING_MESSAGES overflow path which is currently uncovered production code.
