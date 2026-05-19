# Consistency Review Report

**Branch**: fix-git-integration -> main
**Date**: 2026-03-25
**PR**: #120

## Issues in Your Changes (BLOCKING)

### HIGH

**Inconsistent Result type annotation on `captureLoopGitContext`** - `src/utils/git-state.ts:304`
**Confidence**: 90%
- Problem: `captureLoopGitContext` uses `Promise<Result<LoopGitContext>>` (no explicit error type), while all other new functions in the same file explicitly specify the error type: `getCurrentCommitSha` returns `Promise<Result<string, AutobeatError>>`, `commitAllChanges` returns `Promise<Result<string | null, AutobeatError>>`, `resetToCommit` returns `Promise<Result<void, AutobeatError>>`, and `createAndCheckoutBranch` returns `Promise<Result<void, AutobeatError>>`. The pre-existing `captureGitState` also omits the error type, but among the five new/modified exports in this PR, four use explicit `AutobeatError` and one does not.
- Fix: Add explicit error type for consistency with the other new functions:
  ```typescript
  export async function captureLoopGitContext(
    workingDirectory: string,
    gitBranch?: string,
  ): Promise<Result<LoopGitContext, AutobeatError>> {
  ```

### MEDIUM

**Inconsistent `iterationStatus` parameter type between sibling methods** - `src/services/handlers/loop-handler.ts:1181`
**Confidence**: 85%
- Problem: `commitAndCaptureDiff` declares `iterationStatus: string` while its caller `handleIterationGitOutcome` (line 1150) uses the narrower `LoopIteration['status']`. Both are private methods in the same class operating on the same concept. Using `string` widens the type unnecessarily and loses the union type safety that the rest of the handler relies on.
- Fix: Use the same type as the caller:
  ```typescript
  private async commitAndCaptureDiff(
    loop: Loop,
    iteration: LoopIteration,
    iterationStatus: LoopIteration['status'],
  ): Promise<{ gitCommitSha?: string; gitDiffSummary?: string }> {
  ```

**Inconsistent error handling for `captureLoopGitContext` failures between LoopManager and ScheduleHandler** - `src/services/loop-manager.ts:229-231` vs `src/services/handlers/schedule-handler.ts:574-579`
**Confidence**: 82%
- Problem: When `captureLoopGitContext` fails, `ScheduleHandler` logs a warning (line 575: `this.logger.warn('Failed to capture git state for scheduled loop...')`) while `LoopManagerService` silently drops the error by extracting `undefined` via ternary (lines 230-231: `gitContextResult.ok ? ... : undefined`). Both call sites serve the same purpose (capturing git context at loop creation) and should handle errors the same way. The ScheduleHandler pattern of logging a warning is the established approach for best-effort git operations throughout the codebase (see also `setupGitForIteration`, `resetIterationGitState`, `commitAndCaptureDiff` -- all log warnings on failure).
- Fix: Add a warning log to LoopManagerService on failure, matching the ScheduleHandler pattern:
  ```typescript
  const gitContextResult = await captureLoopGitContext(validatedWorkingDirectory, request.gitBranch);
  let gitBaseBranch: string | undefined;
  let gitStartCommitSha: string | undefined;
  if (gitContextResult.ok) {
    gitBaseBranch = gitContextResult.value.gitBaseBranch;
    gitStartCommitSha = gitContextResult.value.gitStartCommitSha;
  } else {
    this.logger.warn('Failed to capture git state for loop — proceeding without git context', {
      error: gitContextResult.error.message,
    });
  }
  ```

## Issues in Code You Touched (Should Fix)

_No issues found._

## Pre-existing Issues (Not Blocking)

### LOW

**Pre-existing: `captureGitState` also omits explicit `AutobeatError` in Result type** - `src/utils/git-state.ts:119`
**Confidence**: 82%
- Problem: `captureGitState` uses `Promise<Result<GitState | null>>` without specifying `AutobeatError`. This is the original pattern that `captureLoopGitContext` inherited. Since `captureLoopGitContext` delegates to `captureGitState`, the inconsistency propagates.
- Fix: In a separate cleanup PR, add `AutobeatError` to `captureGitState`'s return type to match the newer functions.

## Suggestions (Lower Confidence)

- **`loopWithGit` construction style differs between ScheduleHandler and LoopManager** - `src/services/loop-manager.ts:249-255` vs `src/services/handlers/schedule-handler.ts:564-573` (Confidence: 65%) -- Both construct `loopWithGit` from `captureLoopGitContext` results but use different patterns (`let` with reassignment in ScheduleHandler vs `const` ternary in LoopManager). A shared helper or consistent pattern would reduce divergence, though both are functionally correct.

- **Version comment annotations use slightly different styles across files** - multiple files (Confidence: 62%) -- Some fields use trailing comments like `// (v0.8.0, dead after v0.8.1)` (in domain.ts) while repository code uses `// Legacy (v0.8.0), always null for v0.8.1+`. The styles are consistent within each file but vary across files. Minor stylistic variation.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 0 | 0 |
| Pre-existing | 0 | 0 | 0 | 1 |

**Consistency Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Rationale

The branch demonstrates strong consistency overall. Key positives:

- **Result types used throughout**: All new git utility functions return `Result<T, AutobeatError>`, matching the established pattern.
- **Error handling follows best-effort convention**: Git operations in the loop handler log warnings and continue gracefully, consistent with the pre-existing `createAndCheckoutBranch` degradation pattern.
- **Naming conventions followed**: New fields (`gitStartCommitSha`, `gitCommitSha`, `preIterationCommitSha`) use camelCase matching existing `gitBranch`, `gitBaseBranch`, `gitDiffSummary`.
- **Domain model additions mirror established patterns**: New optional fields with version annotations follow the existing `gitBranch`/`gitBaseBranch` precedent.
- **Repository layer consistent**: The `?? null` / `?? undefined` idiom is applied uniformly to all new fields in insert, update, and read paths.
- **Migration follows versioned pattern**: Migration 12 follows the same structure as migrations 9-11.
- **Security pattern preserved**: New `isValidCommitSha` and `resetToCommit` use the same `execFile` (not `exec`) pattern with `'--'` separators as existing functions.
- **Shared helper extraction (`captureLoopGitContext`)**: Correctly eliminates duplication between LoopManager and ScheduleHandler.

The three findings are minor consistency gaps (Result type annotation, parameter type widening, silent error dropping) that would be quick to align.
