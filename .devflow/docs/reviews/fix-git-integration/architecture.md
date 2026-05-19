# Architecture Review Report

**Branch**: fix-git-integration -> main
**Date**: 2026-03-25
**PR**: #120

## Issues in Your Changes (BLOCKING)

### HIGH

**`getResetTargetSha` performs async DB query to find best iteration commit SHA instead of caching it on Loop** - `src/services/handlers/loop-handler.ts:1224-1234`
**Confidence**: 85%
- Problem: `getResetTargetSha()` calls `this.loopRepo.getIterations(loop.id, 100)` to find the best iteration's `gitCommitSha`, then linear-scans by `i.iterationNumber === loop.bestIterationId`. The loop already tracks `bestIterationId` (an iteration number), but does not cache the corresponding `gitCommitSha`. This forces an async DB round-trip with up to 100 rows fetched every time a failed/discarded iteration needs a git reset in optimize mode. This breaks the pattern established elsewhere in the handler where loop state is updated atomically in `runInTransaction` and used directly -- here, the handler re-queries for data it could have stored.
- Impact: Unnecessary DB I/O on every optimize-fail/discard path. More importantly, the `getResetTargetSha` method being async makes `resetIterationGitState` async, which propagates async up through `handleIterationGitOutcome`. If the best iteration's commit SHA were cached on the loop, the entire reset-target resolution would be synchronous.
- Fix: Add `bestIterationCommitSha?: string` to the `Loop` domain interface. Update it atomically alongside `bestIterationId` in the `recordAndContinue` "keep" path. Then `getResetTargetSha` becomes a pure synchronous function:
  ```typescript
  private getResetTargetSha(loop: Loop): string | undefined {
    if (loop.strategy === LoopStrategy.OPTIMIZE && loop.bestIterationCommitSha) {
      return loop.bestIterationCommitSha;
    }
    return loop.gitStartCommitSha;
  }
  ```

## Issues in Code You Touched (Should Fix)

### MEDIUM

**`captureGitDiff` validates commit SHAs with `validateGitRefName` -- works but mismatched abstraction** - `src/utils/git-state.ts:229-233`
**Confidence**: 84%
- Problem: `captureGitDiff()` now accepts commit SHAs as `fromRef`/`toRef` (renamed from `fromBranch`/`toBranch`). It validates inputs using `validateGitRefName()`, which enforces branch naming rules. A separate `isValidCommitSha()` function exists for `resetToCommit()`. This creates two independent validation strategies for git refs: branch-name-rules for diffs, hex-format-rules for resets. While hex SHAs pass branch name validation (no overlap in rejection rules), the dual-path design is an architectural inconsistency.
- Fix: Add a short-circuit in `captureGitDiff`: if the input matches hex SHA format, skip `validateGitRefName`:
  ```typescript
  const fromValidation = /^[0-9a-f]{7,40}$/.test(fromRef)
    ? ok(undefined)
    : validateGitRefName(fromRef, 'ref');
  ```
  This makes `captureGitDiff`'s dual-purpose (branches AND SHAs) architecturally explicit and uses consistent validation rules for SHAs across the codebase.

**`setupGitForIteration` activates for all loops in git repos due to `gitStartCommitSha` always being set** - `src/services/handlers/loop-handler.ts:532`
**Confidence**: 80%
- Problem: The check `const isGitLoop = !!(loop.gitBranch || loop.gitStartCommitSha)` combined with `captureLoopGitContext` always setting `gitStartCommitSha` in git repos means every loop in a git repo enters the git setup path. For loops without `--git-branch`, this captures `preIterationCommitSha` on every iteration. In `handleIterationGitOutcome`, any iteration with `preIterationCommitSha` triggers the commit-or-reset logic -- meaning loops that were NOT created with `--git-branch` will still get `git add -A && git commit` on pass/keep, and `git reset --hard && git clean -fd` on fail/discard. The `git reset --hard && git clean -fd` on failure paths is particularly concerning for users who did not opt into git integration.
- Fix: Guard destructive git operations behind `loop.gitBranch` rather than `iteration.preIterationCommitSha`:
  ```typescript
  // In handleIterationGitOutcome:
  if (!loop.gitBranch || !iteration.preIterationCommitSha) return {};

  // In resetIterationGitState:
  if (!loop.gitBranch || !iteration.preIterationCommitSha) return;
  ```
  Keep passive SHA tracking (via `preIterationCommitSha`) for diff purposes, but only perform destructive operations when the user explicitly opted in with `--git-branch`.

