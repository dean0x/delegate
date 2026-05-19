# Regression Review Report

**Branch**: fix-git-integration -> main
**Date**: 2026-03-25
**PR**: #120

---

## Issues in Your Changes (BLOCKING)

### CRITICAL

(none)

### HIGH

**Missing git reset in crash recovery path for TaskFailed** - `src/services/handlers/loop-handler.ts:1607`
**Confidence**: 82%
- Problem: The `recoverSingleLoop()` method handles `TaskStatus.FAILED` (line 1607-1633) but does not call `resetIterationGitState()` before persisting the failure. The normal `handleTaskTerminal` path (line 252) correctly calls `resetIterationGitState(loop, iteration, 'task failure')` before the transaction. This means if the server crashes after a task fails but before the git reset runs, recovery will skip the reset entirely, leaving the working directory in a dirty state from the failed iteration. This breaks the commit-per-iteration invariant during crash recovery.
- Impact: Git-enabled loops that experience a server crash immediately after a task failure (before git reset completes) will resume with a polluted working directory.
- Fix: Add `await this.resetIterationGitState(loop, latestIteration, 'recovered task failure');` before the transaction block at line 1610:
  ```typescript
  if (task.status === TaskStatus.FAILED) {
    const newConsecutiveFailures = loop.consecutiveFailures + 1;

    // Git reset: revert working directory to pre-iteration state (mirrors handleTaskTerminal path)
    await this.resetIterationGitState(loop, latestIteration, 'recovered task failure');

    // Atomic: iteration fail + consecutiveFailures in single transaction
    const updatedLoop = updateLoop(loop, { consecutiveFailures: newConsecutiveFailures });
    ...
  ```

### MEDIUM

**CLI output regression for v0.8.0 loops: iteration git info silently disappears** - `src/cli/commands/loop.ts:418`
**Confidence**: 82%
- Problem: The CLI changed from `iter.gitBranch` to `iter.gitCommitSha` for displaying git info in iteration history. Existing loops created under v0.8.0 have `gitBranch` set on iterations but `gitCommitSha` will be `undefined` (the new column is NULL for old rows). These iterations will show no git info at all, whereas before they showed `| branch: loop/work/iteration-1`.
- Impact: Users who upgrade from v0.8.0 to v0.8.1 lose visibility into git context for existing completed iterations. No data is lost (the `gitBranch` column is still in the DB), but the CLI no longer surfaces it.
- Fix: Fall back to the old field:
  ```typescript
  const git = iter.gitCommitSha
    ? ` | commit: ${iter.gitCommitSha.slice(0, 8)}`
    : iter.gitBranch
      ? ` | branch: ${iter.gitBranch}`
      : '';
  ```

**CLI loop status: `gitBaseBranch` replaced by `gitStartCommitSha` without fallback** - `src/cli/commands/loop.ts:388`
**Confidence**: 82%
- Problem: Same pattern at the loop level. The display changed from `Git Base: main` to `Git Start: abc12345`. For v0.8.0 loops that have `gitBaseBranch` but no `gitStartCommitSha`, the "Git Base" line disappears entirely with no replacement.
- Impact: Minor display regression for existing loops. Users lose the base branch context in CLI output.
- Fix: Add fallback:
  ```typescript
  if (loop.gitStartCommitSha) lines.push(`Git Start:     ${loop.gitStartCommitSha.slice(0, 8)}`);
  else if (loop.gitBaseBranch) lines.push(`Git Base:      ${loop.gitBaseBranch}`);
  ```

---

## Issues in Code You Touched (Should Fix)

### MEDIUM

**Recovery path for TaskCompleted may commit to wrong branch** - `src/services/handlers/loop-handler.ts:1601`
**Confidence**: 80%
- Problem: When `recoverSingleLoop()` encounters `TaskStatus.COMPLETED`, it calls `handleIterationResult()` which flows through `handleIterationGitOutcome()` -> `commitAndCaptureDiff()`. However, it does not first re-checkout the loop's branch via `createAndCheckoutBranch`. During normal flow, `setupGitForIteration()` ensures the correct branch is checked out at iteration start. After a crash+recovery, the working directory may be on a different branch (e.g., main), meaning `commitAllChanges()` would commit to the wrong branch. This is mitigated by best-effort error handling (never throws), but the commit would land on the wrong ref.
- Fix: Consider adding `createAndCheckoutBranch(loop.workingDirectory, loop.gitBranch)` before `handleIterationResult` in the recovery completed path, or document this as an accepted limitation.

**Behavioral change: `captureLoopGitContext` now called unconditionally** - `src/services/loop-manager.ts:229`
**Confidence**: 80%
- Problem: Previously, `captureGitState` was only called when `request.gitBranch` was set. Now `captureLoopGitContext` is called for every loop creation, adding three subprocess calls (`git rev-parse --abbrev-ref HEAD`, `git rev-parse HEAD`, `git status --porcelain`) even for non-git directories. For non-git repos, `captureGitState` gracefully returns `null`, so this is functionally correct but is a minor performance overhead.
- Note: This is an intentional design choice documented in comments ("Always capture gitStartCommitSha when in a git repo"). Flagging for awareness since it changes observable behavior even when `--git-branch` is not used.

---

## Pre-existing Issues (Not Blocking)

(none)

---

## Suggestions (Lower Confidence)

- **`getResetTargetSha` fetches up to 100 iterations to find best iteration** - `src/services/handlers/loop-handler.ts:1227` (Confidence: 70%) -- For optimize loops with many iterations, this fetches all iterations just to find one by `iterationNumber`. Could use a targeted query, but the practical impact is low.

- **`captureGitDiff` validates commit SHAs through `validateGitRefName` designed for branch names** - `src/utils/git-state.ts:229` (Confidence: 62%) -- Now that `captureGitDiff` accepts commit SHAs, validation via `validateGitRefName` is semantically imprecise, though it works in practice because hex SHAs pass all ref-name checks.

- **`commitAllChanges` trailing `--` after `-m message` is unconventional** - `src/utils/git-state.ts:351` (Confidence: 60%) -- The trailing `--` after `git commit -m message` is non-standard. Git interprets it as "end of options, start of pathspec". With an empty pathspec it commits all staged changes, but this is unconventional and could vary across git versions.

---

## Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| Blocking | 0 | 1 | 2 | 0 |
| Should Fix | 0 | 0 | 2 | 0 |
| Pre-existing | 0 | 0 | 0 | 0 |

**Regression Score**: 8/10
**Recommendation**: CHANGES_REQUESTED

### Rationale

The branch is a significant improvement over the prior review iteration. The two HIGH issues from the prior review (missing git reset on TaskFailed and pipeline intermediate failure paths) have been **resolved** in commits `3793715` and `06059bb`. The core commit-per-iteration design is well-implemented with thorough test coverage (276 new test lines, 13 new git integration test cases).

Remaining issues:
1. **HIGH**: The crash recovery path (`recoverSingleLoop`) still lacks the git reset that the normal failure path now has. This is a narrow edge case (server crash between task failure and git reset) but violates the commit-per-iteration invariant.
2. **MEDIUM (CLI)**: Two CLI display fallbacks missing for v0.8.0 loop backward compatibility. Minor but easy to fix.
3. **MEDIUM (Should-Fix)**: Recovery completed path does not re-checkout the loop branch. Unconditional git subprocess calls for all loop creation (intentional, documented).

No exports removed. No return types changed in breaking ways. No files deleted. Domain model additions are additive and backward-compatible. Database migration is additive-only (new columns, no drops). Legacy fields preserved for migration safety.
