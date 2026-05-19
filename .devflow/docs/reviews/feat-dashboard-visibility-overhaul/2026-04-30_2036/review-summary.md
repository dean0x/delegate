# Code Review Summary

**Branch**: feat/dashboard-visibility-overhaul -> main
**Date**: 2026-04-30T20:36
**Reviewers**: 8 (architecture, complexity, consistency, performance, regression, security, testing, typescript)

## Merge Recommendation: CHANGES_REQUESTED

The branch demonstrates excellent engineering discipline across core optimization logic, but contains **one blocking MEDIUM issue** flagged by multiple reviewers and two blocking HIGH/MEDIUM test concerns. The missing `closingRef` guard breaks the established safety pattern, and the test implementation risk (duplicating production control flow instead of exercising it) must be resolved before merge.

---

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------|----------|------|--------|-----|-------|
| **Blocking** | 0 | 1 | 3 | 0 | **4** |
| **Should Fix** | 0 | 0 | 2 | 0 | **2** |
| **Pre-existing** | 0 | 0 | 2 | 0 | **2** |

---

## Blocking Issues

### 1. Missing `closingRef.current` Guard After `getSize` Await
**Files**: `src/cli/dashboard/use-task-output-stream.ts:397-406`
**Severity**: MEDIUM | **Confidence**: 95% (flagged by architecture, consistency, typescript, performance reviewers)

**Problem**: After `await outputRepo.getSize(taskId)` resolves (line 397), the code proceeds to update `streamsRef` and potentially return without checking `closingRef.current`. The paired `get()` path at line 410 correctly checks `if (closingRef.current) return;` after its await, establishing a guard pattern. The `getSize` probe path violates this pattern.

**Impact**: If component unmounts between the `getSize` await resolution and the state write, the code writes to `streamsRef` and `terminalFetchedRef` on a detached ref. While not a crash (ref writes are no-ops), it breaks the guard contract established by the function.

**Fix**:
```typescript
const sizeResult = await outputRepo.getSize(taskId);
if (closingRef.current) return;  // <-- add this line
if (sizeResult.ok && sizeResult.value === prev.totalBytes && prev.lines.length > 0) {
```

---

### 2. T20 Test Duplicates Production Control Flow Instead of Exercising It
**File**: `tests/unit/cli/dashboard/use-task-output-stream.test.ts:467-499`
**Severity**: HIGH | **Confidence**: 85%

**Problem**: Test T20 manually re-implements the `fetchTask` control flow from `doPoll` (lines 487-494) rather than exercising the actual hook closure. The test inlines `if (!(sizeResult.ok && ...))` which mirrors production logic at `use-task-output-stream.ts:398`. If production logic changes shape, the test passes against its own copy while the real code path goes untested.

**Impact**: Test couples to implementation details instead of behavior. Couples the test to production code — if the conditional guard logic changes, test may pass while real code breaks.

**Fix**: Extract the size-probe-then-fetch logic into a standalone testable function (recommended by complexity reviewer as well), then test that function directly. Alternatively, test via React testing library render that verifies observable output (streams map content) when `getSize` returns error.

---

### 3. T17-T19 Tests Mislabeled — Test `buildStreamState`, Not Size Probe
**File**: `tests/unit/cli/dashboard/use-task-output-stream.test.ts:434-465`
**Severity**: MEDIUM | **Confidence**: 82%

**Problem**: Tests T17-T19 are labeled "Size probe in doPoll -- getSize guards full get() call" but exclusively call `buildStreamState` and never invoke `getSize` or the probe path. They test the `totalBytes` guard in `buildStreamState` (line 181), which is a separate mechanism from the `getSize` probe (lines 397-407). The size-probe optimization remains untested at the integration level for the success path.

**Impact**: Test labeling creates false confidence in probe coverage. Size probe integration path untested for success case (only T20 exercises it, but with duplicated logic).

