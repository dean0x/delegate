# Testing Review Report

**Branch**: feat/dashboard-visibility-overhaul -> main
**Date**: 2026-04-30
**Scope**: Incremental review (4 new commits since last review)

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

**T20 test duplicates production control flow instead of exercising it** - `tests/unit/cli/dashboard/use-task-output-stream.test.ts:467-499`
**Confidence**: 85%
- Problem: Test T20 ("getSize error -> full get() still called") manually re-implements the `fetchTask` control flow from `doPoll` (lines 487-494) rather than exercising the actual hook or the actual `fetchTask` closure. The test inlines `if (!(sizeResult.ok && ...))` which mirrors the production logic at `use-task-output-stream.ts:398`. If the production conditional changes shape (e.g., additional guard conditions), the test continues to pass against its own copy while the real code path goes untested. This couples the test to implementation details rather than behavior.
- Fix: Either (a) extract the size-probe-then-fetch logic into a standalone testable function (e.g., `fetchWithSizeProbe(repo, taskId, prev)`) that the hook delegates to, then test that function directly, or (b) test the hook via a React testing library render that verifies observable output (streams map content) when `getSize` returns an error. Option (a) is more consistent with how `buildStreamState`, `codePointLength`, and `codePointSlice` are already extracted and tested.

### MEDIUM

**T17-T19 test buildStreamState, not the size-probe optimization they claim to verify** - `tests/unit/cli/dashboard/use-task-output-stream.test.ts:434-465`
**Confidence**: 82%
- Problem: Tests T17-T19 are labeled "Size probe in doPoll -- getSize guards full get() call" but they exclusively call `buildStreamState` and never invoke `getSize` or the probe path in `doPoll`. The totalBytes guard in `buildStreamState` (line 181: `if (newTotalBytes <= prev.totalBytes && prev.lines.length > 0)`) is a separate mechanism from the `getSize` probe (line 397-407). These tests effectively duplicate existing `buildStreamState` tests (e.g., the "does not duplicate lines when called with same totalBytes" test at line 186). The size-probe optimization -- the `outputRepo.getSize()` call that avoids the full `outputRepo.get()` -- remains untested at the integration level for the success path.
- Fix: Either rename the describe block and test titles to accurately reflect what they test (buildStreamState's totalBytes guard), or add actual integration tests that mock `getSize` to return matching/differing sizes and verify that `repo.get` is/is not called. The existing T20 test is the only one that actually exercises the probe, but it does so by copying production logic (see HIGH issue above).

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Missing negative-index test for codePointSlice** - `tests/unit/cli/dashboard/use-task-output-stream.test.ts:389` (Confidence: 65%) -- `codePointSlice` does not handle negative `start` values. If called with `start = -1`, the `for-of` loop iterates the entire string without finding `cpIdx === -1`, returning `''`. This may be intentional (callers never pass negative), but a test documenting the behavior would prevent future regressions.

- **Liveness sweep tests (T21/T22) could be timing-fragile** - `tests/unit/cli/dashboard/use-dashboard-data.test.ts:498-543` (Confidence: 62%) -- T21 uses `Date.now() - 10_000` and T22 uses `Date.now() - 1_000` relative to the 4s TTL. These margins are generous enough to be safe in practice, but the tests depend on real `Date.now()` rather than injected/frozen time. If the TTL constant changes, both tests need manual recalculation. Consider using `vi.useFakeTimers()` or deriving the timestamps from the `LIVENESS_CACHE_TTL_MS` constant.

- **Mock fixture getSize default returns 0 unconditionally** - `tests/fixtures/mocks.ts:130` (Confidence: 60%) -- The shared `createMockOutputRepository` always returns `ok(0)` for `getSize`. Tests relying on this mock for non-zero size scenarios must override it. This is consistent with other mock defaults (e.g., `get` returns `ok(null)`), but the implicit `0` could mask bugs in tests that forget to override `getSize` when they save data and expect the probe to skip. Low risk given the current test surface.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Testing Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### What works well

1. **Test quality for pure functions is excellent.** `codePointLength` (T5-T8) and `codePointSlice` (T9-T13) have thorough coverage: ASCII, emoji, CJK, empty string, boundary conditions, and surrogate pair safety. Clear AAA structure, descriptive names, and the U+FFFD non-corruption assertions are particularly strong.

2. **Repository tests use real SQLite** (output-repository.test.ts T1-T4). No mocks for the data layer -- consistent with the project's handler test pattern. The four `getSize` tests cover DB-stored, non-existent, file-backed, and post-append scenarios.

3. **Liveness sweep tests** (T21-T22) verify both stale eviction and fresh retention with simple, focused assertions against the externally-observable cache state.

4. **Mock fixture updated consistently.** `createMockOutputRepository` in `tests/fixtures/mocks.ts` was correctly updated to include `getSize`, preventing compilation failures in downstream test files.

### Conditions for merge

The HIGH issue (T20 duplicating production control flow) should be addressed before merge. When a test embeds a copy of production logic, it validates the copy, not the code -- defeating the purpose of the test. The recommended fix is to extract the probe logic into a testable function.

The MEDIUM issue (T17-T19 mislabeling) is less urgent but should be addressed for clarity -- either rename the tests or add real probe-level integration tests.
