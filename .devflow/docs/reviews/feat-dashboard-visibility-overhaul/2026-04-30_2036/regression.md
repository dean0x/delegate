# Regression Review Report

**Branch**: feat/dashboard-visibility-overhaul -> main
**Date**: 2026-04-30
**Scope**: Incremental review of 4 commits since b477f51

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

### MEDIUM

(none)

## Issues in Code You Touched (Should Fix)

(none)

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Incomplete OutputRepository mock migration (4 occurrences)** - Confidence: 85%
- `tests/fixtures/eval-test-helpers.ts:54`, `tests/unit/services/agent-exit-condition-evaluator.test.ts:50`, `tests/unit/services/agent-exit-condition-evaluator.test.ts:618`, `tests/unit/services/judge-exit-condition-evaluator.test.ts:249`
- Problem: These files create OutputRepository stubs using `as unknown as OutputRepository` and include a method named `getByteSize` instead of `getSize`. They predate this PR and were not touched by this diff. The `as unknown` cast bypasses structural type checking, so these stubs compile without the new `getSize` method. If any future code path calls `getSize` on these stubs, it would fail at runtime with "getSize is not a function".
- Fix: Add `getSize: vi.fn().mockResolvedValue(ok(0))` to each stub and remove the stale `getByteSize` entries (which are not part of the `OutputRepository` interface). Recommend a separate cleanup PR.

## Suggestions (Lower Confidence)

(none)

## Regression Checklist

- [x] **No exports removed without deprecation** - `openDetail` was removed from `types.ts`. Confirmed zero consumers across all `.ts`/`.tsx` files in `src/` and `tests/`. The commit message labels it "cleanup: remove unused openDetail export". No regression.
- [x] **Return types backward compatible** - `OutputRepository` interface gained `getSize()` (additive). No return types were narrowed or changed.
- [x] **Default values unchanged** - No default value modifications.
- [x] **Side effects preserved** - `buildStreamState` still produces identical output. The spread-based `[...str].length` and `[...str].slice(n).join('')` were replaced by `codePointLength()` and `codePointSlice()` respectively. Both produce identical results for all Unicode input (confirmed by T5-T13 tests).
- [x] **All consumers of changed code updated** - `createMockOutputRepository` in `tests/fixtures/mocks.ts` includes `getSize`. The `makeOutputRepo` helper in `use-task-output-stream.test.ts` includes `getSize`. All direct consumers are updated.
- [x] **Migration complete across codebase** - The only `OutputRepository` implementation (`SQLiteOutputRepository`) implements `getSize`. Pre-existing `as unknown` casts in test fixtures are noted above but are not regressions introduced by this PR.
- [x] **Commit message matches implementation** - Commit aae501e claims three fixes (getSize probe, codePointLength/Slice, liveness sweep). All three are present in the diff. Commit 436e30f claims removal of unused openDetail; confirmed unused. Commit 7b7577b adds T20 test; confirmed present.
- [x] **Removed `nextStatus` re-computation is safe** - Old code: `const nextStatus = status === 'terminal' ? 'terminal' : classifyStatus(rawStatus)`. Since `status = classifyStatus(rawStatus)` and `classifyStatus` is a pure function, the ternary always equals `status`. Simplification is identity-preserving.
- [x] **Size probe graceful degradation verified** - When `getSize()` returns `err(...)`, the condition `sizeResult.ok && ...` short-circuits to false, falling through to `get()`. T20 test confirms this path.
- [x] **Terminal task marking preserved** - Both the size-probe early return path (line 405) and the full-fetch path (line 424) call `terminalFetchedRef.current.add(taskId)` when status is terminal. No regression in terminal task handling.
- [x] **Liveness cache sweep is safe** - The sweep uses `LIVENESS_CACHE_TTL_MS` as cutoff, same constant used for cache-hit checking. Entries within TTL are retained (T22). Stale entries are removed (T21).

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 0 | - |
| Should Fix | - | 0 | 0 | - |
| Pre-existing | - | - | 1 | 0 |

**Regression Score**: 9/10
**Recommendation**: APPROVED

No regressions introduced by these 4 commits. The removed `openDetail` export has zero consumers. The new `getSize` interface method is implemented in the sole concrete class and mocked in both test fixture helpers. The `codePointLength`/`codePointSlice` replacements are semantically identical to the spread-based originals. The `nextStatus` simplification is provably equivalent. The liveness cache sweep has proper TTL-gated deletion with test coverage. The only pre-existing issue is stale `getByteSize` references in test fixtures that use `as unknown` casts to bypass type checking -- not introduced by this PR.
