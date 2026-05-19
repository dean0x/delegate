# Regression Review Report

**Branch**: fix/v060-correctness-bugs -> main
**Date**: 2026-03-19
**PR**: #106

## Issues in Your Changes (BLOCKING)

### MEDIUM

**`totalSize` semantics inconsistency: `string.length` vs `Buffer.byteLength`** - `src/implementations/output-capture.ts:13-14`, `src/services/task-manager.ts:33-34`

- Problem: The new `linesSize()` helper uses `string.length` (character count) to recalculate `totalSize` after tail-slicing. However, the `BufferedOutputCapture.capture()` method at line 51 accumulates `totalSize` using `Buffer.byteLength(data, 'utf8')` (byte count). For ASCII-only output these are identical, but for multi-byte characters (e.g., emoji, CJK, accented chars) the values diverge. When `tail` is not applied, the non-tail path at line 120 returns `buffer.totalSize` (byte-based), but when tail IS applied, it returns `linesSize()` (character-based). This creates an inconsistency in what `totalSize` means depending on whether tail-slicing was applied.
- Impact: Consumers relying on `totalSize` for size-based decisions (e.g., `process-connector.ts:143` checks `totalSize === 0` to skip persistence) may behave differently depending on code path. In practice, Claude Code output is predominantly ASCII so this is unlikely to cause bugs today, but it is a latent semantic inconsistency.
- Fix: Use `Buffer.byteLength` in `linesSize` for consistency with the accumulation path, or document that `totalSize` after tail-slicing reflects character length rather than byte length. Alternatively, standardize on character length everywhere (including `capture()`).
- Category: Blocking -- introduced by this PR's new `linesSize()` function

**`linesSize` duplicated as private module functions in two files** - `src/implementations/output-capture.ts:12-15`, `src/services/task-manager.ts:32-35`

- Problem: The identical `linesSize()` helper is defined twice as file-scoped functions. While not a runtime regression, duplication of logic that defines what `totalSize` means creates drift risk. If one copy is updated (e.g., to fix the byte-vs-char issue above), the other may be missed.
- Impact: Future maintenance risk. If the calculation logic needs to change, both sites must be updated in sync.
- Fix: Extract `linesSize` into a shared utility (e.g., `src/utils/output.ts`) and import from both files. This also makes it easier to test the calculation in isolation.
- Category: Blocking -- both copies were introduced by this PR

### LOW

**`getExecutionHistory` now capped at DEFAULT_LIMIT (100) instead of unbounded for cancel** - `src/services/schedule-manager.ts:183`

- Problem: The old code called `getExecutionHistory(scheduleId, 1)` which only looked at the latest execution (the bug being fixed). The new code calls `getExecutionHistory(scheduleId)` without a limit, which defaults to `SQLiteScheduleRepository.DEFAULT_LIMIT` of 100. If a schedule has more than 100 executions with status `'triggered'`, older active executions beyond position 100 would still be missed.
- Impact: Very low in practice -- having more than 100 concurrent triggered executions for a single schedule is an extreme edge case. The fix is a major improvement over the previous `limit: 1` behavior.
- Fix: No immediate action needed. If this ever becomes a concern, pass an explicit large limit or loop with pagination. The current behavior is a reasonable default.
- Category: Blocking -- new code in this PR, but LOW severity

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`TestOutputCapture.getOutput` uses `join('')` while `BufferedOutputCapture.getOutput` uses `linesSize`** - `src/implementations/output-capture.ts:213`

- Problem: `TestOutputCapture.getOutput()` at line 213 calculates `totalSize` as `stdout.join('').length + stderr.join('').length`, which is functionally equivalent to `linesSize()` but uses a different code path. This file was touched by this PR (the `linesSize` addition and `BufferedOutputCapture.getOutput` rewrite) but `TestOutputCapture` was not updated to use the same helper. The two implementations will produce the same result for all inputs, but the divergent calculation approach creates a maintenance burden.
- Impact: Low -- the results are numerically identical. But test doubles should mirror production behavior for reliable testing.
- Fix: Either make `linesSize` a shared export and use it in `TestOutputCapture`, or call `linesSize(stdout) + linesSize(stderr)` in `TestOutputCapture.getOutput()` for consistency.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`OutputRepository.save` recalculates totalSize independently** - `src/implementations/output-repository.ts:66,163-167`

- Problem: `SQLiteOutputRepository.save()` calls `this.calculateTotalSize()` at line 66, which uses `line.length` (character count, same as `linesSize`). However, the `totalSize` field on the incoming `TaskOutput` object (accumulated via `Buffer.byteLength` during capture) is ignored. The DB always stores the character-length version. This means the DB `totalSize` and in-memory `totalSize` (non-tail path) could differ for multi-byte content.
- Impact: Pre-existing semantic mismatch between byte-based in-memory accumulation and character-based DB storage.

