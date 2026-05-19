# Architecture Review Report

**Branch**: feat/dashboard-visibility-overhaul -> main
**Date**: 2026-04-30T20:36
**Scope**: Incremental (4 commits since b477f51)

## Issues in Your Changes (BLOCKING)

### MEDIUM

**Missing closingRef guard after getSize await** - `src/cli/dashboard/use-task-output-stream.ts:397-406`
**Confidence**: 85%
- Problem: After `await outputRepo.getSize(taskId)` resolves (line 397), there is no `closingRef.current` check before writing to `streamsRef.current` (lines 400-401) and returning. The `get()` path on line 410 correctly checks `if (closingRef.current) return;` after its await, but the getSize short-circuit path does not. If the component unmounts between the getSize await resolution and the state write, it will set state on an unmounted ref. In React/Ink this is benign (ref write, not setState), but it breaks the contract established by the existing `closingRef` guard pattern.
- Fix: Add the same guard after the getSize await:
```typescript
const sizeResult = await outputRepo.getSize(taskId);
if (closingRef.current) return;  // <-- add this
if (sizeResult.ok && sizeResult.value === prev.totalBytes && prev.lines.length > 0) {
```

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

_No issues found._

## Suggestions (Lower Confidence)

- **Consider extracting getSize probe logic into a named helper** - `src/cli/dashboard/use-task-output-stream.ts:392-434` (Confidence: 65%) -- The fetchTask closure now has two distinct responsibilities: (1) size-probe short-circuit and (2) full-fetch-and-build. Extracting the probe decision into a small helper (e.g. `shouldSkipFetch(sizeResult, prev)`) would keep the closure focused and make the probe logic independently testable without simulating the full doPoll flow. Not blocking since the function is still under 45 lines and well-commented.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Architecture Score**: 9/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Positive Architecture Observations

1. **Interface segregation done right**: `getSize()` was added to the `OutputRepository` interface in `core/interfaces.ts` with a clear architecture comment explaining its role as a cheap probe. This follows the existing interface extension pattern (e.g. `CheckpointLookup` narrow interface) and keeps the dependency direction correct (hook depends on interface, not implementation).

2. **Layering preserved**: The new `getSize` method lives in the repository layer (`SQLiteOutputRepository`) with a prepared statement, while the consumption lives in the dashboard hook. No layer-skipping -- the hook calls through the repository interface, not directly querying SQLite.

3. **Pure helper extraction**: `codePointLength` and `codePointSlice` are extracted as exported pure functions, following the established pattern in this file (`stripAnsi`, `mergeOutputLines`, `shouldPollThisTick`). This enables focused unit testing without React hook ceremony.

4. **Graceful degradation**: The size probe falls through to the full `get()` call on error, preserving the existing behavior when the optimization cannot apply. This is the correct pattern -- optimizations should never break the happy path.

5. **Liveness cache sweep**: The TTL-based sweep in `fetchAllData` addresses unbounded Map growth without changing the cache's external contract. The sweep runs before the computation loop, ensuring stale entries are cleaned before any cache reads.

6. **Mock consistency**: Both `tests/fixtures/mocks.ts` (`createMockOutputRepository`) and the local `makeOutputRepo` factory in the stream test file were updated to include `getSize`, preventing runtime type errors in any test that constructs a mock `OutputRepository`.