**Fix**: Either (a) rename describe block and test titles to accurately reflect what they test (`buildStreamState`'s `totalBytes` guard), or (b) add real integration tests that mock `getSize` to return matching/differing sizes and verify that `repo.get` is/is not called accordingly.

---

### 4. `getSize` Probe Still Joins Full Stdout Blob on Size Change
**File**: `src/cli/dashboard/use-task-output-stream.ts:190`
**Severity**: HIGH | **Confidence**: 85%

**Problem**: The `getSize()` probe correctly short-circuits the full `get()` call when total_size is unchanged. However, when `get()` IS called (size changed), `buildStreamState` at line 190 still executes `output.stdout.join('')` to reconstruct the entire stdout content. For a 50MB output, this allocates a 50MB string every second on changed-data ticks.

**Impact**: For tasks with continuously growing output (build logs, streaming), every poll tick where size increased still hits the full join allocation cost. The probe helps idle tasks but not actively-writing ones. This is a diminishing-returns concern (common case of idle tasks is improved), but the performance plateau exists.

**Fix**: A future `getSince(taskId, byteOffset)` method that returns only the delta would eliminate this. For now, document this as a follow-up optimization. The current fix addresses the critical OOM failure mode (idle task re-reads), so this is not a blocker but should be tracked as a known limitation.

---

## Should-Fix Issues

### 1. Module Header "Key Exports" List Not Updated
**File**: `src/cli/dashboard/use-task-output-stream.ts:6-12`
**Severity**: MEDIUM | **Confidence**: 92%

**Problem**: The module-level JSDoc at lines 6-12 lists "Key exports" but does not include newly exported `codePointLength` and `codePointSlice` functions. The existing pattern enumerates every export with its category. New functions follow the same pattern but are missing from the index.

**Fix**:
```typescript
 *  - codePointLength: Pure function (exported for testing)
 *  - codePointSlice: Pure function (exported for testing)
```

---

### 2. `codePointLength` Iterates Entire String Even for ASCII
**File**: `src/cli/dashboard/use-task-output-stream.ts:191`
**Severity**: MEDIUM | **Confidence**: 82%

**Problem**: `codePointLength(fullContent)` iterates the entire concatenated stdout string character-by-character to count code points. For ASCII-only output (vast majority of CLI/build logs), `str.length` equals the code point count. The for-of iterator correctly handles multi-byte chars but imposes unnecessary overhead for the common case.

**Impact**: For a 10MB ASCII stdout string, this iterates 10M characters purely to count them, on every tick where data changed.

**Fix** (optional): Add a fast-path check using a heuristic that if `str.length` equals `Buffer.byteLength(str, 'utf8')`, the string is pure ASCII and `str.length` is correct. Alternatively, defer as a follow-up optimization since the primary OOM issue is already fixed.

---

## Pre-existing Issues (Not Blocking)

### 1. Incomplete OutputRepository Mock Migrations
**Files**: `tests/fixtures/eval-test-helpers.ts:54`, `tests/unit/services/agent-exit-condition-evaluator.test.ts:50,618`, `tests/unit/services/judge-exit-condition-evaluator.test.ts:249`
**Severity**: MEDIUM | **Confidence**: 85%

**Problem**: These files create OutputRepository stubs using `as unknown as OutputRepository` and include a stale `getByteSize` method instead of the new `getSize`. They predate this PR and were not touched by this diff. The `as unknown` cast bypasses structural type checking, so these stubs compile without the new `getSize` method. If any code calls `getSize` on these stubs, it fails at runtime.

**Fix**: Add `getSize: vi.fn().mockResolvedValue(ok(0))` to each stub and remove stale `getByteSize` entries. Recommend a separate cleanup PR.

---

### 2. Inconsistent Initial State Constant Naming
**Files**: `src/cli/dashboard/use-task-output-stream.ts:255` vs `tests/unit/cli/dashboard/use-task-output-stream.test.ts:424`
**Severity**: MEDIUM | **Confidence**: 80%

**Problem**: Source file defines `INITIAL_STREAM_STATE`, test defines `STREAM_INITIAL`. Naming convention reversal makes discovery harder. Test constant was introduced in this diff's new test code.

**Fix**: Either export `INITIAL_STREAM_STATE` from source, or rename test constant to `INITIAL_STREAM_STATE` for discoverability.

---

## Summary by Reviewer

| Reviewer | Score | Key Finding |
|----------|-------|-------------|
| **Architecture** | 9/10 | Missing `closingRef` guard (MEDIUM, 85%) |
| **Complexity** | 7/10 | `fetchTask` closure nesting + T20 control flow duplication (HIGH, 85%) |
| **Consistency** | 8/10 | Missing `closingRef` guard (MEDIUM, 85%) + module header gap (MEDIUM, 92%) |
| **Performance** | 8/10 | getSize still joins full blob on size change (HIGH, 85%) + codePointLength ASCII overhead (MEDIUM, 82%) |
| **Regression** | 9/10 | No regressions introduced; pre-existing mock stubs noted |
| **Security** | 9/10 | Security-clean; changes improve availability (OOM fix) |
| **Testing** | 7/10 | T20 duplicates production logic (HIGH, 85%) + T17-T19 mislabeled (MEDIUM, 82%) |
| **TypeScript** | 9/10 | Missing `closingRef` guard (MEDIUM, 82%) |

---

## What Works Well

1. **Core optimization sound**: The three-part fix (getSize probe, codePointLength/Slice helpers, liveness sweep) correctly targets the reported OOM issue. Graceful degradation is implemented consistently.

2. **Interface & implementation solid**: `getSize()` added to `OutputRepository` interface with proper JSDoc. `SQLiteOutputRepository` implements it with parameterized SQL. All mocks updated.

3. **Pure function extraction excellent**: `codePointLength` (T5-T8) and `codePointSlice` (T9-T13) have thorough test coverage (ASCII, emoji, CJK, boundaries, surrogate pairs). Clear AAA test structure.

4. **No regressions**: Removed `openDetail` export has zero consumers. `codePointLength`/`codePointSlice` semantically identical to spread-based originals. Liveness sweep has proper TTL-gated deletion with test coverage.

5. **Security clean**: SQL injection risk mitigated via parameterized statements. ANSI escape injection already handled by `stripAnsi()`. No new attack surface introduced.

---

## Action Plan

**Before Merge** (blocking):
1. Add `closingRef.current` guard after `getSize` await (lines 397-406)
2. Extract size-probe logic into standalone `shouldSkipFetch()` or similar helper function
3. Rewrite T20 test to exercise extracted helper or use React testing library render
4. Rename or rewrite T17-T19 tests to accurately reflect what they test

**Document as Follow-Up** (known limitations, not blockers):
1. Full stdout join cost on changed-data ticks (getSince optimization follow-up)
2. codePointLength ASCII overhead (fast-path optimization follow-up)
3. Cleanup pre-existing mock stubs (`getByteSize` → `getSize`) in separate PR

---

## Confidence Calculation

- **Missing `closingRef` guard**: Flagged by 4 reviewers (architecture 85%, consistency 85%, typescript 82%, performance implied) → aggregated confidence: **95%**
- **T20 test control flow duplication**: HIGH severity, complexity + testing flagged → **85%** confidence
- **T17-T19 mislabeling**: Testing flagged → **82%** confidence
- **getSize joins full blob**: Performance flagged → **85%** confidence
