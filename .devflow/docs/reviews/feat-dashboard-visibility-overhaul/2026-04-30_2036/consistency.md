# Consistency Review Report

**Branch**: feat/dashboard-visibility-overhaul -> main
**Date**: 2026-04-30
**Scope**: Incremental (4 commits since b477f51)

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Missing closingRef guard after getSize async call** - `src/cli/dashboard/use-task-output-stream.ts:397-406`
**Confidence**: 85%
- Problem: After `outputRepo.getSize(taskId)` resolves (line 397), the code immediately proceeds to update `streamsRef` and potentially return without checking `closingRef.current`. The existing pattern in this same function checks `closingRef.current` after `outputRepo.get(taskId)` at line 410, but the new `getSize` probe path at lines 397-406 does not. If the component unmounts during the `getSize` await, the code still writes to `streamsRef` and `terminalFetchedRef`. While this is unlikely to cause a visible bug (no React `setState` is called directly in the fast path), it deviates from the established guard pattern used for every other async call in this function.
- Fix: Add a `closingRef` check after the `getSize` await, consistent with the `get()` path:
```typescript
const sizeResult = await outputRepo.getSize(taskId);
if (closingRef.current) return;
if (sizeResult.ok && sizeResult.value === prev.totalBytes && prev.lines.length > 0) {
```

**Module header "Key exports" list not updated** - `src/cli/dashboard/use-task-output-stream.ts:6-12`
**Confidence**: 92%
- Problem: The module-level JSDoc at lines 6-12 lists "Key exports" for the file but does not include the newly exported `codePointLength` and `codePointSlice` functions. The existing pattern enumerates every export with its category (e.g., `buildStreamState: Pure function (exported for testing)`). The new functions follow this same export-for-testing pattern but are missing from the index.
- Fix: Add the new exports to the header:
```typescript
 *  - codePointLength: Pure function (exported for testing)
 *  - codePointSlice: Pure function (exported for testing)
```

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Inconsistent naming between source and test initial state constants** - `src/cli/dashboard/use-task-output-stream.ts:255` / `tests/unit/cli/dashboard/use-task-output-stream.test.ts:424`
**Confidence**: 80%
- Problem: The source file defines `INITIAL_STREAM_STATE` (not exported) while the test defines its own copy as `STREAM_INITIAL`. The naming convention reversal (ADJECTIVE_NOUN vs NOUN_ADJECTIVE) makes it harder to recognize these as the same concept. Other test files in the codebase generally mirror the source naming (e.g., `MAIN_VIEW` in tests matching `MAIN_VIEW` semantics from the source). This is pre-existing (the source constant existed before this diff), but the test constant `STREAM_INITIAL` was introduced in this diff's new test code. Since the source constant is not exported, duplication is necessary, but the name should match.
- Fix: Either export `INITIAL_STREAM_STATE` from the source, or rename the test constant to `INITIAL_STREAM_STATE` for discoverability.

## Suggestions (Lower Confidence)

_None._

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Consistency Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The changes are well-executed with strong pattern adherence overall. The `getSize` interface addition follows the established `Result<number>` pattern, the `tryCatchAsync` + `AutobeatError` error handling in the implementation matches sibling methods, the JSDoc `ARCHITECTURE:` annotations match codebase conventions, and the test structure (describe/it grouping, mock factories, Result type assertions) is consistent with existing test files. The mock repository in `tests/fixtures/mocks.ts` was correctly updated to include `getSize`. The two blocking MEDIUM issues are minor documentation/guard consistency gaps that should be addressed before merge.
