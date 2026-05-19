# Consistency Review Report

**Branch**: fix/v060-correctness-bugs -> main
**Date**: 2026-03-19
**Commits**: 4 (18d7657, 6866844, 894d3f9, 3301a2e)

## Issues in Your Changes (BLOCKING)

### MEDIUM
**Duplicated `linesSize` utility function** - `src/services/task-manager.ts:33` and `src/implementations/output-capture.ts:13`

- Problem: The identical `linesSize` function is defined as a module-private function in two separate files. Both have the same JSDoc comment, same signature, same implementation. This violates DRY and introduces a maintenance risk where one copy could drift from the other.
- Impact: If the totalSize calculation logic needs to change (e.g., to account for newlines between lines, or switch to byte-length), two call sites must be updated in lockstep. Easy to miss one.
- Fix: Extract `linesSize` to a shared utility module (e.g., `src/utils/output.ts`) and import it from both files:
  ```typescript
  // src/utils/output.ts
  /** Sum the character lengths of all lines in an array */
  export function linesSize(lines: readonly string[]): number {
    return lines.reduce((sum, line) => sum + line.length, 0);
  }
  ```

### MEDIUM
**`TestOutputCapture.getOutput` uses different totalSize calculation than `BufferedOutputCapture.getOutput`** - `src/implementations/output-capture.ts:213`

- Problem: `BufferedOutputCapture` (line 118-120) now uses `linesSize()` which sums `line.length` for each element, while `TestOutputCapture` (line 213) uses `stdout.join('').length + stderr.join('').length`. These are semantically identical today but the implementation patterns diverge -- one uses `reduce`, the other uses `join('')`. The `BufferedOutputCapture` was updated as part of this PR to use `linesSize`, but the `TestOutputCapture` in the same file was not updated to match.
- Impact: The two implementations of the `OutputCapture` interface now use visually different calculation patterns for the same field. If `linesSize` is later modified (e.g., to include separator sizes), `TestOutputCapture` will silently diverge.
- Fix: Update `TestOutputCapture.getOutput` to use `linesSize` as well:
  ```typescript
  // line 213, replace:
  const totalSize = stdout.join('').length + stderr.join('').length;
  // with:
  const totalSize = linesSize(stdout) + linesSize(stderr);
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM
**Naming inconsistency in `RecoveryManager` constructor parameters** - `src/services/recovery-manager.ts:14-19`

- Problem: The constructor uses three different naming conventions for repositories:
  - `repository` (TaskRepository, line 14) -- bare noun, no suffix
  - `workerRepository` (WorkerRepository, line 18) -- full `*Repository` suffix
  - `dependencyRepo` (DependencyRepository, line 19) -- abbreviated `*Repo` suffix
- Impact: The codebase has an established split pattern: handlers use abbreviated `*Repo` (e.g., `taskRepo`, `dependencyRepo`, `scheduleRepo` in handler classes), while `RecoveryManager` pre-existing code uses the full `*Repository` suffix. The new `dependencyRepo` parameter follows handler convention rather than the existing `RecoveryManager` convention. This is a minor readability inconsistency within the class -- three different styles in one constructor.
- Fix: This is low-risk and the abbreviated `*Repo` style is arguably more consistent with the broader codebase (used in 8+ handler/service classes). A full rename of all three to match (`taskRepo`, `workerRepo`, `dependencyRepo`) would be ideal but is a separate refactor. No action required for this PR; noted for awareness.

## Pre-existing Issues (Not Blocking)

### MEDIUM
**`worker-handler.ts` emits `TaskFailed` with `new Error()` instead of `AutobeatError`** - `src/services/handlers/worker-handler.ts:445`

- Problem: The `TaskFailedEvent` interface (events.ts:54) types the `error` field as `AutobeatError`, but worker-handler line 445 emits `new Error(...)`. The new `RecoveryManager` emissions correctly use `AutobeatError(ErrorCode.SYSTEM_ERROR, ...)`.
- Impact: Type inconsistency between event interface and emission. TypeScript may not catch this if the EventBus emit signature is loosely typed.
- Note: Pre-existing issue. The new code in this PR follows the correct pattern.

### LOW
**`createMockDependencyRepo` defined inline instead of in shared mock fixtures** - `tests/unit/services/recovery-manager.test.ts:61-71`

- Problem: `createMockWorkerRepository` lives in `tests/fixtures/mocks.ts` as a shared fixture, but the new `createMockDependencyRepo` is defined inline in the test file. Given that `DependencyRepository` is used across multiple test files, this could lead to duplicate mock definitions.
- Note: The inline pattern is locally acceptable since only `recovery-manager.test.ts` needs it currently. If other test files add dependency repo mocks, extract to `tests/fixtures/mocks.ts`.

### LOW
**`totalSize` semantics differ between character-length and byte-length** - `src/implementations/output-capture.ts:51` vs `output-capture.ts:13`

- Problem: `capture()` accumulates `totalSize` using `Buffer.byteLength(data, 'utf8')` (byte length), but `linesSize()` computes character length via `line.length`. When tail slicing occurs, the returned `totalSize` switches from byte-based to character-based measurement. For ASCII content this is equivalent, but for multi-byte characters they diverge.
- Note: Pre-existing architectural issue, not introduced by this PR. The PR actually improves consistency by ensuring tail-sliced output reflects the sliced content rather than the original buffer size.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 2 | 0 |
| Should Fix | 0 | 0 | 1 | 0 |
| Pre-existing | 0 | 0 | 1 | 2 |

**Consistency Score**: 7/10

The PR demonstrates strong consistency in several areas:
- Error handling pattern (Result types used throughout, event emit error checking follows established patterns)
- New `TaskFailed` emissions in RecoveryManager correctly use `AutobeatError` matching the event type definition
- Test structure follows existing test patterns (describe blocks, beforeEach setup, behavioral assertions)
- The schedule-manager fix correctly uses existing patterns (`flatMap`, `filter`, event emission with error logging)

Deductions are for: duplicated utility function across two files (-1), divergent `totalSize` calculation patterns between `BufferedOutputCapture` and `TestOutputCapture` in the same file (-1), and mixed naming convention in one constructor (-1).

**Recommendation**: APPROVED_WITH_CONDITIONS

Conditions:
1. Consider extracting `linesSize` to a shared utility (or at minimum, update `TestOutputCapture` to use `linesSize` for visual consistency within `output-capture.ts`)