## Pre-existing Issues (Not Blocking)

### MEDIUM

**`LoopHandler` class approaching god-class territory (~1650 lines, 7+ responsibilities)** - `src/services/handlers/loop-handler.ts`
**Confidence**: 82%
- Problem: The class handles event subscription, iteration dispatch, retry strategy evaluation, optimize strategy evaluation, git state management (6 new methods, ~140 lines), pipeline orchestration, cooldown timers, and crash recovery. The git operations form a cohesive responsibility group that could be extracted.
- Fix: Extract git methods (`setupGitForIteration`, `handleIterationGitOutcome`, `commitAndCaptureDiff`, `getResetTargetSha`, `resetIterationGitState`) into a `LoopGitManager` collaborator injected via the constructor. This isolates git concerns for independent testing and reduces LoopHandler to ~1500 lines.

**`bestIterationId` naming stores iteration *number*, not a database ID** - `src/core/domain.ts:541`
**Confidence**: 90%
- Problem: `bestIterationId` is compared against `iterationNumber` in `getResetTargetSha` (line 1229) and set from `iterationNumber` in `recordAndContinue`. The name suggests a database row ID but it is the iteration sequence number. Pre-existing from v0.7.0.
- Fix: Rename to `bestIterationNumber` in a separate PR.

## Suggestions (Lower Confidence)

- **`commitAllChanges` uses `git add -A` which stages all files including unrelated changes** - `src/utils/git-state.ts:339` (Confidence: 72%) -- If the working directory has unrelated dirty files before the iteration starts, `git add -A` will include them in the iteration's commit. A more precise approach would be to only commit files changed since `preIterationCommitSha`, but this would significantly complicate the implementation.

- **Recovery path does not perform git reset for stuck loops** - `src/services/handlers/loop-handler.ts:1533-1646` (Confidence: 65%) -- `recoverSingleLoop` does not call `resetIterationGitState` for failed tasks found during recovery. If the server crashed between task failure and git reset, the working directory remains dirty after restart.

- **Unused `captureGitState` import may remain in `loop-manager.ts`** - `src/services/loop-manager.ts:24` (Confidence: 70%) -- `captureGitState` is still imported alongside `captureLoopGitContext`. It may be used in `validateCreateRequest` for git branch validation, but worth verifying it is not orphaned after the refactoring.

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 0 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 2 | 0 |

**Architecture Score**: 8/10
**Recommendation**: APPROVED_WITH_CONDITIONS

**What improved since the previous review**: The prior review's HIGH finding (duplicated git state capture logic between `LoopManager` and `ScheduleHandler`) has been fully resolved -- `captureLoopGitContext` was extracted as a shared helper in `git-state.ts`, and the redundant `getCurrentCommitSha` call was eliminated by reusing `captureGitState().commitSha`. The prior review's MEDIUM finding about retry-pass duplication was addressed by reusing `handleIterationGitOutcome` consistently.

**Current assessment**: The architecture is clean and well-layered:

- **Good separation of concerns**: Git utilities (`getCurrentCommitSha`, `commitAllChanges`, `resetToCommit`, `captureLoopGitContext`) are pure functions returning `Result` types in the utils layer, consistent with the project's architecture.
- **Clean domain model evolution**: New fields are additive alongside legacy fields with clear comments. The domain factory initializes them to `undefined`; async git operations are injected post-creation, maintaining the pure/async boundary.
- **Proper layering**: No layering violations -- git utilities in `utils/`, domain types in `core/domain.ts`, repository mapping in `implementations/`, orchestration in `services/handlers/`.
- **Security**: `isValidCommitSha` validates SHA format before `git reset --hard`. `execFile` used throughout (no shell injection). `'--'` separators prevent argument injection.
- **Migration safety**: Dead columns kept in SQLite (cannot DROP COLUMN easily), new columns are nullable -- backward compatible.

**Conditions for approval**:
1. Address the should-fix finding about `setupGitForIteration` scope -- destructive git operations (`git reset --hard`, `git clean -fd`, `git add -A && git commit`) should be gated behind explicit `--git-branch` opt-in, not triggered implicitly by `gitStartCommitSha` presence.
2. The HIGH finding about `getResetTargetSha` async I/O is recommended but can be deferred to a follow-up if scoped as tech debt.