### LOW

**`OutputRepository.append` uses `data.length` for totalSize increment** - `src/implementations/output-repository.ts:93`

- Problem: The `append` method at line 93 uses `data.length` (character count) to increment `totalSize`, consistent with `calculateTotalSize` but inconsistent with `BufferedOutputCapture.capture()` which uses `Buffer.byteLength`.
- Impact: Pre-existing inconsistency, same root cause as above.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 1 |
| Should Fix | - | 0 | 1 | - |
| Pre-existing | - | - | 1 | 1 |

## Regression Checklist

- [x] No exports removed without deprecation
- [x] Return types backward compatible (RecoveryManager.recoverQueuedTasks is private, signature change is internal)
- [x] Default values unchanged (or documented)
- [x] Side effects preserved -- new TaskFailed emissions are additive, not replacing existing behavior
- [x] All consumers of changed RecoveryManager constructor updated (bootstrap.ts, 2 integration tests, 1 unit test)
- [x] Migration complete -- getExecutionHistory call site in cancelSchedule updated, other call sites unchanged
- [x] CLI options preserved
- [x] API endpoints preserved
- [x] Commit messages match implementation -- all 4 commits accurately describe their changes
- [x] No deleted files

## Detailed Regression Analysis

### RecoveryManager Constructor Signature Change

The `RecoveryManager` constructor gained a new required parameter `dependencyRepo: DependencyRepository`. All 4 call sites were updated:
1. `src/bootstrap.ts:412` -- uses container DI lookup
2. `tests/integration/task-persistence.test.ts:83` -- creates real `SQLiteDependencyRepository`
3. `tests/integration/task-persistence.test.ts:347` -- creates real `SQLiteDependencyRepository`
4. `tests/unit/services/recovery-manager.test.ts:90` -- uses mock

**Verdict**: No regression. All consumers updated. TypeScript compiler would catch any missed call sites.

### RecoveryManager.recoverQueuedTasks Return Type Change

Changed from `Promise<number>` to `Promise<{ queuedCount: number; blockedCount: number }>`. This is a private method, so only internal callers exist. The single caller in `recover()` at line 64 was updated to destructure the new return shape.

**Verdict**: No regression. Private method, single call site updated.

### CancelSchedule: getExecutionHistory Limit Change

Old: `getExecutionHistory(scheduleId, 1)` -- only latest execution, missed older active runs.
New: `getExecutionHistory(scheduleId)` -- all executions (up to DEFAULT_LIMIT of 100), filters to `'triggered'` status.

The `getExecutionHistory` interface signature is `(scheduleId, limit?)` with optional limit. Removing the `1` argument is valid and falls back to the repository default of 100. No other call sites were affected.

**Verdict**: Intentional behavior change (bug fix). No regression in API compatibility. The filter to `'triggered'` status ensures only active executions get cancellation events, avoiding no-op cancellations on completed/failed executions.

### TaskFailed Event Emission in RecoveryManager

Two new `TaskFailed` event emissions were added:
1. `cleanDeadWorkerRegistrations()` at line 124 -- after marking dead worker tasks as FAILED
2. `recoverRunningTasks()` at line 266 -- after marking crashed tasks as FAILED

These are additive -- they fire the event that should have been fired previously. The `DependencyHandler` listens for `TaskFailed` to resolve dependencies for downstream pipeline tasks. Without these emissions, downstream tasks would remain blocked forever after a crash.

**Verdict**: No regression. Additive side effects that fix a correctness bug.

### totalSize Recalculation After Tail-Slicing

Old behavior: `totalSize` always reflected the full buffer size regardless of tail-slicing.
New behavior: `totalSize` reflects the size of the returned (sliced) content when tail is applied.

This is a **semantic change** in the `TaskOutput.totalSize` field. Any consumer that used `totalSize` after a tail-sliced `getLogs()` call previously saw the full buffer size and now sees the sliced content size. The `process-connector.ts` `flushOutput()` call at line 139 does NOT pass `tail`, so it is unaffected. The `totalSize === 0` guard at line 143 is unaffected because a zero-size buffer produces zero-size output regardless.

The primary consumer is the MCP adapter / CLI displaying output to users, where showing the sliced size is more accurate.

**Verdict**: Intentional behavior change (bug fix). No regression for existing callers since the only non-tail caller (`flushOutput`) hits the non-tail code path.

**Regression Score**: 9/10
**Recommendation**: APPROVED_WITH_CONDITIONS

Conditions:
1. Consider extracting `linesSize` to a shared utility to eliminate duplication (MEDIUM)
2. Document or resolve the `string.length` vs `Buffer.byteLength` semantic inconsistency in `totalSize` (MEDIUM). This is partially pre-existing but the new `linesSize` function makes it more visible.
