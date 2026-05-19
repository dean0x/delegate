# TypeScript Review Report

**Branch**: fix-git-integration -> main
**Date**: 2026-03-25

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

(none)

### MEDIUM

**Type assertion in `isTimeoutError` could use a narrower approach** - `src/utils/git-state.ts:18`
**Confidence**: 82%
- Problem: The function uses `(error as { killed?: boolean }).killed === true` after checking `'killed' in error`. While the runtime guard (`'killed' in error`) makes this safe, the `as` cast bypasses TypeScript's type system. A type predicate or a narrowing helper would be idiomatic TypeScript and eliminate the assertion.
- Fix: Use a type predicate function:
  ```typescript
  function isTimeoutError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    return 'killed' in error && (error as Record<string, unknown>).killed === true;
  }
  ```
  Or define a `NodeChildProcessError` interface and use a proper type guard:
  ```typescript
  interface ChildProcessError extends Error { killed?: boolean; }
  function isChildProcessError(e: unknown): e is ChildProcessError {
    return e instanceof Error && 'killed' in e;
  }
  function isTimeoutError(error: unknown): boolean {
    return isChildProcessError(error) && error.killed === true;
  }
  ```
  Note: This is a pre-existing function (not changed in this PR) but sits in heavily modified `git-state.ts`.

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`as TaskFailedEvent` casts rely on boolean variable rather than direct discriminant check** - `src/services/handlers/loop-handler.ts:248`, `src/services/handlers/loop-handler.ts:1375`
**Confidence**: 80%
- Problem: At line 244, the code assigns `event.type === 'TaskFailed'` to `isTaskFailed` and then uses `if (isTaskFailed)` before casting `event as TaskFailedEvent`. TypeScript cannot narrow a discriminated union through an intermediate boolean variable, which is why the explicit `as` cast is needed. While logically correct (the boolean guards it), this could break silently if the discriminant values change.
- Fix: Use a direct discriminant check which TypeScript can narrow automatically:
  ```typescript
  if (event.type === 'TaskFailed') {
    // TypeScript narrows event to TaskFailedEvent here - no cast needed
    const newConsecutiveFailures = loop.consecutiveFailures + 1;
    // ...
  }
  ```
  For the second instance at line 1375, the cast is in the else-branch of `if (event.type === 'TaskCompleted')` at line 1357. TypeScript should narrow this automatically to `TaskFailedEvent` in the else branch if the handler parameter type is `TaskCompletedEvent | TaskFailedEvent`. If not narrowing, inline the check rather than relying on control flow.

**`loopToRow` return type is `Record<string, unknown>`** - `src/implementations/loop-repository.ts:525`
**Confidence**: 80%
- Problem: The `loopToRow()` helper returns `Record<string, unknown>`, which erases all type information about the row shape. If a column is renamed in the SQL but not in this method, TypeScript will not catch it. The `LoopRow` interface already exists in this file and defines the expected shape.
- Fix: Define a named row-params interface (or reuse the column-name convention) so TypeScript validates the mapping:
  ```typescript
  private loopToRow(loop: Loop): {
    id: string;
    strategy: string;
    taskTemplate: string;
    // ... all named parameters matching the @-params in SQL
  } {
    return { ... };
  }
  ```
  This is a pre-existing pattern that the new `gitStartCommitSha` column follows, so it is not blocking, but worth tightening while the file is being actively modified.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`commitAndCaptureDiff` parameter `iterationStatus` typed as `string` instead of `LoopIteration['status']`** - `src/services/handlers/loop-handler.ts:1181`
**Confidence**: 85%
- Problem: The `iterationStatus` parameter is typed as `string`, losing the discriminated union type `'running' | 'pass' | 'fail' | 'keep' | 'discard' | 'crash' | 'cancelled'`. The caller always passes a string literal, but the function signature does not enforce valid values.
- Fix: Change the parameter type to `LoopIteration['status']`:
  ```typescript
  private async commitAndCaptureDiff(
    loop: Loop,
    iteration: LoopIteration,
    iterationStatus: LoopIteration['status'],
  ): Promise<{ gitCommitSha?: string; gitDiffSummary?: string }> {
  ```

### LOW

**`LoopGitContext` interface fields are optional (`?`) but `captureLoopGitContext` always returns both keys** - `src/utils/git-state.ts:284-287`
**Confidence**: 80%
- Problem: The `LoopGitContext` interface marks `gitBaseBranch` and `gitStartCommitSha` as optional with `?`. However, `captureLoopGitContext` always returns an object with explicit keys (either the value or `undefined`). This makes it harder for callers to distinguish "field not present" from "field is undefined". The pattern works correctly at runtime, but using `| undefined` instead of `?` communicates intent better.
- Fix: Consider `readonly gitBaseBranch: string | undefined` (always present, sometimes undefined) vs current `readonly gitBaseBranch?: string` (key may be absent). This is a minor clarity improvement; current behavior is correct.

## Suggestions (Lower Confidence)

- **Duplicate git-context injection pattern** - `src/services/loop-manager.ts:249-255`, `src/services/handlers/schedule-handler.ts:564-573` (Confidence: 70%) -- Both LoopManagerService.createLoop() and ScheduleHandler.handleLoopTrigger() perform nearly identical logic: call `captureLoopGitContext()`, then conditionally `updateLoop()` with `gitBaseBranch` and `gitStartCommitSha`. This could be extracted into a shared helper to reduce duplication, though both call sites have slightly different error handling so the consolidation may not be clean.

- **Return type of `getResetTargetSha` could be `Result` for consistency** - `src/services/handlers/loop-handler.ts:1224` (Confidence: 65%) -- This private method returns `Promise<string | undefined>` which is a departure from the `Result<T>` pattern used by most async methods in the codebase. Since it only reads data and delegates to the repo, the raw return is arguably fine for a private helper.

- **`handleIterationGitOutcome` catch block swallows typed errors** - `src/services/handlers/loop-handler.ts:1163-1170` (Confidence: 62%) -- The catch block types the error as `unknown` (correct), but discards the `AutobeatError` information from the underlying `resetToCommit` Result. Since this is documented as best-effort, the current approach is defensible, but a debug-level log of the full error context would aid troubleshooting.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 0 | 1 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 1 | 1 |

**TypeScript Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

### Rationale

The TypeScript quality of this branch is strong:

- **No `any` types** anywhere in changed files -- the iron law is fully respected.
- **Strict mode** is enabled in tsconfig and the project compiles cleanly with `--noEmit`.
- **Branded types** (`LoopId`, `TaskId`) are used consistently throughout.
- **Result types** are used for all fallible operations; the new git utilities (`getCurrentCommitSha`, `commitAllChanges`, `resetToCommit`) all return `Result<T, AutobeatError>`.
- **Zod schemas** validate data at the database boundary (loop repository), and the new columns (`git_start_commit_sha`, `git_commit_sha`, `pre_iteration_commit_sha`) are properly added to both schemas and row interfaces.
- **Readonly properties** on all domain interfaces and repository row types.
- **Discriminated unions** for `LoopIteration.status` and `LoopStatus` enum.
- **Input validation** in `isValidCommitSha` and `validateGitRefName` with clear security-first design.

The conditions for approval are minor: tighten one `string` parameter to `LoopIteration['status']`, and consider using direct discriminant checks instead of `as` casts in the two `TaskFailedEvent` locations. Neither issue introduces runtime risk; both are type-safety hygiene improvements.
