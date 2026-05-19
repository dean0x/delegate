# Tests Review Report

**Branch**: chore/v060-tech-debt -> main
**Date**: 2026-03-20
**PR**: #107

## Issues in Your Changes (BLOCKING)

### CRITICAL

No critical issues found.

### HIGH

**BootstrapMode test re-implements source logic instead of testing behavior** - `tests/integration/service-initialization.test.ts:387-398`
**Confidence**: 85%
- Problem: The `BootstrapMode flag derivation` test duplicates the mode-to-flag mapping logic from `src/bootstrap.ts:119-122` verbatim in the test itself, then asserts it matches hardcoded expected values. This tests the test's own logic, not the actual `bootstrap()` function. If someone changes the mapping in `bootstrap.ts`, this test will continue to pass with stale expectations because it never calls `bootstrap()`.
- Fix: Test the actual behavior by calling `bootstrap({ mode: 'cli' })` and verifying that recovery was skipped (e.g., container has no `recoveryManager` initialized) and the schedule executor was not started. Alternatively, export the derivation as a pure function and test that directly:

```typescript
// Option A: Export derivation function from bootstrap.ts
export function deriveFlags(mode: BootstrapMode) {
  return {
    skipResourceMonitoring: mode === 'run',
    skipScheduleExecutor: mode === 'cli' || mode === 'run',
    skipRecovery: mode === 'cli',
  };
}

// Then test:
it.each([...])('mode "%s" produces correct flags', (mode, expected) => {
  expect(deriveFlags(mode)).toEqual(expected);
});
```

```typescript
// Option B: Integration test that calls bootstrap()
it('cli mode skips executor and recovery', async () => {
  const result = await bootstrap({
    mode: 'cli',
    processSpawner: new NoOpProcessSpawner(),
    resourceMonitor: new TestResourceMonitor(),
  });
  expect(result.ok).toBe(true);
  // Assert executor is not started, recovery did not run, etc.
});
```

### MEDIUM

No medium issues found.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Rollback test does not verify ScheduleMissed event is suppressed** - `tests/unit/services/schedule-executor.test.ts:367-394`
**Confidence**: 82%
- Problem: The new `should roll back schedule cancellation if execution recording fails` test correctly verifies that the schedule stays ACTIVE and no execution history is recorded after a transaction failure. However, it does not subscribe to `ScheduleMissed` and verify that no event was emitted. The source code (schedule-executor.ts:405-409) breaks before emitting `ScheduleMissed` when the transaction fails, so the behavior is correct -- but the test does not assert this important invariant. If someone later reorders the code to emit the event before checking `txResult.ok`, this test would still pass while the system would emit misleading events.
- Fix: Add a `ScheduleMissed` subscriber and assert zero events:

```typescript
const missedEvents: unknown[] = [];
eventBus.subscribe('ScheduleMissed', async (event: unknown) => {
  missedEvents.push(event);
});

await executor.triggerTick();
await flushEventLoop();

// ...existing assertions...

// No ScheduleMissed event — transaction failed, so no side effects
expect(missedEvents).toHaveLength(0);
```

## Pre-existing Issues (Not Blocking)

No pre-existing issues found.

## Suggestions (Lower Confidence)

- **Integration tests for ScheduleExecutor.create() signature change could validate type safety** - `tests/integration/task-scheduling.test.ts:245-248` (Confidence: 65%) -- The `database` parameter was added as the 3rd argument to `ScheduleExecutor.create()` in 4 call sites. All pass the correct `database` variable. TypeScript compilation already enforces this, so no runtime test is strictly needed, but a negative test (e.g., passing a non-TransactionRunner) could validate the interface boundary.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Tests Score**: 8/10
**Recommendation**: CHANGES_REQUESTED

### What went well

1. **Transaction rollback test** (schedule-executor.test.ts:367-394) -- Excellent behavioral test for issue #83. Sabotages `recordExecutionSync` to simulate a mid-transaction failure and verifies both the schedule status and execution history are rolled back. Clean Arrange-Act-Assert structure.

2. **Existing FAIL policy test updated implicitly** -- The existing "should apply FAIL policy" test (line 332) now validates the transaction-wrapped happy path without any changes needed, since the source switched from two separate async calls to a single synchronous transaction.

3. **Integration test updates are mechanical and correct** -- All 4 `ScheduleExecutor.create()` call sites in task-scheduling.test.ts correctly pass the `database` parameter. The `skipResourceMonitoring: true` boolean flags are cleanly replaced with `resourceMonitor: new TestResourceMonitor()` or removed where redundant.

4. **Import path migration is thorough** -- All test files (`mocks.ts`, `cli.test.ts`, `task-manager.test.ts`) correctly update `OutputRepository` imports from `../../src/implementations/output-repository` to `../../src/core/interfaces`, matching the interface relocation in issue #101.

5. **Test setup remains lean** -- `beforeEach` blocks stay under 10 lines. No new mocking complexity introduced.

### Blocking issue rationale

The BootstrapMode flag derivation test (HIGH) tests a copy of the logic rather than the actual implementation. While it documents the intended mapping, it provides a false sense of coverage -- the real `bootstrap()` function is not exercised with mode values. This should be addressed before merge to avoid a test that silently drifts from reality.
