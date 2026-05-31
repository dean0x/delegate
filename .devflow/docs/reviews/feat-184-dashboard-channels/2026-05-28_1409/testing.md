# Testing Review Report

**Branch**: feat/184-dashboard-channels -> main
**Date**: 2026-05-28

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Missing test: `channelRepository.findUpdatedSince` is called during main-view metrics fetch** - `tests/unit/cli/dashboard/use-dashboard-data.test.ts`
**Confidence**: 85%
- Problem: The PR adds `channelRepository.findUpdatedSince` as a new parallel call inside `fetchMetricsExtras` (line 324 of `use-dashboard-data.ts`), and the mock is wired in `makeCtx()`, but no test explicitly asserts that `channelRepository.findUpdatedSince` is invoked during a `MAIN_VIEW` fetch. All other entity repos have analogous `findUpdatedSince` mocks wired, but no test in this file verifies the channel variant is called. If the call were accidentally removed, no test would fail.
- Fix: Add a test similar to the existing "calls findAll(FETCH_LIMIT) on all repositories" test:
```typescript
it('calls channelRepository.findUpdatedSince during main-view metrics fetch', async () => {
  const channelRepo = {
    findAll: vi.fn().mockResolvedValue(ok([])),
    countByStatus: vi.fn().mockResolvedValue(ok({})),
    getMessages: vi.fn().mockResolvedValue(ok([])),
    findUpdatedSince: vi.fn().mockResolvedValue(ok([])),
  };
  const ctx = makeCtx({ channelRepository: channelRepo as unknown as ReadOnlyContext['channelRepository'] });
  await fetchAllData(ctx, MAIN_VIEW);
  expect(channelRepo.findUpdatedSince).toHaveBeenCalledWith(expect.any(Number), 50);
});
```

**Missing test: channel detail hints omit 'Enter detail'** - `tests/unit/cli/dashboard/hints.test.ts`
**Confidence**: 82%
- Problem: The PR changes `detailHints` for channels to use `baseChannel` which deliberately omits "Enter detail" to avoid misleading keyboard-only users (line 42 and 55-60 of `hints.ts`). The existing hints tests for channels verify `p pause/resume` and `member` hints but do not assert that "Enter detail" is absent. This is an intentional accessibility behavior change that should be explicitly tested.
- Fix: Add a test to the channels section of the `detailHints()` describe block:
```typescript
it('omits "Enter detail" for channels (no drill-through)', () => {
  const result = detailHints('channels', 'active');
  expect(result).not.toContain('Enter detail');
});
```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**No unit tests for `getPanelItems`, `panelToEntityKind`, or `resolveMemberIndex` pure functions** - `src/cli/dashboard/keyboard/helpers.ts`
**Confidence**: 80%
- Problem: The PR modified all three functions (`getPanelItems` removed null-coalescing fallbacks, `panelToEntityKind` added exhaustive never guard, `resolveMemberIndex` changed from `!selectedName` to `=== null`). These are pure functions with no side effects, making them trivially testable, yet no test file exists for `helpers.ts`. The exhaustive `never` guards in particular are a compile-time safety net, but the behavior of `getPanelItems` and `panelToEntityKind` across all 6 panel types is not verified at runtime. The `resolveMemberIndex` change from falsy check to explicit null check is semantically different (empty string would now not early-return to 0), and should have a test pinning the intended behavior.
- Fix: Create `tests/unit/cli/dashboard/helpers.test.ts` with tests for each function covering all 6 panel/entity types and `resolveMemberIndex` edge cases (null, empty string, not found, found).

## Pre-existing Issues (Not Blocking)

(none)

## Suggestions (Lower Confidence)

- **`findUpdatedSince` edge case: boundary timestamp (updated_at == sinceMs)** - `tests/unit/implementations/channel-repository.test.ts:473` (Confidence: 65%) -- The test uses `WHERE updated_at >= ?` (inclusive boundary) but the test only checks that a channel updated at `recent = Date.now()` is included when `sinceMs = past = Date.now() - 10_000`. It does not verify the exact-boundary case where `updated_at == sinceMs`. A test with a channel whose `updated_at` exactly equals `sinceMs` would pin the inclusive-vs-exclusive behavior.

- **Missing test for `findUpdatedSince` error path in `fetchMetricsExtras`** - `src/cli/dashboard/use-dashboard-data.ts:333` (Confidence: 62%) -- When `channelRepository.findUpdatedSince` returns an `err()`, `fetchMetricsExtras` silently degrades (the result is unwrapped with `.ok ? .value : []`). This graceful degradation is consistent with how other repos are handled but has no dedicated test.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Testing Score**: 7/10
**Recommendation**: CHANGES_REQUESTED

The new `findUpdatedSince` repository method has good tests (time window, limit, empty result) and the entity-mutations tests are thorough with error paths. The message persistence handler now covers the save-failure path. The main gaps are: (1) no assertion that the new `channelRepository.findUpdatedSince` is actually called during the main-view activity feed fetch, (2) no test pinning that channel detail hints deliberately omit "Enter detail", and (3) no test file for the `helpers.ts` pure functions that were modified. The test suite refactoring from `unwrapAll`/positional-cast to individual `Result` unwrap is a clear improvement for type safety and testability.
