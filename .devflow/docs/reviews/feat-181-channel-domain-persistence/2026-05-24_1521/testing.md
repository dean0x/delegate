# Testing Review Report

**Branch**: feat/181-channel-domain-persistence -> main
**Date**: 2026-05-24

## Issues in Your Changes (BLOCKING)

### HIGH

**Missing test coverage for `updateRound` precondition validation** - `src/implementations/channel-repository.ts:216-218`
**Confidence**: 95%
- Problem: The `updateRound` method gained a precondition check (`Number.isInteger(round) || round < 0`) that throws on negative or fractional round values, but no test verifies this error path. The test suite only tests the happy path (round=5) and the no-op case (nonexistent channel). The precondition was explicitly added in this PR but the corresponding test was not.
- Fix: Add test cases for the precondition:
```typescript
describe('updateRound', () => {
  it('rejects negative round values', async () => {
    const channel = buildChannel();
    await repo.save(channel);

    const result = await repo.updateRound(channel.id, -1);
    expect(result.ok).toBe(false);
  });

  it('rejects fractional round values', async () => {
    const channel = buildChannel();
    await repo.save(channel);

    const result = await repo.updateRound(channel.id, 2.5);
    expect(result.ok).toBe(false);
  });
});
```

**Missing test for CHANNEL_NAME_REGEX 64-char max boundary** - `tests/unit/implementations/channel-repository.test.ts:638-655`
**Confidence**: 90%
- Problem: The `CHANNEL_NAME_REGEX` was changed from `/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/` to `/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/` to enforce a 64-char maximum (applies ADR-001 -- tmux session name compatibility). However, the CHANNEL_NAME_REGEX test does not include any boundary-length test cases. The regex boundary is a functional constraint documented in the JSDoc.
- Fix: Add boundary-length test cases:
```typescript
describe('CHANNEL_NAME_REGEX', () => {
  it('accepts 64-char name (max boundary)', () => {
    expect(CHANNEL_NAME_REGEX.test('a'.repeat(64))).toBe(true);
  });

  it('rejects 65-char name (exceeds max)', () => {
    expect(CHANNEL_NAME_REGEX.test('a'.repeat(65))).toBe(false);
  });
});
```

### MEDIUM

**Inconsistent enum usage in assertions -- some use string literals, some use enum** - `tests/unit/implementations/channel-repository.test.ts:82,95,301,353`
**Confidence**: 85%
- Problem: The PR migrated status types from string unions to enums (`ChannelStatus`, `ChannelMemberStatus`), and updated many assertions to use enum values. However, 4 assertions still use string literals (`'active'`) instead of enum constants. This is inconsistent within the same file and means those assertions would not catch a future enum value rename. Locations:
  - Line 82: `expect(found.status).toBe('active')` -- should be `ChannelStatus.ACTIVE`
  - Line 95: `expect(m1.status).toBe('active')` -- should be `ChannelMemberStatus.ACTIVE`
  - Line 301: `expect(added!.status).toBe('active')` -- should be `ChannelMemberStatus.ACTIVE`
  - Line 353: `expect(member.status).toBe('active')` -- should be `ChannelMemberStatus.ACTIVE`
- Fix: Replace all 4 occurrences with their respective enum constants.

**Removed domain factory validation tests (T19/T20) without replacement** - `tests/unit/implementations/channel-repository.test.ts` (deleted lines 549-581)
**Confidence**: 82%
- Problem: The original commit included tests for `createChannel` name validation and member name validation (T19 and T20), which were removed in the refactor. The `createChannel` function no longer validates names internally (validation moved to service/MCP boundary per the JSDoc). The tests were correctly removed since the factory no longer throws. However, there are no tests anywhere in this PR verifying that the boundary validation (service/MCP layer) rejects invalid names. This means the validation is documented as a precondition but is currently untested end-to-end.
- Fix: This is acceptable if boundary validation tests will be added in a subsequent PR when the service/MCP layer is implemented. The PR description states this is Phase 6 with repository persistence. If the service layer is out of scope for this PR, document this as a known gap. If it is in scope, add validation tests at the boundary.

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **Missing test for `ChannelStatus.COMPLETED` transition** - `tests/unit/implementations/channel-repository.test.ts` (Confidence: 70%) -- The `findByStatus` test exercises ACTIVE, PAUSED, and DESTROYED but never COMPLETED, which is a valid status in the enum. A test confirming COMPLETED channels are filterable would improve confidence in status lifecycle coverage.

- **Performance test uses `Date.now()` for timing** - `tests/unit/implementations/channel-repository.test.ts:675-683` (Confidence: 65%) -- The N+1 baseline test relies on `Date.now()` wall-clock measurement with a 500ms threshold. This is documented as a baseline (acceptable for Phase 6) and is not a correctness concern, but wall-clock timings can be flaky on loaded CI machines. Consider `performance.now()` for microsecond precision if this test ever flakes.

- **No test for `delete` on nonexistent channel** - `tests/unit/implementations/channel-repository.test.ts` (Confidence: 62%) -- The delete test covers cascade behavior for existing channels, but there is no test confirming that `delete(ChannelId('ch-nonexistent'))` returns `ok: true` (silent no-op) consistent with the pattern established by the no-op update tests (T15b).

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 2 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Testing Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The test suite is well-structured with clear AAA patterns, good use of builder helpers (`buildChannel`, `buildMember`), proper resource cleanup (`afterEach`), and comprehensive coverage of the repository contract (CRUD, constraints, atomicity, pagination, performance). The refactoring to enums is largely consistent. The two HIGH issues -- missing precondition validation tests for `updateRound` and missing boundary-length tests for the 64-char regex constraint -- represent untested behavior that was explicitly added in this PR and should have corresponding test coverage before merge.
