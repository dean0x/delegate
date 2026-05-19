# Testing Review Report

**Branch**: feat/166-167-dashboard-cleanup -> main
**Date**: 2026-05-14

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

### MEDIUM

**Timing-based assertions use raw setTimeout instead of deterministic flush** - `use-keyboard.test.tsx:803,819,834,849,874,899,924,949,971`
**Confidence**: 82%
- Problem: The 10 new pause/resume tests all use `await new Promise<void>((resolve) => setTimeout(resolve, 20))` after `press()` to wait for the async `pauseOrResumeEntity` call to complete. The `press()` helper already flushes React's microtask/macrotask queue with a 10ms timer for synchronous state updates, but the pause/resume handler fires an unawaited promise (`void pauseOrResumeEntity(...)`) which needs additional time. The 20ms delay works today but is a timing-dependent pattern that could become flaky under CI load.
- Impact: These are the same tests exercising the new `p` key feature -- if they become flaky they block confidence in the new feature. The existing cancel/delete tests in the same file also use `void cancelEntity(...)` but do not have this extra 20ms wait, suggesting those tests may be implicitly passing because cancel is faster or because their assertions happen to succeed within the press() flush window.
- Fix: Consider extracting a reusable `flushAsyncEffects()` helper that combines the press flush with an additional microtask drain, or use `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()` to make the wait deterministic. At minimum, document why the extra 20ms is needed (the `void` fire-and-forget on `pauseOrResumeEntity`) so future maintainers do not remove it.

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Missing negative test: `p` on a terminal schedule/loop in main view** - `use-keyboard.test.tsx` (Confidence: 72%) -- The `entity-mutations.test.ts` unit tests cover terminal status no-ops for `pauseOrResumeEntity`, but the keyboard integration tests do not verify that pressing `p` on a completed/cancelled/failed schedule or loop in the main panel view correctly results in no service call. The detail-view tests cover the `task` non-pauseable case but not terminal-status entities in main view. Low risk since the unit layer covers it.

- **`entity-mutations.test.ts` could use `ok()` from result.ts consistently** - `entity-mutations.test.ts:16-17` (Confidence: 65%) -- The test imports `ok` from `result.ts` and uses `.mockResolvedValue(ok(undefined))` for stubs, but the error test at line 102 uses `.mockRejectedValue(new Error('DB error'))`. This is intentional (testing the catch block), but the mixed pattern with `as DashboardMutationContext` type assertion on line 114 (only in the error case) versus the clean `makeMutations()` helper elsewhere adds slight cognitive overhead.

- **`hints.test.ts` detailHints tests use raw string literals instead of domain status enums** - `hints.test.ts:81-111` (Confidence: 64%) -- Tests pass `'active'`, `'running'`, `'paused'` as raw strings to `detailHints()` rather than using `ScheduleStatus.ACTIVE`, `LoopStatus.RUNNING` etc. This is technically correct since the implementation also compares against raw strings, but it means if the enum values change the tests would still pass with stale strings. The unit test file for `entity-mutations.test.ts` correctly uses the domain enums.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Testing Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### What the tests do well

1. **Behavior-focused approach**: All new tests assert on observable outcomes (service method called, view state unchanged) rather than implementation internals. The `pauseOrResumeEntity` unit tests follow clean Arrange-Act-Assert with a focused `makeMutations()` factory.

2. **Comprehensive coverage of the new `p` key feature**: 9 unit tests for `pauseOrResumeEntity` cover all entity kinds (schedule, loop, task, orchestration), all relevant statuses (active/paused, running/paused, terminal), and error resilience. 10 keyboard integration tests cover both main and detail views for schedule and loop pause/resume, plus non-pauseable entity types and the no-mutations guard.

3. **Clean test removal**: 4 deleted test files (~1,127 lines) and removal of workspace-related test cases from 6 modified files are well-aligned with the source code deletion. No orphaned test infrastructure remains -- `createInitialWorkspaceNavState` imports, `workspaceNav` state, and `workspace` view kind references are all cleanly removed.

4. **Hints unit tests (`hints.test.ts`)**: 20 pure-function tests provide thorough branch coverage for `mainHints`, `detailHints`, and `getHints` with explicit positive and negative assertions for the panel-conditional `p pause/resume` hint.

5. **Footer integration tests**: Replaced 5 stale negative-archaeology tests (asserting absence of removed pre-redesign hints) with 10 focused tests for the new pause/resume hint behavior across main and detail views, including all non-pauseable panel types.

6. **Test pyramid maintained**: New unit tests for pure functions (`hints.ts`, `entity-mutations.ts`) + integration tests for the keyboard hook (`use-keyboard.test.tsx`) + the deleted integration test (`orchestration-workspace.test.ts`) was workspace-specific and correctly removed.

### Condition for approval

The MEDIUM timing issue (raw `setTimeout(20)` in pause/resume keyboard tests) is not blocking merge but should be monitored for flakiness in CI. If any of those 10 tests become flaky, extract a deterministic flush helper.
