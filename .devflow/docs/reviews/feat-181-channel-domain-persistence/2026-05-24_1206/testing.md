# Testing Review Report

**Branch**: feat/181-channel-domain-persistence -> main
**Date**: 2026-05-24

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

**Missing test for `updateStatus`/`updateRound`/`updateMemberStatus` on nonexistent channel — silent no-op not validated** - `tests/unit/implementations/channel-repository.test.ts`
**Confidence**: 85%
- Problem: The repository methods `updateStatus`, `updateRound`, and `updateMemberStatus` all succeed (return `ok: true`) even when the target channel/member does not exist — the SQLite UPDATE simply matches zero rows. No test validates this behavior. If a caller expects an error on missing channel (e.g., to surface "channel not found" to the user), the current contract silently succeeds, and there is no test documenting whether this is intentional.
- Fix: Add explicit tests documenting the zero-row-update behavior. If the intended contract is to return an error on missing channel, add a row-count check in the repository:
```typescript
it('returns ok for nonexistent channel updateStatus (no-op)', async () => {
  const result = await repo.updateStatus(ChannelId('ch-nonexistent'), 'paused');
  expect(result.ok).toBe(true);
  // Confirm no channel was created
  const count = await repo.count();
  expect(count.ok && count.value).toBe(0);
});
```

### MEDIUM

**`saveMemberStmt` and `addMemberStmt` are identical prepared statements** - `src/implementations/channel-repository.ts:109-135`
**Confidence**: 90%
- Problem: Both `saveMemberStmt` (line 109) and `addMemberStmt` (line 132) prepare the exact same SQL. This is not a test issue per se, but it means `save()` and `addMember()` use different statement handles for the same operation with no behavioral distinction in tests. The test for `addMember` (T8) validates behavior correctly, but the duplication makes it unclear whether the two paths have different intended semantics.
- Fix: Reuse a single prepared statement for member insertion. Tests already cover both code paths, so no test change needed — this is a production code simplification.

**Performance test uses wall-clock timing (`Date.now()`) — prone to flakiness under CI load** - `tests/unit/implementations/channel-repository.test.ts:674-682`
**Confidence**: 82%
- Problem: The performance test at line 661 asserts `elapsed < 500` using `Date.now()` delta. Under CI environments with resource contention, wall-clock timing is nondeterministic. This is a known flaky test pattern (references/violations: timing races).
- Fix: Either increase the threshold significantly (e.g., 2000ms) for CI safety, or convert to a "does not throw" + "returns correct count" test and remove the timing assertion. The N+1 baseline comment already documents this is acceptable for Phase 6.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`createChannel` and `updateChannel` domain factories throw exceptions rather than returning Result** - `src/core/domain.ts:1093-1140`
**Confidence**: 65% (moved to Suggestions — factory throw is consistent with project convention)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Missing error-path test for Zod validation failure** - `tests/unit/implementations/channel-repository.test.ts` (Confidence: 72%) — No test verifies what happens when `ChannelRowSchema.parse()` or `ChannelMemberRowSchema.parse()` encounters corrupt database rows (e.g., an invalid status value inserted directly via SQL). A test inserting a malformed row and asserting the `tryCatchAsync` wrapper catches the Zod error would increase confidence in boundary validation.

- **No tests for channel events (ChannelCreatedEvent, etc.)** - `src/core/events/events.ts:313-349` (Confidence: 68%) — Six new event interfaces are defined but no handler subscribes to them yet and no test validates their type structure. This is acceptable for Phase 6 (persistence-only), but worth noting for the next phase when handlers are added.

- **`createChannel` factory throws but tests use `expect(() => ...).toThrow()` without asserting error message** - `tests/unit/implementations/channel-repository.test.ts:553-565` (Confidence: 62%) — The invalid name tests (T19) assert that `createChannel` throws but do not verify the error message content or error type. Adding `.toThrow(/must match/)` would make the assertion more specific and guard against regression if the error message changes.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Testing Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The test suite is well-structured and thorough for a repository implementation. 40 tests covering CRUD, pagination, cascade delete, constraints, domain factory validation, and a performance baseline is strong coverage. Tests follow Arrange-Act-Assert, use in-memory databases for isolation, and properly clean up in `afterEach`. The factory function tests (T19-T22) are a good addition testing domain logic alongside persistence.

Conditions for approval:
1. Add a test (or explicit comment) documenting the silent no-op behavior of `updateStatus`/`updateRound`/`updateMemberStatus` on nonexistent channels (HIGH).
2. Consider deduplicating `saveMemberStmt`/`addMemberStmt` or documenting why two identical statements exist (MEDIUM).
3. Consider hardening the performance test timing threshold for CI reliability (MEDIUM).

Note: `avoids PF-001` — all findings are surfaced explicitly with actionable fixes rather than deferred.
