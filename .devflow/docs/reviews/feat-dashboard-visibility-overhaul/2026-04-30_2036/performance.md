# Performance Review Report

**Branch**: feat/dashboard-visibility-overhaul -> main
**Date**: 2026-04-30
**Scope**: Incremental review (4 commits since b477f51)

## Issues in Your Changes (BLOCKING)

### HIGH

**getSize probe still joins full stdout blob before size comparison when size HAS changed** - `src/cli/dashboard/use-task-output-stream.ts:190`
**Confidence**: 85%
- Problem: The `getSize()` probe correctly short-circuits the full `get()` call when total_size is unchanged. However, when `get()` IS called (size changed), `buildStreamState` at line 190 still executes `output.stdout.join('')` to reconstruct the entire stdout content on every poll tick where data grew. For a task with, say, 50MB of output, this allocates a 50MB string every second. The original OOM complaint was about per-tick allocation cost -- the probe eliminates ticks where nothing changed, but the ticks where data DID change still pay the full join cost. This is a diminishing-returns concern (most ticks are now skipped), but for tasks with continuously growing output, every tick still hits the full join.
- Impact: For tasks that produce continuous output (build logs, streaming), every poll tick where size increased still allocates the full stdout string. The probe helps idle tasks but not actively-writing ones.
- Fix: A future `getSince(taskId, byteOffset)` method that returns only the new delta from the database would eliminate this. For now, the probe provides substantial improvement for the common case (idle tasks), so this is noted as a follow-up optimization, not a blocker.

### MEDIUM

**`codePointLength` iterates entire string even when only checking "did length change"** - `src/cli/dashboard/use-task-output-stream.ts:191`
**Confidence**: 82%
- Problem: `codePointLength(fullContent)` iterates the entire concatenated stdout string character-by-character just to count code points. For ASCII-only output (the vast majority of CLI/build logs), `str.length` is equivalent to the code point count. The for-of iterator is correct for multi-byte characters but imposes unnecessary overhead for the common case.
- Impact: For a 10MB ASCII stdout string, this iterates 10M characters purely to count them. This runs on every tick where data changed.
- Fix: Add a fast-path check using the heuristic that if `str.length` equals `Buffer.byteLength(str, 'utf8')`, the string is pure ASCII and `str.length` is the code-point count. Alternatively, since the totalChars field is only used for delta slicing (not display), consider whether byte-offset-based slicing could replace character-based slicing entirely:
  ```typescript
  export function codePointLength(str: string): number {
    // Fast path: ASCII-only strings have equal .length and code-point count
    if (str.length < 100_000) return countCodePoints(str);
    // For large strings, check if ASCII-only via a quick scan
    let hasSurrogate = false;
    for (let i = 0; i < str.length; i++) {
      if (str.charCodeAt(i) > 0x7F) { hasSurrogate = true; break; }
    }
    return hasSurrogate ? countCodePoints(str) : str.length;
  }
  function countCodePoints(str: string): number {
    let n = 0;
    for (const _ of str) n++;
    return n;
  }
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`output.stdout.join('')` on line 190 creates a full copy of stdout on every changed-data tick** - `src/cli/dashboard/use-task-output-stream.ts:190`
**Confidence**: 83%
- Problem: `output.stdout` is an array of chunks. `.join('')` allocates a new string equal to the sum of all chunk sizes. This happens on every poll tick where getSize detected a change. The join plus the subsequent `codePointLength` plus `codePointSlice` means three passes over the same data (join, count, slice) on changed-data ticks.
- Impact: Three linear passes over potentially large strings. The spread-based allocation spike is eliminated (good), but the overall per-tick cost for actively-growing tasks is still O(N) with constant factor ~3.
- Fix: Consider computing the delta without joining all chunks. Since chunks are appended sequentially, only the last N chunks (those added since the last poll) contain new data. The repository could track chunk boundaries to enable true incremental reads. This is a deeper architectural change -- note for future optimization.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`SELECT *` in getStmt loads all columns including stdout/stderr blobs** - `src/implementations/output-repository.ts:50`
**Confidence**: 85%
- Problem: The `get()` prepared statement uses `SELECT *` which loads the full stdout and stderr TEXT columns. For large outputs stored in the database (below the file threshold), this loads potentially megabytes of JSON text from SQLite into memory. A more targeted SELECT (just the columns needed) would not help here since all columns are needed, but the observation is that the file-storage threshold (configurable via `fileStorageThresholdBytes`) determines when this cost is paid -- outputs below the threshold are always loaded in full from SQLite.
- Impact: Outputs just below the file-storage threshold (e.g., 900KB with a 1MB threshold) still load the full blob via `SELECT *`. The getSize probe mitigates this by skipping the call when unchanged, but when the call is made, the full blob is read.
- Fix: No immediate fix needed -- the getSize probe addresses the hot path. Consider lowering the default file-storage threshold if large in-DB outputs remain a concern.

## Suggestions (Lower Confidence)

- **Ring buffer spread on line 231 creates intermediate array** - `src/cli/dashboard/use-task-output-stream.ts:231` (Confidence: 65%) -- `[...prev.lines, ...newLines]` creates a new array by spreading both arrays. For the ring buffer (capped at 500 lines), this is bounded and unlikely to be a problem, but `prev.lines.concat(newLines)` would avoid the spread overhead.

- **`new Date()` allocation on every skip path** - `src/cli/dashboard/use-task-output-stream.ts:403` (Confidence: 62%) -- The size-probe skip path creates a `new Date()` on every tick per task. For 50 tasks polled at 1s intervals, that is 50 Date allocations/s. Negligible in isolation, but `Date.now()` (a number) would be cheaper if the type allowed it.

- **Liveness cache sweep iterates all entries linearly** - `src/cli/dashboard/use-dashboard-data.ts:225-227` (Confidence: 60%) -- The sweep loop iterates all cache entries on every `fetchAllData` call. With the cache bounded by orchestration count (typically <100), this is negligible. No action needed.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 1 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 0 |

**Performance Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

The core performance optimization in this PR is sound and well-targeted: the `getSize()` probe eliminates O(N*T) blob reads for idle tasks, `codePointLength`/`codePointSlice` eliminate the OOM-causing spread allocations, and the liveness cache sweep prevents unbounded Map growth. These are the right fixes for the reported dashboard OOM crashes.

The remaining performance concerns (HIGH: full join cost on changed-data ticks; MEDIUM: codePointLength iterating ASCII strings) are diminishing-returns optimizations that only apply to actively-writing tasks -- the probe already eliminates the worst case (idle tasks being re-read every second). These should be tracked as follow-up items but do not need to block this PR, as the fix already addresses the critical OOM failure mode.
