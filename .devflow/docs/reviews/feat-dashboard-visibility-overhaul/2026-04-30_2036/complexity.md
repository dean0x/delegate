# Complexity Review Report

**Branch**: feat/dashboard-visibility-overhaul -> main
**Date**: 2026-04-30T20:36
**Scope**: Incremental (4 commits since b477f51)

## Issues in Your Changes (BLOCKING)

### HIGH

**fetchTask closure nesting depth reaches 5 levels** - `src/cli/dashboard/use-task-output-stream.ts:392-434`
**Confidence**: 85%
- Problem: The `fetchTask` closure inside `doPoll` (inside `useCallback`, inside `useTaskOutputStream`) now reaches 5 nesting levels: `useCallback > try > for > fetchTask > try > if`. The addition of the size probe at line 397-407 added a new conditional branch inside an already deeply nested closure (the `if (sizeResult.ok && ...)` block at nesting level 5). The combined fetchTask closure spans 42 lines with 7 decision points (cyclomatic complexity ~8 for the closure alone).
- Impact: Each future optimization or error path added to fetchTask compounds the nesting. The size probe added one conditional branch, one early return, and duplicated the terminal-fetch bookkeeping (`terminalFetchedRef.current.add(taskId)` appears on both line 405 and line 424). This is currently manageable but approaching the warning threshold.
- Fix: Extract the size-probe guard into a standalone helper function. This would flatten one nesting level and eliminate the duplicated terminal-fetch bookkeeping:
  ```typescript
  /** Returns true if the size probe confirms output is unchanged (skip full fetch). */
  async function trySizeProbe(
    outputRepo: OutputRepository,
    taskId: TaskId,
    prev: OutputStreamState,
    status: TaskStreamStatus,
    streamsRef: React.MutableRefObject<Map<TaskId, OutputStreamState>>,
    terminalFetchedRef: React.MutableRefObject<Set<TaskId>>,
  ): Promise<boolean> {
    const sizeResult = await outputRepo.getSize(taskId);
    if (!sizeResult.ok || sizeResult.value !== prev.totalBytes || prev.lines.length === 0) {
      return false;
    }
    const prevState = streamsRef.current.get(taskId) ?? INITIAL_STREAM_STATE;
    streamsRef.current.set(taskId, { ...prevState, taskStatus: status, lastFetchedAt: new Date() });
    if (status === 'terminal') terminalFetchedRef.current.add(taskId);
    return true;
  }
  ```
  Then in fetchTask: `if (await trySizeProbe(...)) return;`

## Issues in Code You Touched (Should Fix)

### MEDIUM

**useTaskOutputStream hook is 180 lines with 7 refs** - `src/cli/dashboard/use-task-output-stream.ts:299-478`
**Confidence**: 82%
- Problem: The hook function spans 180 lines (above the 50-line warning threshold for functions) and manages 7 separate refs (`streamsRef`, `tickRef`, `fetchingRef`, `closingRef`, `prevTaskIdsRef`, `taskIdsRef`, `taskStatusesRef`) plus `terminalFetchedRef`. This is pre-existing complexity (not introduced by this PR), but the new size probe additions increase the cognitive load of the `doPoll` callback. The hook is effectively a mini state machine implemented through scattered refs.
- Impact: Each new optimization path (like the size probe) must correctly interact with all refs. The duplication of `streamsRef.current.get(taskId) ?? INITIAL_STREAM_STATE` appears 5 times within the hook, indicating extraction opportunities.
- Fix: This is pre-existing structural complexity. Consider in a future PR: (1) extract a `getPrevState(taskId)` helper to eliminate the 5x repeated fallback pattern, (2) group related refs into a single `pollState` ref object to reduce the ref count.

**fetchAllData function is 167 lines** - `src/cli/dashboard/use-dashboard-data.ts:132-298`
**Confidence**: 80%
- Problem: The function spans 167 lines (above the 50-line critical threshold). The liveness cache sweep (lines 221-227) added by this PR is well-isolated, but it adds to an already long function. The function handles: parallel fetching, result unwrapping, type casting, detail extras, liveness computation with caching, liveness sweep, metrics extras, and workspace extras -- at least 8 distinct responsibilities.
- Impact: Pre-existing complexity. The cache sweep addition (+7 lines) is clean in isolation but contributes to a function that should eventually be decomposed.
- Fix: Pre-existing. In a future PR, consider extracting the liveness block (lines 218-263) into a `computeOrchestrationLiveness(orchestrations, cache, deps)` helper. The sweep would naturally live inside that helper.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**Duplicated `streamsRef.current.get(taskId) ?? INITIAL_STREAM_STATE` pattern** - `src/cli/dashboard/use-task-output-stream.ts:379,399,414,421,428`
**Confidence**: 82%
- Problem: The fallback pattern `streamsRef.current.get(taskId) ?? INITIAL_STREAM_STATE` appears 5 times within `doPoll` and its `fetchTask` closure (lines 379, 399, 414, 421, 428). Two of these occurrences are in the new size probe code (lines 399 and one was there before). This repetition increases maintenance burden -- if the fallback logic changes, 5 sites must be updated.
- Impact: Minor -- the pattern is simple and unlikely to change. But it indicates the function is doing too many things at different levels of abstraction.
- Fix: Extract to a local helper at the top of `doPoll`: `const getPrev = (id: TaskId) => streamsRef.current.get(id) ?? { ...INITIAL_STREAM_STATE };`

## Suggestions (Lower Confidence)

- **Magic number 10_000 in test** - `tests/unit/cli/dashboard/use-dashboard-data.test.ts:513` (Confidence: 62%) -- The stale timestamp uses `Date.now() - 10_000` (10 seconds). Consider using a named constant like `LIVENESS_CACHE_TTL_MS * 2.5` to tie it to the actual TTL, making the test self-documenting if the TTL changes.

## Summary
| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | - |
| Should Fix | - | 0 | 2 | - |
| Pre-existing | - | - | 1 | 0 |

**Complexity Score**: 7/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The new code (codePointLength, codePointSlice, getSize, cache sweep) is individually clean and low-complexity -- each helper is short, focused, and well-documented. The one blocking concern is that the fetchTask closure is accumulating nesting depth and decision branches; extracting the size-probe guard into a helper would prevent the next optimization from pushing past the 5-level nesting threshold. The should-fix items are pre-existing structural complexity that this PR slightly exacerbates but does not create.
